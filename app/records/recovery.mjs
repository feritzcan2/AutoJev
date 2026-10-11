// @ts-check
import {taskRecordIds, recordScoredInTask} from './task-scope.mjs';
// Reconnect shutdowns and the former app-generated unreported scoring failure.
// User stops and actual tool/provider failures are never revived.
const shutdownMessages = new Set([
  'Uygulama kapatıldı.',
  'Uygulama kapandı. Kaydedilen sonuçlar korunuyor.',
  'Önceki uygulama oturumu kapandı',
]);
export function recoverRecordOperations(db) {
  const queue = db.store.workspaces.tasks;
  for (const a of db.list()) {
    const latest = new Map();
    for (const task of queue.list(a.id))
      if (task.recordId && task.recordOperation)
        for (const itemId of taskRecordIds(task)) latest.set(itemId, task);
    for (const task of new Set(latest.values())) {
      if (taskRecordIds(task).some((itemId) => latest.get(itemId)?.id !== task.id)) continue;
      if (task.stopRequested || task.toolFailure) continue;
      const unreportedScore =
        task.recordOperation === 'score' &&
        task.state === 'failed' &&
        [
          'Agent sonuç bildirmeden durdu. Agent ekranını kontrol et.',
          'Agent oturumu sonuç bildirmeden kapandı.',
        ].includes(task.summary);
      if (unreportedScore) {
        if (
          task.request?.revision !== a.revision ||
          (task.scoreRecovery?.attempt ?? 0) >= 3 ||
          (!task.request?.manual && a.status !== 'enabled')
        )
          continue;
        const items = taskRecordIds(task).map((itemId) => db.result(a.id, itemId));
        if (items.some((item) => item.trial || !['found', 'prepared'].includes(item.status)))
          continue;
        const remaining = items.filter((item) => !recordScoredInTask(db, task, item));
        if (!remaining.length) {
          queue.finish(
            a.id,
            task.id,
            'completed',
            'Bütün puanlar kaydedilmiş; tamamlanma durumu düzeltildi.',
          );
          continue;
        }
        queue.put({
          ...task,
          state: 'pending',
          workerId: null,
          completionState: null,
          summary: `Kaydedilen puanlar korundu; kalan ${remaining.length} kayıttan devam edecek.`,
          recoveredAt: db.now(),
        });
        continue;
      }
      if (task.state !== 'interrupted' || !shutdownMessages.has(task.summary)) continue;
      const item = db.result(a.id, task.recordId);
      if (['completed', 'dismissed'].includes(item.status)) continue;
      const kind = item.status === 'uncertain' ? 'verify' : task.recordOperation,
        op = db.template(a.templateId).recordOperations?.[kind];
      if (!op) continue;
      queue.put({
        ...task,
        state: 'pending',
        workerId: null,
        completionState: null,
        recordOperation: kind,
        operation: op.id,
        capability: op.capability,
        request:
          kind === 'verify' ? {manual: true, revision: a.revision, at: db.now()} : task.request,
        summary: 'Uygulama kapanırken yarım kaldı. Tarayıcı bağlandığında devam edecek.',
        recoveredAt: db.now(),
      });
    }
  }
}

// Execute and verify runs used to fail outright when the agent went idle or
// its session closed without finish_automation_run. They now get one idle
// nudge and one automatic requeue; a reservation that flipped the record to
// uncertain continues as verify, never as a second submit.
const RECORD_RUN_OPERATIONS = ['execute', 'verify'];
function recordRunTask(db, id, runId) {
  let run;
  try {
    run = db.run(runId);
  } catch {
    return null;
  }
  if (!RECORD_RUN_OPERATIONS.includes(run.recordOperation) || !run.taskId || run.stopRequested)
    return null;
  const task = db.store.workspaces.tasks.get(id, run.taskId);
  if (task.stopRequested || task.toolFailure) return null;
  return {run, task};
}
export function continueRecordRun(db, id, runId) {
  const s = recordRunTask(db, id, runId);
  if (!s || s.task.recordRecovery?.nudged === runId) return null;
  db.store.workspaces.tasks.put({
    ...s.task,
    recordRecovery: {...s.task.recordRecovery, nudged: runId},
  });
  return {
    message:
      'The assigned record task is still open. Continue from the current page and saved state. Do not repeat a submission or upload that already happened. When the task is done or blocked, call finish_automation_run.',
  };
}
export function unreportedRecordRun(db, id, runId, reason) {
  const s = recordRunTask(db, id, runId);
  if (!s) return null;
  const attempt = s.task.recordRecovery?.attempt ?? 0;
  if (attempt >= 1) return null;
  db.store.workspaces.tasks.put({
    ...s.task,
    recordRecovery: {...s.task.recordRecovery, attempt: attempt + 1, requeue: runId},
  });
  return {
    status: 'interrupted',
    summary:
      reason === 'idle'
        ? 'Agent sonuç bildirmeden durdu; görev bir kez yeniden denenecek.'
        : 'Agent oturumu sonuç bildirmeden kapandı; görev bir kez yeniden denenecek.',
  };
}
// A record run that stopped on a shared site wait (rate limit, verification
// cooldown with a known end) before anything was reserved resumes after the
// wait, at most twice per task. Waits without an end need the user.
const SITE_WAIT_REQUEUES = 2;
function siteWaitRequeue(run, task, item) {
  const wait = run.siteWait;
  return (
    ['blocked', 'failed'].includes(run.status) &&
    wait &&
    !wait.exhausted &&
    Number.isFinite(wait.retryAt) &&
    !run.actionId &&
    ['found', 'prepared'].includes(item.status) &&
    (task.recordRecovery?.siteWaits ?? 0) < SITE_WAIT_REQUEUES
  );
}
export function requeueRecordRun(db, run) {
  if (!RECORD_RUN_OPERATIONS.includes(run.recordOperation) || run.stopRequested || !run.taskId)
    return false;
  const id = run.automationId,
    queue = db.store.workspaces.tasks,
    a = db.get(id),
    task = queue.get(id, run.taskId);
  if (task.stopRequested || task.toolFailure) return false;
  const item = db.result(id, task.recordId);
  if (['completed', 'dismissed'].includes(item.status)) return false;
  if (siteWaitRequeue(run, task, item)) {
    queue.put({
      ...task,
      state: 'pending',
      workerId: null,
      completionState: null,
      retryAt: Math.max(run.siteWait.retryAt, db.now()) + 5000,
      recordRecovery: {
        ...task.recordRecovery,
        siteWaits: (task.recordRecovery?.siteWaits ?? 0) + 1,
      },
      summary: run.summary,
    });
    return true;
  }
  if (run.status !== 'interrupted' || task.recordRecovery?.requeue !== run.id) return false;
  const kind = item.status === 'uncertain' ? 'verify' : task.recordOperation,
    op = db.template(a.templateId).recordOperations?.[kind];
  if (!op) return false;
  queue.put({
    ...task,
    state: 'pending',
    workerId: null,
    completionState: null,
    recordOperation: kind,
    operation: op.id,
    capability: op.capability,
    request: kind === 'verify' ? {manual: true, revision: a.revision, at: db.now()} : task.request,
    retryAt: db.now() + 5000,
    recordRecovery: {...task.recordRecovery, requeue: false},
    summary: run.summary,
  });
  return true;
}
