// @ts-check
import {scanWork, activeSearch, withScanWork, noteExcluded} from '../sources/scan-work.mjs';
import {JEV_CLASSIFICATION_VERSION, JEV_TRIAGE_CONFIDENCE, EXCLUSION_REASONS} from './triage.mjs';
import {jevDetailKey} from './detail-urls.mjs';
import {needsCollectorReview} from '../sources/collectors.mjs';
import {collectorReviewed} from '../sources/collector-worker.mjs';

export const jevReviewRequired = (message) =>
  Object.assign(Error(message), {code: 'JEV_REVIEW_REQUIRED'});

// Numbers refer to the current batch order, including across index pages.
// Normalize legacy URL selectors too, so deferred work retains its decision.
export function resolveJevReview(items, decisions = []) {
  const keys = new Map(
      items.flatMap((item, index) =>
        [item.url, ...(item.aliases ?? [])].map((url) => [jevDetailKey(url), index]),
      ),
    ),
    seen = new Map();
  if (!Array.isArray(decisions) || decisions.length > 20)
    throw jevReviewRequired('review must be a list of at most 20 decisions.');
  return decisions.map((decision, position) => {
    const fail = (message) => {
      throw jevReviewRequired(
        `review[${position}]: ${message} Use read_browser_task(taskId, batchId, limit:20) for the current batch; send the decision with the item number.`,
      );
    };
    if (!decision || typeof decision !== 'object' || Array.isArray(decision))
      fail('A decision must be an object.');
    const numbered = decision.item !== undefined,
      byUrl = decision.url !== undefined;
    if (numbered === byUrl) fail('Choose a single listing: item, or url in the old format.');
    let index;
    if (numbered) {
      if (!Number.isInteger(decision.item) || decision.item < 1 || decision.item > items.length)
        fail(
          `item must be within 1–${items.length} for this batch; given: ${String(decision.item).slice(0, 30)}.`,
        );
      index = decision.item - 1;
    } else {
      try {
        index = keys.get(jevDetailKey(decision.url));
      } catch {}
      if (index === undefined) fail('The URL does not match any listing in this batch.');
    }
    if (seen.has(index))
      fail(
        `item ${index + 1} was already chosen in review[${seen.get(index)}]; send one decision.`,
      );
    if (
      !['reject', 'defer'].includes(decision.decision) ||
      typeof decision.reason !== 'string' ||
      !decision.reason.trim() ||
      decision.reason.length > 1500
    )
      fail(`item ${index + 1} needs decision reject/defer and a reason of 1–1500 characters.`);
    seen.set(index, position);
    return {url: items[index].url, decision: decision.decision, reason: decision.reason};
  });
}

// The agent's answer to a link selection, keyed by detail URL: selected links
// are read, rejected listings are excluded with the reason, the rest are not
// listings. Numbers refer to the selection's order.
export function resolveLinkSelection(links, selected = [], review = []) {
  const fail = (message) => {
    throw jevReviewRequired(
      `${message} Read the current linkSelection with read_browser_task(taskId); send selected=[item numbers] and review=[{item,decision:"reject",reason}].`,
    );
  };
  if (!Array.isArray(selected) || !Array.isArray(review))
    fail('selected and review must be lists.');
  const decisions = {},
    key = (item, field) => {
      if (!Number.isInteger(item) || item < 1 || item > links.length)
        fail(
          `${field}: item must be within 1–${links.length}; given: ${String(item).slice(0, 30)}.`,
        );
      const value = jevDetailKey(links[item - 1].url);
      if (decisions[value]) fail(`${field}: item ${item} was already chosen; send one decision.`);
      return value;
    };
  for (const [position, item] of selected.entries())
    decisions[key(item, `selected[${position}]`)] = {kind: 'read'};
  for (const [position, decision] of review.entries()) {
    if (!decision || typeof decision !== 'object' || decision.url !== undefined)
      fail(`review[${position}]: choose the link by its item number.`);
    if (
      decision.decision !== 'reject' ||
      typeof decision.reason !== 'string' ||
      !decision.reason.trim() ||
      decision.reason.length > 1500
    )
      fail(`review[${position}]: a link is rejected with decision "reject" and a reason.`);
    decisions[key(decision.item, `review[${position}]`)] = {
      kind: 'reject',
      reason: decision.reason.trim(),
    };
  }
  return decisions;
}

// A local review can retire saved records or explicitly acknowledged exclusions.
// It cannot manufacture a new browser observation or complete source coverage.
export function reviewJevBatch(db, owner, runId, taskId, batchId, decisions = []) {
  return db.store.workspaces.tasks.atomic(() => {
    const run = db.activeRun(owner, runId),
      scope = run.taskId ?? run.id,
      task = db.jevTasks.get(owner, scope, taskId);
    if (
      task.searchId !== (run.scan?.work?.activeSearchId ?? 'default') ||
      task.batch?.id !== batchId ||
      task.classificationVersion !== JEV_CLASSIFICATION_VERSION
    )
      throw Error('The review batch must belong to the current task and search.');
    const items = task.batch.urls.map((url) => task.items.find((i) => i.url === url));
    const review = resolveJevReview(items, decisions),
      choices = new Map(review.map((decision) => [jevDetailKey(decision.url), decision]));
    const known = (url) => {
      const record = db.store.workspaces.records.find(owner, url);
      return record && !record.trial && !needsCollectorReview(record);
    };
    const seen = new Set(
      run.kind === 'run' && run.sourceUrl && !run.recordId
        ? db.seenListingUrls(
            owner,
            run.sourceUrl,
            items.flatMap((item) => [item.url, ...(item.aliases ?? [])]),
          )
        : [],
    );
    const missing = [],
      deferred = new Set();
    for (const [index, item] of items.entries()) {
      const key = jevDetailKey(item.url),
        decision = choices.get(key);
      if (decision?.decision === 'defer') {
        deferred.add(key);
        continue;
      }
      if (!item?.collected || !item.assessment || item.pageKind === 'results' || item.error)
        throw Error('A missing listing cannot be removed from the review batch.');
      const evidence = db.jevTasks.fullEvidence(owner, scope, item.evidenceId);
      if (decision?.decision === 'reject') {
        if (run.kind === 'run' && run.sourceUrl && !run.recordId)
          db.rememberSeenListings(
            owner,
            run.sourceUrl,
            [item.url, ...(item.aliases ?? [])],
            decision.reason ?? 'Rejected in review.',
          );
        continue;
      }
      if (item.assessment.decision === 'mismatch') {
        const proof = item.assessment.exclusion;
        if (
          !(item.assessment.confidence >= JEV_TRIAGE_CONFIDENCE) ||
          !proof ||
          !(proof.confidence >= JEV_TRIAGE_CONFIDENCE) ||
          !Object.hasOwn(EXCLUSION_REASONS, proof.reason) ||
          proof.reason === 'none' ||
          proof.evidenceId !== item.evidenceId
        )
          throw Error(
            'A mismatched listing needs a rejection assessment for this listing with at least 85% confidence.',
          );
      } else if (
        ![item.url, ...(item.aliases ?? [])].some(
          (url) => seen.has(url) || known(url) || known(evidence.url),
        )
      )
        missing.push(index + 1);
    }
    if (missing.length)
      throw jevReviewRequired(
        'Review not complete: first record suitable listings with record_automation_result; send review=[{item,decision:"reject",reason}] for unsuitable ones and decision:"defer" for unreadable ones. Item numbers awaiting a decision: ' +
          missing.join(', ') +
          '. Do not rewrite Jev mismatch decisions with 85% confidence; batch approval is enough.',
      );
    if (run.kind === 'run' && run.sourceUrl && !run.recordId) {
      const work = scanWork(run),
        search = activeSearch(work),
        doneKeys = new Set(
          items
            .filter((i) => !deferred.has(jevDetailKey(i.url)))
            .flatMap((i) => [i.url, ...(i.aliases ?? [])].map(jevDetailKey)),
        );
      const done = new Set([
        ...items
          .filter((i) => doneKeys.has(jevDetailKey(i.url)))
          .flatMap((i) => [i.url, ...(i.aliases ?? [])]),
        ...search.pendingUrls.filter((url) => doneKeys.has(jevDetailKey(url))),
      ]);
      search.pendingUrls = search.pendingUrls.filter((url) => !doneKeys.has(jevDetailKey(url)));
      search.processedUrls = [...new Set([...search.processedUrls, ...done])];
      if (search.cards)
        search.cards = Object.fromEntries(
          Object.entries(search.cards).filter(([url]) => search.pendingUrls.includes(url)),
        );
      noteExcluded(
        search,
        items
          .filter((i) => doneKeys.has(jevDetailKey(i.url)))
          .flatMap((i) => {
            const d = choices.get(jevDetailKey(i.url));
            return d?.decision === 'reject'
              ? [{url: i.url, title: i.title, reason: d.reason, stage: 'detail', by: 'agent'}]
              : i.assessment?.decision === 'mismatch' && !known(i.url)
                ? [
                    {
                      url: i.url,
                      title: i.title,
                      reason: i.assessment.exclusion?.reason ?? i.assessment.reason,
                      confidence: i.assessment.exclusion?.confidence ?? i.assessment.confidence,
                      // Jev's card screen closes a listing before its full text is judged.
                      stage: i.assessment.exclusion?.basis === 'card' ? 'card' : 'detail',
                    },
                  ]
                : [];
          }),
      );
      // A reviewed batch changes the queue, not the pages already read.
      const kept =
        run.scanPlan?.boundary?.pageCap || run.scanPlan?.boundary?.known
          ? run.scanPlan.boundary
          : null;
      const scanPlan = run.scanPlan
        ? {
            ...run.scanPlan,
            boundary: kept,
            ...(run.scanPlan.checkpoint
              ? {checkpoint: {...run.scanPlan.checkpoint, pendingUrls: [...search.pendingUrls]}}
              : {}),
          }
        : run.scanPlan;
      search.plan = scanPlan ?? search.plan;
      db.persistScan(owner, {
        ...run,
        scanPlan,
        scan: withScanWork(run, work, {
          reason: 'Jev batch reviewed; recorded listings and evidenced rejections were processed.',
        }),
      });
    }
    collectorReviewed(db, run, items, review);
    return review;
  });
}
