// @ts-check
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
        !this.slots(id).some((s) => s.run.sourceUrl === task.sourceUrl)
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
  async runSource(id, url, {fresh = false} = {}) {
    this.assertNotStopping(id);
    const source = this.db.sources(id).find((s) => s.url === url);
    if (!source) throw Error('The source does not belong to this workspace');
    if (!source.enabled) throw Error('Turn on the source first');
    if (source.termsRequired) throw Error(TERMS_REQUIRED);
    if (this.slots(id).some((s) => s.run.sourceUrl === url))
      throw Error('This source is already running');
    if (source.siteWait?.exhausted) {
      if (source.accessRecovery?.state === 'waiting')
        return this.sourceAccess.resume(id, url, source.accessRecovery.runId);
      this.db.siteAccess.acknowledge(source.accessRecovery?.waits ?? [source.siteWait]);
      this.sourceState(id, url, {accessRecovery: null});
    }
    const a = this.db.get(id);
    if (a.status !== 'enabled') this.db.enable(id, {sourceUrl: url});
    else if (a.once)
      this.db.put({...a, onceSources: [...new Set([...(a.onceSources ?? a.sources), url])]});
    // resetSources cancels the pending task that carries the saved queue.
    if (fresh) this.db.forgetSourceScan(id, url);
    this.resetSources(id, [url]);
    this.sourceState(id, url, {onceCompleted: false});
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
        onceCompleted: Boolean(this.db.get(id).once),
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
