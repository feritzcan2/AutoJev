// @ts-check
import {
  scanWork,
  activeSearch,
  withScanWork,
  scanQueue,
  scanWorkSummary,
  reportWorkPage,
  updateScanQueue,
  completeScanSearch,
  scanPlanView,
  scanProgressView,
  forgetPlanPosition,
} from '../../sources/scan-work.mjs';
import {jevDetailKey} from '../../jev/detail-urls.mjs';
import {siteListingKey} from '../../site-extensions/index.mjs';

const listingKey = (url) => siteListingKey(url) ?? jevDetailKey(url);
import {boundedText, webUrl} from '../../templates/catalog.mjs';
import {SCAN_SEARCH_LISTINGS} from '../../sources/recipe.mjs';
import {
  sourceJudgementScope,
  advanceSourceScan,
  markKnownBoundary,
  markPageCap,
  markUnservedPage,
} from '../../sources/scan.mjs';
// AutomationStore methods: scan progress of source runs: pages, queue, known listings and observations.
export const scanMethods = {
  spendStep(id, runId, {research = false} = {}) {
    const run = this.activeRun(id, runId);
    if (run.kind === 'interview' && !research)
      throw Error('Only source research is allowed during setup');
    if (research && run.kind !== 'interview')
      throw Error('Source research is only allowed during setup');
    run.browserSteps++;
    this.putRun(run);
  },
  reportPage(id, runId, pageProgress) {
    return this.store.workspaces.tasks.atomic(() => {
      const run = this.activeRun(id, runId);
      if (run.kind !== 'run' || !run.sourceUrl || run.recordId)
        throw Error('Page reports are only available in a source scan.');
      pageProgress = {...pageProgress, url: webUrl(pageProgress.url)};
      if (!(run.navigation ?? []).some((n) => n.url === pageProgress.url))
        throw Error('The reported page was not observed in this task.');
      const reported = reportWorkPage(run, pageProgress),
        scan = withScanWork(run, reported.work, {
          reason: run.scan?.reason ?? `Last reported results page ${pageProgress.currentPage}.`,
          evidenceUrl: run.scan?.evidenceUrl ?? pageProgress.url,
        });
      // Observation and resumable work are separate: even a successful recovery
      // visit to page one must not replace the saved page eight or pending details.
      // Known-listing and page-cap boundaries rest on pages already read, so a
      // reread of the last page served keeps them.
      const kept =
        run.scanPlan?.boundary?.known || run.scanPlan?.boundary?.pageCap
          ? run.scanPlan.boundary
          : null;
      const scanPlan = run.scanPlan ? {...run.scanPlan, boundary: kept} : null;
      this.persistScan(id, {
        ...run,
        observedPage: pageProgress,
        pageProgress: reported.pageProgress,
        scan,
        ...(scanPlan ? {scanPlan} : {}),
      });
      return {
        pageProgress: reported.pageProgress,
        observedPage: pageProgress,
        revisiting: reported.revisiting,
        scanProgress: this.scanProgressView(this.run(runId)),
        queue: scanQueue(this.run(runId)),
        ...(reported.revisiting
          ? {
              guidance:
                'Recovery page observed. Saved progress is unchanged. Resume the pending queue; do not scan earlier pages again.',
            }
          : {}),
      };
    });
  },
  persistScan(id, run) {
    if (run.scan?.work) {
      const work = scanWork(run),
        known = new Set(work.searches.flatMap((s) => s.pendingUrls));
      const extra = (run.scan.pendingUrls ?? []).filter((url) => !known.has(url));
      activeSearch(work).pendingUrls.push(...extra);
      const complete =
        run.scan.complete === true &&
        !work.searches.some((s) => s.pendingUrls.length || s.status !== 'completed');
      run = {...run, scan: {...withScanWork(run, work), complete}};
    }
    this.putRun(run);
    const a = this.get(id),
      state = a.sourceState?.[run.sourceUrl] ?? {};
    this.put({
      ...a,
      sourceState: {
        ...a.sourceState,
        [run.sourceUrl]: {
          ...state,
          pageProgress: run.pageProgress ?? null,
          observedPage: run.observedPage ?? null,
          scan: run.scan,
          ...(run.scanPlan ? {scanState: {...state.scanState, active: run.scanPlan}} : {}),
        },
      },
    });
    if (run.taskId) {
      const queue = this.store.workspaces.tasks;
      queue.put({...queue.get(id, run.taskId), scan: run.scan, scanPlan: run.scanPlan});
    }
  },
  scanProgressView(run) {
    return scanProgressView(run);
  },
  scanWorkRun(id, runId) {
    const run = this.activeRun(id, runId);
    if (run.kind !== 'run' || !run.sourceUrl || run.recordId)
      throw Error('The scan queue belongs only to a source task.');
    return run;
  },
  scanQueue(id, runId, input) {
    return scanQueue(this.scanWorkRun(id, runId), input);
  },
  completeScanSearch(id, runId, completion, snapshot) {
    return this.store.workspaces.tasks.atomic(() => {
      const run = this.scanWorkRun(id, runId),
        before = scanWork(run).activeSearchId,
        work = completeScanSearch(run, completion, snapshot.url),
        next = activeSearch(work);
      if (next.id === before) {
        this.persistScan(id, {...run, scan: withScanWork(run, work)});
        return scanWorkSummary(this.run(runId));
      }
      // Page caps, known boundaries and checkpoints belong to the finished search.
      const scanPlan = next.plan ?? (run.scanPlan ? forgetPlanPosition(run.scanPlan) : null);
      this.persistScan(id, {
        ...run,
        scan: withScanWork(run, work),
        pageProgress: next.pageProgress ?? null,
        observedPage: null,
        ...(scanPlan ? {scanPlan} : {}),
      });
      return {
        ...scanWorkSummary(this.run(runId)),
        next: next.url
          ? `Search "${next.label}" is now active. Call browser_run_task scan_results with url ${next.url}, then complete_scan_search for it as well.`
          : `Search "${next.label}" is now active; continue its queue and complete it as well.`,
      };
    });
  },
  markKnownBoundary(id, runId, url) {
    return this.store.workspaces.tasks.atomic(() => {
      const run = this.scanWorkRun(id, runId),
        scanPlan = markKnownBoundary(run.scanPlan, url, runId, this.now());
      if (scanPlan === run.scanPlan) return false;
      const work = scanWork(run);
      activeSearch(work).plan = scanPlan;
      this.persistScan(id, {
        ...run,
        scanPlan,
        scan: withScanWork(run, work, {
          reason:
            'Consecutive known pages on a board the recipe says is sorted newest first; older listings are already recorded.',
          evidenceUrl: url,
        }),
      });
      return true;
    });
  },
  markPageCap(id, runId, url) {
    return this.store.workspaces.tasks.atomic(() => {
      const run = this.scanWorkRun(id, runId),
        scanPlan = markPageCap(run.scanPlan, url, runId, this.now());
      if (scanPlan === run.scanPlan) return false;
      const work = scanWork(run);
      activeSearch(work).plan = scanPlan;
      this.persistScan(id, {
        ...run,
        scanPlan,
        scan: withScanWork(run, work, {
          reason: `The search reached its limit of ${scanPlan.pageCap} pages or ${SCAN_SEARCH_LISTINGS} new listings.`,
          evidenceUrl: url,
        }),
      });
      return true;
    });
  },
  // The site refuses a later results page of the active search: the search
  // ends at the last page it served. The refused address leaves the queue and
  // its failures, so it holds neither the search nor a technical retry.
  markUnservedPage(id, runId, url) {
    return this.store.workspaces.tasks.atomic(() => {
      const run = this.scanWorkRun(id, runId),
        work = scanWork(run),
        search = activeSearch(work),
        last = search?.pageProgress;
      if (!last?.url || last.url === url || !run.scanPlan) return false;
      const scanPlan = markUnservedPage(run.scanPlan, last.url, url, runId, this.now());
      search.plan = scanPlan;
      if (search.pendingUrls.includes(url)) {
        search.pendingUrls = search.pendingUrls.filter((u) => u !== url);
        search.processedUrls = [...new Set([...search.processedUrls, url])];
      }
      const {[url]: _refused, ...scanIssues} = run.scanIssues ?? {};
      this.persistScan(id, {
        ...run,
        scanPlan,
        scanIssues,
        scan: withScanWork(run, work, {
          reason: `The site does not serve ${url}; this search ends at page ${last.currentPage}, the last page it served.`,
          evidenceUrl: last.url,
        }),
      });
      return true;
    });
  },
  saveScanProgress(id, runId, input, snapshot) {
    return this.store.workspaces.tasks.atomic(() => {
      const run = this.scanWorkRun(id, runId);
      if (!Array.isArray(input.pendingUrls) || input.pendingUrls.length > 100)
        throw Error('Add at most 100 pending addresses at a time; add the rest in the next call.');
      const reason = boundedText(input.reason, 'Coverage explanation', 2000),
        work = updateScanQueue(run, input),
        search = activeSearch(work);
      // Queue updates accept the agent's report. A page is optional and only
      // supplies context for chronological early stopping, never permission to save.
      const page = snapshot ?? {url: run.scanPlan?.checkpoint?.url ?? run.sourceUrl, text: ''};
      const chronology =
        snapshot &&
        !(
          input.chronology?.fromStart &&
          run.observedPage?.url === page.url &&
          run.observedPage.currentPage !== 1
        )
          ? input.chronology
          : undefined;
      const scanPlan = advanceSourceScan(
        run.scanPlan,
        {...input, chronology, pendingUrls: search.pendingUrls, reason},
        page,
        runId,
        this.now(),
      );
      search.plan = scanPlan;
      const scan = withScanWork(run, work, {reason, evidenceUrl: page.url});
      this.persistScan(id, {...run, scan, scanPlan});
      return {
        scanProgress: this.scanProgressView(this.run(runId)),
        scanPlan: scanPlanView(scanPlan),
        queue: scanQueue(this.run(runId)),
      };
    });
  },
  // Listings already recorded in this workspace, or rejected in a review under
  // the current search scope, are not read again. Keys are the Jev detail keys
  // of every alias, so tracking parameters and slashes do not disguise a repeat.
  knownListingUrls(id, runId, urls) {
    const run = this.activeRun(id, runId);
    if (!run.sourceUrl || run.recordId) return [];
    const seen = new Set(this.seenListingUrls(id, run.sourceUrl, urls));
    return urls.filter((url) => {
      try {
        const record = this.store.workspaces.records.find(id, url);
        return Boolean((record && !record.trial) || seen.has(url));
      } catch {
        return false;
      }
    });
  },
  // Known listings split into those the workspace keeps as records and those
  // it excluded earlier (a dismissed record or a remembered rejection).
  knownListingCounts(id, urls) {
    let saved = 0;
    for (const url of urls) {
      try {
        const record = this.store.workspaces.records.find(id, url);
        if (record && !record.trial && record.status !== 'dismissed') saved++;
      } catch {}
    }
    return {saved, excluded: urls.length - saved};
  },
  seenListingUrls(id, sourceUrl, urls) {
    const scopeKey = sourceJudgementScope(this.get(id), sourceUrl);
    const seen = this.db.prepare(
      'SELECT 1 FROM scan_seen_listings WHERE workspace_id=? AND url_key=? AND scope_key=?',
    );
    // Rows written before a site named its listing key carry the generic key.
    return urls.filter((url) => {
      try {
        return Boolean(
          seen.get(id, listingKey(url), scopeKey) || seen.get(id, jevDetailKey(url), scopeKey),
        );
      } catch {
        return false;
      }
    });
  },
  rememberSeenListings(id, sourceUrl, urls, reason) {
    const scopeKey = sourceJudgementScope(this.get(id), sourceUrl),
      insert = this.db.prepare(
        'INSERT OR REPLACE INTO scan_seen_listings(workspace_id,url_key,scope_key,reason,at) VALUES(?,?,?,?,?)',
      ),
      now = this.now();
    for (const url of urls) {
      try {
        insert.run(id, listingKey(url), scopeKey, String(reason).slice(0, 200), now);
      } catch {}
    }
  },
  knownResults(id, runId, keys) {
    const run = this.activeRun(id, runId);
    if (!run.sourceUrl || run.recordId || !Array.isArray(keys) || keys.length > 100)
      throw Error('A source scan accepts at most 100 listing keys.');
    return keys.map((key) => {
      boundedText(key, 'Listing key', 3000);
      const record = this.store.workspaces.records.find(id, key),
        item = record && !record.trial ? record : null;
      return {
        key,
        known: Boolean(item),
        ...(item
          ? {id: item.id, status: item.status, updatedAt: item.updatedAt, revision: item.revision}
          : {}),
      };
    });
  },
  observe(id, runId, url, evidence, links = [], pageContext = {}) {
    const run = this.activeRun(id, runId),
      observation = {url: webUrl(url), evidence: String(evidence).slice(0, 2000), at: this.now()};
    run.observations = [...run.observations, observation].slice(-20);
    // A cutoff proof belongs to the last observed page version. Recheck it after
    // any fresh browser observation rather than completing from stale content.
    // A known-listing boundary rests on Jev's page reads and a page cap on the
    // pages already read, not on this snapshot.
    const invalidated =
      Boolean(run.scanPlan?.boundary) &&
      !run.scanPlan.boundary.known &&
      !run.scanPlan.boundary.pageCap;
    if (invalidated) run.scanPlan = {...run.scanPlan, boundary: null};
    run.resumeContext = {
      url: observation.url,
      ...(typeof pageContext?.tabId === 'string' ? {tabId: pageContext.tabId} : {}),
    };
    // Keep the full route separately from the bounded page excerpts.
    run.navigation = [
      ...(run.navigation ?? []),
      {url: observation.url, at: observation.at, step: run.browserSteps},
    ];
    if (links.length)
      run.observedLinks = [...new Set([...(run.observedLinks ?? []), ...links])].slice(-10000);
    if (invalidated) {
      this.store.workspaces.tasks.atomic(() => this.persistScan(id, run));
      return run;
    }
    return this.putRun(run);
  },
};
