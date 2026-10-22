// @ts-check
import {randomUUID} from 'node:crypto';
// Only scheduling metadata is durable. Retained Jev tasks/pages remain in RAM.
export function rememberSourceAccess(db, run) {
  if (
    run.status !== 'blocked' ||
    !run.sourceUrl ||
    run.recordId ||
    run.recordOperation ||
    !run.siteWait
  )
    return;
  const a = db.get(run.automationId),
    source = a.sourceState?.[run.sourceUrl];
  if (source?.accessRecovery?.runId === run.id) return;
  const observed = [
    run.siteWait,
    ...db.jevTasks
      .list(a.id, run.taskId)
      .flatMap((t) => Object.values(t.blockedSites ?? {}).map((w) => w.siteWait)),
  ].filter(Boolean);
  const waits = [...new Map(observed.map((w) => [w.site, w])).values()].map(
    ({site, blockedAt, retryAt}) => ({site, blockedAt, retryAt}),
  );
  const accessRecovery = {
    runId: run.id,
    revision: run.revision,
    state: 'waiting',
    retryAt: waits.some((w) => w.retryAt === null)
      ? null
      : Math.max(...waits.map((w) => w.retryAt)),
    waits,
  };
  db.put({
    ...a,
    sourceState: {
      ...a.sourceState,
      [run.sourceUrl]: {...source, siteBlocked: true, accessRecovery},
    },
  });
}

export function finishSourceAccess(db, run) {
  if (
    run.status !== 'completed' ||
    !['run', 'trial'].includes(run.kind) ||
    run.recordId ||
    run.recordOperation
  )
    return;
  const waits = db.db
    .prepare(
      "SELECT json_extract(data,'$.siteWait') AS wait FROM automation_runs WHERE automation_id=? AND (json_extract(data,'$.taskId')=? OR json_extract(data,'$.sourceUrl')=?) AND json_extract(data,'$.siteWait') IS NOT NULL",
    )
    .all(run.automationId, run.taskId, run.sourceUrl ?? null)
    .map((row) => JSON.parse(row.wait));
  db.siteAccess.finish(waits);
}

export class SourceAccessRecovery {
  constructor(runtime, {closeTabs = undefined} = {}) {
    this.runtime = runtime;
    this.db = runtime.db;
    this.closeTabs = closeTabs;
    this.pending = new Map();
    this.retryAt = new Map();
  }
  current(id, url) {
    return this.db.get(id).sourceState?.[url]?.accessRecovery;
  }
  busy(id, url) {
    return this.runtime.slots(id).some((s) => s.run.sourceUrl === url && !s.run.recordId);
  }
  key(id, url) {
    return JSON.stringify([id, url]);
  }
  tick(id) {
    const a = this.db.get(id);
    for (const url of a.sources) {
      let recovery = a.sourceState?.[url]?.accessRecovery;
      // Adopt an existing persisted wait after upgrading; never revive a reset.
      if (!recovery && a.sourceState?.[url]?.blocked && a.sourceState[url].lastRunId) {
        const row = this.db.db
          .prepare('SELECT data FROM automation_runs WHERE id=? AND automation_id=?')
          .get(a.sourceState[url].lastRunId, id);
        if (row) rememberSourceAccess(this.db, JSON.parse(row.data));
        recovery = this.current(id, url);
      }
      if (
        recovery?.state === 'answered' &&
        a.status === 'enabled' &&
        a.sourceSettings?.[url]?.enabled !== false &&
        !this.busy(id, url)
      ) {
        // Pause/disable cancels pending queue entries. Re-enabling work must not
        // strand an already answered source behind a cancelled task forever.
        const task = this.runtime.queue.get(id, this.db.run(recovery.runId).taskId);
        if (task.state === 'cancelled' && !task.stopRequested) {
          this.runtime.queue.put({
            ...task,
            state: 'pending',
            workerId: null,
            completionState: null,
            finishedAt: null,
          });
          this.runtime.sourceState(id, url, {batchId: task.batchId, nextRunAt: this.runtime.now()});
        }
      }
      if (!recovery || !['waiting', 'resetting'].includes(recovery.state) || this.busy(id, url))
        continue;
      if (
        recovery.state === 'waiting' &&
        (recovery.retryAt === null ||
          recovery.retryAt > this.runtime.now() ||
          a.status !== 'enabled' ||
          a.sourceSettings?.[url]?.enabled === false ||
          recovery.revision !== a.revision)
      )
        continue;
      if ((this.retryAt.get(this.key(id, url)) ?? 0) > this.runtime.now()) continue;
      if (recovery.state === 'resetting') void this.reset(id, url, recovery.runId).catch(() => {});
      else
        void this.resume(
          id,
          url,
          recovery.runId,
          'The wait is over; continuing automatically from the saved point.',
          {automatic: true},
        ).catch(() => {});
    }
  }
  async resume(
    id,
    url,
    runId,
    response = 'I resolved the access block, continue.',
    {automatic = false} = {},
  ) {
    const r = this.runtime,
      a = this.db.get(id),
      source = this.db.sources(id).find((s) => s.url === url),
      recovery = this.current(id, url);
    if (
      !source?.enabled ||
      recovery?.runId !== runId ||
      recovery.revision !== a.revision ||
      recovery.state !== 'waiting'
    )
      throw Error('This wait can no longer be resumed. Check the current state of the source.');
    if (this.busy(id, url)) throw Error('The previous session of this source is still closing.');
    if (typeof response !== 'string' || !response.trim() || response.length > 10000)
      throw Error('An answer of 1–10000 characters is required.');
    const run = this.db.run(runId),
      task = r.queue.get(id, run.taskId),
      batchId = task.batchId ?? randomUUID();
    if (automatic) {
      if (
        r.closed ||
        a.status !== 'enabled' ||
        source.stopping ||
        task.stopRequested ||
        recovery.retryAt === null ||
        recovery.retryAt > r.now()
      )
        return {resumed: false};
      // Another worker can encounter a later incident or hold the single probe.
      // Keep this task waiting without clearing that worker's gate.
      const current = recovery.waits
        .map((w) => this.db.siteAccess.forWait(w).status('https://' + w.site))
        .filter(Boolean);
      if (current.some((w) => w.waiting)) {
        r.sourceState(id, url, {
          accessRecovery: {
            ...recovery,
            retryAt: current.some((w) => w.exhausted)
              ? null
              : Math.max(...current.map((w) => w.retryAt)),
            waits: current.map(({site, lane, profile, profileName, blockedAt, retryAt}) => ({
              site,
              lane,
              profile,
              profileName,
              blockedAt,
              retryAt,
            })),
          },
        });
        r.changed(id);
        return {resumed: false};
      }
    }
    this.db.store.workspaces.tasks.atomic(() => {
      if (!automatic) this.db.siteAccess.acknowledge(recovery.waits);
      this.db.jevTasks.resumeAccess(
        id,
        run.taskId,
        recovery.waits.map((w) => w.site),
      );
      if (a.status !== 'enabled') this.db.enable(id, {sourceUrl: url});
      r.clearRetry(id, url);
      r.queue.put({
        ...task,
        batchId,
        state: 'pending',
        workerId: null,
        completionState: null,
        finishedAt: null,
        retryAt: null,
        technicalRecovery: null,
        resumeSourceAfterAnswer: false,
      });
      r.sourceState(id, url, {
        blocked: false,
        blocker: null,
        siteBlocked: false,
        batchId,
        nextRunAt: r.now(),
        accessRecovery: {
          ...recovery,
          state: 'answered',
          automatic,
          response: response.trim(),
          answeredAt: r.now(),
        },
      });
      const current = this.db.get(id);
      this.db.put({
        ...current,
        questions: (current.questions ?? []).map((q) =>
          q.answer == null && !q.recordId && q.runId === runId
            ? {
                ...q,
                answer: response.trim(),
                answeredAt: r.now(),
                resolution: automatic ? 'source_access_retry' : 'source_access_response',
              }
            : q,
        ),
      });
      this.db.message(
        id,
        automatic ? 'system' : 'user',
        `${automatic ? 'Automatic continuation' : 'Reply to intervention'} (${url}): ${response.trim()}`,
      );
    });
    r.changed(id);
    await r.tick();
    return {resumed: true};
  }
  reset(id, url, runId, {dismissed = false} = {}) {
    const r = this.runtime,
      key = this.key(id, url),
      recovery = this.current(id, url);
    if (this.pending.has(key)) return this.pending.get(key);
    if (
      recovery?.runId !== runId ||
      !['waiting', 'resetting'].includes(recovery.state) ||
      this.busy(id, url)
    )
      return Promise.reject(Error('This intervention changed or the source is still running.'));
    // Set this synchronously: a reply and the timer cannot both win.
    r.sourceState(id, url, {
      accessRecovery: {
        ...recovery,
        state: 'resetting',
        dismissed: recovery.dismissed || dismissed,
        cleanupError: null,
      },
    });
    r.changed(id);
    const origin = this.db.run(runId);
    this.db.jevTasks.release(id, origin.taskId);
    this.db.browserEvidence.release(id, origin.taskId);
    this.db.scoringListingTexts?.delete(runId);
    const work = Promise.resolve()
      .then(async () => {
        const run = this.db.run(runId),
          sourceRunIds = this.db.db
            .prepare(
              "SELECT id FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.sourceUrl')=? AND json_extract(data,'$.recordId') IS NULL AND json_extract(data,'$.startedAt')<=?",
            )
            .all(id, url, run.startedAt)
            .map((row) => row.id);
        const result = await this.closeTabs?.(id, run, {
          closeTabs: true,
          sourceAccessReset: true,
          runIds: sourceRunIds,
        });
        if (result?.deferred || result?.retained?.length || result?.failed?.length)
          throw Error(
            "The source's pending tabs could not be closed yet; it will be checked again.",
          );
        if (r.closed) return;
        const a = this.db.get(id),
          current = this.current(id, url);
        if (
          current?.runId !== runId ||
          current.state !== 'resetting' ||
          current.revision !== a.revision
        )
          return;
        for (const task of r.queue.list(id, {states: ['pending']}))
          if (task.sourceUrl === url && !task.recordId)
            r.queue.finish(
              id,
              task.id,
              'cancelled',
              'The access wait is over; the next scan will start from scratch.',
            );
        const state = a.sourceState[url];
        r.clearRetry(id, url);
        r.sourceState(id, url, {
          blocked: false,
          blocker: null,
          siteBlocked: current.retryAt === null,
          batchId: null,
          recovery: null,
          scan: null,
          pageProgress: null,
          observedPage: null,
          scanState: state.scanState ? {...state.scanState, active: null} : null,
          nextRunAt: current.retryAt === null ? null : Math.max(current.retryAt, r.now()),
          accessRecovery: {...current, state: 'fresh', cleanupError: null},
        });
        const saved = this.db.get(id);
        this.db.put({
          ...saved,
          questions: (saved.questions ?? []).map((q) =>
            q.answer == null && !q.recordId && q.runId === runId
              ? {
                  ...q,
                  answer: 'The source will be retried.',
                  answeredAt: r.now(),
                  resolution: 'source_access_reset',
                }
              : q,
          ),
        });
        this.retryAt.delete(key);
        r.changed(id);
        return {closed: true};
      })
      .catch((error) => {
        if (!r.closed && this.current(id, url)?.runId === runId) {
          r.sourceState(id, url, {
            accessRecovery: {...this.current(id, url), cleanupError: error.message},
          });
          r.changed(id);
        }
        this.retryAt.set(key, r.now() + 5000);
        throw error;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
}
