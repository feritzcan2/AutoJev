// @ts-check
import {createHash, randomUUID} from 'node:crypto';
import {boundedText} from '../templates/catalog.mjs';

export const SCAN_OVERLAP_MS = 24 * 60 * 60 * 1000;
export const FULL_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;

// Schedule, provider, table layout and permission changes do not change which
// listings belong to a search. Search criteria do.
export function sourceScanScope(a, url) {
  const source = a.sourceSettings?.[url] ?? {};
  return createHash('sha256')
    .update(
      JSON.stringify(
        stable({
          ...(source.instructions ? {sourceInstructions: source.instructions} : {}),
          ...(source.skill ? {sourceSkill: source.skill} : {}),
          url,
          query: source.query ?? a.goal,
          goal: a.goal,
          criteria: a.criteria,
          instructions: a.instructions,
          facts: a.facts,
          workflow: a.workflow,
          templateId: a.templateId,
          templateVersion: a.templateVersion,
        }),
      ),
    )
    .digest('hex');
}

export const KNOWN_BOUNDARY_PAGES = 2;

function withPageCap(plan, pageCap) {
  const {pageCap: _old, ...rest} = plan,
    boundary = plan.boundary?.pageCap ? null : plan.boundary;
  return {...rest, boundary, ...(pageCap ? {pageCap} : {})};
}
export function beginSourceScan(saved, scopeKey, now, {ordering = null, pageCap = null} = {}) {
  const state = saved?.scopeKey === scopeKey ? saved : {scopeKey};
  // Keep the original start and cutoff on recovery; the page cap follows the
  // current recipe, so an edited recipe applies to the scan already under way.
  if (state.active)
    return (state.active.pageCap ?? null) === pageCap
      ? state
      : {...state, active: withPageCap(state.active, pageCap)};
  const full =
    state.lastSuccessfulStartAt == null ||
    state.lastFullScanAt == null ||
    now - state.lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
  return {
    ...state,
    active: {
      id: randomUUID(),
      scopeKey,
      startedAt: now,
      mode: full ? 'full' : 'incremental',
      cutoffAt: full ? null : state.lastSuccessfulStartAt - SCAN_OVERLAP_MS,
      overlapMs: SCAN_OVERLAP_MS,
      reason: state.lastSuccessfulStartAt == null ? 'initial' : full ? 'periodic' : 'new_listings',
      order: null,
      boundary: null,
      ...(!full && ordering === 'newest_first' ? {ordering: 'recipe'} : {}),
      ...(pageCap ? {pageCap} : {}),
    },
  };
}

// Only absolute dates can establish a cutoff. Ambiguous/relative/localized
// dates fall back to full coverage. Date-only values get a conservative upper
// bound covering the entire day in every timezone.
function publishedUpperBound(item) {
  const value = item.publishedAt;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
  )
    return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return value.length === 10 ? at + 38 * 60 * 60 * 1000 : at;
}

export function advanceSourceScan(
  plan,
  {chronology, pendingUrls, cursor, reason},
  snapshot,
  runId,
  now,
) {
  if (!plan) throw Error('Source scan plan not found.');
  // A page-cap boundary survives later queue updates like a known boundary.
  const capBoundary = plan.boundary?.pageCap ? plan.boundary : null;
  let next = {
    ...plan,
    boundary: capBoundary,
    checkpoint: {
      url: snapshot.url,
      pendingUrls,
      reason,
      at: now,
      ...(cursor ? {cursor: boundedText(cursor, 'Continuation cursor', 2000)} : {}),
    },
  };
  if (plan.mode === 'full') return next;
  // A verified recipe ordered newest-first stops at known listings instead of
  // dates; a marked known boundary survives later queue updates.
  if (plan.ordering === 'recipe') return {...next, boundary: plan.boundary ?? null};
  const fallback = (reason) => ({
    ...next,
    mode: 'full',
    reason,
    order: null,
    boundary: capBoundary,
  });
  if (!chronology?.newestFirst) return fallback('ordering_unverified');
  if (!plan.order && !chronology.fromStart) return fallback('start_unverified');
  const dates = chronology.items ?? [];
  if (!chronology.allItemsDated || !dates.length || dates.length > 100)
    return fallback('dates_unverified');
  let evidence, times;
  try {
    evidence = boundedText(chronology.evidence, 'Date ordering explanation', 2000);
    times = dates.map(publishedUpperBound);
  } catch {
    return fallback('chronology_unverified');
  }
  if (times.some((t) => t === null)) return fallback('dates_unverified');
  if (times.some((at, index) => index > 0 && at > times[index - 1]))
    return fallback('ordering_changed');
  const newest = times[0],
    oldest = times.at(-1),
    previous = plan.order;
  if (previous && previous.url !== snapshot.url && newest > previous.oldest)
    return fallback('ordering_changed');
  // Incomplete pages can checkpoint, but never authorize an early finish.
  next.order = {
    evidence,
    runId,
    url: snapshot.url,
    oldest: chronology.pageComplete ? oldest : (previous?.oldest ?? newest),
  };
  if (chronology.pageComplete && newest < plan.cutoffAt && !pendingUrls.length)
    next.boundary = {url: snapshot.url, runId, newestPublishedAt: newest, at: now};
  return next;
}

// Consecutive result pages holding only known listings end an incremental
// scan on a board whose recipe is ordered newest-first.
export function markKnownBoundary(plan, url, runId, now) {
  if (plan?.mode !== 'incremental' || plan.ordering !== 'recipe') return plan;
  return {...plan, boundary: {url, runId, known: true, at: now}};
}

// A recipe without a known ordering bounds every search to its first pages;
// reaching that page ends the search even when the board continues.
export function markPageCap(plan, url, runId, now) {
  if (!plan?.pageCap) return plan;
  return {...plan, boundary: {url, runId, pageCap: true, at: now}};
}

export function validateScanCompletion(plan, scan, pageProgress, runId) {
  const completion = scan.completion ?? 'end';
  if (!['end', 'cutoff', 'user_stop'].includes(completion)) throw Error('Invalid scan completion.');
  if (completion === 'cutoff' && plan?.boundary?.known) {
    if (plan.boundary.runId !== runId || plan.checkpoint?.pendingUrls.length)
      throw Error(
        'The known-listing boundary was not verified in this turn, or addresses are still pending in the queue.',
      );
    return completion;
  }
  if (
    completion === 'cutoff' &&
    (plan?.mode !== 'incremental' ||
      !plan.boundary ||
      plan.boundary.runId !== runId ||
      plan.boundary.url !== scan.evidenceUrl ||
      plan.checkpoint?.pendingUrls.length)
  )
    throw Error(
      'The date cutoff was not verified. Start from the newest and process the whole page; without reliable ordering and dates, continue to the last page.',
    );
  if (completion === 'end' && plan?.boundary?.pageCap) {
    if (plan.boundary.runId !== runId || plan.checkpoint?.pendingUrls.length)
      throw Error(
        'The page limit was not verified in this turn, or addresses are still pending in the queue.',
      );
    return completion;
  }
  if (
    completion === 'end' &&
    pageProgress?.totalPages &&
    pageProgress.currentPage < pageProgress.totalPages
  )
    throw Error(
      'The last page has not been reached yet. Process the remaining pages or report a verified date cutoff.',
    );
  return completion;
}

export function completeSourceScan(state, plan, completion, now) {
  if (!state?.active || state.active.id !== plan?.id || state.scopeKey !== plan.scopeKey)
    return state;
  const completed = {...state, active: null, lastCompleted: {...plan, completion, finishedAt: now}};
  if (completion === 'user_stop') return completed;
  return {
    ...completed,
    lastSuccessfulStartAt: plan.startedAt,
    lastSuccessfulAt: now,
    ...(completion === 'end' ? {lastFullScanAt: now} : {}),
  };
}

export const SOURCE_PAGE_INSTRUCTIONS =
  'Page cycle: work one results page at a time. 1) Run browser_jev_run scan_results on the results page; Jev saves its listing links to the pending queue and the page number (checkpointSaved=true). 2) Run browser_jev_run collect_details without URLs; Jev reads the pending queue and classifies each listing. 3) In every review batch read briefs with read_jev_brief evidenceIds and save suitable listings together with record_automation_results (with score, optional scoreReason, eligibility and eligibilityReason when scoring is enabled) and reject or defer the rest. Saved and rejected listings leave the queue automatically. 4) Follow the observed next page and repeat. Never collect all result pages first and evaluate later.';
export const SOURCE_SCAN_INSTRUCTIONS =
  SOURCE_PAGE_INSTRUCTIONS +
  ' Coverage: read assignedSource.instructions first; source guidance never grants outgoing actions. Run scan_results once per saved query or filter set; the pending queue is shared and has no size limit. get_scan_queue shows the pending count. When the queue is empty and the last results page was observed, call complete_scan_search with completion=end, then finish_automation_run. scanPlan may show an incremental plan with cutoffAt; without verified dates the app treats it as a full scan, so cover the board to its observed end. When scan_results ends with knownBoundary=true (recipe ordered newest-first, consecutive pages held only known listings), empty the queue and call complete_scan_search with completion=cutoff. When scan_results ends with pageCapReached=true (each search reads at most scanPlan.pageCap pages and 100 new listings), empty the queue and call complete_scan_search with completion=end; do not open further pages of that search. Known listing IDs never authorize stopping. user_stop is only for an explicit saved user stopping condition. Interrupted work resumes from the saved queue and page. These are coverage rules, not a time or step budget.';
