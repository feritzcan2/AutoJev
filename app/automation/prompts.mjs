// @ts-check
import {batchScoring} from '../records/task-scope.mjs';
import {COLLECTOR_INSTRUCTIONS, COLLECTOR_RESUME} from '../sources/collector-worker.mjs';
import {isConversation} from '../workspaces/conversation.mjs';
import {JEV_LAUNCH_INSTRUCTIONS, AGENT_LAUNCH_INSTRUCTIONS} from '../jev/task-tools.mjs';
import {SCAN_SEARCH_LISTINGS, SCAN_SEARCH_PAGES} from '../sources/recipe.mjs';
import {SOURCE_PAGE_INSTRUCTIONS} from '../sources/scan.mjs';
import {COVER_LETTER_PROMPT} from './cover-letters.mjs';
import {contactPrompt} from './contacts.mjs';

// agentDecides: the workspace lets the agent make the listing decisions (no Jev model).
export function automationPrompt(
  run,
  request = null,
  {evidenceExpired = false, agentDecides = false} = {},
) {
  if (run.recordOperation === 'cover_letter') return COVER_LETTER_PROMPT;
  if (run.recordOperation === 'contacts') return contactPrompt(run);
  if (run.collector && run.kind === 'run' && !run.recordId)
    return (
      'Read AGENTS.md and get_automation_context. ' +
      (agentDecides ? '' : jevProfilePrompt) +
      (run.continuation && run.continuation.resumeConversation !== false ? COLLECTOR_RESUME : '') +
      COLLECTOR_INSTRUCTIONS
    );
  const refresh =
    evidenceExpired && !isConversation(run)
      ? 'The app restarted. Continue from the saved task checkpoint and answers. Earlier Jev task IDs, evidence IDs, snapshots and browser control handles have expired. Read get_automation_context, then observe the assigned retained tab once for current content and handles without reloading it. Start new Jev reading tasks for pending details; read pages again before relying on their content. Preserve entered form values and completed work; do not repeat completed searches.\n\n'
      : '';
  const prompt = refresh + baseAutomationPrompt(run, request, agentDecides);
  return !isConversation(run) && !batchScoring(run)
    ? prompt + '\n\n' + (agentDecides ? AGENT_LAUNCH_INSTRUCTIONS : JEV_LAUNCH_INSTRUCTIONS)
    : prompt;
}
const jevProfilePrompt =
  'If get_automation_context shows jevProfile.status missing or stale, write it first with save_jev_profile, then continue. ';
const sourceMethodPrompt = (agentDecides, trial = false) =>
  (agentDecides ? '' : jevProfilePrompt) +
  'Read assignedSource.instructions and assignedSource.recipe. When assignedSource.recipeReplay is present start there and run its searches one after another: for url_template call browser_run_task scan_results with each search url; ' +
  (agentDecides
    ? 'for search_form open the search url, enter its answers yourself with browser_interact and submit, then call scan_results on the resulting page. '
    : 'for search_form call prepare_search at the search url with its answers, then scan_results on the resulting page. ') +
  // complete_scan_search belongs to scheduled scans; a trial has no search queue.
  (trial
    ? 'Check the searches one after another. '
    : 'Finish one search before starting the next: when its queue is empty call complete_scan_search; the app then makes the next search active and names its url. ') +
  'Do not look for the results page yourself while a replay exists. Without a replay, use the managed browser to search with the current workspace criteria and assigned source query. ';
const recipePrompt = (agentDecides) =>
  'Before finishing a completed trial save the search recipe with save_source_recipe: url_template with {query} (and {location} if the site has it) or search_form with the field labels. When assignedSource.siteSearch is present, build the recipe from its template and filters and skip exploring the board controls. Otherwise use the newest-first sort of the board by default whenever it offers one (a date sort option or parameter you observed), so each scan reads the newest listings first and later scans stop at already known listings. Sort controls are often dropdowns near the result count: scan_results reports them in lastPage.controls with their option names, and on an open page controls with nativeSelect:true or role combobox list theirs with browser_interact options. Check them before concluding that the board has no date order. Also apply the board filters for anything the criteria or saved profile make decisive, such as a listing language the user cannot work in, an excluded workplace type or seniority, when the board offers them in the results address or search form; name each filter in notes and check that the filtered results still hold matching listings. Each search reads at most ' +
  `${SCAN_SEARCH_PAGES} result pages and ${SCAN_SEARCH_LISTINGS} new listings, so pick specific terms. ` +
  'When the source query is a description rather than a search keyword, add terms: up to 5 concrete keywords from the criteria that the site accepts; the app fills {query} with each term. Choose specific terms the board matches, such as exact titles or categories, rather than one generic word that returns hundreds of pages. ' +
  (agentDecides
    ? 'The app verifies the recipe from the listings you selected in a scan_results task at its first search address: run that scan and select its listings before saving. Save a url_template; a search form cannot be replayed with agent decisions. '
    : 'The app checks the recipe with Jev and reports the result; correct and retry on failure. ') +
  'Only when no stable method exists save entry.kind=discovery with a short note. ';
// Users do not know which board filters exist; scans that keep rejecting
// listings for one decisive reason add the matching filter to the recipe.
const recipeFilterPrompt =
  'Before finishing, if this scan rejected most listings for the same decisive reason (for example a listing language the user cannot work in or an excluded workplace type) and the board offers a filter for it in the results address or search form, save the recipe again with save_source_recipe adding that filter and naming it in notes, so later scans skip those listings. ';
function sourceTrialPrompt(run, agentDecides) {
  return (
    'This is a new access check. Previous runs are historical context, not current evidence. This turn checks only the assigned source; do not scan other sources. ' +
    sourceMethodPrompt(agentDecides, true) +
    recipePrompt(agentDecides) +
    'Check search results and a representative detail. Full scan coverage is not required during a trial: scan_results reads at most two result pages per scan here, and pageLimitReached means the board continues. Never enter personal/contact data or send applications, messages, payments or bookings in a trial. Use browser_interact to accept cookie overlays and terms-of-service gates (see the site access gate rule), and for search, filters, scrolling and pagination, and browser_read, browser_search and browser_read_part for observed details. Report a tool permission problem only when an actual tool call returns a permission error; include that error in the report. A site_wait response is current application evidence: report blocked with its retry time; do not force another request or ask the user to fix an automatic wait. Do not finish by repeating an earlier blocker without checking it in this turn. If access is still blocked, report the current evidence and stop.'
  );
}
function baseAutomationPrompt(run, request = null, agentDecides = false) {
  if (batchScoring(run))
    return 'Read AGENTS.md and get_automation_context. This is one batch scoring task. Read assignedRecords, assignedOperation, recordAuthorization, criteria.ranking and saved profile/documents once, then assess only records with scoredInThisTask=false. Earlier saved scores from this same task are complete and must not be repeated. For an assigned record with savedListing (text the site reader returned) score from that snapshot with browser_read_part/browser_search and do not open its page; for the others use browser_run_task collect_details with their URLs and read each relevant Jev brief, or read listing details directly. Keep retained forms intact; use the separate batch reading tab. Save a separate record_automation_score with explicit itemId for every assigned record; use score=null with the reason when a record cannot be assessed. Ask genuinely missing facts with the relevant recordId and continue the other selected records. Do not scan sources, score unrelated records, alter proposals, fill or submit forms. Do not finish after the first score. After every assigned record has a saved assessment or record-scoped question, call finish_automation_run with a short batch summary.';
  if (isConversation(run))
    return (
      (request
        ? 'Current user request (JSON):\n' + JSON.stringify(request) + '\n\n'
        : 'The user opened the workspace conversation. Ask briefly what they want to discuss.\n\n') +
      'Read AGENTS.md and get_automation_context once at session start. This is the persistent independent workspace conversation, starting with initial setup and continuing in the same provider session. If conversation.setupComplete is false, lead setup proactively; otherwise continue the user’s current request. Keep this session open until the user closes it. Do not preload old messages or summaries, even on a fresh session. Use get_workspace_history only when this request needs historical evidence. Later messages arrive directly in this session: use your conversation history and do not reread context unless the app reports a profile change or the request needs current data. Answer simple follow-ups directly. Look up only relevant records; do not enumerate the whole table for an ordinary question. Other workers continue running. save_automation_plan saves the initial unapproved profile during onboarding, or a separate draft for review once setup is complete. Save each answer with reply_to_user, then call finish_automation_run to mark the reply complete and wait for the next user message; this does not close the session.'
    );
  return `Read AGENTS.md and get_automation_context. ${run.continuation ? (run.continuation.resumeConversation === false ? 'This is a fresh conversation for saved source work. Continue from the persisted searches, pending queue, checkpoint, source instructions and saved answers. Raw page text and Jev helper tasks are RAM-only; after an app restart read pending details again with new helper tasks. Do not reload the old transcript or repeat completed searches. Observe any retained tab once to obtain current tool handles and recheck earlier blockers. ' : run.continuation.reason === 'source_retry' ? 'Resume the same source conversation after the previous scan stopped. The app has started a new task for this source; continue its saved checkpoint and retained tabs. Recheck any earlier blocker using current evidence. ' : run.continuation.reason === 'task_retry' ? 'Continue the same unfinished task and conversation using the saved checkpoint. Earlier tool handles are stale: get current task context and observe the retained tab once; do not reread unchanged documents or repeat completed work. ' : "The user answered your saved question. Continue that task using the current saved answers; an answer marked instruction is the user's instruction for this task. Earlier finish_automation_run calls ended earlier turns, not this one. ") : ''}${run.kind === 'run' && run.sourceUrl && !run.recordId && !run.recordOperation ? 'Read the current assignedSource, criteria, questions and answers, scanPlan and scanProgress from get_automation_context before browsing. These saved records are authoritative over conversation history. If scanProgress has unfinished work, continue its saved queue; otherwise start the current scan at the newest results and follow its full/incremental plan and cutoff. Earlier task IDs, tool handles, snapshots and finish_automation_run calls belong to earlier turns. Previous completion, login and blocker reports are historical context, not current evidence: observe the source in this turn and verify its current state. Do not infer that this scan is finished or blocked from the previous conversation. ' : ''}${run.recordOperation ? 'This is a record ' + run.recordOperation + ' task, independent of source scan coverage. Read assignedRecord, assignedOperation, template guidance and recordAuthorization. Follow assignedOperation.successCriteria. Do not scan the source or act on other records. Old login questions and answers such as refresh/recheck are historical context, not proof of a current barrier. With Jev, first call browser_tabs and reuse the retained tab for this assigned record with browser_use_tab. Inspect its current state without reloading, preserve entered form values, and continue there. Only open the assigned listing and follow its actual entry control when no retained record tab exists. Do not open another copy of an existing form. A signup URL or hidden/stale login link alone does not establish that the user is logged out. For scoring, when get_automation_context has savedListing with readBy, that is the listing text the site reader returned: score from it with browser_read_part/browser_search and skip the tab and page steps above. Otherwise read the Jev brief (or the record details when no brief is available). Read the current profile/documents, follow criteria.ranking and save record_automation_score. If a retained tab contains an unfinished form, keep it intact and inspect the listing separately. Never fill or submit a form or change the proposal during scoring. For preparation ask missing facts with this recordId and finish; the form answer resumes preparation. For execution, directExecution in recordAuthorization authorizes inspection, saving the complete proposal and submission in this same task without a prior preparation task or separate draft review; follow that rule over saved-proposal-only instructions. Otherwise complete the application from the saved proposal without asking again. Call reserve_automation_action right before the final submit click and record_automation_outcome after observing confirmation. For verification never send again. If the portal explicitly marks this exact record as a draft/not submitted or rejected before submission, use record_automation_outcome not_submitted with current status and identity evidence, then finish completed. An unfinished form or absent success message alone is inconclusive. ' : ''}Execute only this ${run.kind} turn, operation ${run.operation ?? run.kind}. ${
    run.kind === 'interview'
      ? 'Lead setup proactively: identify missing decisions, research and recommend sources even if none are saved, save the draft, and ask the next concrete question or direct the user to review.'
      : run.kind === 'trial'
        ? sourceTrialPrompt(run, agentDecides)
        : 'Follow assignedOperation instructions and work only on assignedRecord when present, otherwise assigned sources. ' +
          (run.sourceUrl && !run.recordId
            ? sourceMethodPrompt(agentDecides) + SOURCE_PAGE_INSTRUCTIONS + ' ' + recipeFilterPrompt
            : '') +
          'Resume saved pending URLs and scan progress before new discovery. Dependent steps belong to separate queue tasks; do not execute them in this turn.'
  } Use the automation tools. Save user-facing messages with reply_to_user and finish with finish_automation_run.`;
}
