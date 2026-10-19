import {taskHasRecord, batchScoring} from '../records/task-scope.mjs';
import {jevTokenTotal, runTokenUsage} from '../agents/run-token-usage.mjs';
import {loadScoringDocuments, scoringSources} from '../scoring/profile.mjs';
import {jevCriteria} from '../jev/triage.mjs';
import {reviewJevBatch} from '../jev/review.mjs';
import {readJevBrief} from '../jev/brief.mjs';
import {jevWaitMsFor, observeClientAbort} from '../jev/execution.mjs';
import {withAgentDefaults, agentDecides} from '../agents/settings.mjs';
import {otherScanSearchesPending, scanWork, activeSearch} from '../sources/scan-work.mjs';
import {
  siteKey,
  sameSite,
  runSiteLane,
  SiteWaitError,
  siteDomainOf,
} from '../browser/site-access.mjs';
import {collectorRun, collectorExtension} from '../sources/collectors.mjs';
import {
  collectSourcePage,
  collectorSaved,
  collectorProgress,
  collectorPageReady,
  prefetchCollectorPage,
  prepareCollection,
} from '../sources/collector-worker.mjs';
import {
  siteReaderFor,
  siteExtensionFor,
  siteExtensionKind,
  siteListingAddress,
} from '../site-extensions/index.mjs';
import {siteSearchRecipe} from '../site-extensions/search.mjs';
import {setTimeout as pause} from 'node:timers/promises';
import {readRecordListings} from '../records/listing-reader.mjs';
import {noteSourceActivity, agentStepLabel} from '../sources/source-activity.mjs';
import {jevDetailKey} from '../jev/detail-urls.mjs';
import {
  recordResultInput,
  saveRecordScore,
  normalizeRecordToolArgs,
} from '../scoring/record-scoring.mjs';
import {recordToolGuard} from '../records/tool-guard.mjs';
import {
  isSubmitLabel,
  SUBMIT_SCREENSHOT_NOTE,
  clickTargetLabel,
  classifySubmission,
  assertSubmitAllowed,
  submissionGuidance,
} from '../records/submission.mjs';
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
  requestCoverLetter,
  coverLetterBrief,
  saveCoverLetter,
  finishCoverLetter,
  coverLetterFields,
  coverLetterUploaded,
  mergeCoverLetterFields,
  coverLetterStep,
} from './cover-letters.mjs';
import {renderCoverLetterPdf} from './cover-letter-pdf.mjs';
import {
  contactBrief,
  saveRecordContacts,
  reserveContactAction,
  recordContactOutcome,
  contactClick,
  contactSendClicked,
  finishContactTask,
} from './contacts.mjs';
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
import {JEV_LAUNCH_INSTRUCTIONS, AGENT_LAUNCH_INSTRUCTIONS} from '../jev/task-tools.mjs';
import {
  normalizeSourceRecipe,
  recipeNeedsTerms,
  recipeReplay,
  recipeValues,
  jevListingItem,
  replayMatches,
  SCAN_SEARCH_LISTINGS,
} from '../sources/recipe.mjs';
import {scopedAutomationTools, collectorHidden, scoreWrites} from './tools.mjs';
import {pageObservation, researchUrl, unchangedPageContent} from './page-content.mjs';
import {automationPrompt} from './prompts.mjs';
import {finishAutomationRun} from './finish.mjs';
import {saveJevCheckpoint, settleJevDetails, releaseBlockedSource} from './jev-scan.mjs';
import {saveJevProfile, jevProfileView} from '../jev/qualification-profile.mjs';
// A recipe check reads this many uncertain leads when discovery confirms none.
const RECIPE_CHECK_DETAILS = 3;
// One collect_source_page call reads on past at most this many pages that held
// only listings the workspace already recorded or rejected.
const KNOWN_COLLECTOR_PAGES = 20;
// A trial checks access and learns the recipe; it never scans a whole board.
const samePath = (a, b) => {
  try {
    const x = new URL(a),
      y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
};
const TRIAL_SCAN_PAGE_LIMIT = 2;
// Pages a card collector opens in the user's (logged-in) browser: 12-20 s
// apart, about a person reading postings, and at most 120 an hour per site,
// counted apart from the site's API budget, since these views belong to the
// user's account. A site extension's own pacing replaces these.
export const BROWSER_PACING = {
  minIntervalMs: 12000,
  jitterMs: 8000,
  budget: {requests: 120, windowMs: 60 * 60000},
};
// A new step forgets the previous one's posting, wait and tool.
const IDLE_STEP = {
  done: null,
  total: null,
  title: null,
  company: null,
  waitUntil: null,
  browser: false,
};
const BACKGROUND_READ =
  'The app reads the next result page and its listings itself, at the pace this site allows; that can take many minutes. End this turn now: do not call finish_automation_run or any other tool. The app resumes you with the ready review batch.';
// Another results page of the active search: same address shape as the last
// page it served (numbers may differ, as in ?page=7 or /page/7), not that page.
const laterResultsPage = (run, url) => {
  const last = activeSearch(scanWork(run))?.pageProgress?.url;
  if (!last || last === url) return false;
  try {
    const shape = (u) => u.origin + u.pathname.replace(/\d+/g, '#').replace(/\/$/, '');
    return shape(new URL(last)) === shape(new URL(url));
  } catch {
    return false;
  }
};
const UNSERVED_PAGE =
  ' [The site does not serve this results page: it failed to load again while the earlier pages of this search loaded. The app ended this search at the last page served. Finish its queue and call complete_scan_search with completion=end; do not open this page again.]';
// Click targets keep the page's raw spacing; form inspection collapses it.
const spaced = (label) =>
  String(label ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function automationWorkflow({
  workspace,
  db,
  run,
  signal,
  browser,
  report,
  changed = () => {},
  jevWaitMs = 30000,
  submitSettleMs = 2000,
  collectorReadPage,
  collectorReadDetail,
  renderPdf = renderCoverLetterPdf,
}) {
  const id = run.automationId,
    snapshots = new BrowserSnapshot(),
    context = new AutomationContext();
  const collecting = Boolean(collectorRun(db.get(id), run));
  // Read once per run: changing the setting restarts the worker with new tools.
  const decideByAgent = agentDecides(db.get(id).agentSettings);
  const scopedTools = scopedAutomationTools({
    run,
    template: db.template(db.get(id).templateId),
    collecting,
    agentDecides: decideByAgent,
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
      if (
        issue.verified &&
        !issue.global &&
        laterResultsPage(active, url) &&
        db.markUnservedPage(id, run.id, url)
      ) {
        error.message += UNSERVED_PAGE;
        changed(id);
        throw error;
      }
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
          const summary = `Page failed to load; will retry: ${url}`;
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
                ? ' Automatic retries stopped; restarting needs user action.'
                : ' The scan is on hold; take no other action this round.';
          }
        }
      }
      changed(id);
    }
    throw error;
  };
  let stepWaited = false;
  const callBrowser = async (owner, name, args, session, options) => {
    if (args.url) attemptedUrl = args.url;
    const current = db.activeRun(id, run.id);
    if (args.url && current.scanPlan?.boundary?.unserved === args.url)
      throw Error(`Not opened: ${args.url}.${UNSERVED_PAGE}`);
    const issue = current.scanIssues?.[attemptedUrl];
    if (issue?.kind === 'browser_error' && issue.attempts >= 3)
      throw Error(
        `This address repeatedly failed to load: ${attemptedUrl}. The app will retry it later; process the other pending addresses.`,
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
      // Whether the latest browser step was stopped by this run's shared site
      // wait; record recovery only resumes runs that ended on that wait. The
      // page the app reads after a stopped action belongs to the same step.
      const wait = response.siteWait ?? response.jevPage?.siteWait;
      stepWaited ||= Boolean(
        wait && (!run.sourceUrl || sameSite(run.sourceUrl, 'https://' + wait.site)),
      );
      if (Boolean(db.run(run.id).siteWaitBlocked) !== stepWaited)
        db.putRun({...db.run(run.id), siteWaitBlocked: stepWaited});
      return name === 'browser_navigate' && response.pageContext
        ? {...response, pageContext: {...response.pageContext, requestedUrl: args.url}}
        : response;
    } catch (error) {
      return browserError(error);
    }
  };
  const screenshot = async () => {
    try {
      const response = await browser.call(id, 'browser_screenshot', {}, run.id);
      return (response?.content ?? []).find((p) => p.type === 'image' && p.data) ?? null;
    } catch {
      return null;
    }
  };
  let lastSnapshot = null,
    lastVerification = null,
    formSubmits = null;
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
  // A shared site wait reported by any browser step belongs to this run when it
  // is the run's own site; the app resumes record work after the wait.
  const noteSiteWait = (response) => {
    if (
      response?.siteWait &&
      (!run.sourceUrl || sameSite(run.sourceUrl, 'https://' + response.siteWait.site))
    )
      db.putRun({...db.run(run.id), siteWait: response.siteWait});
  };
  const inspect = async ({research = false, response: provided, jev = false} = {}) => {
    snapshots.invalidate();
    const response =
        provided ??
        (await callBrowser(id, 'browser_snapshot', {}, run.id, {completeSnapshot: true})),
      observation = pageObservation(response);
    lastVerification = response.jevPage?.verification ?? null;
    // A CAPTCHA that renders after the submit click stopped that submission too.
    if (lastVerification?.state === 'required') {
      const active = db.run(run.id);
      if (
        active?.submission &&
        !active.submission.verification &&
        active.submission.outcome !== 'confirmed'
      )
        db.putRun({
          ...active,
          submission: {
            ...active.submission,
            verification: String(lastVerification.evidence ?? 'CAPTCHA'),
          },
        });
    }
    if (response.siteWait) {
      noteSiteWait(response);
      const saved = db.get(id),
        sourceState = {...saved.sourceState};
      for (const url of saved.sources)
        if (!run.recordId && siteKey(url) === response.siteWait.site)
          sourceState[url] = {...sourceState[url], siteBlocked: true};
      db.put({...saved, sourceState});
    }
    if (!observation)
      return browserError(Error('Could not get a page observation; check the browser connection'));
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
      throw Error('Page rechecks are only available in a read-only source scan.');
    let result = await inspect();
    if (result.url !== url) throw Error('The tab address changed. Check the current page.');
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
        fill: 'browser_fill_fields',
        options: 'browser_list_options',
        suggestions: 'browser_list_suggestions',
        select: 'browser_choose_option',
        autocomplete: 'browser_autocomplete',
        click: 'browser_click_target',
        scroll: 'browser_scroll',
        reveal: 'browser_reveal',
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
          if (db.get(id).revision !== a.revision) throw error;
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
        criteria: jevCriteria(a, documents, db.template(a.templateId)),
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
                'For this source, get the CLI data with collect_source_page; review only the returned Jev task.',
              );
            if (
              ['score', 'verify'].includes(active.recordOperation) &&
              !['collect_details', 'classify_results'].includes(operation)
            )
              throw Error('This record task can only read and pre-assess.');
            if (active.recordId && ['prepare_search', 'scan_results'].includes(operation))
              throw Error('An assigned record task cannot scan sources.');
            if (operation === 'fill_form' && (research || (active.sourceUrl && !active.recordId)))
              throw Error('Form filling must be used in an assigned record task.');
          },
          assertActive: () => {
            signal.throwIfAborted();
            const current = db.activeRun(id, run.id);
            if ((current.scan?.work?.activeSearchId ?? 'default') !== searchId)
              throw Error('The active search changed; the Jev task was stopped.');
          },
          decisions: decideByAgent ? 'agent' : 'jev',
          evaluate: decideByAgent
            ? null
            : (state, questions, abort) => browser.evaluateJev(id, state, questions, abort),
          browser: async (action, parameters) => {
            if (collecting)
              throw Error(
                'The CLI listing content could not be assessed; fetch the API page again.',
              );
            if (!actions[action]) throw Error('Unsupported Jev operation');
            if (parameters.url) (research ? researchUrl : webUrl)(parameters.url);
            db.spendStep(id, run.id, {research});
            // A site extension's HTTP reader serves its addresses without a tab.
            const reader = ['open', 'reopen'].includes(action)
              ? siteReaderFor(parameters.url)
              : null;
            const page =
              action === 'observe' &&
              readerPage &&
              (!parameters.url || parameters.url === readerPage.url)
                ? readerPage
                : reader
                  ? await reader.read(parameters.url, {
                      signal,
                      siteAccess: db.siteAccess.forLane(runSiteLane(run)),
                      wait: (ms) => pause(ms, undefined, {signal}),
                    })
                  : null;
            // A reader that cannot read this address (null) leaves it to the tab.
            if (page) {
              readerPage = page;
              await inspect({research, response: readerResponse(page), jev: true});
              return page;
            }
            readerPage = null;
            let response = await callBrowser(id, actions[action], parameters, run.id);
            if (!response.jevPage) throw Error('Could not get the Jev task observation');
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
              if (!response.jevPage) throw Error('Could not get the Jev task observation');
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
                listingLimit: SCAN_SEARCH_LISTINGS,
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
    if (signal.aborted || db.get(id).revision !== before.revision)
      throw Error('The profile changed; read the current scoring context.');
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
      if (++polls > 40) throw Error('The recipe check timed out.');
      signal.throwIfAborted();
      result = await executeJev({taskId: result.taskId});
    }
    return result;
  };
  // Listings the run already proved from the replayed address: a scan that
  // confirmed a link, or a detail of one of its links judged an opportunity.
  const provenListings = (replay, scope) => {
    const tasks = db.jevTasks.list(id, scope),
      // A scan paused for the agent's next choice already holds its selection.
      scans = tasks.filter(
        (t) =>
          t.input?.operation === 'scan_results' &&
          (t.status === 'completed' || t.decisions === 'agent') &&
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
  // A collector recipe is checked through the site's API: its first search
  // must return listings.
  const checkCollectorRecipe = async (replay) => {
    const collector = collectorExtension(db.get(id), run.sourceUrl).collector,
      url = collector.searchUrl(replay.searches[0].url),
      // Only the listing count matters here: a card site reads no listings.
      page = await (collectorReadPage ?? collector.readPage)(url, {
        signal,
        wanted: () => [],
        siteAccess: db.siteAccess,
        wait: (ms) => pause(ms, undefined, {signal}),
      });
    return page.jobs.length
      ? {ok: true, listings: page.jobs.length, pages: 1, url, term: replay.searches[0].term}
      : {ok: false, reason: 'the first page has no listings', url};
  };
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
          'Access blocked: the recipe check could not run. ' +
            (prepared.issue.siteWait?.message ?? ''),
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
        'Access blocked: the recipe check could not run. ' + (scan.issue.siteWait?.message ?? ''),
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
          'Access blocked: the recipe check could not run. ' +
            (details.issue.siteWait?.message ?? ''),
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
        throw Error('The record is in another task; this assessment was not saved yet.');
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
            reason: saved.skipped ? saved.message : 'Record saved.',
            ...(current.scanPlan?.checkpoint?.cursor
              ? {cursor: current.scanPlan.checkpoint.cursor}
              : {}),
          },
          snapshots.current,
        );
    }
    return recordReceipt(saved);
  };
  // A page of already known listings leaves nothing to review. Read on in the
  // same call so an empty result never looks like a stalled collector.
  // A card site's next page needs one request per listing at the site's pace.
  // The app reads it between agent turns, so the agent ends its turn instead
  // of waiting in a tool call. A site wait parks the source as usual. After a
  // failed background read the call reads the page itself and reports the error.
  const backgroundRead = () => {
    const current = db.activeRun(id, run.id);
    if (
      !collectorExtension(db.get(id), current.sourceUrl)?.collector.cards ||
      current.collectorError ||
      collectorPageReady(db, run.id)
    )
      return null;
    const search = activeSearch(scanWork(current)),
      next = search?.collector?.page?.url ?? search?.collector?.nextUrl ?? current.sourceUrl,
      wait = db.siteAccess.status(next);
    if (wait?.waiting)
      return releaseBlockedSource({db, id, runId: run.id, report}, current.sourceUrl, {
        issue: {reason: 'access_barrier', url: next, siteWait: wait, sites: [wait.site]},
      });
    db.putRun({...current, collectorReading: true});
    return {status: 'background_read', progress: collectorProgress(current), next: BACKGROUND_READ};
  };
  // What this scan does right now, for the Sources page (RAM only).
  const activity = (step) => {
    noteSourceActivity(run.id, step);
    changed(id);
  };
  // A card site that reads its listings in the browser: open the posting in
  // this source's tab and take the listing text its posting reader found.
  // Waits for the budget and pacing in place; this runs before the agent.
  // One page of a card site in the user's (signed-in) browser: waits for the
  // site's browser budget and pace in place, then opens the address in this
  // source's tab. Runs before the agent.
  const openInBrowser = async (url, address) => {
    // One budget and pace for the whole site, whichever host serves the page.
    const site = siteDomainOf(url),
      waitFor = async (ms) => {
        activity({waitUntil: Date.now() + ms});
        await pause(ms, undefined, {signal});
      };
    const pacing = siteExtensionFor(url)?.pacing ?? BROWSER_PACING;
    for (let delay; (delay = db.siteAccess.reserve(site + ' browser', pacing.budget)) > 0; )
      await waitFor(Math.min(delay, 60000));
    const gap = db.siteAccess.pace('https://' + site, pacing.minIntervalMs, pacing.jitterMs);
    if (gap) await waitFor(gap);
    activity({waitUntil: null, browser: true});
    let response = await browser.call(id, 'browser_navigate', {url: address}, run.id);
    for (let i = 0; i < 3 && response.jevPage?.reading?.readiness?.loading; i++) {
      await pause(2000, undefined, {signal});
      response = await browser.call(id, 'browser_snapshot', {}, run.id);
    }
    const page = response.jevPage;
    if (page?.siteWait) throw new SiteWaitError(page.siteWait);
    // A page that lands elsewhere (a sign-in or home page) is not the one asked for.
    if (page?.url && new URL(page.url).pathname !== new URL(address).pathname)
      throw Error(`The page opened as ${page.url}; this browser may need to sign in to the site.`);
    return page;
  };
  // A card site that reads its listings in the browser: take the listing text
  // its posting reader found.
  const readListingInBrowser = async (url) => {
    const page = await openInBrowser(url, siteListingAddress(url));
    if (!page?.listing?.text)
      throw Error('The opened posting gave no listing text (login prompt, loading or new layout).');
    return {
      url,
      ...(page.listing.title ? {title: page.listing.title} : {}),
      description: page.listing.text,
      ...(page.listing.fields?.company ? {company: page.listing.fields.company} : {}),
      ...(page.listing.fields?.location ? {location: page.listing.fields.location} : {}),
    };
  };
  // A card site's results page in the browser, read by its results reader.
  const readCardsInBrowser = async (url) => {
    const cards = collectorExtension(db.get(id), run.sourceUrl)?.collector?.cardsInBrowser;
    if (!cards) throw Error('This site has no browser reader for its results pages.');
    const read = cards.read(await openInBrowser(url, cards.open(url)), url);
    if (!read)
      throw Error(
        'The results page opened in the browser gave no job cards (sign-in, loading or new layout).',
      );
    return read;
  };
  const collectNextPage = async () => {
    for (let page = 1; ; page++) {
      const background = backgroundRead();
      if (background) return background;
      let collected;
      try {
        collected = await collectSourcePage(db, run.id, {
          signal,
          readPage: collectorReadPage,
          readDetail: collectorReadDetail,
          readListing: readListingInBrowser,
          readCardsInBrowser,
          progress: activity,
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
      const result = {
        ...(await executeJev({taskId: collected.taskId})),
        collector: db.activeRun(id, run.id).collector,
        progress: collectorProgress(db.run(run.id)),
      };
      // Listings whose details stayed unreadable remain pending in the collector;
      // a page holding nothing else to review is read on like a known page.
      const unreadable =
        result.unavailable > 0 && result.unavailable === result.total && !result.classified;
      if (!unreadable && (result.status !== 'completed' || result.total || result.issue))
        return result.unavailable
          ? {
              ...result,
              next: `${result.next} Unreadable listings stay pending in the collector; after this batch call collect_source_page for the next page.`,
            }
          : result;
      if (page >= KNOWN_COLLECTOR_PAGES)
        return {
          ...result,
          issue: undefined,
          next: `The last ${page} pages held no new listings to review. Call collect_source_page again for the next page.`,
        };
    }
  };
  const performCall = async (owner, session, name, args) => {
    if (owner !== id || session !== run.id || signal.aborted)
      throw Error('Invalid automation session');
    // Each agent browser step starts unblocked; other tools keep the last step's state.
    if (name.startsWith('browser_')) stepWaited = false;
    activity({
      ...IDLE_STEP,
      step: 'agent',
      tool: name,
      label: agentStepLabel(name, args),
      url: args?.url ?? null,
    });
    let active = db.activeRun(id, run.id);
    const a = db.get(id),
      sourceTask =
        ['trial', 'run'].includes(active.kind) &&
        Boolean(active.sourceUrl) &&
        !active.recordId &&
        !active.recordOperation;
    let result;
    if (collecting && collectorHidden.has(name))
      throw Error(
        'For this source, get the data through collect_source_page and review the Jev batch.',
      );
    // Jev owns the browser and selected queue while its request is pending.
    // Read-only inspection stays available; mutations wait for the same task.
    if (
      jevExecution.busy &&
      ![
        'browser_run_task',
        'read_browser_task',
        'read_listing_brief',
        'read_listing_evidence',
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
      throw Error('A scoring task can only save assessments');
    if (workspaceTableTools.some((t) => t.name === name)) {
      const value = workspaceTableCall(db.store, id, name, args);
      changed(id);
      return name === 'get_workspace_records' ? context.capture(value) : value;
    }
    switch (name) {
      case 'collect_source_page': {
        if (!collecting) throw Error('No CLI extension is assigned to this source.');
        result = await collectNextPage();
        break;
      }
      case 'read_scoring_profile': {
        const source =
          args.source === 'documents'
            ? await scoringDocuments()
            : scoringSources(a, undefined, db.template(a.templateId).fields)[args.source];
        if (!source) throw Error('Choose a valid scoring source.');
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
          throw Error('Invalid source text range.');
        return {
          ...source,
          source: args.source,
          text: source.text.slice(offset, offset + limit),
          offset,
          totalCharacters: source.text.length,
          nextOffset: offset + limit < source.text.length ? offset + limit : null,
        };
      }
      case 'read_browser_task': {
        db.jevTasks.get(id, active.taskId ?? run.id, args.taskId);
        if (jevExecution.owns(args.taskId)) {
          const value = await jevExecution.wait();
          if (value.status === 'running' || value.parent?.stop) return value;
        }
        return jevTaskSummary(db.jevTasks.get(id, active.taskId ?? run.id, args.taskId), args);
      }
      case 'read_listing_brief': {
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
          criteria = jevCriteria(a, documents, db.template(a.templateId));
        const briefFor = (evidenceId, offset, waitMs) => {
          const evidence = db.jevTasks.fullEvidence(id, scope, evidenceId);
          const task = db.jevTasks
            .list(id, scope)
            .find((t) => t.items.some((i) => i.evidenceId === evidence.id));
          if (!task || task.searchId !== searchId)
            throw Error('The Jev brief must belong to a listing in the active search.');
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
                throw Error('The active search changed; the brief was stopped.');
            },
            evaluate: decideByAgent
              ? null
              : (state, questions, abort) => browser.evaluateJev(id, state, questions, abort),
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
          next: 'One entry per listing in the requested order. Use the original sections for assessment; absent facts stay unknown. Poll read_listing_brief again only for entries with status=running; read nextOffset pages per evidenceId; use read_listing_evidence only for a missing or conflicting detail.',
        });
      }
      case 'read_listing_evidence': {
        const scope = active.taskId ?? run.id,
          value = db.jevTasks.readEvidence(id, scope, args.evidenceId, args);
        return value;
      }
      case 'browser_run_task':
        result = await executeJev(args);
        // A finished collector review continues with the next page in the same
        // call, saving the agent one model turn per page.
        if (collecting && args.reviewedBatchId && result.status === 'completed') {
          const acknowledged = {taskId: result.taskId, status: result.status};
          try {
            result = {acknowledged, next: await collectNextPage()};
          } catch (error) {
            signal.throwIfAborted();
            result = {acknowledged, collectorError: error.message};
          }
        }
        break;
      case 'ask_workspace_question': {
        if (batchScoring(active) && !args.recordId)
          throw Error('In batch scoring, give a recordId for the question');
        if (active.recordId && args.recordId && !taskHasRecord(active, args.recordId))
          throw Error('The question must belong to an assigned record');
        let accessCheck;
        if (active.kind !== 'interview' && asksForLogin(args)) {
          const previous = args.accessCheck && snapshots.get(args.accessCheck.snapshotId);
          if (!previous)
            throw Error(
              'Before a login question, follow the actual apply/task link, check it with browser_read and add accessCheck.',
            );
          validateLoginQuestion(previous, args.accessCheck);
          const fresh = await inspect(),
            page = snapshots.get(fresh.snapshot.id);
          if (page.url !== previous.url)
            throw Error(
              'The page changed during the login check. Inspect the current page with browser_read and continue the task; do not repeat the old login blocker.',
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
        // Detail reads after the last results page replace the live snapshot; the
        // results page the agent cites stays the completion evidence.
        const page = args.snapshotId
          ? {url: snapshots.address(args.snapshotId)}
          : snapshots.current;
        if (!page) throw Error('Observe the latest results page first.');
        result = db.completeScanSearch(id, run.id, args.completion, page);
        break;
      }
      case 'save_jev_profile': {
        if (!sourceTask) throw Error('The Jev profile is only written in a source task.');
        result = saveJevProfile(
          db,
          id,
          args.profile,
          'agent',
          await scoringDocuments(),
          db.template(a.templateId).fields,
        );
        changed(id);
        break;
      }
      case 'save_source_recipe': {
        if (!active.sourceUrl || active.recordId || !['trial', 'run'].includes(active.kind))
          throw Error('A recipe is only saved in an assigned source task.');
        const sourceUrl = active.sourceUrl,
          siteSearch = siteExtensionKind(sourceUrl, a.templateId)?.search ?? null;
        let recipe = normalizeSourceRecipe(args),
          adjusted = [];
        // A site extension knows the results address: the agent chooses the
        // terms, path and filter values; the extension keeps the sort,
        // pagination and ordering. Discovery stays open for a changed site.
        if (siteSearch && recipe.entry.kind === 'search_form')
          throw Error(
            'This site’s results address is defined in its site extension. Save the recipe as url_template with siteSearch.template; choose only the terms and siteSearch.filters values.',
          );
        if (siteSearch && recipe.entry.kind === 'url_template')
          ({recipe, changed: adjusted} = siteSearchRecipe(siteSearch, recipe));
        if (collecting && recipe.entry.kind !== 'url_template')
          throw Error(
            'This source is read by its collector: save a url_template recipe from siteSearch.template.',
          );
        // Without terms {query} holds the source scope and later scans wait for terms.
        if (recipeNeedsTerms(recipe))
          throw Error(
            `The template takes {query} but the recipe has no terms, so {query} would be the source scope "${recipeValues(a, sourceUrl).query}". Save concrete search terms with terms${siteSearch?.notes ? ' as siteSearch.notes describes {query}' : ''}. If that scope is itself the right search, save it as the only term.`,
          );
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
        // With agent decisions the app judges no listing itself: a recipe is
        // verified from the listings the agent selected at its address.
        if (decideByAgent && !collecting) {
          const replay = recipeReplay(recipe, recipeValues(a, sourceUrl));
          if (replay.kind === 'search_form')
            throw Error(
              'With agent decisions the app cannot replay a search form. Save a url_template from the results address the form produced, or entry.kind=discovery with a short note.',
            );
          if (!provenListings(replay, active.taskId ?? run.id))
            throw Error(
              `Recipe not checked yet: run browser_run_task scan_results at ${replay.searches[0].url} and select its listings, then save the recipe again. The app verifies the recipe from your selection; no check was used.`,
            );
        }
        const checks = active.recipeChecks ?? 0;
        if (checks >= 3)
          throw Error(
            '3 recipe checks were done this round. If it cannot be verified, save a short note with entry.kind=discovery and finish the round normally.',
          );
        db.putRun({...db.activeRun(id, run.id), recipeChecks: checks + 1});
        const replay = recipeReplay(recipe, recipeValues(a, sourceUrl)),
          check = collecting
            ? await checkCollectorRecipe(replay)
            : await checkRecipe(replay, active.taskId ?? run.id);
        if (!check.ok)
          throw Error(
            `Recipe could not be verified: ${check.reason} (${check.url}). ${2 - checks} check(s) left. ${recipe.terms ? '' : 'If the source query is not a keyword, give concrete search terms with terms. '}Fix the template or form labels; if there is no stable method, save entry.kind=discovery.`,
          );
        db.learnSourceRecipe(id, sourceUrl, recipe, {
          runId: run.id,
          verified: true,
          listings: check.listings,
          pages: check.pages,
        });
        db.putRun({...db.activeRun(id, run.id), recipeSaved: true});
        // The collection restarts with the saved searches; known listings are skipped.
        if (collecting) prepareCollection(db, db.activeRun(id, run.id), db.get(id));
        result = {
          saved: true,
          status: 'verified',
          url: check.url,
          ...(adjusted.length
            ? {
                siteExtension: `The site extension set ${adjusted.join(', ')} from siteSearch; the saved recipe uses them.`,
              }
            : {}),
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
          next: collecting
            ? 'Recipe verified and saved. Call collect_source_page; the scan starts over with the saved searches.'
            : active.kind === 'trial'
              ? 'Recipe verified and saved. Read one representative detail from the found listings, then finish the trial.'
              : 'Recipe verified and saved. Continue the scan from the found listings with collect_details using the returned scan task.',
        };
        break;
      }
      case 'get_automation_context': {
        const value = scanToolOutput(automationTaskContext(db, id, active, args), {summary: true});
        // Source tasks keep the short Jev profile current (save_jev_profile).
        if (sourceTask && !args.section && !decideByAgent) {
          const documents = await scoringDocuments().catch(() => null);
          if (documents) {
            const {status, by, text} = jevProfileView(
              a,
              documents,
              db.template(a.templateId).fields,
            );
            value.jevProfile = {status, ...(by === 'user' ? {by, text} : {})};
          }
        }
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
          throw Error('The plan can only change in the setup conversation');
        const {addSources, removeSources, ...fields} = args,
          plan = {
            ...fields,
            criteria: Object.fromEntries(args.criteria.map((f) => [f.key, f.value])),
          };
        if (addSources?.length || removeSources?.length)
          plan.sources = db.proposedSources(id, addSources, removeSources);
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
            'The research page could not be opened: ' +
              JSON.stringify(response.content).slice(0, 1000),
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
      case 'reserve_automation_action': {
        // A cover letter field seen on this run's form pages must be filled
        // before the submit; an optional one is not skipped.
        const coverLetter =
          active.recordOperation === 'execute' &&
          coverLetterStep(a, active.recordId, active.coverLetterFields);
        if (coverLetter) throw Error(coverLetter);
        result = db.reserve(id, run.id, args.itemId);
        break;
      }
      case 'record_automation_outcome': {
        // The app knows the assigned record and the observed page; the agent
        // names them only when it reports on something else.
        args = {itemId: active.recordId ?? undefined, url: snapshots.current?.url, ...args};
        // The current page named without its query or hash is still that page.
        if (snapshots.current?.url && args.url && samePath(args.url, snapshots.current.url))
          args.url = snapshots.current.url;
        if (!args.itemId)
          throw Error('itemId is required: this task has no single assigned record');
        if (!args.url) throw Error('Observe the results page in the browser first');
        if (args.status === 'closed' || args.status === 'applied') {
          result = db.closeRecord(id, run.id, args.itemId, args, snapshots.current);
          break;
        }
        let page, fresh;
        if (args.status === 'not_submitted') {
          const previous = snapshots.get(args.notSubmittedProof?.snapshotId);
          if (previous.url !== args.url)
            throw Error('The evidence address does not match the current page');
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
              'Evidence not accepted; the record was not changed. Use the returned current page and snapshot.id. Copy the quote verbatim from the visible text; do not add separators or partial text.',
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
          throw Error(
            'The page could not be opened: ' + JSON.stringify(response.content).slice(0, 1000),
          );
        result = await inspect({research, ...(response.pageContext ? {response} : {})});
        if (
          result.readiness?.loading &&
          sourceScan(active) &&
          operationFor(db.template(a.templateId), active.operation).effect === 'read'
        )
          result = await recheckPage(result.url);
        break;
      }
      case 'browser_tabs':
      case 'browser_use_tab':
      case 'browser_close_tab': {
        if (
          !(
            (active.sourceUrl && !active.recordId) ||
            (active.recordOperation && name !== 'browser_close_tab')
          )
        )
          throw Error('Tab handover is only available in a source scan or an assigned record task');
        if (name !== 'browser_tabs') snapshots.invalidate();
        const response = await callBrowser(id, name, args, run.id);
        if (response.isError) throw Error('The source tab operation could not complete');
        result = name === 'browser_use_tab' ? await inspect({response}) : response;
        break;
      }
      case 'browser_read': {
        const research = active.kind === 'interview';
        db.spendStep(id, run.id, {research});
        const waitSeconds = Math.min(30, Math.max(0, Math.trunc(Number(args.waitSeconds) || 0)));
        if (waitSeconds) await pause(waitSeconds * 1000, undefined, {signal});
        result = await inspect({research});
        if (
          result.readiness?.loading &&
          sourceScan(active) &&
          operationFor(db.template(a.templateId), active.operation).effect === 'read'
        )
          result = await recheckPage(result.url);
        break;
      }
      case 'browser_inspect_form': {
        const research = active.kind === 'interview',
          url = await browser.currentUrl(id);
        if (research) researchUrl(url);
        else webUrl(url);
        db.spendStep(id, run.id, {research});
        snapshots.invalidate();
        result = await callBrowser(id, name, {}, run.id);
        // The submit buttons Jev found on an application form (required fields
        // or uploads): a click on one of them on this page is the submission,
        // also when its label is "Apply" or "Bewerben".
        formSubmits =
          result.fields?.some((field) => field.required) || result.uploads?.length
            ? {
                url: result.url,
                labels: new Set((result.submitControls ?? []).map((c) => spaced(c.label))),
              }
            : null;
        const coverFields = active.recordOperation === 'execute' ? coverLetterFields(result) : [];
        if (coverFields.length) {
          // Kept per label across the form's steps; a later inspection updates `filled`.
          const current = db.run(run.id),
            fields = mergeCoverLetterFields(current.coverLetterFields, coverFields);
          db.putRun({...current, coverLetterFields: fields});
          const step = coverLetterStep(db.get(id), active.recordId, fields);
          if (step) result = {...result, coverLetter: step};
        }
        break;
      }
      case 'browser_upload_document': {
        if (active.recordOperation !== 'execute' || !active.recordId)
          throw Error('A document can only be uploaded in a record application task');
        const item = db.result(id, active.recordId),
          base = workspace && (await realpath(workspace));
        if (!base) throw Error('Workspace file directory not found');
        const file = await realpath(path.resolve(base, args.filePath)),
          relative = path.relative(base, file);
        if (
          relative.startsWith('..' + path.sep) ||
          path.isAbsolute(relative) ||
          !(await stat(file)).isFile()
        )
          throw Error('Only documents in this workspace can be uploaded');
        // Any document the user added to this workspace may be uploaded; there
        // is no draft that has to name it first.
        void item;
        db.spendStep(id, run.id);
        snapshots.invalidate();
        const response = await callBrowser(
          id,
          'browser_upload_document',
          {ref: args.ref, filePath: file},
          run.id,
        );
        if (response.isError)
          throw Error(
            'The document could not be uploaded: ' +
              JSON.stringify(response.content).slice(0, 1000),
          );
        const current = db.run(run.id),
          uploaded = coverLetterUploaded(
            db.get(id),
            active.recordId,
            current.coverLetterFields,
            args.ref,
            relative,
          );
        if (uploaded) db.putRun({...current, coverLetterFields: uploaded});
        result = {...(await inspect()), action: response.action};
        break;
      }
      case 'request_cover_letter': {
        if (active.recordOperation !== 'execute' || !active.recordId)
          throw Error('A cover letter can only be requested in a record application task');
        const item = db.result(id, active.recordId),
          question = requestCoverLetter(db, id, active, {
            notes: args.notes,
            listing: db.browserEvidence.latest(active, item.url),
          });
        result = {
          questionId: question.id,
          next: 'Leave the cover letter field empty and keep the tab. Call finish_automation_run with status blocked and blocker category needs_answer now; the approved letter resumes this application.',
        };
        break;
      }
      case 'read_cover_letter_brief':
        if (active.recordOperation !== 'cover_letter')
          throw Error('Only a cover letter task has a brief');
        return coverLetterBrief(db, id, active);
      case 'save_cover_letter': {
        if (active.recordOperation !== 'cover_letter')
          throw Error('Only a cover letter task can save a cover letter');
        if (!workspace) throw Error('Workspace file directory not found');
        result = await saveCoverLetter(db, id, active, args.text, {workspace, renderPdf});
        break;
      }
      case 'read_contact_brief':
        if (active.recordOperation !== 'contacts') throw Error('Only a contact task has a brief');
        return contactBrief(db, id, active);
      case 'save_record_contacts':
        if (active.recordOperation !== 'contacts')
          throw Error('Only a contact task can save contacts');
        result = saveRecordContacts(db, id, active, args);
        break;
      case 'reserve_contact_action':
        if (active.recordOperation !== 'contacts')
          throw Error('Only a contact send task can reserve a contact');
        result = reserveContactAction(db, id, active, args.contactId);
        break;
      case 'record_contact_outcome':
        if (active.recordOperation !== 'contacts')
          throw Error('Only a contact send task records contact outcomes');
        result = recordContactOutcome(db, id, active, args);
        break;
      case 'browser_interact': {
        const research = active.kind === 'interview';
        db.spendStep(id, run.id, {research});
        if (['scroll', 'reveal', 'options'].includes(args.operation)) {
          const url = await browser.currentUrl(id);
          if (research) researchUrl(url);
          else webUrl(url);
          const tool =
            args.operation === 'scroll'
              ? 'browser_scroll'
              : args.operation === 'reveal'
                ? 'browser_reveal'
                : 'browser_options';
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
              'The browser step could not complete: ' +
                JSON.stringify(response.content).slice(0, 1000),
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
          if (typeof args.text !== 'string') throw Error('Text to type is required');
          operation = 'browser_type';
          parameters.text = args.text;
          parameters.submit = false;
        } else if (args.operation === 'select') {
          const value = typeof args.text === 'string' ? args.text : args.option;
          if (typeof value !== 'string')
            throw Error(
              'select requires text: the option’s exact label or value (list them with browser_interact operation=options)',
            );
          operation = 'browser_select_option';
          parameters.values = [value];
        } else if (args.operation === 'press') {
          if (!args.key?.trim()) throw Error('A key is required');
          // Enter in a message box sends it past the Send-click gate.
          if (active.recordOperation === 'contacts' && active.request?.phase === 'send')
            throw Error('Keys are off in a contact send task; click the Send button instead.');
          operation = 'browser_target_press';
          parameters.ref = args.ref;
          parameters.key = args.key;
        } else if (args.operation === 'autocomplete') {
          // Text alone names the wanted option; without an exact match the
          // tool returns the full suggestion list and selects nothing.
          const option = args.option ?? (args.text?.trim() ? args.text : undefined);
          operation = option === undefined ? 'browser_list_suggestions' : 'browser_autocomplete';
          parameters.controlId = args.ref;
          if (args.text !== undefined) parameters.text = args.text;
          if (option !== undefined) parameters.option = option;
        } else throw Error('Unsupported interaction');
        // The final submit click is gated by the app: execute task, reservation
        // first, one click. The fresh page is then classified from evidence.
        const submitLabel =
          args.operation === 'click' ? clickTargetLabel(snapshots.current, args.ref) : null;
        const submitClick =
          isSubmitLabel(submitLabel) ||
          (Boolean(submitLabel) &&
            formSubmits?.labels.has(spaced(submitLabel)) &&
            formSubmits.url === (await browser.currentUrl(id)));
        // A contact task has no application to submit: its own gate allows
        // connect/message after a reservation and one Send per contact.
        const contactTask = active.recordOperation === 'contacts',
          contactSpend = contactTask
            ? contactClick(db.activeRun(id, run.id), submitLabel, submitClick)
            : null;
        if (submitClick && !contactTask) assertSubmitAllowed(db.activeRun(id, run.id), submitLabel);
        const beforeSubmit = submitClick ? (snapshots.current?.text ?? '') : '';
        snapshots.invalidate();
        const response = await callBrowser(id, operation, parameters, run.id);
        if (contactSpend === 'send' && response.action?.executed !== false)
          contactSendClicked(db, id, run);
        if (response.isError)
          throw Error(
            'The browser step could not complete; check the result: ' +
              JSON.stringify(response.content).slice(0, 1000),
          );
        noteSiteWait(response);
        const openedTab = response.action?.openedTab;
        if (openedTab?.tabId) {
          // The click opened the next page in a new tab; continue there.
          const switched = await callBrowser(
            id,
            'browser_use_tab',
            {tabId: openedTab.tabId},
            run.id,
          );
          result = {
            ...(await inspect({research, response: switched})),
            action: {
              ...response.action,
              message:
                'The click opened a new tab. This observation is that new tab; continue here. The previous tab stays open.',
            },
          };
        } else
          result = {
            ...(await inspect({research})),
            ...(response.action ? {action: response.action} : {}),
          };
        if (response.siteWait && active.recordId)
          result.siteWaitGuidance =
            'This site asked to slow down, so the step was not executed. Do not retry it now. Call finish_automation_run with status=blocked; the app resumes this record after the wait from the same tab.';
        if (submitClick && !contactTask) {
          let outcome = classifySubmission(snapshots.current?.text ?? '', beforeSubmit);
          // A confirmation often renders a moment after the click: look twice more.
          for (
            let i = 0;
            i < 2 && outcome.outcome === 'unknown' && !openedTab?.tabId && !response.siteWait;
            i++
          ) {
            await pause(submitSettleMs, undefined, {signal});
            result = {
              ...(await inspect({research})),
              ...(response.action ? {action: response.action} : {}),
            };
            outcome = classifySubmission(snapshots.current?.text ?? '', beforeSubmit);
          }
          // A CAPTCHA the user must solve stopped the submission on this page.
          const challenge =
              outcome.outcome !== 'confirmed' && lastVerification?.state === 'required'
                ? String(lastVerification.evidence ?? 'CAPTCHA')
                : null,
            active = db.run(run.id),
            submission = {
              ...outcome,
              ...(challenge ? {verification: challenge} : {}),
              label: submitLabel,
              attempts: (active.submission?.attempts ?? 0) + 1,
              at: db.now(),
            };
          db.putRun({...active, submission});
          result.submission = {...submission, guidance: submissionGuidance(submission)};
          // Text alone did not confirm the submission: one viewport image lets
          // the agent judge the visible reaction. Capture failures stay silent.
          if (submission.outcome !== 'confirmed') {
            const image = await screenshot();
            if (image) {
              result.attachments = [image];
              result.submission.screenshot = SUBMIT_SCREENSHOT_NOTE;
            }
          }
        }
        break;
      }
      case 'finish_automation_run':
        if (active.recordOperation === 'cover_letter')
          finishCoverLetter(db, id, active, args.status, args.summary);
        if (active.recordOperation === 'contacts')
          finishContactTask(db, id, active, args.status, args.summary);
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
        throw Error('Unknown automation tool');
    }
    changed(id);
    return name === 'complete_scan_search' ? scanToolOutput(result, {summary: true}) : result;
  };
  return {
    // Reads the next review batch of a card collector before the agent starts.
    prefetchCollector: async () => {
      await prefetchCollectorPage(db, run.id, {
        signal,
        readListing: readListingInBrowser,
        readCardsInBrowser,
        progress: activity,
      });
      activity({...IDLE_STEP, step: 'agent', tool: null, label: null, url: null});
    },
    normalizeToolArgs: normalizeRecordToolArgs,
    guardToolCall:
      run.taskId && run.kind !== 'interview'
        ? recordToolGuard({db, run, report, changed})
        : undefined,
    assertOwner: (owner) => {
      if (owner !== id) throw Error('Invalid automation session');
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
    if (closing) throw Error('The session is closing');
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
    // A cover letter is written once and read by an employer, so it gets the same model.
    // Contact tasks have their own model setting (Opus by default for Claude).
    const trialSettings = (s) => {
      const model =
        run.kind === 'trial' || run.recordOperation === 'cover_letter'
          ? s?.trialModel
          : run.recordOperation === 'contacts' && s
            ? withAgentDefaults(s).contactModel
            : null;
      return model ? {...s, model} : s;
    };
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
    if (signal.aborted) throw Error('Run cancelled');
    const decideByAgent = agentDecides(automation.agentSettings);
    const protocol = persistent
      ? null
      : automationProtocol(flow.tools, [
          AUTOMATION_INSTRUCTIONS,
          decideByAgent ? AGENT_LAUNCH_INSTRUCTIONS : JEV_LAUNCH_INSTRUCTIONS,
          SCORING_INSTRUCTIONS,
          SOURCE_SCAN_INSTRUCTIONS,
        ]);
    const evidenceExpired = !persistent && automationEvidenceExpired(db, run);
    if (protocol) run = prepareAutomationProtocol(db, run, protocol);
    // Records a site extension reads are scored from its text, like a scan.
    if (run.recordOperation === 'score')
      await readRecordListings(db, run, {signal, wait: (ms) => pause(ms, undefined, {signal})});
    // A card site's next batch is read here, before the agent starts.
    if (
      collectorRun(automation, run) &&
      collectorExtension(automation, run.sourceUrl)?.collector.cards
    )
      await flow.prefetchCollector();
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
        {evidenceExpired, agentDecides: decideByAgent},
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
            compacted: true,
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
