// @ts-check
import {operationFor} from '../templates/contract.mjs';
import {sourceMode} from '../sources/automation-sources.mjs';
import {SOURCE_PAGE_INSTRUCTIONS} from '../sources/scan.mjs';
import {COLLECTOR_INSTRUCTIONS, COLLECTOR_RESUME} from '../sources/collector-worker.mjs';

const TECHNICAL_RETRY_LIMIT = 3,
  IDLE_RETRY_LIMIT = 5;
const exhaustedSummary =
  'Access problem persists. 3 scan rounds ended with a technical error; automatic retries stopped. Progress is kept. Press Retry to continue.';
const idleExhaustedSummary =
  'The agent stopped 5 times in a row without saving progress or reporting; automatic resume stopped. Progress is kept. Press Retry to continue.';
function exhaustTechnicalRetries(db, run, attempt, summary, finalSummary = exhaustedSummary) {
  const id = run.automationId,
    task = db.store.workspaces.tasks.get(id, run.taskId),
    a = db.get(id),
    state = a.sourceState?.[run.sourceUrl] ?? {};
  const stop = {...run.stop, kind: 'technical', retryExhausted: true, evidence: summary};
  db.putRun({...run, recovery: null, stop});
  db.store.workspaces.tasks.put({
    ...task,
    retryAt: null,
    technicalRecovery: {reason: 'technical_page', attempt, readyAt: null, exhausted: true},
  });
  const retryPlan = {...a.retryPlan};
  delete retryPlan[run.sourceUrl];
  db.put({
    ...a,
    retryPlan,
    sourceState: {
      ...a.sourceState,
      [run.sourceUrl]: {
        ...state,
        blocked: true,
        siteBlocked: false,
        recovery: null,
        nextRunAt: null,
        lastStatus: 'blocked',
        lastResult: exhaustedSummary,
        lastRunId: run.id,
        blocker: {...run.resumeContext, runId: run.id, workerId: run.workerId, stop},
      },
    },
  });
  return {status: 'blocked', summary: finalSummary};
}

const legacyMessages = new Set([
  'The agent stopped without reporting a result. Check the agent screen.',
  'The agent session closed without reporting a result.',
  // Stored by earlier app versions.
  'Agent sonuç bildirmeden durdu. Agent ekranını kontrol et.',
  'Agent oturumu sonuç bildirmeden kapandı.',
]);
function resumable(db, run) {
  const a = db.get(run.automationId);
  if (
    run.toolFailure ||
    (run.taskId && db.store.workspaces.tasks.get(run.automationId, run.taskId).toolFailure)
  )
    return false;
  if (
    !['run', 'trial'].includes(run.kind) ||
    !run.sourceUrl ||
    run.recordId ||
    run.actionId ||
    !run.taskId ||
    a.status !== 'enabled' ||
    !a.sources.includes(run.sourceUrl) ||
    a.sourceSettings?.[run.sourceUrl]?.enabled === false
  )
    return false;
  if (run.kind === 'trial') return true;
  const template = db.template(a.templateId);
  if (!template.workflow.some((step) => step.id === run.operation)) return false;
  const step = operationFor(template, run.operation);
  return (
    step.scope === 'source' &&
    (step.effect === 'read' || sourceMode(a, run.sourceUrl) === 'observe') &&
    !db
      .results(a.id)
      .some((r) => r.runId === run.id && ['executing', 'uncertain'].includes(r.status))
  );
}

export function continueSourceRun(db, id, runId) {
  const run = db.run(runId);
  if (
    !resumable(db, run) ||
    // Ended for the app's background read: resumed after it, not nudged now.
    run.collectorReading ||
    Object.keys(run.scanIssues ?? {}).length ||
    (db.get(id).questions ?? []).some((q) => q.answer == null && q.taskId === run.taskId)
  )
    return null;
  return (
    'The same assigned source task is still open; no restart or new task occurred. Continue from the current page and saved checkpoint. Do not reread unchanged context or documents. If your last finish_automation_run was rejected, inspect its error, correct only the missing report or continue the remaining work. Page loading failures are verified and retried by the app. Do not repeat an unchanged failed action or submit anything.' +
    (run.kind === 'run'
      ? ' ' + (run.collector ? COLLECTOR_RESUME + COLLECTOR_INSTRUCTIONS : SOURCE_PAGE_INSTRUCTIONS)
      : '')
  );
}

export function unreportedSourceRun(db, id, runId, reason, now) {
  const run = db.run(runId);
  if (!resumable(db, run)) return null;
  // The agent ended its turn so the app could read a card site's next page;
  // that is the expected stop, not an idle agent. Resume at once.
  if (run.collectorReading) {
    db.putRun({...run, recovery: {reason: 'collector_read', attempt: 0, readyAt: now}});
    return {
      status: 'interrupted',
      summary:
        'The app is reading the next page and its listings; the agent resumes with the ready batch.',
    };
  }
  const issues = Object.values(run.scanIssues ?? {}).filter(
    (issue) => issue.verified || issue.kind === 'browser_error',
  );
  if (issues.length) {
    const pendingUrls = [
      ...new Set([...(run.scan?.pendingUrls ?? []), ...issues.map((issue) => issue.url)]),
    ];
    const summary = `Page failed to load; will retry: ${issues[0].url}`;
    db.persistScan(id, {
      ...run,
      scan: {
        ...run.scan,
        complete: false,
        pendingUrls,
        reason: summary,
        evidenceUrl: run.scan?.evidenceUrl ?? issues[0].url,
      },
    });
    return retryTechnicalSource(db, id, runId, summary, now);
  }
  // A running source task has no duration or step budget. Relaunches are
  // bounded only when the agent keeps stopping without a single browser step.
  const task = db.store.workspaces.tasks.get(id, run.taskId),
    attempt = (run.browserSteps ?? 0) > 0 ? 1 : (task.recovery?.attempt ?? 0) + 1;
  if (attempt >= IDLE_RETRY_LIMIT)
    return exhaustTechnicalRetries(
      db,
      run,
      attempt,
      run.summary ?? 'The agent session was interrupted without a report.',
      idleExhaustedSummary,
    );
  const delay = [5000, 15000, 30000, 60000][Math.min(attempt - 1, 3)],
    recovery = {reason, attempt, readyAt: now + delay};
  const summary = `The agent session was interrupted. It will resume automatically from the saved checkpoint in ${delay / 1000} seconds.`;
  db.putRun({...run, recovery});
  return {status: 'interrupted', summary};
}

// 30 s, 2 min, 10 min, 30 min, then one hour longer each time (1 h, 2 h, 3 h...).
const TECHNICAL_RETRY_STEPS = [30000, 120000, 600000, 1800000];
export const technicalRetryDelay = (attempt) =>
  attempt > TECHNICAL_RETRY_STEPS.length
    ? (attempt - TECHNICAL_RETRY_STEPS.length) * 3600000
    : TECHNICAL_RETRY_STEPS[Math.max(attempt - 1, 0)];

export function retryTechnicalSource(db, id, runId, summary, now) {
  const run = db.run(runId);
  if (!resumable(db, run)) return null;
  const task = db.store.workspaces.tasks.get(id, run.taskId),
    attempt = (task.technicalRecovery?.attempt ?? 0) + 1;
  if (attempt >= TECHNICAL_RETRY_LIMIT) return exhaustTechnicalRetries(db, run, attempt, summary);
  const delay = technicalRetryDelay(attempt),
    urls = [
      ...new Set(
        Object.values(run.scanIssues ?? {})
          .filter((issue) => issue.verified || issue.kind === 'browser_error')
          .map((issue) => issue.url),
      ),
    ];
  const recovery = {reason: 'technical_page', attempt, urls, readyAt: now + delay};
  db.putRun({...run, recovery});
  db.store.workspaces.tasks.put({...task, technicalRecovery: recovery});
  return {
    status: 'interrupted',
    summary:
      `Temporary scan problem; the saved addresses will be retried automatically in ${delay / 60000 < 1 ? '30 seconds' : delay / 60000 + ' minutes'}. ${summary}`.slice(
        0,
        6000,
      ),
  };
}

// A technical stop keeps its failed addresses in the scan queue and schedules
// the source retry. Returns the retry outcome, or null when no retry applies.
export function holdForTechnicalRetry(
  db,
  id,
  runId,
  {stop, urls, summary, evidenceUrl = undefined},
) {
  const current = db.run(runId),
    pendingUrls = [...new Set([...(current.scan?.pendingUrls ?? []), ...urls])];
  db.persistScan(id, {
    ...current,
    stop,
    scan: {
      ...current.scan,
      complete: false,
      pendingUrls,
      reason: summary,
      evidenceUrl: current.scan?.evidenceUrl ?? evidenceUrl ?? pendingUrls[0],
    },
  });
  return retryTechnicalSource(db, id, runId, summary, db.now());
}

export function requeueSourceRun(db, run) {
  return db.store.workspaces.tasks.atomic(() => {
    const q = db.store.workspaces.tasks,
      task = q.get(run.automationId, run.taskId),
      a = db.get(run.automationId),
      state = a.sourceState?.[run.sourceUrl] ?? {};
    if (run.toolFailure || task.toolFailure)
      return q.finish(run.automationId, task.id, 'blocked', run.summary);
    if (run.stopRequested || task.stopRequested)
      return q.finish(run.automationId, task.id, 'cancelled', 'Scan stopped by the user.');
    q.put({
      ...task,
      state: 'pending',
      workerId: null,
      scan: run.scan ?? task.scan,
      scanPlan: run.scanPlan ?? task.scanPlan,
      completionState: null,
      summary: run.summary,
      retryAt: run.recovery?.readyAt ?? null,
      ...(run.recovery ? {recovery: run.recovery} : {}),
    });
    if (run.recovery)
      db.put({
        ...a,
        sourceState: {
          ...a.sourceState,
          [run.sourceUrl]: {
            ...state,
            batchId: task.batchId,
            blocked: false,
            blocker: null,
            lastStatus: 'interrupted',
            lastResult: run.summary,
            lastRunId: run.id,
            nextRunAt: run.recovery.readyAt,
            recovery: run.recovery,
          },
        },
      });
  });
}

export function recoverUnreportedSources(db, now) {
  // Upgrade only the specific app-generated failure. CAPTCHA, explicit failures
  // and a user's paused workspace remain untouched.
  for (const a of db.list().filter((a) => a.status === 'enabled'))
    for (const state of Object.values(a.sourceState ?? {})) {
      if (!state.blocked || !state.lastRunId || !legacyMessages.has(state.lastResult)) continue;
      const run = db.run(state.lastRunId);
      if (run.status !== 'failed') continue;
      if (
        a.retryPlan?.[run.sourceUrl] ||
        db.runs(a.id).some((r) => r.sourceUrl === run.sourceUrl && r.status === 'running')
      )
        continue;
      const outcome = unreportedSourceRun(db, a.id, run.id, 'legacy_unreported', now);
      if (!outcome) continue;
      const recovered = {...db.run(run.id), ...outcome};
      db.putRun(recovered);
      if (outcome.status === 'blocked')
        db.store.workspaces.tasks.finish(a.id, run.taskId, 'blocked', outcome.summary);
      else requeueSourceRun(db, recovered);
    }
}

export function unreportedInterviewRun(db, id, runId) {
  const run = db.run(runId);
  if (run.kind !== 'interview') return null;
  const pending = (db.get(id).questions ?? []).filter(
    (q) =>
      q.answer == null &&
      q.createdAt >= run.startedAt &&
      (q.runId ? q.runId === runId : !q.recordId && !q.sourceUrl),
  );
  if (!pending.length) return null;
  return {status: 'completed', summary: 'Setup questions saved; waiting for your form answers.'};
}
