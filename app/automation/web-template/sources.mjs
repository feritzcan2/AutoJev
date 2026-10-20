// @ts-check
import {randomUUID} from 'node:crypto';
import {siteTurn} from '../../sources/site-turns.mjs';
import {sourceInput, TERMS_REQUIRED} from '../../sources/automation-sources.mjs';
import {automationAttention, dismissAutomationAttention} from '../attention.mjs';
// WebTasks methods: per-source state, retries, runs and settings.
export const sourceMethods = {
  sourceState(id, url, patch) {
    const a = this.db.get(id);
    if (
      Object.entries(patch).every(([key, value]) => Object.is(a.sourceState?.[url]?.[key], value))
    )
      return a;
    return this.db.put({
      ...a,
      sourceState: {...a.sourceState, [url]: {...a.sourceState?.[url], ...patch}},
    });
  },
  clearRetry(id, key) {
    const a = this.db.get(id);
    if (!a.retryPlan?.[key]) return;
    const retryPlan = {...a.retryPlan};
    delete retryPlan[key];
    this.db.put({...a, retryPlan});
    this.changed(id);
  },
  retryLater(id, key, cancel = false) {
    const a = this.db.get(id);
    if (cancel) {
      this.clearRetry(id, key);
      return {cancelled: true};
    }
    const issue = automationAttention({
      ...this.db.snapshot(id),
      activeRuns: this.slots(id).map((s) => s.run),
    }).find((i) => i.id === key);
    if (!issue?.retry || issue.closing)
      throw Error('A retry cannot be scheduled for this item right now.');
    const at = this.now() + 2 * 60 * 60 * 1000;
    if (issue.kind === 'site_access') {
      if (issue.accessExhausted)
        throw Error('Automatic retries stopped. Continue once the blocker is resolved.');
      const accessRecovery = this.sourceAccess.current(id, key);
      this.sourceState(id, key, {accessRecovery: {...accessRecovery, retryAt: at}});
      this.changed(id);
      return {at};
    }
    this.db.put({...a, retryPlan: {...a.retryPlan, [key]: {at, revision: a.revision}}});
    this.changed(id);
    return {at};
  },
  async dismissAttention(id, key, dismissKey) {
    const issue = automationAttention({
      ...this.db.snapshot(id),
      activeRuns: this.slots(id).map((s) => s.run),
    }).find((i) => i.id === key);
    if (!issue?.dismissKey || issue.dismissKey !== dismissKey || issue.closing)
      throw Error('This item changed or the session is still closing.');
    if (issue.kind === 'site_access') {
      await this.sourceAccess.reset(id, key, issue.runId, {dismissed: true});
      return {dismissed: true};
    }
    const result = dismissAutomationAttention(this.db, id, key, dismissKey);
    this.changed(id);
    return result;
  },
  resetSources(id, urls) {
    const a = this.db.get(id);
    for (const task of this.queue.list(id, {states: ['pending']}))
      if (
        !task.recordOperation &&
        (!task.sourceUrl || urls.includes(task.sourceUrl)) &&
        !a.sourceState?.[task.sourceUrl]?.accessRecovery &&
        !this.slots(id).some((s) => s.run.sourceUrl === task.sourceUrl && !s.run.recordId)
      )
        this.queue.finish(id, task.id, 'cancelled', 'New source round');
    for (const url of urls) {
      if (a.sourceState?.[url]?.accessRecovery) continue;
      const wait = this.db.sourceWait(id, {url}, a);
      this.clearRetry(id, url);
      this.sourceState(id, url, {
        batchId: null,
        blocked: false,
        blocker: null,
        recovery: null,
        siteBlocked: Boolean(wait?.waiting),
        nextRunAt: wait?.waiting ? wait.retryAt : this.now(),
      });
    }
    return a;
  },
  // The current state of the shared waits a source's access recovery recorded.
  currentSourceWaits(source) {
    return (source.accessRecovery?.waits ?? []).map((w) =>
      this.db.siteAccess.forLane(w.lane).status('https://' + w.site),
    );
  },
  async runSource(id, url, {fresh = false, force = false} = {}) {
    this.assertNotStopping(id);
    let source = this.db.sources(id).find((s) => s.url === url);
    if (!source) throw Error('The source does not belong to this workspace');
    if (!source.enabled) throw Error('Turn on the source first');
    if (source.termsRequired) throw Error(TERMS_REQUIRED);
    // A record's run (an application) from this source is not a scan.
    if (this.slots(id).some((s) => s.run.sourceUrl === url && !s.run.recordId))
      throw Error('This source is already running');
    // A timed site wait resumes by itself; a plain run queues behind it. Force
    // retry is the user choosing not to wait it out: the current wait ends
    // now, as Retry ends one whose automatic retries ran out, and the scan
    // continues from its saved point.
    if (force && source.siteWait?.waiting && !source.siteWait.exhausted) {
      this.db.siteAccess.acknowledge(
        [source.siteWait, ...this.currentSourceWaits(source)].filter((w) => w?.waiting),
      );
      source = this.db.sources(id).find((s) => s.url === url);
    }
    // Starting over from an access block drops the stopped run's saved
    // position, tabs and queue; the stopped wait is retired below.
    if (fresh && source.accessRecovery?.state === 'waiting') {
      await this.sourceAccess.reset(id, url, source.accessRecovery.runId);
      this.sourceState(id, url, {accessRecovery: null});
    }
    // A source waiting on an access block continues from its saved point. The
    // shared wait may already be gone (another workspace or a record retry
    // retired it); the source still waits for this Retry.
    else if (
      source.accessRecovery?.state === 'waiting' &&
      (!source.siteWait?.waiting || source.siteWait.exhausted)
    )
      return this.sourceAccess.resume(id, url, source.accessRecovery.runId);
    if (source.siteWait?.exhausted) {
      // The site waits are shared across workspaces, so the recorded wait can be
      // older than the one on screen. Retry acknowledges the current wait.
      this.db.siteAccess.acknowledge(
        [source.siteWait, ...this.currentSourceWaits(source)].filter(Boolean),
      );
      this.sourceState(id, url, {accessRecovery: null});
    }
    const a = this.db.get(id);
    if (a.status !== 'enabled') this.db.enable(id, {sourceUrl: url});
    // resetSources cancels the pending task that carries the saved queue.
    if (fresh) this.db.forgetSourceScan(id, url);
    this.resetSources(id, [url]);
    // Scan now is the user's call: it skips the gap after another workspace's
    // round on this site (site-turns.mjs), not a round still open there.
    const state = this.db.get(id).sourceState?.[url] ?? {},
      turn = siteTurn(this.db, id, url, this.now());
    if (turn && !turn.scanning && !state.batchId && !state.siteBlocked && !state.accessRecovery)
      this.sourceState(id, url, {batchId: randomUUID(), roundStartedAt: this.now()});
    await this.tick();
    return this.db.sources(id).find((s) => s.url === url);
  },
  // Relearn: the next turn of this source is a trial again, run by the trial agent.
  async relearnSource(id, url) {
    this.assertNotStopping(id);
    const source = this.db.sources(id).find((s) => s.url === url);
    if (!source) throw Error('The source does not belong to this workspace');
    if (source.scanning) await this.stopSource(id, url);
    this.clearRetry(id, url);
    for (const task of this.queue.list(id, {states: ['pending']}))
      if (task.sourceUrl === url && !task.recordOperation)
        this.queue.finish(id, task.id, 'cancelled', 'The source will be learned again');
    this.db.relearnSource(id, url);
    this.sourceState(id, url, {batchId: null});
    this.changed(id);
    if (source.enabled && this.db.get(id).status === 'enabled') await this.tick();
    return this.db.sources(id).find((s) => s.url === url);
  },
  async stopSource(id, url) {
    const source = this.db.sources(id).find((s) => s.url === url);
    if (!source) throw Error('The source does not belong to this workspace');
    const summary = 'Scan stopped by the user.',
      matches = (run) =>
        ['run', 'trial'].includes(run.kind) &&
        !run.recordId &&
        !run.recordOperation &&
        (run.sourceUrl === url ||
          (!run.sourceUrl && run.sources?.length === 1 && run.sources[0] === url));
    const runs = this.db.runs(id).filter((run) => run.status === 'running' && matches(run)),
      slots = this.slots(id).filter((slot) => matches(slot.run)),
      taskIds = new Set(runs.map((run) => run.taskId));
    const nextRunAt = this.now() + source.intervalMinutes * 60000,
      accessTask = source.accessRecovery ? this.db.run(source.accessRecovery.runId).taskId : null;
    this.queue.atomic(() => {
      this.clearRetry(id, url);
      this.sourceState(id, url, {
        stopping: true,
        batchId: null,
        blocked: false,
        siteBlocked: false,
        blocker: null,
        recovery: null,
        accessRecovery: null,
        nextRunAt,
        lastStatus: 'interrupted',
        lastResult: summary,
      });
      if (accessTask) {
        this.queue.put({...this.queue.get(id, accessTask), stopRequested: true});
        this.queue.finish(id, accessTask, 'cancelled', summary);
        this.db.jevTasks.release(id, accessTask);
        this.db.browserEvidence.release(id, accessTask);
      }
      for (const run of runs) this.db.putRun({...run, stopRequested: true});
      for (const task of this.queue.list(id, {
        states: ['pending', 'running', 'reported', 'paused'],
      }))
        if (
          !task.recordId &&
          !task.recordOperation &&
          (task.sourceUrl === url || taskIds.has(task.id))
        ) {
          this.queue.put({...task, stopRequested: true});
          if (task.state === 'pending') this.queue.finish(id, task.id, 'cancelled', summary);
        }
    });
    this.changed(id);
    try {
      await Promise.all(
        slots.map((slot) => this.finish(id, 'interrupted', summary, slot.workerId)),
      );
    } catch (error) {
      this.sourceState(id, url, {stopping: false});
      this.changed(id);
      throw error;
    }
    for (const run of runs)
      if (this.db.run(run.id).status === 'running')
        this.db.finish(id, run.id, 'interrupted', summary);
    for (const task of this.queue.list(id, {states: ['pending', 'running', 'reported', 'paused']}))
      if (task.stopRequested && !task.recordId && (task.sourceUrl === url || taskIds.has(task.id)))
        this.queue.finish(id, task.id, 'cancelled', summary);
    this.sourceState(id, url, {
      stopping: false,
      batchId: null,
      blocked: false,
      siteBlocked: false,
      blocker: null,
      recovery: null,
      nextRunAt,
      lastStatus: 'interrupted',
      lastResult: summary,
    });
    this.changed(id);
    return this.db.sources(id).find((s) => s.url === url);
  },
  async saveSourcesInterval(id, intervalMinutes) {
    this.db.saveSourcesInterval(id, intervalMinutes);
    this.changed(id);
    await this.tick();
    return this.db.sources(id);
  },
  async saveSource(id, url, input) {
    // Validate before stopping anything. Turning a source off only stops its workers.
    sourceInput(this.db.get(id), url, input);
    if (input.enabled === false) {
      if (this.db.sources(id).find((source) => source.url === url).scanning)
        await this.stopSource(id, url);
      this.clearRetry(id, url);
      for (const task of this.queue.list(id, {states: ['pending']}))
        if (task.sourceUrl === url && !task.recordOperation)
          this.queue.finish(id, task.id, 'cancelled', 'Source turned off');
      this.sourceState(id, url, {batchId: null});
    }
    const before = this.db.sources(id).find((s) => s.url === url);
    this.db.saveSource(id, url, input);
    if (input.enabled === true && !before.enabled) this.resetSources(id, [url]);
    this.changed(id);
    await this.tick();
    return this.db.sources(id).find((s) => s.url === url);
  },
};
