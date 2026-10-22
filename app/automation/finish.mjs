// @ts-check
import {taskHasRecord} from '../records/task-scope.mjs';
import {
  validateWorkCompletion,
  hasUnblockedScanWork,
  scanWorkVerified,
} from '../sources/scan-work.mjs';
import {scanCheckpoint} from '../sources/automation-scan.mjs';
import {sourceScan} from '../sources/scan-issues.mjs';
import {validateLoginQuestion, LOGGED_IN_FIELD} from './login-question.mjs';
import {OUTCOME_FIELD} from './question-forms.mjs';
import {sourceStop} from './stop.mjs';
import {holdForTechnicalRetry} from './recovery.mjs';
import {searchLearning, searchLearningSummary} from '../sources/search-learning.mjs';
import {recipeNeedsTerms} from '../sources/recipe.mjs';
import {recordBlocker} from '../records/blockers.mjs';

// finish_automation_run: check that the reported status is backed by the saved
// task state, ask the user what only they can answer, then report the run.
export function finishAutomationRun({
  db,
  id,
  run,
  active,
  automation,
  args,
  collecting,
  snapshot,
  report,
}) {
  const status = args.status;
  // Checked first: a refused finish must not leave questions or stops behind.
  const blocker = active.recordOperation ? recordBlocker(status, args.blocker) : null;
  if (collecting && status === 'completed' && !active.scan?.complete)
    throw Error(
      'CLI pages and the Jev/agent review are not finished; continue with collect_source_page.',
    );
  if (
    sourceScan(active) &&
    args.stop?.kind === 'access' &&
    ['blocked', 'failed'].includes(status)
  ) {
    const sites = new Set(
      db.jevTasks.list(id, active.taskId ?? run.id).flatMap((t) =>
        t.items
          .filter((i) => i.error === 'access_barrier')
          .map((i) => i.blockedSite)
          .filter(Boolean),
      ),
    );
    if (active.siteWait) sites.add(active.siteWait.site);
    if (sites.size && hasUnblockedScanWork(active, sites))
      throw Object.assign(
        Error(
          'The access blocker applies only to the reported sites. Other sites have pending listings or searches; process them and leave the blocked addresses in the pending queue.',
        ),
        {code: 'JEV_WORK_REMAINS'},
      );
  }
  // The collector reported a search value it cannot write: the next round
  // learns it in a trial, so the run ends without a technical retry.
  if (collecting && active.searchLearning && status !== 'completed')
    return report(id, run.id, 'interrupted', searchLearningSummary(active.searchLearning), false);
  // A learning trial ends only with the recipe learned for the value.
  const learning = active.kind === 'trial' ? searchLearning(automation, active.sourceUrl) : null;
  if (learning && status === 'completed')
    throw Error(
      `This trial learns how the site writes the ${learning.field} "${learning.value}". Save the recipe with save_source_recipe first (see assignedSource.searchLearning), or report the trial blocked with what you observed.`,
    );
  // A trial of a search without terms ends only with the terms chosen.
  if (
    active.kind === 'trial' &&
    status === 'completed' &&
    recipeNeedsTerms(automation.sourceSettings?.[active.sourceUrl]?.recipe)
  )
    throw Error(
      'This source has no search terms yet. Choose up to 5 from the profile’s target roles, in the form siteSearch.notes describes when present, and save them with save_source_recipe terms before you complete the trial.',
    );
  const stop =
    collecting && active.collectorError && ['failed', 'blocked'].includes(status)
      ? {kind: 'technical', evidence: active.collectorError, issueIds: []}
      : sourceStop(active, args);
  // A login form on the last observed page is an app-verified barrier: the
  // app asks the user itself instead of judging the agent's summary text.
  let loginAsked = false;
  if (
    ['blocked', 'failed'].includes(status) &&
    active.kind !== 'interview' &&
    snapshot &&
    !(automation.questions ?? []).some(
      (q) =>
        q.answer == null &&
        q.accessCheck?.kind === 'login' &&
        (active.recordId
          ? taskHasRecord(active, q.recordId)
          : !q.recordId && q.sourceUrl === active.sourceUrl),
    )
  ) {
    let accessCheck = null;
    try {
      accessCheck = validateLoginQuestion(snapshot, {
        kind: 'login',
        snapshotId: snapshot.id,
        evidence: stop?.evidence,
      });
    } catch {}
    if (accessCheck) {
      db.askQuestion(
        id,
        {
          text: args.summary,
          accessCheck: {...accessCheck, checkedAt: db.now()},
          fields: [LOGGED_IN_FIELD],
          ...(active.recordId ? {recordId: active.recordId} : {}),
        },
        {runId: run.id},
      );
      loginAsked = true;
    }
  }
  // An execute or verify that ends without portal proof leaves the record
  // uncertain, and most portals never show a draft state. The user knows the
  // outcome (confirmation mail, portal account); the app asks once and applies it.
  if (
    ['blocked', 'failed'].includes(status) &&
    ['execute', 'verify'].includes(active.recordOperation) &&
    active.recordId &&
    !loginAsked
  ) {
    const item = db.result(id, active.recordId),
      uncertain =
        item.status === 'uncertain' || (item.status === 'executing' && active.actionId === item.id);
    // A CAPTCHA after the submit click: the user must act first, so say so up front.
    const challenge = Boolean(db.run(run.id)?.submission?.verification),
      // A code sent to the user's email or phone after the submit click.
      code = !challenge && blocker?.category === 'needs_code';
    if (
      uncertain &&
      !(automation.questions ?? []).some((q) => q.recordId === item.id && q.answer == null)
    )
      db.askQuestion(
        id,
        {
          text: challenge
            ? `${item.title ?? item.url}: a verification (CAPTCHA) appeared on the page after submitting. Solve it in the open tab in Chrome. Then choose "${OUTCOME_FIELD.options[0]}" if a confirmation message appears, or "${OUTCOME_FIELD.options[1]}" if the form is still there.\nAgent note: ${String(args.summary ?? '').slice(0, 1500)}`
            : code
              ? `${item.title ?? item.url}: the site sent a security code to your email or phone after submitting. Enter the code in the open tab in Chrome. Then choose "${OUTCOME_FIELD.options[0]}" if a confirmation message appears, or "${OUTCOME_FIELD.options[1]}" if the form is still there.\nAgent note: ${String(args.summary ?? '').slice(0, 1500)}`
              : `The submission result for ${item.title ?? item.url} could not be verified.\nAgent note: ${String(args.summary ?? '').slice(0, 1500)}`,
          recordId: item.id,
          fields: [
            challenge
              ? {
                  ...OUTCOME_FIELD,
                  label: 'After solving the verification: was this record submitted?',
                }
              : code
                ? {...OUTCOME_FIELD, label: 'After entering the code: was this record submitted?'}
                : OUTCOME_FIELD,
          ],
          outcome: true,
          ...(challenge ? {verification: true} : {}),
          ...(code ? {code: true} : {}),
        },
        {runId: run.id},
      );
  }
  if (
    status === 'completed' &&
    active.siteWait &&
    db.siteAccess.forWait(active.siteWait).status('https://' + active.siteWait.site)
  )
    throw Error('A shared wait for this site is in progress; report this round as blocked.');
  if (active.kind === 'trial' && !active.browserSteps)
    throw Error(
      'This trial has not checked the source yet. First check current access with browser_open. The previous trial’s blocker report is not evidence for this round.',
    );
  if (status === 'completed' && active.kind === 'run' && active.sourceUrl && !active.recordId) {
    if (Object.keys(active.scanIssues ?? {}).length)
      throw Error(
        'There are unresolved page issues. Reopen these addresses with browser_open; if they do not load, report failed and the app retries later.',
      );
    // The verified searches decide; agents that saw pages beyond the page
    // budget reported complete:false and were refused in a loop.
    const scan = scanWorkVerified(active)
      ? {...active.scan, complete: true, pendingUrls: []}
      : scanCheckpoint(active, args.scan);
    if (!scan.complete && args.goalReached)
      throw Error('An incomplete scan cannot report the goal as reached');
    if (!scan.complete)
      throw Error(
        'The source scan is not finished. There is no time or step limit; keep processing the remaining pages in the same task and close it with complete_scan_search. Report a real access blocker as blocked.',
      );
    scan.completion = validateWorkCompletion(active, scan);
    if (scan.completion === 'cutoff' && args.goalReached)
      throw Error(
        'Reaching the date cutoff of a new-listing check does not mean the automation goal is finished.',
      );
    db.putRun({...active, scan});
  }
  if (stop?.kind === 'technical') {
    const retry = holdForTechnicalRetry(db, id, run.id, {
      stop,
      urls: Object.values(db.run(run.id).scanIssues ?? {})
        .filter((i) => stop.issueIds.includes(i.id))
        .map((i) => i.url),
      summary: args.summary,
    });
    if (retry) return report(id, run.id, retry.status, retry.summary, false);
  } else if (stop) db.putRun({...db.run(run.id), stop});
  if (active.recordOperation && run.taskId) {
    const queue = db.store.workspaces.tasks,
      task = queue.get(id, run.taskId);
    if (task && (blocker || task.blocker)) queue.put({...task, blocker});
  }
  // Kept on the run as well, for the application failure report.
  if (blocker) db.putRun({...db.run(run.id), blocker});
  return report(id, run.id, status, args.summary, args.goalReached === true);
}
