// @ts-check
// What a source scan is doing right now, for the Sources page: the app reading
// a results page, posting 3 of 7 or waiting for the site's pace, or the
// agent's current step. RAM only: it describes the moment and is gone after a
// restart.
const activity = new Map();

export const sourceActivity = (runId) => activity.get(runId) ?? null;

// Merges a step into the run's activity; null clears it.
export function noteSourceActivity(runId, step, now = Date.now()) {
  // Runs that ended long ago leave their last step behind; drop those.
  for (const [id, entry] of activity) if (now - entry.at > 6 * 60 * 60000) activity.delete(id);
  if (!step) activity.delete(runId);
  else activity.set(runId, {...sourceActivity(runId), ...step, at: now});
}

// The agent's step in plain words, as the Sources page shows it.
const OPERATIONS = {
  prepare_search: 'preparing the search',
  scan_results: 'reading a results page',
  classify_results: 'sorting the results',
  collect_details: 'reading listings',
  fill_form: 'filling a form',
};
const STEPS = {
  browser_navigate: 'opening a page',
  browser_open: 'opening a page',
  browser_read: 'reading the page',
  browser_read_part: 'reading the page',
  browser_snapshot: 'reading the page',
  browser_observe: 'reading the page',
  browser_search: 'searching the web',
  read_listing_brief: 'reading listing summaries',
  read_listing_evidence: 'checking a listing detail',
  read_browser_task: 'checking the batch',
  record_automation_results: 'saving scores',
  record_automation_result: 'saving a score',
  collect_source_page: 'taking the next batch',
  complete_scan_search: 'finishing a search',
  save_source_recipe: 'saving the search recipe',
  read_scoring_profile: 'reading the profile',
  read_automation_context_part: 'reading the task notes',
  ask_workspace_question: 'asking you a question',
  finish_automation_run: 'finishing the run',
};
export function agentStepLabel(tool, args = {}) {
  if (tool === 'browser_run_task')
    return args?.reviewedBatchId
      ? 'continuing after the batch review'
      : (OPERATIONS[args?.operation] ?? 'reading pages');
  return (
    STEPS[tool] ??
    tool
      .replace(/^browser_/, '')
      .replace(/_/g, ' ')
      .trim()
  );
}
