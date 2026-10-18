// @ts-check
import {jevDetailKey} from '../jev/detail-urls.mjs';
import {
  scanWork,
  activeSearch,
  hasUnblockedScanWork,
  searchNewListings,
} from '../sources/scan-work.mjs';
import {scanIssue, clearScanIssue} from '../sources/scan-issues.mjs';
import {scanPageReport} from '../sources/scan-page.mjs';

// Scan queue bookkeeping for Jev tasks of one source run. `scan` is
// {db, id, runId, snapshot}: the workspace store, automation, run and the
// current browser snapshot the progress refers to.

// The store accepts at most 100 queue addresses per update.
const QUEUE_CHUNK = 100;

function saveInChunks({db, id, runId, snapshot}, key, urls, input) {
  for (let offset = 0; offset < urls.length; offset += QUEUE_CHUNK)
    db.saveScanProgress(
      id,
      runId,
      {
        pendingUrls: [],
        processedUrls: [],
        ...input(offset),
        [key]: urls.slice(offset, offset + QUEUE_CHUNK),
      },
      snapshot,
    );
}

/** @param {(offset: number) => object} [extra] */
const retire = (scan, urls, reason, extra = () => ({})) =>
  saveInChunks(scan, 'processedUrls', urls, (offset) => ({reason, ...extra(offset)}));

// Jev's checkpoint after a results page: discovered listings wait for the
// parent's assessment; navigation, rejected and known links are retired.
/**
 * @param {{navigationUrls?: string[], rejectedUrls?: string[], rejected?: object[], cards?: object[], knownUrls?: string[], position?: object, decidedBy?: 'jev' | 'agent'}} [options]
 */
export function saveJevCheckpoint(scan, {sourceUrl, now}, page, urls, options = {}) {
  const {
    navigationUrls = [],
    rejectedUrls = [],
    rejected = [],
    cards = [],
    knownUrls = [],
    position,
    decidedBy = 'jev',
  } = options;
  const {db, id, runId, snapshot} = scan;
  // Leave discovered details pending until the parent has assessed and
  // recorded them. A helper finishing cannot complete a source queue.
  const pageReport = position ? scanPageReport(snapshot, position, now) : null;
  if (pageReport) db.reportPage(id, runId, pageReport);
  saveInChunks(scan, 'pendingUrls', urls, () => ({
    cards,
    reason: 'Listings found on the results page are waiting for assessment.',
  }));
  db.saveScanProgress(
    id,
    runId,
    {
      pendingUrls: [],
      processedUrls: [page.url],
      newListings: {url: page.url, count: cards.length + rejected.length},
      reason: 'Links from the results page are saved; the listings are waiting for assessment.',
    },
    snapshot,
  );
  retire(scan, navigationUrls, 'Observed navigation and filter links are not listings.');
  const agent = decidedBy === 'agent';
  retire(
    scan,
    rejectedUrls,
    agent
      ? 'The agent rejected the listing from its card; excluded without creating a record.'
      : 'Jev found a clear mismatch on the listing card with at least 85% confidence; excluded without creating a record.',
    (offset) => (offset ? {} : {excluded: rejected}),
  );
  if (rejectedUrls.length)
    db.rememberSeenListings(
      id,
      sourceUrl,
      rejectedUrls,
      agent
        ? 'The agent rejected the listing from its card.'
        : 'Jev found a clear mismatch on the listing card.',
    );
  retire(scan, knownUrls, 'Listings already recorded or excluded earlier; not read again.');
  return {
    saved: true,
    pageReport,
    newListings: searchNewListings(activeSearch(scanWork(db.activeRun(id, runId)))),
  };
}

// After a detail task: retire queued details that stay unreadable after Jev's
// bounded recovery and leads that are results pages, and keep unrendered ones
// as verified loading issues. Returns the receipt with what the app retired.
export function settleJevDetails(scan, {scope, searchId}, result) {
  const {db, id, runId} = scan;
  const pending = new Map(
    (
      scanWork(db.activeRun(id, runId)).searches.find((s) => s.id === searchId)?.pendingUrls ?? []
    ).map((url) => [jevDetailKey(url), url]),
  );
  const items = db.jevTasks.get(id, scope, result.taskId).items,
    queued = (item) => pending.get(jevDetailKey(item.url)),
    queuedUrls = (filter) => [...new Set(items.filter(filter).map(queued).filter(Boolean))];
  // A detail that stays unreadable after Jev's bounded read recovery is not
  // the agent's problem: the app retires it from the queue with the reason.
  // Access barriers keep their site wait; slow pages get three deferrals.
  const unreadable = queuedUrls(
    (i) =>
      i.error &&
      i.error !== 'access_barrier' &&
      (i.error !== 'page_not_ready' || db.jevTasks.detailDeferrals(id, scope, i.url) >= 3),
  );
  if (unreadable.length) {
    retire(
      scan,
      unreadable,
      `${unreadable.length} detail address(es) could not be read even after bounded rereads; removed from the queue.`,
    );
    for (const url of unreadable) clearScanIssue(db, id, runId, url);
    result = {
      ...result,
      retired: {count: unreadable.length, urls: unreadable.slice(0, 20)},
      next:
        (result.next ?? '') +
        ` The app retired ${unreadable.length} unreadable detail URL(s) from the queue; they need no further reading. Continue with the remaining queue or complete the search.`,
    };
  }
  // A detail still unrendered after Jev's bounded wait is a verified loading
  // issue of this scan: the agent cannot complete the source over it and the
  // app retries the source itself at the saved checkpoint instead of asking
  // the user. A later successful read clears it.
  for (const item of items) {
    const url = queued(item);
    if (!url) continue;
    if (item.error === 'page_not_ready') {
      if (!db.activeRun(id, runId).scanIssues?.[url]?.verified)
        scanIssue(db, id, runId, {
          url,
          kind: 'render_pending',
          evidence: `Jev: ${item.readUrl ?? url} did not load even after a bounded wait and reread.`,
          verified: true,
        });
    } else if (item.collected) clearScanIssue(db, id, runId, url);
  }
  // A lead that turned out to be a results/category page is not a listing to
  // read; the queue drops it so later detail rounds do not open it again.
  const boards = queuedUrls((i) => i.pageKind === 'results');
  if (boards.length) {
    retire(
      scan,
      boards,
      `${boards.length} address(es) are results/category pages, not listings; removed from the queue.`,
    );
    result = {
      ...result,
      retiredBoards: {count: boards.length, urls: boards.slice(0, 20)},
      next:
        (result.next ?? '') +
        ` ${boards.length} queued URL(s) were results/category pages, not listings; the app removed them from the queue.`,
    };
  }
  return result;
}

// The assigned source's own barrier releases its worker immediately. An
// unrelated detail host may still leave reachable work within this source.
export function releaseBlockedSource({db, id, runId, report}, sourceUrl, result) {
  const wait = result.issue.siteWait,
    current = db.activeRun(id, runId);
  if (hasUnblockedScanWork(current, result.issue.sites ?? [wait.site])) return result;
  const saved = db.get(id);
  db.put({
    ...saved,
    sourceState: {
      ...saved.sourceState,
      [sourceUrl]: {...saved.sourceState?.[sourceUrl], siteBlocked: true},
    },
  });
  db.putRun({...current, siteWait: wait, stop: {kind: 'access', evidence: wait.message}});
  return {
    ...result,
    parent: report(id, runId, 'blocked', wait.message, false),
    next: 'The source is waiting for user intervention or its retry deadline. Its worker is released for other work. A user response resumes this scan; an unanswered deadline closes its tabs and starts a fresh scan. Do not call more tools in this turn.',
  };
}
