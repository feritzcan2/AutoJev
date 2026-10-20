// @ts-check
import {createHash} from 'node:crypto';
import {jobUrlKey} from './job-urls.mjs';
import {batchScoring, taskHasRecord} from './task-scope.mjs';

const LIMIT = 3,
  ARGUMENT_LIMIT = 6;
const operationNames = {
  score: 'Scoring',
  prepare: 'Preparation',
  execute: 'Execution',
  verify: 'Verification',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const category = (message) =>
  /arguments[.:\[]/.test(message)
    ? 'arguments'
    : /scorecard|candidateQuote|listingQuote/.test(message)
      ? 'scorecard'
      : /page observation is stale/i.test(message)
        ? 'snapshot'
        : /is not an assigned record ID/.test(message)
          ? 'record_id'
          : /is not a Jev task ID/.test(message)
            ? 'task_id'
            : null;
const recoveryHint = (kind) =>
  kind === 'arguments'
    ? 'Fix all listed field errors in one call; resend the full arguments, keeping the other valid fields. You do not need to read the page again for this error.'
    : kind === 'scorecard'
      ? 'Use the current tool schema and the scoringPolicy section; fix the missing fields in one go.'
      : kind === 'snapshot'
        ? 'Continue with savedListing from the current context or the latest snapshot.id; if there is no saved text, use browser_read.'
        : kind === 'record_id'
          ? 'Copy itemId exactly from the list of assigned records not yet scored.'
          : kind === 'task_id'
            ? 'Copy a taskId from the Current Jev tasks list or a browser_run_task result; do not guess one.'
            : 'Do not repeat the same operation without fixing the cause of the error.';
function operationKey(run, name, args) {
  let target = run.recordId;
  // Each batch row counts its own failures; one row cannot stop the others.
  if (name === 'record_automation_score' && batchScoring(run) && taskHasRecord(run, args?.itemId))
    target = args.itemId;
  if (name.startsWith('browser_')) {
    const url = args?.url ?? run.resumeContext?.url;
    if (url) {
      try {
        target = jobUrlKey(url);
      } catch {
        target = String(url);
      }
    }
  }
  return hash(JSON.stringify([name, target, name === 'browser_interact' ? args?.action : null]));
}

// The task owns the counters, so rebuilding a workflow or resuming an
// interrupted run cannot reset them. Only this operation succeeding clears it.
export function recordToolGuard({db, run, report, changed}) {
  const id = run.automationId,
    queue = db.store.workspaces.tasks;
  let pending = Promise.resolve();
  const saveFailure = (name, operation, error) => {
    const active = db.run(run.id);
    if (active.status !== 'running') return error.message;
    const message = String(error.message).trim().replace(/\s+/g, ' ').slice(0, 2000),
      key = hash(operation + '\n' + message);
    // A wrong Jev task ID is a slip of one agent session that the error text
    // corrects; it counts per run, so fresh sessions of a retried task do not
    // add up to a stop.
    const kind = category(message),
      failureKey = kind
        ? hash(name + '\n' + kind + (kind === 'task_id' ? '\n' + run.id : ''))
        : key;
    const task = queue.get(id, run.taskId),
      failures = {...task.toolFailures},
      count = (failures[failureKey]?.count ?? 0) + 1;
    failures[failureKey] = {operation, tool: name, message, count, category: kind};
    let summary;
    // A wrong argument name is the agent misreading the schema, not a page or
    // record problem: it gets the schema hint and twice the room before the
    // task stops.
    const limit = kind === 'arguments' ? ARGUMENT_LIMIT : LIMIT;
    queue.atomic(() => {
      queue.put({...task, toolFailures: failures});
      if (count >= limit) {
        const failure = {tool: name, message, count, runId: run.id, at: db.now()};
        summary = `${operationNames[run.recordOperation] ?? (run.sourceUrl ? 'Source scan' : 'Record operation')} stopped: the same operation failed ${limit} times with the same kind of error. Last error: ${message}`;
        queue.put({...queue.get(id, run.taskId), toolFailure: failure});
        db.putRun({
          ...db.run(run.id),
          toolFailure: failure,
          stop: {kind: 'technical', evidence: message},
        });
        db.message(id, 'system', summary, {runId: run.id, recordId: run.recordId});
      }
    });
    if (summary) {
      report(id, run.id, 'blocked', summary, false);
      changed(id);
      return summary + ' The task was stopped; do not call any other tool.';
    }
    if (kind === 'arguments')
      return `${message}\nArgument error ${count}/${limit}. ${recoveryHint(kind)} Use only the field names in the tool schema (browser_interact: operation, ref, text, option, key). The task stops at error ${limit}.`;
    return `${message}\nThe same operation failed ${count}/${limit} times with the same kind of error. ${recoveryHint(kind)} The task stops automatically at the third error.`;
  };
  const call = async (name, args, execute) => {
    name = typeof name === 'string' ? name : 'unknown';
    const active = db.run(run.id),
      task = queue.get(id, run.taskId);
    if (task.toolFailure)
      throw Error(
        'The task was stopped because of a repeated error. Check the error description on the source or record task.',
      );
    if (active.status !== 'running') throw Error('The task is no longer running.');
    const operation = operationKey(active, name, args);
    let value;
    try {
      value = await execute();
    } catch (error) {
      if (['JEV_REVIEW_REQUIRED', 'JEV_WORK_REMAINS'].includes(error?.code)) throw error;
      // DOMException.message is read-only. Keep its cause/code without masking
      // the actual timeout or transport failure with an assignment TypeError.
      const wrapped = new Error(
        saveFailure(name, operation, error instanceof Error ? error : Error(String(error))),
        {cause: error},
      );
      for (const key of ['code', 'validationPath', 'validationIssues', 'siteWait', 'wait', 'url'])
        if (error?.[key] !== undefined)
          Object.defineProperty(wrapped, key, {value: error[key], enumerable: true});
      throw wrapped;
    }
    // A rejected submission proof carries a fresh snapshot for recovery rather
    // than throwing. It is still a failed save and must obey the same limit.
    if (value?.status === 'evidence_rejected' && value.saved === false)
      return {...value, message: saveFailure(name, operation, Error(value.error))};
    if (value?.status === 'running') return value;
    const latest = queue.get(id, run.taskId),
      failures = latest.toolFailures;
    if (failures)
      queue.put({
        ...latest,
        toolFailures: Object.fromEntries(
          Object.entries(failures).filter(
            ([, f]) => f.operation !== operation && !(f.category && f.tool === name),
          ),
        ),
      });
    return value;
  };
  // Serialize this record's MCP calls: parallel retries must not execute a
  // fourth failing operation before the third response closes the worker.
  return (name, args, execute) => {
    const next = pending.then(() => call(name, args, execute));
    pending = next.catch(() => {});
    return next;
  };
}
