// @ts-check
import {taskRecordIds} from './task-scope.mjs';

// Validate the whole selection before deleting anything. Other records and
// workers keep their tasks, including the remaining members of stopped batches.
export function deleteRecords(db, id, itemIds) {
  return db.store.workspaces.tasks.atomic(() => {
    if (
      !Array.isArray(itemIds) ||
      !itemIds.length ||
      itemIds.some((value) => typeof value !== 'string' || !value.trim())
    )
      throw Error('Select the records to delete');
    const a = db.get(id),
      records = db.store.workspaces.records,
      queue = db.store.workspaces.tasks;
    const selected = new Map(
      itemIds.map((itemId) => {
        const item = db.result(id, itemId);
        return [item.id, item];
      }),
    );
    const canonical = (itemId) => records.identities.resolve(id, itemId)?.id ?? itemId;
    const owns = (itemId) => selected.has(canonical(itemId));
    const tasks = queue.list(id);
    if (
      [...selected.values()].some((item) => item.status === 'executing') ||
      tasks.some(
        (task) =>
          ['pending', 'running', 'reported', 'paused'].includes(task.state) &&
          taskRecordIds(task).some(owns),
      ) ||
      db
        .runs(id)
        .some((run) => run.status === 'running' && [...taskRecordIds(run), run.actionId].some(owns))
    )
      throw Error('Stop the queued or running actions of the selected records before deleting');
    // Remove merged aliases too, so old keys cannot resolve to a missing survivor.
    const ids = db.db
      .prepare('SELECT id FROM workspace_records WHERE workspace_id=?')
      .all(id)
      .map((row) => row.id)
      .filter(owns);
    const removed = new Set(ids);
    for (const task of tasks) {
      if (!taskRecordIds(task).some(owns)) continue;
      const remaining = taskRecordIds(task).filter((itemId) => !owns(itemId));
      // Keep an empty task's historical record scope: clearing it would make a
      // stopped record operation look like a resumable source scan after restart.
      if (!remaining.length) {
        queue.put({
          ...task,
          stopRequested: true,
          resumeRecordAfterAnswer: false,
          resumeRecordAfterVerification: false,
          resumeSourceAfterAnswer: false,
        });
        continue;
      }
      queue.put({
        ...task,
        recordId: remaining[0],
        ...(task.recordIds ? {recordIds: remaining} : {}),
        ...(removed.has(task.subject) ? {subject: remaining[0]} : {}),
        ...(task.lockKey?.startsWith('record:') && removed.has(task.lockKey.slice(7))
          ? {lockKey: 'record:' + remaining[0]}
          : {}),
      });
    }
    db.put({
      ...a,
      questions: (a.questions ?? []).filter((question) => !removed.has(question.recordId)),
    });
    const remove = db.db.prepare('DELETE FROM workspace_records WHERE workspace_id=? AND id=?');
    for (const itemId of ids) remove.run(id, itemId);
    db.event(id, 'records_deleted', {itemIds: [...selected.keys()]});
    return {deleted: selected.size};
  });
}
