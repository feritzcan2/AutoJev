// @ts-check
// Judges each open Jev tab against the rules that close tabs when work ends.
//   keep  - the tab still has work: a running run, a question, a form or a check
//   leak  - a rule should already have closed it
//   stale - kept on purpose, but no queued work will ever close it
const FORM_WAITING = ['prepared', 'executing', 'uncertain'];
const FINAL_RECORD = ['completed', 'dismissed'];

/**
 * @param {any} tab one entry of BrowserTools.tabAudit()
 * @param {{
 *   run: (id: string) => any,
 *   record: (id: string) => any,
 *   waiting: (runId: string, tabId: string) => boolean,
 *   openTask: (run: any) => boolean,
 *   newerFinishedSourceRun: (run: any) => any,
 * }} lookup
 */
export function judgeTab(tab, lookup) {
  const verdict = (state, reason) => ({verdict: state, reason});
  if (tab.role === 'home') return verdict('keep', 'home');
  if (tab.role === 'spare')
    return tab.url === 'about:blank'
      ? verdict('keep', 'spare')
      : verdict('leak', 'spare_not_blank');
  if (!tab.runId) return verdict('stale', 'no_run_label');
  if (tab.runId === 'user') return verdict('keep', 'user_tab');
  const run = lookup.run(tab.runId);
  if (!run) return verdict('leak', 'run_missing');
  if (run.status === 'running') return verdict('keep', 'run_running');
  if (lookup.waiting(run.id, tab.tabId)) return verdict('keep', 'question');
  if (tab.verification) return verdict('keep', 'verification');
  const recordId = tab.recordId ?? run.recordId;
  if (recordId) {
    const record = lookup.record(recordId);
    if (!record) return verdict('leak', 'record_missing');
    if (FINAL_RECORD.includes(record.status)) return verdict('leak', `record_${record.status}`);
    if (FORM_WAITING.includes(record.status)) return verdict('keep', `record_${record.status}`);
    if (lookup.openTask(run)) return verdict('keep', 'record_task_open');
    return verdict(
      run.status === 'completed' ? 'leak' : 'stale',
      `record_${record.status}_run_${run.status}`,
    );
  }
  if (run.sourceUrl) {
    const newer = lookup.newerFinishedSourceRun(run);
    if (newer) return verdict('leak', `newer_source_run_${newer.status}`);
    if (run.status === 'completed' && (run.kind === 'trial' || run.scan?.complete))
      return verdict('leak', 'source_finished');
    return verdict('keep', `source_resume_${run.status}`);
  }
  if (lookup.openTask(run)) return verdict('keep', 'task_open');
  return verdict(run.status === 'completed' ? 'leak' : 'stale', `run_${run.status}`);
}

// An unfinished application (blocked, failed, interrupted) with no queued
// task and no question keeps its tabs this long for the user, then they close.
export const STALE_RECORD_TAB_MS = 3 * 3600000;

// Records whose tabs can close: their work ended for good (skipped, marked
// applied, deleted), or it stopped and nothing has picked it up since
// STALE_RECORD_TAB_MS. A record any of whose tabs a running run, a question or
// a verification check still holds keeps all of them.
export function closableRecordIds(tabs, lookup, now = Date.now()) {
  const closable = new Set(),
    held = new Set();
  for (const tab of tabs) {
    if (tab.role !== 'task') continue;
    const run = tab.runId ? lookup.run(tab.runId) : null,
      recordId = tab.recordId ?? run?.recordId;
    if (!recordId) continue;
    if (
      run?.status === 'running' ||
      (run && lookup.waiting(run.id, tab.tabId)) ||
      tab.verification
    ) {
      held.add(recordId);
      continue;
    }
    const record = lookup.record(recordId);
    if (!record || FINAL_RECORD.includes(record.status)) closable.add(recordId);
    else if (
      run &&
      !FORM_WAITING.includes(record.status) &&
      !lookup.openTask(run) &&
      now - (run.finishedAt ?? now) >= STALE_RECORD_TAB_MS
    )
      closable.add(recordId);
    else held.add(recordId);
  }
  return [...closable].filter((id) => !held.has(id));
}
