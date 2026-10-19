// @ts-check

import {jevReviewRequired} from './review.mjs';
import {listingFirst} from './results.mjs';
import {JEV_CLASSIFICATION_VERSION} from './triage.mjs';
import {
  JEV_REVIEW_INSTRUCTIONS,
  AGENT_REVIEW_INSTRUCTIONS,
  AGENT_LINK_INSTRUCTIONS,
  AGENT_PAGINATION_INSTRUCTIONS,
} from './task-tools.mjs';
// Version of results-page discovery recorded on scan tasks.
export const DISCOVERY_VERSION = 3;

// What a Jev task reports back to the parent agent and the task context.
const compactItem = (item) => ({
  url: item.url,
  title: item.title,
  evidenceId: item.evidenceId ?? null,
  ...(item.discoveryEvidenceId ? {discoveryEvidenceId: item.discoveryEvidenceId} : {}),
  ...(item.discovery ? {discovery: item.discovery} : {}),
  ...(item.detailComplete === false ? {detailComplete: false} : {}),
  ...(item.assessment ? {assessment: item.assessment} : {}),
  ...(item.pageKind ? {pageKind: item.pageKind} : {}),
  ...(item.scanTaskId ? {scanTaskId: item.scanTaskId, scanStatus: item.scanStatus} : {}),
  ...(item.error
    ? {error: item.error, retryAt: item.retryAt ?? null, blockedSite: item.blockedSite ?? null}
    : {}),
  ...(item.unreadFrames ? {unreadFrames: item.unreadFrames} : {}),
});
const triageRefresh = (task) =>
  ['collect_details', 'classify_results'].includes(task.input.operation) &&
  task.classificationVersion !== JEV_CLASSIFICATION_VERSION &&
  task.items.some((i) => i.collected && i.assessment);
export function jevContextTasks(tasks, searchId = 'default') {
  const priority = (t) =>
    ((t.searchId ?? 'default') === searchId ? 0 : 10) +
    (t.batch ? 0 : ['collect_details', 'classify_results'].includes(t.input.operation) ? 1 : 2);
  return [...tasks]
    .sort((a, b) => priority(a) - priority(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 20)
    .map((t) => ({
      taskId: t.id,
      operation: t.input.operation,
      status: t.status,
      total: t.items.length,
      searchId: t.searchId,
      usage: t.usage,
      ...(t.batch ? {batch: {id: t.batch.id, total: t.batch.urls.length}} : {}),
      ...(triageRefresh(t) ? {assessmentRefreshRequired: true} : {}),
    }));
}
function taskNext(task) {
  if (task.issue?.reason === 'access_barrier')
    return 'The listed sites are blocked. Do not resume this helper or retry those sites before recovery; keep their URLs pending. Review previously collected real listings first. Continue other sites and saved searches with a new detail task. A blocked detail host does not block the whole assigned source when other reachable work remains. Only finish the source blocked after checking all remaining work; respect siteWait.retryAt.';
  if (triageRefresh(task))
    return 'These assessments use an older classifier. FIRST resume browser_run_task with this taskId to refresh classification from saved evidence and receive review batches. Do not read individual bodies or score the old assessments yet. Original evidence and queue entries are preserved; no browser reread is needed.';
  if (task.batch)
    return (
      (task.decisions === 'agent' ? AGENT_REVIEW_INSTRUCTIONS : JEV_REVIEW_INSTRUCTIONS) +
      ' Read read_listing_brief for relevant listings before final scoring; use read_listing_evidence only for missing or conflicting details. For missing details inspect the observed listing URL through the browser; keep unresolved facts uncertain.'
    );
  if (task.pageWork?.selection)
    return `${AGENT_LINK_INSTRUCTIONS} The pending choice: reviewedBatchId=${task.pageWork.selection.id}, items 1–${task.pageWork.selection.links.length}.`;
  if (task.pageWork?.paginationChoice)
    return `${AGENT_PAGINATION_INSTRUCTIONS} lastPage holds the observed pagination and position.`;
  if (task.issue?.reason === 'discovery_refresh_required')
    return 'This task contains links from an older ambiguous classifier. Its original work is preserved, but do not resume this task or read the whole board. Run NEW scan_results tasks at issue.urls with the current classifier, then collect_details using each NEW fromTaskId. Fresh scan checkpoints retire observed navigation links from the saved queue. Existing collected details/evidence remain usable.';
  if (
    task.input.operation === 'scan_results' &&
    task.status === 'completed' &&
    task.discoveryVersion !== DISCOVERY_VERSION
  )
    return `This historical scan uses an older link classifier. Run a NEW scan_results at ${task.input.url ?? task.currentUrl}, then collect_details with its new fromTaskId. Do not reopen every old candidate or read the whole board.`;
  if (task.status === 'continue') return 'Continue browser_run_task with this taskId only.';
  const unclassified =
    task.input.operation === 'collect_details' &&
    task.items.some(
      (i) =>
        i.evidenceId && i.detailComplete !== false && !i.assessment && i.pageKind !== 'results',
    );
  const classifySaved = `These saved details have not been classified. Call browser_run_task operation=classify_results with fromTaskId=${task.id} before reading listing bodies. Do not reopen already collected details.`;
  if (task.status === 'needs_agent') {
    const reason = task.issue?.reason;
    if (reason === 'search_control_missing')
      return 'This page has no search/filter action. To discover its visible listing links call browser_run_task operation=scan_results at currentUrl. For known listing URLs use collect_details with url/urls. Do not repeat prepare_search on this page.';
    if (
      [
        'pagination_uncertain',
        'no_listing_links',
        'no_progress',
        'pagination_action_unconfirmed',
      ].includes(reason)
    )
      return 'Inspect lastPage pagination/continuation first: observed URLs and guarded targetId/controlId are included. These IDs belong to that observation; after a page change obtain fresh controls before interacting. Read only a specific missing evidence fragment, never the whole board to recover pagination. This is not complete source coverage. Use an actual results/company-board URL or resolve the missing pagination control, then resume discovery. Collect relevant observed listing URLs with collect_details + urls; keep uncertain leads.';
    if (reason === 'page_changed')
      return 'The page moved to issue.url instead of issue.expected. On another host this is usually a sign-in, consent or verification page, not more results. Listings found before it stay queued; collect them. Resolve that page (a sign-in needs the user), then run a NEW scan_results at issue.expected; do not resume this task.';
    if (reason === 'search_not_verified')
      return 'The requested filters could not be verified. prepare_search only applies search inputs; use scan_results to discover listings already visible on the current board. Do not repeat prepare_search to extract listings.';
    if (reason === 'task_error')
      return 'Inspect issue.message for the exact provider or browser failure. Saved candidates, classifications and checkpoints remain available; a provider response error does not require rereading page text. Resume this same task only after resolving the failure; do not restart the whole scan or repeat unchanged failed input.';
    if (reason === 'discovery_required')
      return 'Review collected listings first. Results boards are deferred discovery leads, not listings. Read their saved evidence/index only if needed; select a relevant board explicitly with a separate scan_results task. Do not recursively expand every board, company filter or location variant. Unprocessed leads stay pending; this does not complete source coverage.';
    if (reason === 'details_deferred')
      return 'Deferred items remain in the parent pending queue and were not saved or rejected. Resolve their missing details before starting a NEW task for those URLs. Other collected results remain available; this is not complete source coverage.';
    if (reason === 'detail_unavailable')
      return (
        (unclassified
          ? classifySaved + ' '
          : task.decisions === 'agent'
            ? 'Other details were read, not judged; assess them from their read_listing_brief text. '
            : 'Other details were processed and automatically classified. Use their compact assessments; read relevant listing evidence for final assessment. ') +
        'Unavailable details have already had bounded read recovery. A page_not_ready item is incomplete content, not an unsuitable listing. For an assigned scoring record save status=unavailable, score=null and the reason; old record summaries cannot replace missing current details. Keep source-discovery URLs pending and honor each retryAt; do not create immediate retry tasks. Continue reachable details. Results pages are deferred discovery leads: choose any relevant new scan explicitly.'
      );
    return 'Resolve this specific issue using the current page/evidence; do not repeat unchanged input. Resume the task or delegate the remaining supported work once resolved. Parent work is still pending.';
  }
  if (unclassified) return classifySaved;
  if (
    task.input.operation === 'collect_details' &&
    task.items.some((i) => i.detailComplete === false && !i.error && i.pageKind !== 'results')
  )
    return `Descriptions are missing. Call browser_run_task operation=collect_details with fromTaskId=${task.id}; collected details will ${task.decisions === 'agent' ? 'wait for your assessment' : 'be classified automatically'}.`;
  return task.input.operation === 'scan_results'
    ? `${task.pageLimitReached ? 'Page limit for this turn reached; the board continues beyond the read pages. ' : ''}${task.knownBoundary ? 'Known boundary reached: consecutive pages held only listings this workspace already has, and the recipe orders the board newest-first. Empty the queue, then complete_scan_search with completion=cutoff. ' : ''}${task.pageCapReached ? 'Search limit reached: this search read its maximum pages or new listings. Empty the queue, then complete_scan_search with completion=end. ' : ''}Collect details using fromTaskId=${task.id}. Confirmed listing links are first; uncertain leads remain explicit. Listings this workspace already recorded or rejected are retired without a read (lastPage.knownListings). Reuse lastPage/pages for exact pagination and saved checkpoint facts; do not reread the board or repeat saved page reports. Unverified chronology requires full coverage, not an inferred cutoff. This result does not certify complete source coverage.`
    : task.input.operation === 'collect_details'
      ? task.decisions === 'agent'
        ? 'Details are read, not judged. Read the original listing text with read_listing_brief and assess the listings yourself. Do not read result-page bodies as listings.'
        : 'Details are already classified. Use the compact assessments and relevant original listing evidence for final assessment. Do not classify this same evidence again or read result-page bodies as listings.'
      : 'Review results and continue the assigned parent task.';
}
// A review pause returns its whole batch at once: a second read of the same
// 20 items only repeats them in the parent context.
export function jevTaskSummary(
  task,
  {
    offset = 0,
    limit = task.batch ? 20 : 10,
    pageOffset = undefined,
    batchId = undefined,
    view = 'compact',
  } = {},
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    (pageOffset !== undefined && (!Number.isSafeInteger(pageOffset) || pageOffset < 0))
  )
    throw Error('Invalid Jev result range.');
  limit = Math.min(limit, 20);
  if (batchId && batchId !== task.batch?.id)
    throw jevReviewRequired(
      'The review batch is stale; read the current batch and item numbers with read_browser_task(taskId).',
    );
  const scan = task.input.operation === 'scan_results',
    all = scan ? listingFirst(task.items) : task.items,
    items = task.batch ? task.batch.urls.map((url) => task.items.find((i) => i.url === url)) : all,
    pages = task.pages ?? [],
    refresh = triageRefresh(task);
  return {
    taskId: task.id,
    operation: task.input.operation,
    status: task.status,
    steps: task.steps,
    usage: task.usage,
    total: items.length,
    classified: items.filter((i) => i.collected && i.assessment).length,
    unavailable: items.filter((i) => i.error).length,
    resultsPages: items.filter((i) => i.pageKind === 'results').length,
    offset,
    items: refresh
      ? []
      : items.slice(offset, offset + limit).map((item, index) =>
          task.batch && view !== 'details'
            ? {
                item: offset + index + 1,
                title: item.title,
                evidenceId: item.evidenceId,
                assessment: item.assessment
                  ? {
                      decision: item.assessment.decision,
                      confidence: item.assessment.confidence,
                      ...(item.assessment.reason ? {reason: item.assessment.reason} : {}),
                    }
                  : {decision: 'uncertain'},
              }
            : {...compactItem(item), ...(task.batch ? {item: offset + index + 1} : {})},
        ),
    nextOffset: !refresh && offset + limit < items.length ? offset + limit : null,
    ...(refresh ? {assessmentRefreshRequired: true} : {}),
    answers: Object.fromEntries(
      Object.entries(task.answers).map(([key, a]) => [key, {verified: a.verified, label: a.label}]),
    ),
    issue: task.issue ?? null,
    currentUrl: task.currentUrl ?? null,
    endEvidenceId: task.endEvidenceId ?? null,
    ...(scan
      ? {
          confirmedListings: items.filter((i) => i.discovery?.decision === 'listing').length,
          uncertainLinks: items.filter((i) => i.discovery?.decision !== 'listing').length,
          pageCount: pages.length,
          ...(task.pageLimitReached ? {pageLimitReached: true} : {}),
          ...(task.pageCapReached ? {pageCapReached: true} : {}),
          ...(task.knownBoundary ? {knownBoundary: true} : {}),
          lastPage: pages.at(-1) ?? null,
          ...(pageOffset !== undefined
            ? {
                pageOffset,
                pages: pages.slice(pageOffset, pageOffset + 5),
                nextPageOffset: pageOffset + 5 < pages.length ? pageOffset + 5 : null,
              }
            : {}),
        }
      : {}),
    ...(task.batch ? {batch: {id: task.batch.id, total: items.length}, taskTotal: all.length} : {}),
    ...(task.pageWork?.selection
      ? {
          linkSelection: {
            id: task.pageWork.selection.id,
            total: task.pageWork.selection.links.length,
            links: task.pageWork.selection.links.map((link, index) => ({
              item: index + 1,
              title: link.text,
              url: link.url,
              ...(link.listing ? {listing: true} : {}),
              ...(link.context ? {card: link.context} : {}),
            })),
          },
        }
      : {}),
    ...(task.pageWork?.paginationChoice
      ? {paginationChoice: {options: task.pageWork.paginationChoice.options}}
      : {}),
    deferredDiscovery: all.filter((i) => i.pageKind === 'results').length,
    next: taskNext(task),
  };
}

// Transport checkpoints do not need to replay the first ten candidates. The
// complete index remains available on demand, including partial successes.
export function jevTaskReceipt(summary) {
  if (summary.issue?.reason === 'access_barrier') {
    const {items, offset, nextOffset, ...receipt} = summary;
    return receipt;
  }
  if (summary.status !== 'continue' && summary.operation !== 'scan_results') return summary;
  const {items, offset, nextOffset, pages, pageOffset, nextPageOffset, ...receipt} = summary;
  return {
    ...receipt,
    index: {tool: 'read_browser_task', taskId: summary.taskId, total: summary.total, offset: 0},
    next:
      summary.next + ' Results are saved; read_browser_task can inspect partial results if needed.',
  };
}
