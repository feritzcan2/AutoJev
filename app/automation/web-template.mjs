import {continueScoringRun, unreportedScoringRun, requeueScoringRun} from '../scoring/recovery.mjs';
import {continueRecordRun, unreportedRecordRun, requeueRecordRun} from '../records/recovery.mjs';
import {taskHasRecord, batchScoring} from '../records/task-scope.mjs';
import {SourceRetryChecks} from '../sources/retry-check.mjs';
import {CONVERSATION_WORKER, isConversation} from '../workspaces/conversation.mjs';
import {queueProfileUpdate, applyProfileUpdate, applyProfileInPlace} from './profile-updates.mjs';
import {automationRunHistory} from './continuation.mjs';
import {
  enqueueScoreBatch,
  enqueueRecordOperation,
  dispatchRecordOperations,
  recordOperationError,
} from '../records/operations.mjs';
import {sourceTrialReady} from '../sources/trial.mjs';
import {TaskRuns} from './task-runs.mjs';
import {recoverRecordOperations} from '../records/recovery.mjs';
import {workerKey} from './worker-key.mjs';
import {randomUUID} from 'node:crypto';
import {sourceCollector, collectorRun} from '../sources/collectors.mjs';
import {prepareCollection} from '../sources/collector-worker.mjs';
import {automationAttention} from './attention.mjs';
import {
  SourceAccessRecovery,
  rememberSourceAccess,
  finishSourceAccess,
} from '../sources/access-recovery.mjs';
import {
  continueSourceRun,
  unreportedInterviewRun,
  unreportedSourceRun,
  requeueSourceRun,
  recoverUnreportedSources,
} from './recovery.mjs';
import {sourceMethods} from './web-template/sources.mjs';
import {conversationMethods} from './web-template/conversation.mjs';
// Template definitions select operations; the common queue owns dependencies,
// worker leases and record/source exclusivity. No template-name dispatch here.
export class WebTasks extends TaskRuns {
  async saveProfile(id, input, options = {}) {
    this.assertNotStopping(id);
    if (this.restarting.has(id)) throw Error('The workspace is being updated.');
    const saved = queueProfileUpdate(this.db, id, input, options);
    if (!saved.profileUpdate) return {saved: true, applied: true};
    // Without a restart the profile is saved at once; running agents keep their
    // task and read the new profile from their next context read.
    if (options.restart === false && this.slots(id).some((slot) => slot.run.kind !== 'interview')) {
      applyProfileInPlace(this.db, id);
      this.changed(id);
      await this.tick();
      return {saved: true, applied: true, restarted: false};
    }
    this.restarting.add(id);
    this.changed(id);
    try {
      const results = await Promise.allSettled(
        this.slots(id)
          .filter((slot) => slot.run.kind !== 'interview')
          .map((slot) =>
            this.finish(id, 'interrupted', 'Applying the new profile.', slot.workerId),
          ),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (!applyProfileUpdate(this.db, id))
        throw Error('Running tasks could not be stopped yet. Save again.');
    } catch (error) {
      const a = this.db.get(id);
      if (a.profileUpdate)
        this.db.put({...a, profileUpdate: {...a.profileUpdate, error: error.message}});
      throw error;
    } finally {
      this.restarting.delete(id);
      this.changed(id);
    }
    await this.tick();
    return {saved: true, applied: true};
  }
  constructor(db, options) {
    super(
      {
        separateCapacity: (worker) => worker === CONVERSATION_WORKER,
        idleGraceMs: 10000,
        continueIdle: (id, runId) =>
          continueScoringRun(db, id, runId) ??
          continueRecordRun(db, id, runId) ??
          continueSourceRun(db, id, runId),
        unreported: (id, runId, reason) =>
          unreportedScoringRun(db, id, runId, reason) ??
          unreportedRecordRun(db, id, runId, reason) ??
          unreportedInterviewRun(db, id, runId) ??
          unreportedSourceRun(db, id, runId, reason, (options?.now ?? Date.now)()),
        recover: () => {
          const interrupted = db
            .list()
            .flatMap((a) =>
              db.store.workspaces.tasks.list(a.id, {states: ['running', 'reported', 'paused']}),
            );
          db.recover();
          for (const previous of interrupted) {
            const queue = db.store.workspaces.tasks,
              a = db.get(previous.workspaceId),
              task = queue.get(a.id, previous.id),
              source = a.sourceState?.[task.sourceUrl],
              scan = task.scan ?? source?.scan;
            if (task.stopRequested)
              queue.finish(a.id, task.id, 'cancelled', 'Scan stopped by the user.');
            else if (
              task.sourceUrl &&
              !task.recordId &&
              ['interrupted', 'partial'].includes(task.completionState ?? task.state) &&
              a.status === 'enabled' &&
              !source?.blocked
            )
              queue.put({...task, state: 'pending', workerId: null, scan, completionState: null});
            else
              queue.finish(
                a.id,
                task.id,
                task.completionState ?? 'interrupted',
                'The previous app session closed',
              );
          }
          for (const a of db.list())
            if (Object.values(a.sourceState ?? {}).some((s) => s.stopping))
              db.put({
                ...a,
                sourceState: Object.fromEntries(
                  Object.entries(a.sourceState).map(([url, s]) => [url, {...s, stopping: false}]),
                ),
              });
          recoverUnreportedSources(db, (options?.now ?? Date.now)());
          recoverRecordOperations(db);
        },
        config: (id) => db.get(id),
        run: (id) => db.run(id),
        save: (run) => db.putRun(run),
        due: (now) =>
          db
            .list()
            .filter((a) => a.status === 'enabled' && a.nextRunAt <= now)
            .map((a) => a.id),
        begin: (id, input = 'run', worker) => {
          const run = db.begin(id, input, worker),
            a = db.get(id),
            source = a.sourceState?.[run.sourceUrl];
          if (!run.recordId && (source?.recovery || source?.accessRecovery))
            db.put({
              ...a,
              sourceState: {
                ...a.sourceState,
                [run.sourceUrl]: {...source, recovery: null, accessRecovery: null},
              },
            });
          return run;
        },
        report: (id, runId, status, summary, goalReached) => {
          const result = db.finish(id, runId, status, summary, {release: false});
          rememberSourceAccess(db, result);
          if (
            goalReached &&
            result.kind === 'run' &&
            result.status === 'completed' &&
            !result.recordId &&
            !result.recordOperation
          )
            db.pause(id, 'complete');
          return result;
        },
        finish: (id, runId, status, summary) => {
          if (db.run(runId).status === 'running') db.finish(id, runId, status, summary);
          const run = db.run(runId);
          rememberSourceAccess(db, run);
          finishSourceAccess(db, run);
          if (!run.taskId) return;
          const queue = db.store.workspaces.tasks,
            task = queue.get(id, run.taskId);
          if (requeueScoringRun(db, run) || requeueRecordRun(db, run)) {
          } else if (
            ['partial', 'interrupted'].includes(run.status) &&
            run.sourceUrl &&
            !run.recordId &&
            db.get(id).status === 'enabled'
          )
            requeueSourceRun(db, run);
          else
            queue.finish(
              id,
              run.taskId,
              run.status === 'timeout' ? 'failed' : run.status,
              run.summary,
            );
          const waiting = db.get(id).sourceState?.[run.sourceUrl]?.accessRecovery;
          if (
            !(waiting?.runId === run.id && waiting.state === 'waiting') &&
            ['completed', 'failed', 'blocked', 'cancelled'].includes(
              queue.get(id, run.taskId).state,
            )
          ) {
            db.jevTasks.release(id, run.taskId);
            db.browserEvidence.release(id, run.taskId);
            db.scoringListingTexts?.delete(run.id);
          }
        },
        closeFailed: (id, runId, error) => {
          const run = db.run(runId),
            summary = 'The session could not be closed: ' + error.message;
          if (run.status === 'running') db.finish(id, runId, 'failed', summary);
          else db.putRun({...run, status: 'failed', summary});
          if (run.taskId) {
            const q = db.store.workspaces.tasks;
            q.put({...q.get(id, run.taskId), state: 'paused'});
          }
          if (!isConversation(run)) db.pause(id, 'blocked');
        },
        afterFinish: async (id, runId) => {
          if (db.run(runId).collector) return;
          const run = db.run(runId),
            unanswered = (db.get(id).questions ?? []).filter((q) => q.answer == null),
            pending = unanswered.some((q) => q.taskId === run.taskId);
          // Finished work closes its tabs: a trial, a complete scan, a scoring batch,
          // or a record that is not waiting with a prepared, sending or unverified form.
          const record = run.recordId ? db.result(id, run.recordId) : null;
          const finished = record
            ? !['prepared', 'executing', 'uncertain'].includes(record.status)
            : run.kind === 'trial' ||
              batchScoring(run) ||
              Boolean(run.sourceUrl && run.scan?.complete && run.scan.completion !== 'user_stop');
          const closeTabs = run.status === 'completed' && !pending && finished,
            scope = run.recordId ?? (batchScoring(run) ? null : run.sourceUrl);
          // Earlier interrupted or blocked turns of the same record/source may have
          // left their own tabs; runs still waiting for an answer keep theirs.
          const waiting = new Set(unanswered.map((q) => q.runId ?? q.browserContext?.runId));
          const runIds =
            closeTabs && scope
              ? db.db
                  .prepare(
                    `SELECT id FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.status')<>'running' AND ${run.recordId ? "json_extract(data,'$.recordId')=?" : "json_extract(data,'$.sourceUrl')=? AND json_extract(data,'$.recordId') IS NULL"}`,
                  )
                  .all(id, scope)
                  .map((row) => row.id)
                  .filter((other) => !waiting.has(other))
              : [run.id];
          const pendingContexts = unanswered.map((q) => q.browserContext).filter(Boolean);
          await options?.onRunFinished?.(id, run, {
            retainForAccess:
              db.get(id).sourceState?.[run.sourceUrl]?.accessRecovery?.runId === run.id,
            closeTabs,
            keepForms: record?.status !== 'completed',
            runIds,
            pendingTabIds: pendingContexts.map((context) => context.tabId).filter(Boolean),
            pendingUrls: pendingContexts.map((context) => context.url).filter(Boolean),
          });
        },
      },
      options,
    );
    this.db = db;
    this.queue = db.store.workspaces.tasks;
    this.workers = db.store.workspaces.workers;
    this.dispatching = false;
    this.restarting = new Set();
    this.pausing = new Map();
    this.browserReady = options?.browserReady ?? (() => true);
    this.sourceChecks = new SourceRetryChecks(db, {
      probe: options?.probeSource,
      now: this.now,
      changed: this.changed,
      isClosed: () => this.closed,
    });
    this.sourceAccess = new SourceAccessRecovery(this, {closeTabs: options?.onRunFinished});
    const launchAgent = this.launch;
    this.launch = (run, automation, onEvent, signal) => {
      if (collectorRun(automation, run)) {
        prepareCollection(db, run, automation);
        run = db.run(run.id);
      }
      return launchAgent(run, automation, onEvent, signal);
    };
  }
  assertNotStopping(id) {
    if (this.pausing.has(id))
      throw Error('The workspace is stopping. Restart it once shutdown completes.');
  }
  async start(id, input, workerId = 'main') {
    this.assertNotStopping(id);
    return super.start(id, input, workerId);
  }
  plan(id, batchId, source) {
    const a = this.db.get(id),
      template = this.db.template(a.templateId),
      tasks = this.queue.list(id, {batchId});
    if (sourceCollector(a, source.url)) {
      for (const task of tasks)
        if (task.operation === 'trial' && task.state === 'pending')
          this.queue.finish(
            id,
            task.id,
            'cancelled',
            'This source will be scanned by its dedicated collector.',
          );
      const scan = tasks.find((t) => t.operation === 'scan');
      return scan
        ? [scan]
        : [
            this.queue.enqueue(id, {
              batchId,
              sourceUrl: source.url,
              operation: 'scan',
              capability: 'browser.observe',
              subject: source.url,
              sources: [source.url],
              lockKey: 'source:' + source.url,
            }),
          ];
    }
    if (tasks.some((t) => t.operation === 'trial'))
      return tasks.filter((t) => t.operation === 'trial');
    if (!sourceTrialReady(a, source.url)) {
      for (const task of tasks)
        if (task.state === 'pending')
          this.queue.finish(id, task.id, 'cancelled', 'The source’s first round will be a trial');
      return [
        this.queue.enqueue(id, {
          batchId,
          sourceUrl: source.url,
          operation: 'trial',
          capability: 'browser.observe',
          subject: source.url,
          sources: [source.url],
          lockKey: 'source:' + source.url,
        }),
      ];
    }
    for (const step of template.workflow) {
      const subjects =
        step.scope === 'source'
          ? [{key: source.url, sources: [source.url]}]
          : this.db
              .results(id)
              .filter(
                (r) =>
                  !r.trial &&
                  !['completed', 'uncertain', 'executing', 'dismissed'].includes(r.status) &&
                  (r.sourceUrl
                    ? r.sourceUrl === source.url
                    : new URL(r.url).origin === new URL(source.url).origin),
              )
              .map((r) => ({key: r.id, recordId: r.id, sources: [r.url]}));
      for (const subject of subjects) {
        const parents = tasks.filter(
          (t) =>
            step.after.includes(t.operation) &&
            (!t.recordId || !subject.recordId || t.recordId === subject.recordId),
        );
        if (
          step.after.some((parent) => !parents.some((t) => t.operation === parent)) ||
          parents.some((t) => t.state !== 'completed')
        )
          continue;
        if (subject.recordId) {
          const record = this.db.result(id, subject.recordId);
          if (
            (step.capability === 'browser.prepare' && source.mode === 'observe') ||
            (step.capability === 'browser.act' &&
              (source.mode === 'observe' ||
                record.status !== 'prepared' ||
                (source.mode === 'prepare' && record.approvedDigest !== record.digest)))
          )
            continue;
        }
        if (tasks.some((t) => t.operation === step.id && t.subject === subject.key)) continue;
        const task = this.queue.enqueue(id, {
          batchId,
          sourceUrl: source.url,
          operation: step.id,
          capability: step.capability,
          subject: subject.key,
          recordId: subject.recordId,
          sources: subject.sources,
          lockKey: (subject.recordId ? 'record:' : 'source:') + subject.key,
          dependsOn: parents.map((t) => t.id),
        });
        tasks.push(task);
      }
    }
    return tasks;
  }
  async tick({workspaceId, workerId} = {}) {
    if (this.closed || this.dispatching) return;
    this.dispatching = true;
    try {
      recoverUnreportedSources(this.db, this.now());
      const ready = [],
        canBrowse = new Set();
      for (const saved of this.db.list()) {
        if (this.restarting.has(saved.id) || this.pausing.has(saved.id)) continue;
        if (saved.profileUpdate) {
          if (saved.profileUpdate.error) continue;
          if (
            this.slots(saved.id).some((slot) => slot.run.kind !== 'interview') ||
            !applyProfileUpdate(this.db, saved.id)
          )
            continue;
          this.changed(saved.id);
        }
        this.sourceAccess.tick(saved.id);
        const native = saved.sources.some(
          (url) => saved.sourceSettings?.[url]?.enabled !== false && sourceCollector(saved, url),
        );
        // Loading every record is the costly check, so it runs last.
        const automaticRecords = () =>
          saved.status === 'enabled' &&
          saved.mode !== 'observe' &&
          this.db.results(saved.id).some((item) => {
            const kind =
              item.status === 'found' ? 'prepare' : item.status === 'prepared' ? 'execute' : null;
            return kind && !recordOperationError(saved, item, kind, {now: this.now()});
          });
        const needsBrowser =
          !native ||
          saved.sources.some(
            (url) => saved.sourceSettings?.[url]?.enabled !== false && !sourceCollector(saved, url),
          ) ||
          this.queue
            .list(saved.id, {states: ['pending'], summary: true})
            .some((t) => t.recordOperation) ||
          automaticRecords();
        const browserReady = needsBrowser && this.browserReady(saved.id);
        if (browserReady) canBrowse.add(saved.id);
        if (!browserReady && !native) continue;
        ready.push(saved.id);
        // Give explicit requests every available worker before any workspace can
        // spend shared capacity on older source tasks or automatic record work.
        if (browserReady) await dispatchRecordOperations(this, saved.id, {manualOnly: true});
      }
      for (const id of ready) {
        if (this.closed || this.pausing.has(id) || this.restarting.has(id)) continue;
        let a = this.db.get(id);
        if (a.profileUpdate) continue;
        for (const [key, retry] of Object.entries(a.retryPlan ?? {})) {
          if (retry.revision !== a.revision) {
            this.clearRetry(a.id, key);
            continue;
          }
          if (retry.at > this.now()) continue;
          const issue = automationAttention({
            ...this.db.snapshot(a.id),
            activeRuns: this.slots(a.id).map((s) => s.run),
          }).find((i) => i.id === key);
          if (!issue?.retry) {
            this.clearRetry(a.id, key);
            continue;
          }
          if (
            issue.closing ||
            this.capacityUsed >= this.concurrency ||
            (a.status !== 'enabled' && this.slots(a.id).length)
          )
            continue;
          const worker =
            issue.retry === 'trial'
              ? this.workers.list(a.id).find((w) => w.enabled !== false)
              : null;
          if (issue.retry === 'trial' && !worker) continue;
          this.clearRetry(a.id, key);
          try {
            if (issue.retry === 'source') await this.runSource(a.id, issue.sourceUrl);
            else void this.start(a.id, 'trial', worker.id).catch(() => {});
          } catch (error) {
            this.db.message(
              a.id,
              'system',
              'The scheduled trial could not start: ' + error.message,
            );
            this.changed(a.id);
          }
        }
        for (const task of this.queue
          .resumptions(a.id)
          .filter(
            (t) =>
              t.resumeSourceAfterAnswer && !['running', 'reported', 'paused'].includes(t.state),
          )) {
          this.queue.put({...task, resumeSourceAfterAnswer: false});
          if (
            a.status === 'enabled' &&
            !task.stopRequested &&
            ['blocked', 'failed'].includes(task.state) &&
            a.sources.includes(task.sourceUrl) &&
            a.sourceSettings?.[task.sourceUrl]?.enabled !== false
          ) {
            this.resetSources(a.id, [task.sourceUrl]);
            this.sourceState(a.id, task.sourceUrl, {onceCompleted: false});
            this.changed(a.id);
          }
        }
        a = this.db.get(a.id);
        if (canBrowse.has(a.id)) await dispatchRecordOperations(this, a.id);
        if (this.closed || this.pausing.has(a.id) || this.restarting.has(a.id)) continue;
        a = this.db.get(a.id);
        if (a.status !== 'enabled') continue;
        if (
          this.slots(a.id).some(
            (s) =>
              !isConversation(s.run) &&
              (s.run.kind === 'interview' || (s.run.kind === 'trial' && !s.run.sourceUrl)),
          )
        )
          continue;
        const pending = [];
        for (const source of this.db.schedulingSources(a.id, a)) {
          if (
            !source.enabled ||
            source.stopping ||
            (a.onceSources && !a.onceSources.includes(source.url))
          )
            continue;
          if (!canBrowse.has(a.id) && !sourceCollector(a, source.url)) continue;
          // Skip due turns during an existing search instead of queuing a duplicate.
          if (this.slots(a.id).some((s) => s.run.sourceUrl === source.url)) continue;
          if (['waiting', 'resetting'].includes(source.accessRecovery?.state)) continue;
          if (source.accessRecovery?.state === 'fresh' && source.nextRunAt > this.now()) continue;
          if (
            (a.questions ?? []).some(
              (q) =>
                !q.conversation &&
                q.answer == null &&
                !q.recordId &&
                (!q.sourceUrl || q.sourceUrl === source.url),
            )
          )
            continue;
          if (source.siteWait?.waiting || source.termsRequired) continue;
          if (source.siteBlocked && !source.blocker?.recordId) {
            this.sourceState(a.id, source.url, {
              blocked: false,
              siteBlocked: false,
              batchId: null,
              nextRunAt: this.now(),
              onceCompleted: false,
            });
            Object.assign(source, {
              blocked: false,
              batchId: null,
              nextRunAt: this.now(),
              onceCompleted: false,
            });
          }
          let batchId = source.batchId;
          if (!batchId) {
            if (source.blocked || source.nextRunAt > this.now() || (a.once && source.onceCompleted))
              continue;
            batchId = randomUUID();
            this.sourceState(a.id, source.url, {batchId});
          }
          const tasks = source.blocked
            ? this.queue.list(a.id, {batchId})
            : this.plan(a.id, batchId, source);
          if (source.blocked)
            for (const task of tasks.filter((t) => t.state === 'pending'))
              this.queue.finish(a.id, task.id, 'cancelled', 'Source blocked');
          const waiting = source.blocked ? [] : tasks.filter((t) => t.state === 'pending');
          if (!waiting.length && !this.slots(a.id).some((s) => s.run.batchId === batchId)) {
            const blocked =
              source.blocked ||
              tasks.some((t) => ['blocked', 'failed', 'interrupted'].includes(t.state));
            // A passed trial only learned the source; its first scan starts right away.
            const trialPassed =
              tasks.some((t) => t.operation === 'trial') &&
              sourceTrialReady(this.db.get(a.id), source.url);
            this.sourceState(a.id, source.url, {
              batchId: null,
              blocked,
              nextRunAt: blocked
                ? null
                : this.now() + (trialPassed ? 0 : source.intervalMinutes * 60000),
              onceCompleted: Boolean(a.once),
            });
          } else
            pending.push(...waiting.filter((task) => !task.retryAt || task.retryAt <= this.now()));
        }
        const current = this.db.get(a.id),
          sources = this.db.schedulingSources(a.id, current),
          eligible = sources.filter(
            (s) => s.enabled && (!a.onceSources || a.onceSources.includes(s.url)),
          );
        if (
          a.once &&
          !this.slots(a.id).some((s) => !isConversation(s.run)) &&
          !pending.length &&
          eligible.every(
            (s) =>
              !s.siteWait &&
              (s.blocked || s.onceCompleted || s.termsRequired) &&
              !(a.questions ?? []).some(
                (q) =>
                  !q.conversation &&
                  q.answer == null &&
                  !q.recordId &&
                  (!q.sourceUrl || q.sourceUrl === s.url),
              ),
          )
        ) {
          this.db.put({
            ...this.db.get(a.id),
            once: false,
            onceSources: null,
            status: 'paused',
            nextRunAt: null,
          });
          this.changed(a.id);
          continue;
        }
        const next = sources
          .filter(
            (s) =>
              s.enabled && !s.termsRequired && !s.siteWait?.exhausted && (!s.blocked || s.siteWait),
          )
          .map((s) => s.siteWait?.retryAt ?? s.nextRunAt ?? this.now());
        const nextRunAt = next.length ? Math.min(...next) : null;
        if (current.nextRunAt !== nextRunAt) this.db.put({...current, nextRunAt});
        pending.sort((x, y) => x.createdAt - y.createdAt);
        for (const worker of this.workers
          .list(a.id)
          .sort((x, y) =>
            a.id === workspaceId ? Number(y.id === workerId) - Number(x.id === workerId) : 0,
          )) {
          if (
            worker.enabled === false ||
            this.active.has(workerKey(a.id, worker.id)) ||
            this.capacityUsed >= this.concurrency
          )
            continue;
          const index = pending.findIndex(
            (task) =>
              sourceCollector(a, task.sourceUrl) ||
              (canBrowse.has(a.id) && this.sourceChecks.ready(a.id, task)),
          );
          if (index < 0) continue;
          const [task] = pending.splice(index, 1);
          // Reservation occurs synchronously inside start before provider awaits.
          void this.start(
            a.id,
            {kind: task.operation === 'trial' ? 'trial' : 'run', taskId: task.id},
            worker.id,
          ).catch(() => {});
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
  async runRecords(id, itemIds) {
    const task = enqueueScoreBatch(this, id, itemIds);
    await this.tick();
    return this.queue.get(id, task.id);
  }
  async runRecord(id, itemId, kind, input = {}) {
    this.retireRecordSiteWait(id, itemId);
    const task = enqueueRecordOperation(this, id, itemId, kind, {
      manual: true,
      digest: input.digest,
      direct: input.direct,
      changes: input.changes,
    });
    await this.tick();
    return this.queue.get(id, task.id);
  }
  // A wait whose automatic retries ran out needs the user. A record retry is
  // that intervention, as a source run is: it retires the wait the record's
  // last run stopped on, unless the site has failed again since.
  retireRecordSiteWait(id, itemId) {
    const row = this.db.db
      .prepare(
        "SELECT json_extract(data,'$.siteWait') AS wait FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.recordId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(id, itemId);
    const wait = row?.wait && JSON.parse(row.wait),
      current =
        wait?.exhausted && this.db.siteAccess.forLane(wait.lane).status('https://' + wait.site);
    if (current?.exhausted && current.blockedAt === wait.blockedAt)
      this.db.siteAccess.acknowledge([wait]);
  }
  markRecordSubmitted(id, itemId) {
    const item = this.db.markSubmitted(id, itemId);
    this.changed(id);
    return item;
  }
  async dismissRecord(id, itemId) {
    const item = this.db.dismiss(id, itemId, {stopActive: true});
    this.changed(id);
    await Promise.all(
      this.slots(id)
        .filter((slot) => taskHasRecord(slot.run, itemId))
        .map((slot) =>
          this.finish(id, 'interrupted', 'The user rejected this record.', slot.workerId),
        ),
    );
    for (const task of this.queue.list(id, {states: ['pending', 'running', 'reported', 'paused']}))
      if (taskHasRecord(task, itemId))
        this.queue.finish(id, task.id, 'cancelled', 'The user rejected this record.');
    this.changed(id);
    return item;
  }
  async runOnce(id) {
    this.assertNotStopping(id);
    this.db.enable(id);
    const urls = this.db
      .sources(id)
      .filter((s) => s.enabled)
      .map((s) => s.url);
    this.resetSources(id, urls);
    for (const url of urls) this.sourceState(id, url, {onceCompleted: false});
    this.db.put({...this.db.get(id), once: true, onceSources: urls});
    await this.tick();
    return this.slots(id)[0]?.run ?? null;
  }
  report(id, runId, status, summary, goalReached = false) {
    const result = this.complete(id, runId, status, summary, {goalReached}),
      run = this.db.run(runId);
    if (
      status === 'blocked' &&
      run.kind === 'trial' &&
      !run.sourceUrl &&
      run.siteWait &&
      !run.siteWait.exhausted
    ) {
      const a = this.db.get(id);
      this.db.put({
        ...a,
        retryPlan: {...a.retryPlan, [runId]: {at: run.siteWait.retryAt, revision: a.revision}},
      });
      this.changed(id);
    }
    return result;
  }
  pause(id, status = 'paused') {
    if (this.pausing.has(id)) return this.pausing.get(id);
    // Revoke queued work before releasing any worker slot. Manual tasks can
    // normally run in a paused workspace, but cannot cross an explicit stop.
    this.queue.atomic(() => {
      this.db.pause(id, status);
      for (const task of this.queue.list(id)) {
        if (
          task.resumeRecordAfterVerification ||
          task.resumeRecordAfterAnswer ||
          task.resumeSourceAfterAnswer
        )
          this.queue.put({
            ...task,
            resumeRecordAfterVerification: false,
            resumeRecordAfterAnswer: false,
            resumeSourceAfterAnswer: false,
          });
        if (
          ['pending', 'running', 'reported', 'paused'].includes(task.state) &&
          task.recordOperation
        )
          this.queue.put({...this.queue.get(id, task.id), stopRequested: true});
        if (task.state === 'pending') this.queue.finish(id, task.id, 'cancelled', 'Run stopped');
      }
    });
    const slots = this.slots(id);
    for (const slot of slots) slot.controller.abort();
    const stopping = Promise.resolve()
      .then(async () => {
        const results = await Promise.allSettled(
          slots.map((slot) =>
            this.finish(id, 'interrupted', 'Stopped by the user.', slot.workerId),
          ),
        );
        for (const source of this.db.sources(id)) this.sourceState(id, source.url, {batchId: null});
        this.db.put({
          ...this.db.get(id),
          batchId: null,
          once: false,
          onceSources: null,
          retryPlan: {},
        });
        this.changed(id);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
      })
      .finally(() => this.pausing.delete(id));
    this.pausing.set(id, stopping);
    return stopping;
  }
  async restart(id) {
    if (this.restarting.has(id)) throw Error('The workspace is restarting.');
    const a = this.db.get(id),
      runs = this.slots(id).map((slot) => this.db.run(slot.run.id)),
      conversation = runs.find(isConversation),
      setup = runs.find((run) => run.kind === 'interview' && !isConversation(run));
    this.restarting.add(id);
    try {
      await this.pause(id);
      for (const worker of [...this.workers.list(id), {id: CONVERSATION_WORKER}]) {
        const history = this.db.store.workspaces.history(id, worker.id);
        for (const provider of ['codex', 'claude', 'opencode'])
          history.forgetConversation(id, provider, history.conversation(id, provider));
      }
      this.db.db
        .prepare(
          "UPDATE automation_runs SET data=json_set(data,'$.conversation',NULL) WHERE automation_id=? AND json_extract(data,'$.conversation') IS NOT NULL",
        )
        .run(id);
      if (setup) return await this.start(id, setup.kind, setup.workerId);
      if (conversation && a.status !== 'enabled' && !runs.some((run) => !isConversation(run)))
        return await this.start(
          id,
          {
            kind: 'interview',
            messageId: conversation.messageId,
            inputQuestionIds: conversation.inputQuestionIds,
          },
          CONVERSATION_WORKER,
        );
      this.db.enable(id);
      if (a.once) this.db.put({...this.db.get(id), once: true, onceSources: a.onceSources});
      if (conversation)
        await this.start(
          id,
          {
            kind: 'interview',
            messageId: conversation.messageId,
            inputQuestionIds: conversation.inputQuestionIds,
          },
          CONVERSATION_WORKER,
        );
    } finally {
      this.restarting.delete(id);
    }
    await this.tick();
    return this.slots(id)[0]?.run ?? null;
  }
  async add(id, input) {
    const worker = this.workers.add(id, input);
    this.changed(id);
    await this.tick();
    return worker;
  }
  restartState(id, worker) {
    // Browser settings can close the session before the restart confirmation.
    // Keep the last worker task's kind so unfinished setup never becomes a trial.
    const slot = this.slots(id).find((s) => s.workerId === worker),
      run = slot
        ? this.db.run(slot.run.id)
        : this.db.runs(id).find((r) => (r.workerId ?? 'main') === worker);
    return run
      ? {kind: run.kind, resume: run.kind === 'interview' && !isConversation(run), runId: run.id}
      : null;
  }
  async startWorker(id, worker, restart) {
    this.assertNotStopping(id);
    this.workers.get(id, worker);
    if (worker === CONVERSATION_WORKER)
      return restart ? this.configureConversation(id, null, {restart: true}) : this.setup(id);
    if (restart?.runId && !restart.resume) {
      const previous = this.db.run(restart.runId),
        conversation = previous.conversation;
      if (previous.automationId !== id || (previous.workerId ?? 'main') !== worker)
        throw Error('The session to restart does not belong to this worker.');
      // Source retries use the run's conversation, not just worker history. Clear
      // both references while retaining the durable task, queue and browser tabs.
      if (conversation)
        automationRunHistory(
          this.db,
          previous,
          this.db.store.workspaces.history(id, worker),
          conversation.profileId,
        ).forgetConversation(id, conversation.provider, conversation.nativeId);
    }
    this.workers.setEnabled(id, worker, true);
    if (restart?.kind === 'interview') return this.start(id, 'interview', worker);
    const a = this.db.get(id);
    if (a.status !== 'enabled') {
      this.db.enable(id);
      this.resetSources(
        id,
        this.db
          .sources(id)
          .filter((s) => s.enabled && !s.blocked)
          .map((s) => s.url),
      );
    }
    await this.tick({workspaceId: id, workerId: worker});
  }
  async stopWorker(id, worker) {
    this.workers.get(id, worker);
    if (worker !== CONVERSATION_WORKER) this.workers.setEnabled(id, worker, false);
    await this.finish(
      id,
      'interrupted',
      worker === CONVERSATION_WORKER ? 'Chat stopped.' : 'Worker stopped.',
      worker,
    );
    this.changed(id);
  }
  async remove(id, worker) {
    if (worker === 'main' || worker === CONVERSATION_WORKER)
      throw Error('The first worker cannot be removed.');
    await this.stopWorker(id, worker);
    this.workers.remove(id, worker);
    this.changed(id);
  }
}

// Larger method groups live in ./web-template/ and share `this` with the class.
Object.assign(WebTasks.prototype, sourceMethods, conversationMethods);
