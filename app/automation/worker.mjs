import {taskHasRecord, batchScoring} from '../records/task-scope.mjs';
import {jevTokenTotal, runTokenUsage} from '../agents/run-token-usage.mjs';
import {loadScoringDocuments, scoringSources} from '../scoring/profile.mjs';
import {jevCriteria} from '../jev/triage.mjs';
import {reviewJevBatch} from '../jev/review.mjs';
import {readJevBrief} from '../jev/brief.mjs';
import {jevWaitMsFor, observeClientAbort} from '../jev/execution.mjs';
import {withAgentDefaults} from '../agents/settings.mjs';
import {otherScanSearchesPending, scanWork} from '../sources/scan-work.mjs';
import {siteKey} from '../browser/site-access.mjs';
import {collectorRun} from '../sources/collectors.mjs';
import {
  collectSourcePage,
  collectorSaved,
  collectorProgress,
} from '../sources/collector-worker.mjs';
import {siteReaderFor} from '../site-extensions/index.mjs';
import {setTimeout as pause} from 'node:timers/promises';
import {jevDetailKey} from '../jev/detail-urls.mjs';
import {
  recordResultInput,
  saveRecordScore,
  normalizeRecordToolArgs,
} from '../scoring/record-scoring.mjs';
import {recordToolGuard} from '../records/tool-guard.mjs';
import {automationTaskContext, conversationContextVersion} from './task-context.mjs';
import {automationRunHistory} from './continuation.mjs';
import {
  automationProtocol,
  prepareAutomationProtocol,
  automationEvidenceExpired,
} from './protocol.mjs';
import {SCORING_INSTRUCTIONS} from '../scoring/policy.mjs';
import {readBrowserEvidence} from '../browser/evidence-read.mjs';
import {JevExecution} from '../jev/execution.mjs';
import {asksForLogin, validateLoginQuestion, LOGGED_IN_FIELD} from './login-question.mjs';
import {workspaceDirectory} from '../workspaces/paths.mjs';
import {AUTOMATION_INSTRUCTIONS, webAgentProfile} from '../agents/automation-profiles.mjs';
import {
  isConversation,
  conversationRequest,
  workspaceHistory,
} from '../workspaces/conversation.mjs';
import {conversationToolLabel} from '../agents/conversation-activity.mjs';
import {setupAgentHistory, setupAgentSettings} from '../agents/setup-agent.mjs';
import {operationFor} from '../templates/contract.mjs';
import {workspaceTableTools, workspaceTableCall} from '../workspaces/table-tools.mjs';
import {BrowserSnapshot, BROWSER_RESPONSE_BYTES} from '../browser/snapshot.mjs';
import {AutomationContext} from './context.mjs';
import {
  recordReceipt,
  scanToolOutput,
  documentToolContent,
  briefToolOutput,
} from './tool-output.mjs';
import {browserNavigation} from '../browser/navigation.mjs';
import {mkdir, writeFile, rm, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {writeWorkspaceInstructions} from '../workspaces/instructions.mjs';
import {webUrl} from '../templates/catalog.mjs';
import {SOURCE_SCAN_INSTRUCTIONS, KNOWN_BOUNDARY_PAGES} from '../sources/scan.mjs';
import {observedLinks} from '../sources/automation-scan.mjs';
import {observedScanPage} from '../sources/scan-page.mjs';
import {workerKey} from './worker-key.mjs';
import {sourceScan, scanIssue, clearScanIssue, browserFailure} from '../sources/scan-issues.mjs';
import {holdForTechnicalRetry} from './recovery.mjs';
import {runJevTask, jevDetailItems} from '../jev/tasks.mjs';
import {jevTaskSummary, jevTaskReceipt} from '../jev/task-summary.mjs';
import {JEV_LAUNCH_INSTRUCTIONS} from '../jev/task-tools.mjs';
import {
  normalizeSourceRecipe,
  recipeReplay,
  recipeValues,
  jevListingItem,
  replayMatches,
} from '../sources/recipe.mjs';
import {scopedAutomationTools, collectorHidden, scoreWrites} from './tools.mjs';
import {pageObservation, researchUrl, unchangedPageContent} from './page-content.mjs';
import {automationPrompt} from './prompts.mjs';
import {finishAutomationRun} from './finish.mjs';
import {saveJevCheckpoint, settleJevDetails, releaseBlockedSource} from './jev-scan.mjs';
// A recipe check reads this many uncertain leads when discovery confirms none.
const RECIPE_CHECK_DETAILS = 3;
// A trial checks access and learns the recipe; it never scans a whole board.
const TRIAL_SCAN_PAGE_LIMIT = 2;

export function automationWorkflow({
  workspace,
  db,
  run,
  signal,
  browser,
  report,
  changed = () => {},
  jevWaitMs = 30000,
  collectorReadPage,
  collectorReadDetail,
}) {
  const id = run.automationId,
    snapshots = new BrowserSnapshot(),
    context = new AutomationContext();
  const collecting = Boolean(collectorRun(db.get(id), run));
  const scopedTools = scopedAutomationTools({
    run,
    template: db.template(db.get(id).templateId),
    collecting,
  });
  const rechecked = new Set();
  let calls = Promise.resolve();
  let attemptedUrl = run.resumeContext?.url ?? run.sourceUrl;
  const browserError = (error) => {
    const failure = browserFailure(error),
      active = db.activeRun(id, run.id);
    if (failure && sourceScan(active)) {
      const url = attemptedUrl ?? active.sourceUrl,
        issue = scanIssue(db, id, run.id, {url, ...failure});
      error.message +=
        ' [Page load failed. Retry once; the app records repeated failures and retries them later. Continue with other pending work.]';
      if (issue.attempts >= 3) {
        const current = db.run(run.id),
          issues = Object.values(current.scanIssues ?? {}),
          pendingUrls = [
            ...new Set([...(current.scan?.pendingUrls ?? []), ...issues.map((i) => i.url)]),
          ];
        if (
          issue.global ||
          (!otherScanSearchesPending(current) &&
            pendingUrls.every((url) => issues.some((i) => i.url === url && i.verified)))
        ) {
          const summary = `Sayfa yüklenemedi; yeniden denenecek: ${url}`;
          const retry = holdForTechnicalRetry(db, id, run.id, {
            stop: {
              kind: 'technical',
              evidence: issue.evidence,
              issueIds: issues.filter((i) => i.verified).map((i) => i.id),
            },
            urls: issues.map((i) => i.url),
            summary,
            evidenceUrl: url,
          });
          if (retry) {
            report(id, run.id, retry.status, retry.summary, false);
            error.message +=
              retry.status === 'blocked'
                ? ' Otomatik deneme durduruldu; yeniden başlatmak için kullanıcı müdahalesi gerekli.'
                : ' Tarama beklemeye alındı; bu turda başka işlem yapma.';
          }
        }
      }
      changed(id);
    }
    throw error;
  };
  const callBrowser = async (owner, name, args, session, options) => {
    if (args.url) attemptedUrl = args.url;
    const issue = db.activeRun(id, run.id).scanIssues?.[attemptedUrl];
    if (issue?.kind === 'browser_error' && issue.attempts >= 3)
      throw Error(
        `Bu adres tekrar tekrar yüklenemedi: ${attemptedUrl}. Uygulama bu adresi sonra yeniden deneyecek; diğer bekleyen adresleri işle.`,
      );
    try {
      const response = await browser.call(owner, name, args, session, options);
      if (response.isError)
        throw Error(
          (response.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
        );
      return name === 'browser_navigate' && response.pageContext
        ? {...response, pageContext: {...response.pageContext, requestedUrl: args.url}}
        : response;
    } catch (error) {
      return browserError(error);
    }
  };
  let lastSnapshot = null;
  // The last page a site reader returned is the Jev task's current page; it
  // has no browser tab, so observing it returns the same read.
  let readerPage = null;
  const readerResponse = (page) => ({
    jevPage: page,
    pageContext: {url: page.url, tabId: null},
    readiness: page.reading.readiness,
    content: [{type: 'text', text: `Page URL: ${page.url}\n${JSON.stringify(page)}`}],
  });
  // Jev pages report their scan position through its own checkpoint. A detail
  // or company page read by Jev never moves the search position or its page cap.
  const inspect = async ({research = false, response: provided, jev = false} = {}) => {
    snapshots.invalidate();
    const response =
        provided ??
        (await callBrowser(id, 'browser_snapshot', {}, run.id, {completeSnapshot: true})),
      observation = pageObservation(response);
    if (response.siteWait) {
      if (!run.sourceUrl || siteKey(run.sourceUrl) === response.siteWait.site)
        db.putRun({...db.run(run.id), siteWait: response.siteWait});
      const saved = db.get(id),
        sourceState = {...saved.sourceState};
      for (const url of saved.sources)
        if (!run.recordId && siteKey(url) === response.siteWait.site)
          sourceState[url] = {...sourceState[url], siteBlocked: true};
      db.put({...saved, sourceState});
    }
    if (!observation)
      return browserError(Error('Sayfa gözlemi alınamadı; tarayıcı bağlantısını kontrol et'));
    attemptedUrl = observation.url;
    if (research) researchUrl(observation.url);
    else webUrl(observation.url);
    const links = observedLinks(response, observation.url);
    // A successful navigation observes both the requested address and its
    // redirect destination. Queue retirement must recognize the original URL.
    if (response.pageContext?.requestedUrl && !response.siteWait && !response.readiness?.loading)
      links.push(webUrl(response.pageContext.requestedUrl));
    db.observe(id, run.id, observation.url, observation.evidence, links, response.pageContext);
    let readiness = response.readiness;
    if (sourceScan(db.run(run.id))) {
      if (!readiness?.loading) {
        clearScanIssue(db, id, run.id, observation.url);
        if (response.pageContext?.requestedUrl)
          clearScanIssue(db, id, run.id, webUrl(response.pageContext.requestedUrl));
      }
      if (readiness?.loading) {
        const issue = scanIssue(db, id, run.id, {
          url: observation.url,
          kind: 'render_pending',
          evidence: readiness.reason,
        });
        readiness = {
          ...readiness,
          issueId: issue.id,
          guidance:
            'Page rendering is unfinished. Do not treat this as zero results or complete coverage. The app rechecks and retries this address; continue with other pending work.',
        };
      }
    }
    const content = documentToolContent(response.content),
      pageNavigation = browserNavigation(response);
    // Unchanged page text is not sent again: the model keeps the earlier snapshot
    // and receives only the fresh control maps, readiness and navigation.
    const unchanged =
      lastSnapshot && lastSnapshot.url === observation.url
        ? unchangedPageContent(content, lastSnapshot)
        : null;
    let captured = null;
    if (unchanged) {
      snapshots.current = {
        ...lastSnapshot,
        ...(readiness ? {readiness} : {}),
        ...(pageNavigation ? {pageNavigation} : {}),
      };
      captured = {
        url: observation.url,
        ...(readiness ? {readiness} : {}),
        ...(pageNavigation ? {pageNavigation} : {}),
        content: unchanged,
        snapshot: {
          id: lastSnapshot.id,
          totalCharacters: lastSnapshot.text.length,
          offset: 0,
          endOffset: lastSnapshot.text.length,
          nextOffset: null,
          complete: true,
        },
        textUnchanged: true,
        notice:
          'Page text is unchanged since snapshot ' +
          lastSnapshot.id +
          '. Reuse that snapshot with browser_read_part or browser_search; only the control maps, readiness and navigation above are new.',
      };
      if (Buffer.byteLength(JSON.stringify(captured), 'utf8') > BROWSER_RESPONSE_BYTES)
        captured = null;
    }
    captured ??= snapshots.capture({url: observation.url, content, readiness, pageNavigation});
    lastSnapshot = snapshots.current;
    db.browserEvidence.save(db.activeRun(id, run.id), snapshots.current);
    db.browserEvidence.rememberIdentity(db.activeRun(id, run.id), {
      url: observation.url,
      canonicalUrl: response.jevPage?.canonicalUrl,
      readiness,
    });
    db.scoringListingTexts ??= new Map();
    if (db.scoringListingTexts.size >= 64)
      db.scoringListingTexts.delete(db.scoringListingTexts.keys().next().value);
    db.scoringListingTexts.set(run.id, {
      owner: id,
      url: observation.url,
      text: snapshots.current.text,
    });
    if (
      !jev &&
      sourceScan(db.run(run.id)) &&
      db.run(run.id).kind === 'run' &&
      !readiness?.loading
    ) {
      const pageReport = observedScanPage(snapshots.current, db.now());
      if (pageReport) {
        db.reportPage(id, run.id, pageReport);
        return {...captured, pageReport: {saved: true, ...pageReport}};
      }
    }
    return captured;
  };
  const recheckPage = async (url, {alwaysReopen = false} = {}) => {
    const active = db.activeRun(id, run.id),
      a = db.get(id);
    if (
      !sourceScan(active) ||
      operationFor(db.template(a.templateId), active.operation).effect !== 'read'
    )
      throw Error('Sayfa yeniden kontrolü yalnızca salt okuma kaynak taramasında kullanılabilir.');
    let result = await inspect();
    if (result.url !== url) throw Error('Sekme adresi değişti. Güncel sayfayı kontrol et.');
    if (
      (result.readiness?.loading || alwaysReopen) &&
      !rechecked.has(url) &&
      !db.run(run.id).siteWait
    ) {
      rechecked.add(url);
      const response = await callBrowser(id, 'browser_reopen_readonly', {url}, run.id);
      result = await inspect({response});
    }
    if (result.readiness?.loading) {
      const issue = scanIssue(db, id, run.id, {
        url: result.url,
        kind: 'render_pending',
        evidence: result.readiness.reason,
        verified: true,
      });
      result = {
        ...result,
        technicalIssue: issue,
        nextStep:
          'This page did not finish loading in a fresh tab. The app will retry it later; process every other reachable pending detail or page first.',
      };
    } else {
      clearScanIssue(db, id, run.id, url);
      result = {...result, nextStep: 'Read the fresh document and continue.'};
    }
    return result;
  };
  const jevExecution = new JevExecution({waitMs: jevWaitMs});
  const executeJev = (args, extraPorts = {}) =>
    jevExecution.run(args, async (onTask, args) => {
      const active = db.activeRun(id, run.id),
        a = db.get(id);
      const research = active.kind === 'interview',
        scope = active.taskId ?? run.id;
      const actions = {
        observe: 'browser_snapshot',
        open: 'browser_navigate',
        reopen: 'browser_reopen_readonly',
        fill: 'browser_jev_fill_fields',
        options: 'browser_jev_list_options',
        suggestions: 'browser_jev_list_suggestions',
        select: 'browser_jev_select_option',
        autocomplete: 'browser_jev_autocomplete',
        click: 'browser_jev_click',
        scroll: 'browser_jev_scroll',
        reveal: 'browser_jev_reveal',
      };
      const searchId = active.scan?.work?.activeSearchId ?? 'default';
      const operation = args.taskId
        ? db.jevTasks.get(id, scope, args.taskId).input.operation
        : args.operation;
      let documents;
      if (
        db.template(a.templateId).recordOperations?.score &&
        ['scan_results', 'collect_details', 'classify_results'].includes(operation)
      ) {
        try {
          documents = await scoringDocuments();
        } catch (error) {
          signal.throwIfAborted();
          db.activeRun(id, run.id);
          if (
            db.get(id).revision !== a.revision ||
            db.get(id).referenceData?.profile?.cvPath !== a.referenceData?.profile?.cvPath
          )
            throw error;
          documents = {
            unavailable:
              'The user documents could not be read; use known facts and keep missing qualifications uncertain.',
          };
        }
      }
      let result = await runJevTask({
        store: db.jevTasks,
        owner: id,
        taskId: scope,
        input: args,
        signal,
        criteria: jevCriteria(a, documents, db.template(a.templateId).assessmentHints),
        ports: {
          onTask,
          sourceUrl: sourceScan(active) ? active.sourceUrl : null,
          assignedRecord:
            active.recordId && !batchScoring(active) ? db.result(id, active.recordId) : null,
          searchId,
          hasPage: () => Boolean(readerPage) || browser.hasPage(),
          reviewFinalBatch: Boolean(sourceScan(active)),
          recoverDetails: Boolean(sourceScan(active)),
          resolveDetails: (input) => {
            const current = db.activeRun(id, run.id),
              explicit = input.urls ?? (input.url ? [input.url] : []);
            const queued = sourceScan(current)
              ? (scanWork(current).searches.find((s) => s.id === searchId)?.pendingUrls ?? [])
              : [];
            const available = queued.filter(
              (url) =>
                !db.jevTasks.detailWait(id, scope, url) && !db.siteAccess.status(url)?.waiting,
            );
            const pendingUrls = (available.length ? available : queued).slice(0, 100);
            const observedUrls = [
              ...(current.navigation ?? []).map((n) => n.url),
              ...(current.observedLinks ?? []),
              ...db.jevTasks.observedUrls(id, scope, searchId),
            ];
            const savedUrls =
              explicit.length && sourceScan(current)
                ? db
                    .knownResults(id, run.id, explicit)
                    .filter((r) => r.known)
                    .map((r) => r.key)
                : [];
            return jevDetailItems(input, {
              assignedRecord:
                current.recordId && !batchScoring(current) ? db.result(id, current.recordId) : null,
              assignedRecords: batchScoring(current)
                ? current.recordIds.map((itemId) => db.result(id, itemId))
                : undefined,
              pendingUrls,
              observedUrls: [...observedUrls, ...(explicit.length ? queued : [])],
              savedUrls,
            });
          },
          authorize: async (operation) => {
            if (
              collecting &&
              (!args.taskId ||
                db.jevTasks.get(id, scope, args.taskId).sourceCollector !== active.collector ||
                operation !== 'collect_details')
            )
              throw Error(
                'Bu kaynakta collect_source_page ile CLI verisini al; yalnızca dönen Jev görevini incele.',
              );
            if (
              ['score', 'verify'].includes(active.recordOperation) &&
              !['collect_details', 'classify_results'].includes(operation)
            )
              throw Error('Bu kayıt görevi yalnızca okuma ve ön değerlendirme yapabilir.');
            if (active.recordId && ['prepare_search', 'scan_results'].includes(operation))
              throw Error('Atanmış kayıt görevinde kaynak taraması yapılamaz.');
            if (operation === 'fill_form' && (research || (active.sourceUrl && !active.recordId)))
              throw Error('Form doldurma atanmış kayıt işinde kullanılmalı.');
          },
          assertActive: () => {
            signal.throwIfAborted();
            const current = db.activeRun(id, run.id);
            if ((current.scan?.work?.activeSearchId ?? 'default') !== searchId)
              throw Error('Etkin arama değişti; Jev görevi durduruldu.');
          },
          evaluate: (state, questions, abort) => browser.evaluateJev(id, state, questions, abort),
          browser: async (action, parameters) => {
            if (collecting)
              throw Error('CLI ilan içeriği değerlendirilemedi; API sayfası yeniden alınmalı.');
            if (!actions[action]) throw Error('Desteklenmeyen Jev işlemi');
            if (parameters.url) (research ? researchUrl : webUrl)(parameters.url);
            db.spendStep(id, run.id, {research});
            // A site extension's HTTP reader serves its addresses without a tab.
            const reader = ['open', 'reopen'].includes(action)
              ? siteReaderFor(parameters.url)
              : null;
            if (
              reader ||
              (action === 'observe' &&
                readerPage &&
                (!parameters.url || parameters.url === readerPage.url))
            ) {
              const page =
                action === 'observe'
                  ? readerPage
                  : await reader.read(parameters.url, {
                      signal,
                      siteAccess: db.siteAccess,
                      wait: (ms) => pause(ms, undefined, {signal}),
                    });
              readerPage = page;
              await inspect({research, response: readerResponse(page), jev: true});
              return page;
            }
            readerPage = null;
            let response = await callBrowser(id, actions[action], parameters, run.id);
            if (!response.jevPage) throw Error('Jev görev gözlemi alınamadı');
            if (
              operation === 'scan_results' &&
              ['scroll', 'reveal', 'click'].includes(action) &&
              !['no_progress', 'uncertain', 'stale', 'unsupported'].includes(
                response.jevPage.status,
              ) &&
              !response.jevPage.siteWait
            ) {
              const actionState = Object.fromEntries(
                ['status', 'executed', 'progress', 'verified', 'message']
                  .filter((key) => Object.hasOwn(response.jevPage, key))
                  .map((key) => [key, response.jevPage[key]]),
              );
              db.spendStep(id, run.id, {research});
              response = await callBrowser(id, 'browser_snapshot', {}, run.id);
              if (!response.jevPage) throw Error('Jev görev gözlemi alınamadı');
              response = {...response, jevPage: {...response.jevPage, ...actionState}};
            }
            await inspect({research, response, jev: true});
            return response.jevPage;
          },
          // Titles this scan's detail reading proved unrelated teach card triage
          // the user's boundaries; constraint rejections are listing-specific.
          detailExclusions: () => {
            const current = db.run(run.id);
            if (!sourceScan(current) || active.kind !== 'run') return [];
            return scanWork(current)
              .searches.flatMap((s) => s.excluded ?? [])
              .filter((e) => e.stage === 'detail' && e.reason === 'unrelated_role' && e.title)
              .slice(-30)
              .map((e) => e.title.slice(0, 120));
          },
          knownListings: (urls) => {
            const current = db.run(run.id);
            if (!sourceScan(current) || active.kind !== 'run') return [];
            return db.knownListingUrls(id, run.id, urls);
          },
          checkpoint: async (page, urls, options) => {
            if (!sourceScan(db.run(run.id)) || active.kind !== 'run') return;
            return saveJevCheckpoint(
              {db, id, runId: run.id, snapshot: snapshots.current},
              {sourceUrl: run.sourceUrl, now: db.now()},
              page,
              urls,
              options,
            );
          },
          reviewBatch: (task, items, decisions) =>
            reviewJevBatch(db, id, run.id, task.id, task.batch.id, decisions),
          progress: (summary) => {
            const current = db.activeRun(id, run.id);
            db.putRun({
              ...current,
              jevTask: {
                taskId: summary.taskId,
                operation: summary.operation,
                status: summary.status,
                steps: summary.steps,
                usage: summary.usage,
                total: summary.taskTotal ?? summary.total,
              },
            });
            changed(id);
          },
          ...(active.kind === 'trial' && operation === 'scan_results'
            ? {pageLimit: TRIAL_SCAN_PAGE_LIMIT}
            : {}),
          ...(active.kind === 'run' &&
          operation === 'scan_results' &&
          active.scanPlan?.mode === 'incremental' &&
          active.scanPlan?.ordering === 'recipe'
            ? {
                knownBoundaryPages: KNOWN_BOUNDARY_PAGES,
                knownBoundary: (page) => db.markKnownBoundary(id, run.id, page.url),
              }
            : {}),
          ...(active.kind === 'run' && operation === 'scan_results' && active.scanPlan?.pageCap
            ? {
                pageCap: active.scanPlan.pageCap,
                pageCapReached: (page) => db.markPageCap(id, run.id, page.url),
              }
            : {}),
          ...extraPorts,
        },
      });
      result = jevTaskReceipt(result);
      if (
        !collecting &&
        sourceScan(active) &&
        active.kind === 'run' &&
        ['collect_details', 'classify_results'].includes(operation) &&
        result.taskId
      )
        result = settleJevDetails(
          {db, id, runId: run.id, snapshot: snapshots.current},
          {scope, searchId},
          result,
        );
      if (snapshots.current)
        result = {...result, snapshot: {id: snapshots.current.id, url: snapshots.current.url}};
      if (
        result.issue?.reason === 'access_barrier' &&
        result.issue.siteWait &&
        active.sourceUrl &&
        !active.recordId &&
        ['run', 'trial'].includes(active.kind)
      )
        result = releaseBlockedSource({db, id, runId: run.id, report}, active.sourceUrl, result);
      return result;
    });
  const scoringDocuments = async () => {
    const before = db.get(id),
      value = await loadScoringDocuments(db, id);
    db.activeRun(id, run.id);
    if (
      signal.aborted ||
      db.get(id).revision !== before.revision ||
      db.get(id).referenceData?.profile?.cvPath !== before.referenceData?.profile?.cvPath
    )
      throw Error('Profil değişti; güncel puanlama bağlamını oku.');
    return value;
  };
  // Recipe check: open the first replayed search with Jev and require at least
  // one listing within two result pages. Result links that discovery cannot
  // confirm (redirects, tracking links) are proven by reading a few details.
  // Bounded polling, no coverage claim.
  const settleJev = async (first) => {
    let result = first,
      polls = 0;
    while (result.status === 'running') {
      if (++polls > 40) throw Error('Reçete kontrolü zaman aşımına uğradı.');
      signal.throwIfAborted();
      result = await executeJev({taskId: result.taskId});
    }
    return result;
  };
  // Listings the run already proved from the replayed address: a scan that
  // confirmed a link, or a detail of one of its links judged an opportunity.
  const provenListings = (replay, scope) => {
    const tasks = db.jevTasks.list(id, scope),
      scans = tasks.filter(
        (t) =>
          t.input?.operation === 'scan_results' &&
          t.status === 'completed' &&
          replayMatches(replay, t.input.url),
      );
    if (!scans.length) return null;
    const keys = new Set(
      scans.flatMap((t) => t.items.flatMap((i) => [i.url, ...(i.aliases ?? [])])).map(jevDetailKey),
    );
    const details = tasks
      .filter((t) => t.input?.operation === 'collect_details')
      .flatMap((t) => t.items)
      .filter((i) => keys.has(jevDetailKey(i.url)));
    const listings =
      scans.flatMap((t) => t.items).filter(jevListingItem).length +
      details.filter(jevListingItem).length;
    return listings
      ? {listings, pages: Math.max(...scans.map((t) => t.pages?.length ?? 1)), taskId: scans[0].id}
      : null;
  };
  const leadOrder = {listing: 0, uncertain: 1, other: 2};
  const checkRecipe = async (replay, scope) => {
    const first = replay.searches[0];
    let url = first.url;
    const proven = provenListings(replay, scope);
    if (proven) return {ok: true, ...proven, url, term: first.term, reused: true};
    if (replay.kind === 'search_form') {
      const prepared = await settleJev(
        await executeJev(
          {
            operation: 'prepare_search',
            url: first.url,
            answers: first.answers,
            goal: 'Apply the saved source search',
          },
          {pageLimit: 2},
        ),
      );
      if (prepared.issue?.reason === 'access_barrier')
        throw Error(
          'Erişim engeli: reçete kontrolü yapılamadı. ' + (prepared.issue.siteWait?.message ?? ''),
        );
      if (prepared.status !== 'completed')
        return {
          ok: false,
          reason: prepared.issue?.reason ?? prepared.status,
          url: first.url,
          term: first.term,
        };
      url = db.jevTasks.get(id, scope, prepared.taskId).currentUrl ?? first.url;
    }
    const scan = await settleJev(
      await executeJev({operation: 'scan_results', url}, {pageLimit: 2}),
    );
    if (scan.issue?.reason === 'access_barrier')
      throw Error(
        'Erişim engeli: reçete kontrolü yapılamadı. ' + (scan.issue.siteWait?.message ?? ''),
      );
    const task = scan.taskId ? db.jevTasks.get(id, scope, scan.taskId) : null,
      items = task?.items ?? [],
      listings = items.filter(jevListingItem).length;
    if (listings)
      return {
        ok: true,
        listings,
        pages: task.pages?.length ?? 1,
        url,
        term: first.term,
        taskId: scan.taskId,
      };
    const leads = items
      .filter((i) => i.discovery?.decision === 'uncertain' && i.pageKind !== 'results')
      .sort((a, b) => (leadOrder[a.discovery.choice] ?? 1) - (leadOrder[b.discovery.choice] ?? 1))
      .slice(0, RECIPE_CHECK_DETAILS);
    if (leads.length) {
      const details = await settleJev(
        await executeJev({operation: 'collect_details', urls: leads.map((l) => l.url)}),
      );
      if (details.issue?.reason === 'access_barrier')
        throw Error(
          'Erişim engeli: reçete kontrolü yapılamadı. ' + (details.issue.siteWait?.message ?? ''),
        );
      const read =
          (details.taskId ? db.jevTasks.get(id, scope, details.taskId)?.items : null) ?? [],
        confirmed = read.filter(jevListingItem).length;
      if (confirmed)
        return {
          ok: true,
          listings: confirmed,
          pages: task.pages?.length ?? 1,
          url,
          term: first.term,
          taskId: scan.taskId,
          detailsTaskId: details.taskId,
        };
      return {
        ok: false,
        reason: details.issue?.reason ?? 'no_listings',
        url,
        term: first.term,
        listings: 0,
        leads: leads.length,
      };
    }
    return {
      ok: false,
      reason: scan.issue?.reason ?? 'no_listings',
      url,
      term: first.term,
      listings: 0,
    };
  };
  // A saved finding retires its listing from the pending queue; Jev review
  // batches retire rejected items. The agent keeps no queue bookkeeping.
  const saveFinding = (input) => {
    const saved = db.record(id, run.id, recordResultInput(input)),
      current = db.activeRun(id, run.id);
    if (collecting) {
      if (!saved.skipped && saved.assessment?.runId !== run.id)
        throw Error('Kayıt başka bir görevde; bu değerlendirme henüz kaydedilmedi.');
      collectorSaved(db, current, input.url, {skipped: saved.skipped});
    } else if (sourceScan(current) && current.kind === 'run') {
      const done = [input.url, saved.url, saved.key].filter((url) =>
        (current.scan?.pendingUrls ?? []).includes(url),
      );
      if (done.length)
        db.saveScanProgress(
          id,
          run.id,
          {
            pendingUrls: [],
            processedUrls: done,
            reason: saved.skipped ? saved.message : 'Kayıt kaydedildi.',
            ...(current.scanPlan?.checkpoint?.cursor
              ? {cursor: current.scanPlan.checkpoint.cursor}
              : {}),
          },
          snapshots.current,
        );
    }
    return recordReceipt(saved);
  };
  const performCall = async (owner, session, name, args) => {
    if (owner !== id || session !== run.id || signal.aborted)
      throw Error('Otomasyon oturumu geçersiz');
    let active = db.activeRun(id, run.id);
    const a = db.get(id);
    let result;
    if (collecting && collectorHidden.has(name))
      throw Error('Bu kaynakta veriyi collect_source_page üzerinden al ve Jev grubunu incele.');
    // Jev owns the browser and selected queue while its request is pending.
    // Read-only inspection stays available; mutations wait for the same task.
    if (
      jevExecution.busy &&
      ![
        'browser_jev_run',
        'read_jev_task',
        'read_jev_brief',
        'read_jev_evidence',
        'get_automation_context',
        'read_automation_context_part',
        'search_automation_context',
        'read_scoring_profile',
        'get_automation_result',
        'get_workspace_history',
        'get_scan_queue',
        'lookup_scan_results',
        'browser_read_part',
        'browser_search',
      ].includes(name)
    )
      return jevExecution.receipt();
    if (isConversation(active) && !['reply_to_user', 'finish_automation_run'].includes(name)) {
      active = db.putRun({
        ...active,
        chatActivity: {label: conversationToolLabel(name), at: db.now()},
      });
      changed(id);
    }
    if (active.recordOperation === 'score' && scoreWrites.has(name))
      throw Error('Puanlama görevi yalnızca değerlendirme kaydedebilir');
    if (workspaceTableTools.some((t) => t.name === name)) {
      const value = workspaceTableCall(db.store, id, name, args);
      changed(id);
      return name === 'get_workspace_records' ? context.capture(value) : value;
    }
    switch (name) {
      case 'collect_source_page': {
        if (!collecting) throw Error('Bu kaynak için CLI extension atanmadı.');
        let collected;
        try {
          collected = await collectSourcePage(db, run.id, {
            signal,
            readPage: collectorReadPage,
            readDetail: collectorReadDetail,
          });
        } catch (error) {
          signal.throwIfAborted();
          const current = db.activeRun(id, run.id);
          db.putRun({...current, collectorError: String(error.message).slice(0, 2000)});
          throw error;
        }
        if (!collected.issue && db.run(run.id).collectorError)
          db.putRun({...db.run(run.id), collectorError: null});
        changed(id);
        if (collected.complete || !collected.taskId) return collected;
        result = {
          ...(await executeJev({taskId: collected.taskId})),
          collector: active.collector,
          progress: collectorProgress(db.run(run.id)),
        };
        break;
      }
      case 'read_scoring_profile': {
        const source =
          args.source === 'documents' ? await scoringDocuments() : scoringSources(a)[args.source];
        if (!source) throw Error('Geçerli puanlama kaynağı seç.');
        const offset = args.offset ?? 0,
          limit = args.limit ?? 6000;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > source.text.length ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 6000
        )
          throw Error('Geçersiz kaynak metin aralığı.');
        return {
          ...source,
          source: args.source,
          text: source.text.slice(offset, offset + limit),
          offset,
          totalCharacters: source.text.length,
          nextOffset: offset + limit < source.text.length ? offset + limit : null,
        };
      }
      case 'read_jev_task': {
        db.jevTasks.get(id, active.taskId ?? run.id, args.taskId);
        if (jevExecution.owns(args.taskId)) {
          const value = await jevExecution.wait();
          if (value.status === 'running' || value.parent?.stop) return value;
        }
        return jevTaskSummary(db.jevTasks.get(id, active.taskId ?? run.id, args.taskId), args);
      }
      case 'read_jev_brief': {
        if (jevExecution.busy) return jevExecution.receipt();
        const ids = args.evidenceIds ?? (args.evidenceId ? [args.evidenceId] : []);
        if (!ids.length || (args.evidenceIds && args.evidenceId))
          throw Error(
            'arguments.evidenceId: Send evidenceId for one brief or evidenceIds for several, not both.',
          );
        const scope = active.taskId ?? run.id,
          searchId = active.scan?.work?.activeSearchId ?? 'default';
        let documents;
        try {
          documents = await scoringDocuments();
        } catch {
          documents = {
            unavailable:
              'The user documents could not be read; facts they would prove remain unknown.',
          };
        }
        const deadline = Date.now() + jevExecution.waitWindow,
          criteria = jevCriteria(a, documents, db.template(a.templateId).assessmentHints);
        const briefFor = (evidenceId, offset, waitMs) => {
          const evidence = db.jevTasks.fullEvidence(id, scope, evidenceId);
          const task = db.jevTasks
            .list(id, scope)
            .find((t) => t.items.some((i) => i.evidenceId === evidence.id));
          if (!task || task.searchId !== searchId)
            throw Error('Jev özeti etkin aramadaki bir ilana ait olmalı.');
          return readJevBrief({
            store: db.jevTasks,
            owner: id,
            taskId: scope,
            evidenceId,
            offset,
            waitMs,
            criteria,
            signal,
            assertActive: () => {
              const current = db.activeRun(id, run.id);
              if ((current.scan?.work?.activeSearchId ?? 'default') !== searchId)
                throw Error('Etkin arama değişti; özet durduruldu.');
            },
            evaluate: (state, questions, abort) => browser.evaluateJev(id, state, questions, abort),
          });
        };
        if (!args.evidenceIds)
          return briefToolOutput(await briefFor(ids[0], args.offset, jevExecution.waitWindow));
        // Start every brief before waiting so the batch shares one wait budget.
        const briefs = new Map();
        const attempt = async (evidenceId, waitMs) => {
          try {
            briefs.set(evidenceId, await briefFor(evidenceId, 0, waitMs));
          } catch (error) {
            briefs.set(evidenceId, {
              status: 'error',
              evidenceId,
              error: String(error?.message ?? error),
            });
          }
        };
        for (const evidenceId of ids) await attempt(evidenceId, 0);
        for (const evidenceId of ids)
          if (briefs.get(evidenceId).status === 'running')
            await attempt(evidenceId, Math.max(0, deadline - Date.now()));
        // One hint for the batch; per-entry guidance would repeat it five times.
        const values = ids.map((evidenceId) => {
          const {next, ...value} = briefs.get(evidenceId);
          return value;
        });
        if (values.every((v) => v.status === 'error'))
          throw Error(
            values.map((v) => `arguments.evidenceIds (${v.evidenceId}): ${v.error}`).join('\n'),
          );
        return briefToolOutput({
          briefs: values,
          next: 'One entry per listing in the requested order. Use the original sections for assessment; absent facts stay unknown. Poll read_jev_brief again only for entries with status=running; read nextOffset pages per evidenceId; use read_jev_evidence only for a missing or conflicting detail.',
        });
      }
      case 'read_jev_evidence': {
        const scope = active.taskId ?? run.id,
          value = db.jevTasks.readEvidence(id, scope, args.evidenceId, args);
        return value;
      }
      case 'browser_jev_run':
        result = await executeJev(args);
        break;
      case 'ask_workspace_question': {
        if (batchScoring(active) && !args.recordId)
          throw Error('Toplu puanlamada soru için recordId belirt');
        if (active.recordId && args.recordId && !taskHasRecord(active, args.recordId))
          throw Error('Soru atanmış kayda ait olmalı');
        let accessCheck;
        if (active.kind !== 'interview' && asksForLogin(args)) {
          const previous = args.accessCheck && snapshots.get(args.accessCheck.snapshotId);
          if (!previous)
            throw Error(
              'Giriş sorusundan önce gerçek başvuru/görev bağlantısını takip et, browser_read ile kontrol et ve accessCheck ekle.',
            );
          validateLoginQuestion(previous, args.accessCheck);
          const fresh = await inspect(),
            page = snapshots.get(fresh.snapshot.id);
          if (page.url !== previous.url)
            throw Error(
              'Giriş kontrolü sırasında sayfa değişti. Güncel sayfayı browser_read ile incele ve göreve devam et; eski giriş engelini tekrarlama.',
            );
          accessCheck = {
            ...validateLoginQuestion(page, {...args.accessCheck, snapshotId: page.id}),
            checkedAt: db.now(),
          };
        }
        result = db.askQuestion(
          id,
          {
            ...args,
            ...(accessCheck
              ? {accessCheck, fields: args.fields?.length ? args.fields : [LOGGED_IN_FIELD]}
              : {}),
            ...(active.recordId ? {recordId: args.recordId ?? active.recordId} : {}),
          },
          {runId: run.id},
        );
        break;
      }
      case 'read_automation_context_part':
        return context.read(args);
      case 'browser_read_part':
        return readBrowserEvidence({db, run: active, snapshots, method: 'read', args});
      case 'browser_search':
        return readBrowserEvidence({db, run: active, snapshots, method: 'search', args});
      case 'get_scan_queue':
        return scanToolOutput(db.scanQueue(id, run.id, args), {
          limit: args.limit ?? 25,
          summary: args.view !== 'entries',
        });
      case 'complete_scan_search': {
        const page = args.snapshotId ? snapshots.get(args.snapshotId) : snapshots.current;
        if (!page) throw Error('Önce son sonuç sayfasını gözle.');
        result = db.completeScanSearch(id, run.id, args.completion, page);
        break;
      }
      case 'save_source_recipe': {
        if (!active.sourceUrl || active.recordId || !['trial', 'run'].includes(active.kind))
          throw Error('Reçete yalnızca atanmış kaynak görevinde kaydedilir.');
        const recipe = normalizeSourceRecipe(args),
          sourceUrl = active.sourceUrl;
        if (recipe.entry.kind === 'discovery') {
          db.learnSourceRecipe(id, sourceUrl, recipe, {runId: run.id, verified: false});
          db.putRun({...db.activeRun(id, run.id), recipeSaved: true});
          result = {
            saved: true,
            status: 'discovery',
            next: 'The source stays in discovery mode: every scan searches the board itself. Continue this turn normally.',
          };
          break;
        }
        const checks = active.recipeChecks ?? 0;
        if (checks >= 3)
          throw Error(
            'Bu turda 3 reçete kontrolü yapıldı. Doğrulanamıyorsa entry.kind=discovery ile kısa bir not kaydet ve turu normal şekilde bitir.',
          );
        db.putRun({...db.activeRun(id, run.id), recipeChecks: checks + 1});
        const replay = recipeReplay(recipe, recipeValues(a, sourceUrl)),
          check = await checkRecipe(replay, active.taskId ?? run.id);
        if (!check.ok)
          throw Error(
            `Reçete doğrulanamadı: ${check.reason} (${check.url}). ${2 - checks} kontrol hakkı kaldı. ${recipe.terms ? '' : 'Kaynak sorgusu bir anahtar kelime değilse terms ile somut arama terimleri ver. '}Şablonu veya form etiketlerini düzelt; kalıcı bir yöntem yoksa entry.kind=discovery kaydet.`,
          );
        db.learnSourceRecipe(id, sourceUrl, recipe, {
          runId: run.id,
          verified: true,
          listings: check.listings,
          pages: check.pages,
        });
        db.putRun({...db.activeRun(id, run.id), recipeSaved: true});
        result = {
          saved: true,
          status: 'verified',
          url: check.url,
          ...(check.term ? {term: check.term, searches: replay.searches.length} : {}),
          listings: check.listings,
          pages: check.pages,
          ...(check.reused
            ? {
                reused: true,
                note: 'Verified from listings this turn already read at the replayed address; no page was reopened.',
              }
            : {}),
          ...(check.detailsTaskId
            ? {
                detailsTaskId: check.detailsTaskId,
                note: 'Discovery could not confirm the result links; reading details proved them.',
              }
            : {}),
          next:
            active.kind === 'trial'
              ? 'Recipe verified and saved. Read one representative detail from the found listings, then finish the trial.'
              : 'Recipe verified and saved. Continue the scan from the found listings with collect_details using the returned scan task.',
        };
        break;
      }
      case 'get_automation_context': {
        const value = scanToolOutput(automationTaskContext(db, id, active, args), {summary: true});
        if (isConversation(active) && !args.section)
          db.putRun({...active, contextVersion: conversationContextVersion(a)});
        return context.capture(value);
      }
      case 'get_workspace_history':
        return context.capture(workspaceHistory(db, id, args));
      case 'get_automation_result':
        return context.capture(db.result(id, args.itemId));
      case 'save_automation_plan': {
        if (active.kind !== 'interview')
          throw Error('Plan yalnızca kurulum sohbetinde değişebilir');
        const plan = {
          ...args,
          criteria: Object.fromEntries(args.criteria.map((f) => [f.key, f.value])),
        };
        result = isConversation(active)
          ? db.saveConversationPlan(id, run.id, plan)
          : db.save(id, plan, {agent: true});
        break;
      }
      case 'reply_to_user':
        result = db.message(id, 'assistant', args.message, {
          runId: run.id,
          conversation: active.kind === 'interview',
        });
        break;
      case 'research_automation_source': {
        db.spendStep(id, run.id, {research: true});
        const url = researchUrl(args.url);
        snapshots.invalidate();
        const response = await callBrowser(id, 'browser_navigate', {url}, run.id);
        if (response.isError)
          throw Error(
            'Araştırma sayfası açılamadı: ' + JSON.stringify(response.content).slice(0, 1000),
          );
        result = await inspect({research: true, ...(response.pageContext ? {response} : {})});
        break;
      }
      case 'record_automation_score':
        result = saveRecordScore(db, id, run.id, args);
        break;
      case 'record_automation_result':
        result = saveFinding(args);
        break;
      case 'record_automation_results': {
        const records = [],
          skippedRecords = [],
          failed = [];
        for (const [index, entry] of args.records.entries()) {
          try {
            const receipt = saveFinding(entry);
            if (receipt.skipped) skippedRecords.push({index, ...receipt});
            else records.push(receipt);
          } catch (error) {
            failed.push({index, key: entry?.key, error: String(error?.message ?? error)});
          }
        }
        if (!records.length && !skippedRecords.length)
          throw Error(failed.map((f) => `arguments.records[${f.index}]: ${f.error}`).join('\n'));
        result = {
          saved: records.length,
          records,
          ...(skippedRecords.length ? {skipped: skippedRecords.length, skippedRecords} : {}),
          ...(failed.length
            ? {
                failed,
                next: 'Resend only the failed entries after correcting them; saved and skipped entries are final.',
              }
            : {}),
        };
        break;
      }
      case 'reserve_automation_action':
        result = db.reserve(id, run.id, args.itemId);
        break;
      case 'record_automation_outcome': {
        // The app knows the assigned record and the observed page; the agent
        // names them only when it reports on something else.
        args = {itemId: active.recordId ?? undefined, url: snapshots.current?.url, ...args};
        if (!args.itemId) throw Error('itemId gerekli: bu görevde atanmış tek kayıt yok');
        if (!args.url) throw Error('Önce sonuç sayfasını tarayıcıda gözlemle');
        let page, fresh;
        if (args.status === 'not_submitted') {
          const previous = snapshots.get(args.notSubmittedProof?.snapshotId);
          if (previous.url !== args.url) throw Error('Kanıt adresi güncel sayfayla eşleşmiyor');
          fresh = await inspect();
          page = snapshots.get(fresh.snapshot.id);
        }
        try {
          result = db.resolve(id, run.id, args.itemId, args, page);
        } catch (error) {
          if (!fresh) throw error;
          return {
            ...fresh,
            status: 'evidence_rejected',
            saved: false,
            error: error.message,
            message:
              'Kanıt kabul edilmedi; kayıt değiştirilmedi. Dönen güncel sayfayı ve snapshot.id değerini kullan. Alıntıyı görünür metinden aynen al; ayraç veya eksik metin ekleme.',
          };
        }
        break;
      }
      case 'browser_open': {
        const research = active.kind === 'interview';
        db.spendStep(id, run.id, {research});
        const url = research ? researchUrl(args.url) : webUrl(args.url);
        snapshots.invalidate();
        const response = await callBrowser(id, 'browser_navigate', {url}, run.id);
        if (response.isError)
          throw Error('Sayfa açılamadı: ' + JSON.stringify(response.content).slice(0, 1000));
        result = await inspect({research, ...(response.pageContext ? {response} : {})});
        if (
          result.readiness?.loading &&
          sourceScan(active) &&
          operationFor(db.template(a.templateId), active.operation).effect === 'read'
        )
          result = await recheckPage(result.url);
        break;
      }
      case 'browser_jev_tabs':
      case 'browser_jev_use_tab':
      case 'browser_jev_close_tab': {
        if (
          !(
            (active.sourceUrl && !active.recordId) ||
            (active.recordOperation && name !== 'browser_jev_close_tab')
          )
        )
          throw Error(
            'Sekme devri yalnızca kaynak taraması veya atanmış kayıt görevinde kullanılabilir',
          );
        if (name !== 'browser_jev_tabs') snapshots.invalidate();
        const response = await callBrowser(id, name, args, run.id);
        if (response.isError) throw Error('Kaynak sekmesi işlemi tamamlanamadı');
        result = name === 'browser_jev_use_tab' ? await inspect({response}) : response;
        break;
      }
      case 'browser_read': {
        const research = active.kind === 'interview';
        db.spendStep(id, run.id, {research});
        result = await inspect({research});
        if (
          result.readiness?.loading &&
          sourceScan(active) &&
          operationFor(db.template(a.templateId), active.operation).effect === 'read'
        )
          result = await recheckPage(result.url);
        break;
      }
      case 'browser_jev_inspect_form': {
        const research = active.kind === 'interview',
          url = await browser.currentUrl(id);
        if (research) researchUrl(url);
        else webUrl(url);
        db.spendStep(id, run.id, {research});
        snapshots.invalidate();
        result = await callBrowser(id, name, {}, run.id);
        break;
      }
      case 'browser_upload_document': {
        if (active.recordOperation !== 'execute' || active.actionId !== active.recordId)
          throw Error('Belge yüklemeden önce bu kayıt için gönderim rezervasyonu gerekli');
        const item = db.result(id, active.recordId),
          base = workspace && (await realpath(workspace));
        if (!base) throw Error('Çalışma alanı dosya dizini bulunamadı');
        const file = await realpath(path.resolve(base, args.filePath)),
          relative = path.relative(base, file);
        if (
          relative.startsWith('..' + path.sep) ||
          path.isAbsolute(relative) ||
          !(await stat(file)).isFile()
        )
          throw Error('Yalnızca bu çalışma alanındaki belgeler yüklenebilir');
        // Drafts name documents by file name; the folder they live in is the app's.
        if (
          !item.proposal.includes(relative) &&
          !item.proposal.includes(file) &&
          !item.proposal.includes(path.basename(file))
        )
          throw Error('Belge onaylanan taslakta yok; yeni taslak ve onay gerekli');
        db.spendStep(id, run.id);
        snapshots.invalidate();
        const response = await callBrowser(
          id,
          'browser_upload_document',
          {ref: args.ref, filePath: file},
          run.id,
        );
        if (response.isError)
          throw Error('Belge yüklenemedi: ' + JSON.stringify(response.content).slice(0, 1000));
        result = {...(await inspect()), action: response.action};
        break;
      }
      case 'browser_interact': {
        const research = active.kind === 'interview';
        db.spendStep(id, run.id, {research});
        if (['scroll', 'reveal', 'options'].includes(args.operation)) {
          const url = await browser.currentUrl(id);
          if (research) researchUrl(url);
          else webUrl(url);
          const tool =
            args.operation === 'scroll'
              ? 'browser_jev_scroll'
              : args.operation === 'reveal'
                ? 'browser_jev_reveal'
                : 'browser_jev_options';
          const parameters =
            args.operation === 'options'
              ? {ref: args.ref}
              : {
                  controlId: args.ref,
                  ...(args.operation === 'scroll' ? {direction: args.direction ?? 'down'} : {}),
                };
          snapshots.invalidate();
          const response = await callBrowser(id, tool, parameters, run.id);
          if (response.isError)
            throw Error(
              'Tarayıcı adımı tamamlanamadı: ' + JSON.stringify(response.content).slice(0, 1000),
            );
          result =
            args.operation === 'options'
              ? snapshots.capture({url, content: response.content})
              : {...(await inspect({research})), action: response.action};
          break;
        }
        await inspect({research});
        const parameters = {element: 'Observed target', target: args.ref};
        let operation;
        if (args.operation === 'click') operation = 'browser_click';
        else if (args.operation === 'type') {
          if (typeof args.text !== 'string') throw Error('Yazılacak metin gerekli');
          operation = 'browser_type';
          parameters.text = args.text;
          parameters.submit = false;
        } else if (args.operation === 'select') {
          const value = typeof args.text === 'string' ? args.text : args.option;
          if (typeof value !== 'string')
            throw Error(
              'select için text gerekli: seçeneğin tam etiketi veya değeri (browser_interact operation=options ile listele)',
            );
          operation = 'browser_select_option';
          parameters.values = [value];
        } else if (args.operation === 'press') {
          if (!args.key?.trim()) throw Error('Tuş gerekli');
          operation = 'browser_target_press';
          parameters.ref = args.ref;
          parameters.key = args.key;
        } else if (args.operation === 'autocomplete') {
          operation =
            args.option === undefined ? 'browser_jev_list_suggestions' : 'browser_jev_autocomplete';
          parameters.controlId = args.ref;
          if (args.text !== undefined) parameters.text = args.text;
          if (args.option !== undefined) parameters.option = args.option;
        } else throw Error('Desteklenmeyen etkileşim');
        snapshots.invalidate();
        const response = await callBrowser(id, operation, parameters, run.id);
        if (response.isError)
          throw Error(
            'Tarayıcı adımı tamamlanamadı; sonucu kontrol et: ' +
              JSON.stringify(response.content).slice(0, 1000),
          );
        result = {
          ...(await inspect({research})),
          ...(response.action ? {action: response.action} : {}),
        };
        break;
      }
      case 'finish_automation_run':
        return finishAutomationRun({
          db,
          id,
          run,
          active,
          automation: a,
          args,
          collecting,
          snapshot: snapshots.current,
          report,
        });
      default:
        throw Error('Bilinmeyen otomasyon aracı');
    }
    changed(id);
    return name === 'complete_scan_search' ? scanToolOutput(result, {summary: true}) : result;
  };
  return {
    normalizeToolArgs: normalizeRecordToolArgs,
    guardToolCall:
      run.taskId && run.kind !== 'interview'
        ? recordToolGuard({db, run, report, changed})
        : undefined,
    assertOwner: (owner) => {
      if (owner !== id) throw Error('Otomasyon oturumu geçersiz');
      db.get(owner);
    },
    tools: scopedTools,
    call(owner, session, name, args) {
      // A provider may issue a parallel batch. This run owns one current search,
      // context and browser snapshot: advance those in call order, then recheck
      // authorization and cancellation when each queued call actually starts.
      const pending = calls
        .catch(() => {})
        .then(() => performCall(owner, session, name, normalizeRecordToolArgs(name, args)));
      calls = pending;
      return pending;
    },
  };
}

export async function launchAutomationWorker({
  data,
  db,
  run,
  automation,
  onEvent,
  signal,
  browser,
  report,
  changed,
  onOutput = () => {},
  agents,
  mcp,
}) {
  const workerId = run.workerId ?? 'main',
    directory = path.join(data, 'automations', 'runs', run.id),
    workspace = workspaceDirectory(data, db.store.workspaces.get(automation.id));
  await mkdir(path.join(workspace, 'documents'), {recursive: true, mode: 0o700});
  await mkdir(directory, {recursive: true, mode: 0o700});
  const cwd = await realpath(workspace),
    runtime = path.join(directory, 'runtime');
  await mkdir(runtime, {recursive: true, mode: 0o700});
  await writeWorkspaceInstructions(cwd, AUTOMATION_INSTRUCTIONS);
  const initialJevTokens = jevTokenTotal(db.jevTasks.list(automation.id, run.taskId ?? run.id));
  let closing = false,
    closed = false,
    token;
  const close = async () => {
    if (closed) return;
    if (closing) throw Error('Oturum kapanışı sürüyor');
    closing = true;
    try {
      await agents.stop(automation.id, workerId, {
        settle: () => browser.waitForOperations?.(automation.id),
      });
      const agentTokens =
        (await agents.tokenUsage?.(automation.id, workerId, {
          since: run.startedAt,
          until: Date.now(),
        })) ?? null;
      const jevTokens = Math.max(
        0,
        jevTokenTotal(db.jevTasks.list(automation.id, run.taskId ?? run.id)) - initialJevTokens,
      );
      db.putRun({...db.run(run.id), tokenUsage: runTokenUsage(agentTokens, jevTokens)});
      changed?.(automation.id);
      mcp.revoke(token);
      await writeFile(
        path.join(directory, 'terminal.log'),
        Buffer.from(agents.output(automation.id, workerId).bytes).subarray(-150000),
        {mode: 0o600},
      );
      await rm(path.join(runtime, 'mcp.json'), {force: true});
      closed = true;
    } finally {
      closing = false;
    }
  };
  try {
    // A trial may use a stronger model: it discovers the source once; scans replay the recipe.
    const trialSettings = (s) =>
      run.kind === 'trial' && s?.trialModel ? {...s, model: s.trialModel} : s;
    const persistent = run.kind === 'interview',
      history = persistent
        ? setupAgentHistory(db, automation.id)
        : db.store.workspaces.history(automation.id, workerId),
      settings = trialSettings(
        persistent ? setupAgentSettings(db, automation.id) : automation.agentSettings,
      );
    const provider = withAgentDefaults(settings ?? {}).provider;
    const flow = automationWorkflow({
      workspace: cwd,
      db,
      run,
      signal,
      browser,
      report,
      changed,
      jevWaitMs: () => jevWaitMsFor(provider),
    });
    // A tool call the client dropped before the answer teaches the real limit.
    flow.clientAborted = (elapsedMs) => observeClientAbort(provider, elapsedMs);
    token = mcp.grant(automation.id, run.id, workerId, flow);
    if (signal.aborted) throw Error('Çalışma iptal edildi');
    const protocol = persistent
      ? null
      : automationProtocol(flow.tools, [
          AUTOMATION_INSTRUCTIONS,
          JEV_LAUNCH_INSTRUCTIONS,
          SCORING_INSTRUCTIONS,
          SOURCE_SCAN_INSTRUCTIONS,
        ]);
    const evidenceExpired = !persistent && automationEvidenceExpired(db, run);
    if (protocol) run = prepareAutomationProtocol(db, run, protocol);
    await agents.start({
      agentProfile: webAgentProfile(run.kind, settings),
      taskType: 'automation',
      persistent,
      rotateAtBoundary: !persistent,
      resume:
        persistent ||
        (Boolean(run.continuation) && run.continuation.resumeConversation !== false) ||
        (!run.recordOperation && run.kind === 'run' && !(run.sourceUrl && !run.recordId)),
      id: automation.id,
      worker: workerId,
      sessionId: run.id,
      settings,
      cwd,
      runtimeDirectory: runtime,
      endpoint: mcp.endpoint,
      token,
      history: automationRunHistory(
        db,
        persistent ? {...run, continuation: null} : run,
        history,
        null,
        protocol,
      ),
      currentSettings: () =>
        trialSettings(
          persistent ? setupAgentSettings(db, automation.id) : db.get(automation.id).agentSettings,
        ),
      approvedTools: flow.tools.map((t) => t.name),
      prompt: automationPrompt(
        run,
        isConversation(run) ? conversationRequest(db, automation.id, run) : null,
        {evidenceExpired},
      ),
      onEvent: (event) => {
        if (event.event === 'output') onOutput(event.bytes);
        if (!closing) onEvent(event);
      },
      onSettled: () => {
        if (!closing)
          onEvent({
            event: 'state',
            state: agents.sessions?.get(workerKey(automation.id, workerId))?.state ?? 'Idle',
          });
      },
      onRetire: () => mcp.revoke(token),
      onRecord: (kind, value) => db.event(automation.id, kind, value),
    });
    return {
      close,
      isBusy: () => agents.contextBusy?.(automation.id, workerId) ?? false,
      state: () => agents.sessions?.get(workerKey(automation.id, workerId))?.state,
      message: (text) => agents.message(automation.id, text, workerId),
      input: (text) => agents.input(automation.id, text, workerId, run.id),
      resize: (rows, cols) => agents.resize(automation.id, rows, cols, workerId, run.id),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
