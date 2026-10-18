// @ts-check
// Development tools of unpackaged builds: the agent trace (everything a run's
// agent received, ./agent-trace.mjs) and trial scores (a scoring run that
// keeps its assessment off the record, ../scoring/trial-scores.mjs). A
// packaged build only answers that they are unavailable.
import {enqueueRecordOperation} from '../records/operations.mjs';
import {taskHasRecord} from '../records/task-scope.mjs';
import {dryRunTask, dryScores} from '../scoring/trial-scores.mjs';

const runMeta = (db, id, runId) => {
  try {
    const run = db.run(runId);
    if (run.automationId !== id) return null;
    return {
      id: run.id,
      kind: run.kind,
      status: run.status,
      summary: run.summary ?? '',
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      workerId: run.workerId ?? 'main',
      recordOperation: run.recordOperation ?? null,
      recordIds: run.recordIds ?? (run.recordId ? [run.recordId] : []),
      sourceUrl: run.sourceUrl ?? null,
      dryRun: run.request?.dryRun === true,
    };
  } catch {
    return null;
  }
};

export function registerDevTools({handle, trace, db, runtime}) {
  handle('dev-tools-status', () => ({available: Boolean(trace)}));
  if (!trace) return;
  handle('agent-trace-runs', (id) => {
    db.get(id);
    return trace.runs(id).map((run) => ({...run, run: runMeta(db, id, run.runId)}));
  });
  handle('agent-trace-run', (id, runId) => {
    db.get(id);
    const run = trace.events(id, runId);
    return run ? {...run, run: runMeta(db, id, runId)} : null;
  });
  // Queues an ordinary scoring run of one record whose score is not saved.
  handle('dev-trial-score', async (id, itemId) => {
    const task = enqueueRecordOperation(runtime, id, itemId, 'score', {
      manual: true,
      dryRun: true,
    });
    await runtime.tick();
    return runtime.queue.get(id, task.id);
  });
  handle('dev-trial-scores', (id, itemId) => {
    db.result(id, itemId);
    return {
      scores: dryScores(itemId).map((entry) => ({...entry, run: runMeta(db, id, entry.runId)})),
      queued: runtime.queue
        .list(id, {states: ['pending', 'running', 'reported', 'paused']})
        .filter((task) => dryRunTask(task) && taskHasRecord(task, itemId))
        .map((task) => ({taskId: task.id, state: task.state})),
    };
  });
}
