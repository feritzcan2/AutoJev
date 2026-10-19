// @ts-check
import {taskRecordIds, recordScoredInTask} from '../../records/task-scope.mjs';
import {CONVERSATION_WORKER} from '../../workspaces/conversation.mjs';
import {
  activeSearch,
  replayScanWork,
  validateWorkCompletion,
  scanStats,
} from '../../sources/scan-work.mjs';
import {answerContinuation} from '../continuation.mjs';
import {validateRecordTask} from '../../records/operations.mjs';
import {sameSite} from '../../browser/site-access.mjs';
import {
  recipeValues,
  recipeReplay,
  replayUrls,
  replayMatches,
  recipeRunOutcome,
  advanceRecipeState,
  SCAN_SEARCH_PAGES,
  sourceRecipeOf,
} from '../../sources/recipe.mjs';
import {collectorRun} from '../../sources/collectors.mjs';
import {randomUUID} from 'node:crypto';
import {boundedText} from '../../templates/catalog.mjs';
import {
  beginSourceScan,
  sourceScanScope,
  currentScanState,
  completeSourceScan,
} from '../../sources/scan.mjs';
// AutomationStore methods: run lifecycle: starting a task and finishing it.
export const runMethods = {
  begin(id, input, workerId = 'main') {
    return this.store.workspaces.tasks.atomic(() => {
      const {kind, taskId, messageId, inputQuestionIds, onboarding} =
        typeof input === 'string' ? {kind: input} : input;
      const conversation = workerId === CONVERSATION_WORKER;
      if (conversation && kind !== 'interview')
        throw Error('The chat worker can only run the conversation task');
      if (!taskId && !conversation) this.assertIdle(id);
      const a = this.get(id);
      this.store.workspaces.workers.get(id, workerId);
      if (!['interview', 'trial', 'run'].includes(kind)) throw Error('Invalid run');
      if (kind !== 'interview' && a.profileUpdate)
        throw Error('A new task cannot start until the profile update completes.');
      if (
        kind !== 'interview' &&
        !(taskId && this.store.workspaces.tasks.get(id, taskId).recordOperation === 'verify') &&
        a.reviewedRevision !== a.revision
      )
        throw Error('Review and save the setup card first');
      if (
        !taskId &&
        !conversation &&
        ['interview', 'trial'].includes(kind) &&
        a.status === 'enabled'
      )
        this.pause(id);
      const queue = this.store.workspaces.tasks;
      let task = taskId
        ? queue.get(id, taskId)
        : queue.enqueue(id, {
            operation: kind,
            lockKey: conversation ? 'conversation' : 'workspace',
            capability: 'browser.observe',
          });
      validateRecordTask(this, id, task, this.now());
      task = queue.claim(id, task.id, workerId);
      if (
        !taskId &&
        !conversation &&
        ['interview', 'trial'].includes(kind) &&
        Object.keys(a.retryPlan ?? {}).length
      )
        this.put({...this.get(id), retryPlan: {}});
      const saved = a.sourceState?.[task.sourceUrl] ?? {},
        state = saved.scanState
          ? {...saved, scanState: currentScanState(saved.scanState, a, task.sourceUrl)}
          : saved,
        scopeKey = task.sourceUrl ? sourceScanScope(a, task.sourceUrl) : null;
      const scopeMatches = !state.scanState || state.scanState.scopeKey === scopeKey;
      const resumable = !task.recordId && scopeMatches && (task.scan ?? state.scan),
        replaySearches =
          kind === 'run' && task.sourceUrl && !task.recordId
            ? this.sourceRecipe(id, task.sourceUrl).replay?.searches
            : null;
      const savedScan =
        kind === 'run' && task.sourceUrl && !task.recordId && !collectorRun(a, {...task, kind})
          ? (replayScanWork(resumable && !resumable.complete ? resumable : null, replaySearches) ??
            resumable)
          : resumable;
      const pageProgress =
        savedScan?.work && savedScan !== resumable
          ? (activeSearch(savedScan.work)?.pageProgress ?? null)
          : scopeMatches
            ? state.pageProgress
            : null;
      // Every source is scanned newest first: a repeat scan stops at known listings.
      const scanState =
        kind === 'run' && task.sourceUrl && !task.recordId
          ? beginSourceScan(state.scanState, scopeKey, this.now(), {
              ordering: 'newest_first',
              pageCap: SCAN_SEARCH_PAGES,
            })
          : null;
      if (scanState) {
        this.put({...a, sourceState: {...a.sourceState, [task.sourceUrl]: {...state, scanState}}});
        queue.put({...queue.get(id, task.id), scanPlan: scanState.active});
      }
      const continuation = answerContinuation(this, id, task, kind),
        runId = randomUUID();
      if (continuation) {
        queue.put({...queue.get(id, task.id), continuation});
        const current = this.get(id);
        this.put({
          ...current,
          questions: (current.questions ?? []).map((q) =>
            continuation.questionIds.includes(q.id) ? {...q, continuationRunId: runId} : q,
          ),
        });
      }
      return this.putRun({
        id: runId,
        ...(!task.recordId && state.accessRecovery?.state === 'fresh' ? {freshSource: true} : {}),
        ...(conversation
          ? {
              interactive: true,
              awaitingMessage: false,
              ...(messageId ? {messageId} : {}),
              ...(inputQuestionIds ? {inputQuestionIds} : {}),
              ...(onboarding ? {onboarding: true} : {}),
            }
          : {}),
        ...(continuation ? {continuation} : {}),
        automationId: id,
        workerId,
        taskId: task.id,
        operation: task.operation,
        ...(task.recordOperation
          ? {recordOperation: task.recordOperation, request: task.request}
          : {}),
        sources: task.sources ?? a.sources,
        sourceUrl: task.sourceUrl ?? null,
        recordId: task.recordId ?? null,
        ...(task.recordIds ? {recordIds: task.recordIds} : {}),
        batchId: task.batchId ?? null,
        ...(scanState ? {scanPlan: scanState.active} : {}),
        ...(kind === 'run' && savedScan && !savedScan.complete
          ? {scan: savedScan, ...(pageProgress ? {pageProgress} : {})}
          : {}),
        kind,
        revision: a.revision,
        status: 'running',
        state: 'Starting',
        startedAt: this.now(),
        finishedAt: null,
        browserSteps: 0,
        observations: [],
        summary: 'Starting',
        actionId: null,
      });
    });
  },
  finish(id, runId, status, summary, {release = true} = {}) {
    return this.store.workspaces.tasks.atomic(() => {
      const run = this.activeRun(id, runId);
      if (!['completed', 'partial', 'failed', 'blocked', 'interrupted', 'timeout'].includes(status))
        throw Error('Invalid run result');
      if (status === 'completed' && run.recordOperation)
        for (const itemId of taskRecordIds(run)) {
          const item = this.result(id, itemId),
            question = (this.get(id).questions ?? []).some(
              (q) => q.recordId === item.id && (q.answer == null || q.createdAt >= run.startedAt),
            );
          if (run.recordOperation === 'score' && !recordScoredInTask(this, run, item) && !question)
            throw Error(
              'Save the scoring result for this record or ask the missing-information question first',
            );
          if (
            run.recordOperation === 'prepare' &&
            !(item.status === 'prepared' && item.proposal && item.runId === run.id) &&
            !question
          )
            throw Error(
              'Save the draft for this record or ask the missing-information question first',
            );
          if (
            run.recordOperation === 'execute' &&
            item.status !== 'completed' &&
            !(item.status === 'dismissed' && item.closed?.runId === run.id) &&
            !run.actionId &&
            !(
              run.request?.direct !== true &&
              item.status === 'prepared' &&
              item.digest !== run.request?.digest
            ) &&
            !question
          )
            throw Error(
              'The application is not finished. Record the real outcome with record_automation_outcome, or ask the missing question, before finishing.',
            );
          if (
            run.recordOperation === 'verify' &&
            item.status !== 'completed' &&
            !(run.verifiedNotSubmitted === item.id && item.notSubmitted?.runId === run.id)
          )
            throw Error(
              'The result is not verified yet; keep the uncertain state and report the blocker',
            );
        }
      if (status === 'partial' && (!run.sourceUrl || run.recordId || !run.scan?.pendingUrls.length))
        throw Error('A partial run requires a saved source checkpoint');
      if (run.actionId) {
        const item = this.result(id, run.actionId);
        if (item.status === 'executing')
          this.putResult({
            ...item,
            status: 'uncertain',
            evidence: 'The action result could not be verified; check it without submitting again.',
          });
        if (['completed', 'partial'].includes(status)) status = 'blocked';
      }
      const a = this.get(id);
      if (run.kind === 'trial' && status === 'completed') {
        const observed = run.observations.filter((o) => o.evidence.trim()).map((o) => o.url);
        if (
          !(run.sources ?? a.sources).every((url) => observed.some((o) => sameSite(o, url))) ||
          !a.sources.length ||
          a.revision !== run.revision
        ) {
          status = 'failed';
          summary =
            'Trial could not complete: every source needs a current page observation or CLI response.';
        }
      }
      let scanCompletion = null;
      if (
        status === 'completed' &&
        run.kind === 'run' &&
        run.sourceUrl &&
        !run.recordId &&
        run.scan?.complete
      ) {
        scanCompletion = validateWorkCompletion(run, run.scan);
      }
      this.putRun({
        ...run,
        status,
        summary: boundedText(summary, 'Run summary', 6000),
        finishedAt: this.now(),
        actionId: null,
        ...(run.sourceUrl && !run.recordId && scanStats(run.scan)
          ? {scanStats: scanStats(run.scan)}
          : {}),
      });
      if (run.kind === 'run' && run.sourceUrl && !run.recordId && run.scanPlan) {
        const state = a.sourceState?.[run.sourceUrl] ?? {};
        a.sourceState = {
          ...a.sourceState,
          [run.sourceUrl]: {
            ...state,
            scanState: scanCompletion
              ? completeSourceScan(state.scanState, run.scanPlan, scanCompletion, this.now())
              : state.scanState,
          },
        };
      }
      if (run.kind === 'trial') {
        const trial = {status: status === 'completed' ? 'passed' : 'failed', runId, at: this.now()};
        for (const url of run.sources ?? [])
          if (a.sources.includes(url))
            a.sourceState = {...a.sourceState, [url]: {...a.sourceState?.[url], trial}};
        if (!run.sourceUrl) a.trial = {...trial, revision: run.revision};
        // A passed trial without a saved recipe leaves the source in discovery mode.
        if (
          run.sourceUrl &&
          status === 'completed' &&
          !run.recipeSaved &&
          !a.sourceSettings?.[run.sourceUrl]?.recipe
        ) {
          a.sourceSettings = {
            ...a.sourceSettings,
            [run.sourceUrl]: {
              ...a.sourceSettings?.[run.sourceUrl],
              recipe: {
                entry: {kind: 'discovery'},
                pagination: 'auto',
                notes: 'The trial round did not save a recipe.',
              },
            },
          };
          a.sourceState = {
            ...a.sourceState,
            [run.sourceUrl]: {
              ...a.sourceState?.[run.sourceUrl],
              recipeState: {
                status: 'discovery',
                successCount: 0,
                failCount: 0,
                learnedRunId: runId,
                learnedAt: this.now(),
              },
            },
          };
        }
      }
      if (
        run.kind === 'run' &&
        run.sourceUrl &&
        !run.recordId &&
        !run.recordOperation &&
        ['completed', 'partial', 'failed'].includes(status)
      ) {
        const recipe = sourceRecipeOf(a, run.sourceUrl),
          state = a.sourceState?.[run.sourceUrl] ?? {};
        if (recipe && recipe.entry.kind !== 'discovery') {
          const replay = recipeReplay(recipe, recipeValues(a, run.sourceUrl)),
            tasks = this.jevTasks.list(id, run.taskId ?? run.id);
          const urls = replayUrls(replay),
            outcome = recipeRunOutcome(replay, tasks),
            failed = tasks.find((t) => replayMatches(replay, t.input?.url) && t.issue);
          const recipeState = advanceRecipeState(state.recipeState, outcome, {
            runId,
            now: this.now(),
            reason: failed?.issue?.reason ?? (outcome === 'failure' ? 'no_listings' : null),
            url: failed?.input?.url ?? urls[0] ?? null,
          });
          // A stale recipe sends the source back to a trial so it can be relearned.
          a.sourceState = {
            ...a.sourceState,
            [run.sourceUrl]: {
              ...state,
              recipeState,
              ...(recipeState.status === 'stale' && state.recipeState?.status !== 'stale'
                ? {trial: null}
                : {}),
            },
          };
        }
      }
      if (['run', 'trial'].includes(run.kind) && a.status === 'enabled') {
        if (run.sourceUrl && !run.recordOperation) {
          const blocked = ['blocked', 'timeout', 'failed'].includes(status),
            state = a.sourceState?.[run.sourceUrl] ?? {};
          a.sourceState = {
            ...a.sourceState,
            [run.sourceUrl]: {
              ...state,
              lastRunAt: this.now(),
              lastStatus: status,
              lastResult: summary,
              lastRunId: run.id,
              ...(run.scan ? {scan: run.scan} : {}),
              ...(blocked
                ? {
                    blocked: true,
                    nextRunAt: null,
                    blocker: {
                      ...run.resumeContext,
                      ...(run.stop ? {stop: run.stop} : {}),
                      runId: run.id,
                      workerId: run.workerId,
                      recordId: run.recordId,
                    },
                  }
                : {blocker: null}),
            },
          };
        } else if (!run.recordOperation) a.nextRunAt = this.now() + a.intervalMinutes * 60000;
        // An uncertain write is held on its record; independent sources and records
        // keep their schedules. Only an unscoped workspace failure stops the workspace.
        if (
          !run.actionId &&
          !run.sourceUrl &&
          !run.recordOperation &&
          ['blocked', 'timeout', 'failed'].includes(status)
        ) {
          a.status = 'blocked';
          a.nextRunAt = null;
          a.retryPlan = {};
        }
      }
      if (run.taskId) {
        const queue = this.store.workspaces.tasks;
        if (release)
          queue.finish(id, run.taskId, status === 'timeout' ? 'failed' : status, summary);
        else
          queue.put({
            ...queue.get(id, run.taskId),
            state: 'reported',
            completionState: status === 'timeout' ? 'failed' : status,
            summary,
          });
      }
      if (
        status === 'completed' &&
        run.recordOperation === 'verify' &&
        run.verifiedNotSubmitted &&
        run.taskId
      ) {
        const queue = this.store.workspaces.tasks;
        queue.put({...queue.get(id, run.taskId), resumeRecordAfterVerification: true});
      }
      this.put(a);
      return this.run(runId);
    });
  },
};
