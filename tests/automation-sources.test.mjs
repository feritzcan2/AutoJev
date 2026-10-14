import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {automationProgress} from '../app/automation/progress.mjs';

const urls = [
  'https://blocked.test/search',
  'https://fast.test/search',
  'https://slow.test/search',
];
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, {onRunFinished} = {}) {
  const store = new WorkspaceDatabase(':memory:');
  let now = 1_790_000_000_000;
  const db = new AutomationStore(store, {now: () => now});
  const a = db.create('housing', {
    title: 'Evler',
    goal: 'Uygun evleri bul',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 oda'},
    sources: urls,
  });
  db.review(a.id);
  const trial = db.begin(a.id, 'trial');
  for (const url of urls) db.observe(a.id, trial.id, url, 'Observed listings');
  db.finish(a.id, trial.id, 'completed', 'Read all sources');
  const launches = [],
    runtime = new WebTasks(db, {
      now: () => now,
      onRunFinished,
      launch: async (run) => {
        launches.push(run);
        return {close: async () => {}};
      },
    });
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const finish = async (run, status = 'completed') => {
    runtime.report(a.id, run.id, status, status === 'blocked' ? 'IP range blocked' : 'Observed');
    await runtime.finish(a.id, status, 'Observed', run.workerId);
  };
  return {
    store,
    db,
    id: a.id,
    runtime,
    launches,
    finish,
    advance: (minutes) => {
      now += minutes * 60000;
    },
  };
}

test('one worker continues other sources after an access block and honors separate intervals', async (t) => {
  const {db, id, runtime, launches, finish, advance} = fixture(t);
  db.saveSource(id, urls[1], {intervalMinutes: 1});
  db.saveSource(id, urls[2], {intervalMinutes: 10});
  db.enable(id);
  await runtime.tick();
  await settle();
  await finish(launches[0], 'blocked');
  await runtime.tick();
  await settle();
  assert.equal(launches[1].sourceUrl, urls[1]);
  await finish(launches[1]);
  await runtime.tick();
  await settle();
  assert.equal(launches[2].sourceUrl, urls[2]);
  await finish(launches[2]);
  await runtime.tick();
  assert.equal(db.get(id).status, 'enabled');
  assert.equal(db.sources(id)[0].blocked, true);
  assert.equal(db.sources(id)[0].nextRunAt, null);
  advance(2);
  await runtime.tick();
  await settle();
  assert.equal(launches.length, 4);
  assert.equal(launches[3].sourceUrl, urls[1]);
  assert.equal(launches.filter((r) => r.sourceUrl === urls[0]).length, 1);
  await finish(launches[3]);
  await runtime.tick();
  await runtime.close();
  const recovered = new WebTasks(db, {
    launch: async () => {
      throw Error('Should not launch');
    },
  });
  await recovered.close();
  assert.equal(db.sources(id)[0].blocked, true);
});

test('parallel workers retain their own source leases and disabling one source leaves the other running', async (t) => {
  const {store, db, id, runtime, launches} = fixture(t);
  store.workspaces.workers.add(id);
  db.enable(id);
  await runtime.tick();
  await settle();
  assert.equal(launches.length, 2);
  const other = launches[1];
  await runtime.saveSource(id, urls[0], {enabled: false});
  await settle();
  assert.equal(db.run(other.id).status, 'running');
  assert.equal(db.sources(id)[0].enabled, false);
  assert.equal(launches.length, 3);
  assert.equal(launches[2].sourceUrl, urls[2]);
  assert.equal(db.get(id).status, 'enabled');
});

test('disabling a running source waits for its scan to stop before switching it off', async (t) => {
  const {store, db, id, runtime, launches} = fixture(t);
  store.workspaces.workers.add(id);
  db.enable(id);
  await runtime.tick();
  await settle();
  const scan = launches.find((run) => run.sourceUrl === urls[0]),
    other = launches.find((run) => run.sourceUrl === urls[1]);
  runtime.sourceState(id, urls[0], {
    scan: {complete: false, pendingUrls: ['https://blocked.test/next']},
  });
  let release;
  runtime.slots(id).find((slot) => slot.run.id === scan.id).worker.close = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const disabling = runtime.saveSource(id, urls[0], {enabled: false});
  assert.equal(db.sources(id)[0].enabled, true);
  assert.equal(db.sources(id)[0].stopping, true);
  assert.equal(db.run(other.id).status, 'running');
  release();
  await disabling;
  const source = db.sources(id)[0],
    task = runtime.queue.get(id, scan.taskId);
  assert.equal(source.enabled, false);
  assert.equal(source.scanning, false);
  assert.equal(source.stopping, false);
  assert.deepEqual(source.scan, {complete: false, pendingUrls: ['https://blocked.test/next']});
  assert.equal(task.stopRequested, true);
  assert.equal(task.state, 'cancelled');
  assert.equal(db.run(other.id).status, 'running');
});

test('confirmed scan completion cleans tabs before the worker becomes available', async (t) => {
  const calls = [];
  let release;
  const {db, id, runtime, launches} = fixture(t, {
    onRunFinished: (owner, run, options) => {
      calls.push({owner, run, options});
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  db.enable(id);
  await runtime.tick();
  await settle();
  const scan = launches[0];
  db.putRun({
    ...db.run(scan.id),
    scan: {
      complete: true,
      pendingUrls: [],
      reason: 'Reached the end',
      evidenceUrl: scan.sourceUrl,
      completion: 'end',
    },
  });
  runtime.report(id, scan.id, 'completed', 'All pages checked');
  const finishing = runtime.finish(id, 'completed', 'All pages checked', scan.workerId);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.closeTabs, true);
  assert.equal(runtime.slots(id).length, 1);
  release();
  await finishing;
  assert.equal(runtime.slots(id).length, 0);
});

test('a completed source trial closes its tabs and those left by earlier turns of the source', async (t) => {
  const calls = [],
    {db, id, runtime, launches} = fixture(t, {
      onRunFinished: (owner, run, options) => calls.push(options),
    });
  await runtime.relearnSource(id, urls[0]);
  await runtime.runSource(id, urls[0]);
  await settle();
  const blocked = launches.at(-1);
  assert.equal(blocked.kind, 'trial');
  runtime.report(id, blocked.id, 'blocked', 'Verification');
  await runtime.finish(id, 'blocked', 'Verification', blocked.workerId);
  assert.equal(calls.at(-1).closeTabs, false);
  await runtime.runSource(id, urls[0]);
  await settle();
  const trial = launches.at(-1);
  assert.equal(trial.kind, 'trial');
  assert.notEqual(trial.id, blocked.id);
  db.observe(id, trial.id, urls[0], 'Listings');
  runtime.report(id, trial.id, 'completed', 'Source checked');
  await runtime.finish(id, 'completed', 'Source checked', trial.workerId);
  assert.equal(db.run(trial.id).status, 'completed');
  assert.equal(calls.at(-1).closeTabs, true);
  assert.equal(calls.at(-1).keepForms, true);
  assert.deepEqual(calls.at(-1).runIds.toSorted(), [blocked.id, trial.id].toSorted());
});

test('a source waiting for an answer keeps its task tabs open', async (t) => {
  const calls = [],
    {db, id, runtime, launches} = fixture(t, {
      onRunFinished: (owner, run, options) => calls.push(options),
    });
  db.enable(id);
  await runtime.tick();
  await settle();
  const scan = launches[0];
  db.putRun({
    ...db.run(scan.id),
    scan: {
      complete: true,
      pendingUrls: [],
      reason: 'Reached the end',
      evidenceUrl: scan.sourceUrl,
      completion: 'end',
    },
  });
  db.askQuestion(id, {text: 'Which location should I use?'}, {runId: scan.id});
  runtime.report(id, scan.id, 'completed', 'All pages checked');
  await runtime.finish(id, 'completed', 'All pages checked', scan.workerId);
  assert.equal(calls.at(-1).closeTabs, false);
});

test('stop source preserves progress, other workers and record operations, then waits for its interval', async (t) => {
  const {store, db, id, runtime, launches, advance} = fixture(t);
  db.save(id, {mode: 'observe'});
  store.workspaces.workers.add(id);
  db.enable(id);
  await runtime.tick();
  await settle();
  const scan = launches.find((r) => r.sourceUrl === urls[0]),
    other = launches.find((r) => r.sourceUrl === urls[1]);
  const item = db.record(id, scan.id, {
    url: 'https://blocked.test/home',
    title: 'Home',
    summary: 'Saved before stop',
    assessment: {score: 70},
  });
  const a = db.get(id);
  runtime.sourceState(id, urls[0], {
    pageProgress: {page: 2, evidence: 'Page two', at: db.now()},
    scan: {complete: false, pendingUrls: ['https://blocked.test/next']},
  });
  const worker = store.workspaces.workers.add(id),
    recordTask = runtime.queue.enqueue(id, {
      recordId: item.id,
      recordOperation: 'prepare',
      sourceUrl: urls[0],
      operation: 'prepare',
    });
  runtime.queue.claim(id, recordTask.id, worker.id);
  const before = {...db.sources(id)[0], pageProgress: db.get(id).sourceState[urls[0]].pageProgress};
  await runtime.stopSource(id, urls[0]);
  const stopped = db.sources(id)[0];
  assert.equal(stopped.scanning, false);
  assert.equal(stopped.enabled, true);
  assert.equal(stopped.blocked, false);
  assert.equal(stopped.nextRunAt, db.now() + before.intervalMinutes * 60000);
  assert.deepEqual(stopped.pageProgress, before.pageProgress);
  assert.deepEqual(stopped.scan, before.scan);
  assert.equal(db.result(id, item.id).summary, 'Saved before stop');
  assert.equal(db.run(other.id).status, 'running');
  assert.equal(runtime.queue.get(id, recordTask.id).state, 'running');
  assert.equal(runtime.queue.get(id, scan.taskId).state, 'cancelled');
  assert.equal(db.get(id).status, a.status);
  await runtime.tick();
  assert.equal(launches.filter((r) => r.sourceUrl === urls[0]).length, 1);
  advance(before.intervalMinutes + 1);
  await runtime.finish(id, 'completed', 'Finished other source', other.workerId);
  await runtime.tick();
  await settle();
  assert.ok(launches.some((r) => r.sourceUrl === urls[0] && r.id !== scan.id));
});

test('stop scan cannot restart during closure and persists across app recovery', async (t) => {
  const {db, id, runtime, launches} = fixture(t);
  db.enable(id);
  await runtime.tick();
  await settle();
  const scan = launches[0];
  let release;
  runtime.slots(id)[0].worker.close = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const stopping = runtime.stopSource(id, urls[0]);
  await runtime.tick();
  assert.equal(launches.length, 1);
  assert.equal(db.sources(id)[0].stopping, true);
  release();
  await stopping;
  const task = runtime.queue.get(id, scan.taskId);
  assert.equal(task.stopRequested, true);
  assert.equal(task.state, 'cancelled');
  // Simulate a crash after stop intent was stored but before the session closed.
  runtime.queue.put({...task, state: 'running'});
  db.putRun({...db.run(scan.id), status: 'running', finishedAt: null});
  runtime.sourceState(id, urls[0], {stopping: true});
  const recovered = new WebTasks(db, {launch: async () => ({close: async () => {}})});
  assert.equal(recovered.queue.get(id, task.id).state, 'cancelled');
  assert.equal(db.sources(id)[0].stopping, false);
  assert.ok(db.sources(id)[0].nextRunAt > db.now());
  await recovered.close();
  await assert.rejects(runtime.stopSource(id, 'https://unknown.test/'), /does not belong/);
});

test('record preparation does not appear as an active source scan', async (t) => {
  const {db, id, runtime, launches, finish} = fixture(t);
  db.save(id, {mode: 'observe'});
  await runtime.runSource(id, urls[0]);
  await settle();
  const scan = launches[0];
  const item = db.record(id, scan.id, {
    url: 'https://blocked.test/home',
    title: 'Home',
    summary: 'Observed',
    assessment: {score: 70},
  });
  await finish(scan);
  await runtime.runRecord(id, item.id, 'prepare');
  await settle();
  assert.equal(launches.at(-1).recordId, item.id);
  assert.equal(db.sources(id)[0].scanning, false);
  await runtime.stopSource(id, urls[0]);
  assert.equal(db.run(launches.at(-1).id).status, 'running');
});

for (const spareWorker of [false, true])
  test(`retrying a blocked source while a paused workspace processes a record (spare worker: ${spareWorker})`, async (t) => {
    const {store, db, id, runtime, launches, finish} = fixture(t);
    db.save(id, {mode: 'observe'});
    await runtime.runSource(id, urls[1]);
    await settle();
    const seed = launches.at(-1),
      item = db.record(id, seed.id, {
        url: 'https://fast.test/home',
        title: 'Home',
        summary: 'Observed',
        assessment: {score: 70},
      });
    await finish(seed);
    await runtime.tick();
    await runtime.runSource(id, urls[0]);
    await settle();
    const failed = launches.at(-1);
    const scan = {
      complete: false,
      pendingUrls: ['https://blocked.test/next'],
      reason: 'Continue saved listings',
    };
    db.putRun({...db.run(failed.id), scan});
    await finish(failed, 'blocked');
    await runtime.tick();
    assert.equal(db.get(id).status, 'paused');
    assert.equal(db.sources(id)[0].blocked, true);
    await runtime.runRecord(id, item.id, 'prepare');
    await settle();
    const recordRun = launches.at(-1);
    assert.equal(recordRun.recordId, item.id);
    assert.equal(db.get(id).status, 'paused');
    if (spareWorker) store.workspaces.workers.add(id);
    const otherStates = urls.slice(1).map((url) => db.get(id).sourceState[url]);
    assert.throws(() => db.enable(id), /Stop the running automation first/);
    await runtime.runSource(id, urls[0]);
    await settle();
    assert.equal(db.run(recordRun.id).status, 'running');
    assert.equal(runtime.slot(id, recordRun.id).finishing, false);
    assert.equal(db.get(id).status, 'enabled');
    assert.equal(db.get(id).once, true);
    assert.deepEqual(db.get(id).onceSources, [urls[0]]);
    assert.deepEqual(
      urls.slice(1).map((url) => db.get(id).sourceState[url]),
      otherStates,
    );
    assert.equal(db.sources(id)[0].blocked, false);
    assert.deepEqual(db.get(id).sourceState[urls[0]].scan, scan);
    const pending = runtime.queue
      .list(id, {states: ['pending']})
      .filter((task) => !task.recordOperation);
    assert.equal(pending.length, spareWorker ? 0 : 1);
    if (!spareWorker) assert.equal(pending[0].sourceUrl, urls[0]);
    await finish(recordRun, 'blocked');
    await runtime.tick();
    await settle();
    const resumed = launches.at(-1);
    assert.equal(resumed.sourceUrl, urls[0]);
    assert.equal(resumed.recordId, null);
    assert.deepEqual(resumed.scan.pendingUrls, scan.pendingUrls);
    assert.equal(launches.filter((run) => run.sourceUrl === urls[0] && !run.recordId).length, 2);
    await assert.rejects(runtime.runSource(id, urls[0]), /source is already running/);
    await finish(resumed);
    await runtime.tick();
    assert.equal(db.get(id).status, 'paused');
  });

test('source retry still requires reviewed setup and an enabled source', async (t) => {
  const {db, id, runtime, launches} = fixture(t);
  db.saveSource(id, urls[0], {enabled: false});
  await assert.rejects(runtime.runSource(id, urls[0]), /Turn on the source first/);
  await assert.rejects(runtime.runSource(id, 'https://unknown.test/'), /does not belong/);
  db.saveSource(id, urls[0], {enabled: true});
  db.save(id, {goal: 'A changed goal'});
  const before = db.get(id);
  await assert.rejects(runtime.runSource(id, urls[0]), /Save the setup first/);
  assert.deepEqual(db.get(id), before);
  assert.equal(launches.length, 0);
});

test('one-off scans finish every independent source without scheduling repeats', async (t) => {
  const {db, id, runtime, launches, finish, advance} = fixture(t);
  await runtime.runOnce(id);
  await settle();
  await finish(launches[0], 'blocked');
  for (let n = 1; n < 3; n++) {
    await runtime.tick();
    await settle();
    await finish(launches[n]);
  }
  await runtime.tick();
  assert.equal(db.get(id).status, 'paused');
  assert.equal(launches.length, 3);
  advance(100);
  await runtime.tick();
  assert.equal(launches.length, 3);
  await runtime.runSource(id, urls[1]);
  await settle();
  assert.equal(launches.length, 4);
  assert.equal(launches[3].sourceUrl, urls[1]);
  await finish(launches[3]);
  await runtime.tick();
  assert.equal(db.get(id).status, 'paused');
});

test('source scope reaches the agent and the action permission comes only from the profile', async (t) => {
  const {db, id, runtime, launches} = fixture(t);
  db.save(id, {mode: 'observe'});
  // A per-source mode from older versions is ignored, never a wider permission.
  db.saveSource(id, urls[0], {name: 'First', query: 'Only two-room apartments', mode: 'auto'});
  assert.equal(db.get(id).sourceSettings[urls[0]].mode, undefined);
  db.enable(id);
  await runtime.tick();
  await settle();
  const run = launches[0],
    flow = automationWorkflow({
      db,
      run,
      signal: new AbortController().signal,
      browser: {},
      report: () => {},
    }),
    context = await flow.call(id, run.id, 'get_automation_context', {});
  assert.equal(context.assignedSource.query, 'Only two-room apartments');
  assert.equal(context.automation.mode, 'observe');
  assert.deepEqual(context.automation.sources, [urls[0]]);
  const record = db.record(id, run.id, {
    url: 'https://blocked.test/home',
    title: 'Home',
    summary: 'Observed',
    assessment: {score: 70},
  });
  assert.equal(record.sourceUrl, urls[0]);
  assert.throws(() => db.reserve(id, run.id, record.id), /cannot submit/);
  assert.throws(() => db.saveSource(id, urls[0], {query: 'Changed'}), /Stop this source/);
  await runtime.pause(id);
  assert.throws(() => db.saveSource(id, 'https://other.test/', {enabled: true}), /does not belong/);
});

test('an uncertain record action leaves the workspace enabled without changing its source result', async (t) => {
  const {db, id, runtime, launches, finish} = fixture(t);
  db.save(id, {mode: 'auto'});
  await runtime.runSource(id, urls[0]);
  await settle();
  const scan = launches[0];
  const record = db.record(id, scan.id, {
    url: 'https://blocked.test/home',
    title: 'Home',
    summary: 'Observed',
    assessment: {score: 70},
  });
  await finish(scan);
  await runtime.runRecord(id, record.id, 'prepare');
  await settle();
  const prepare = launches.at(-1);
  const draft = db.record(id, prepare.id, {
    url: record.url,
    title: record.title,
    summary: record.summary,
    proposal: 'Hello',
  });
  await finish(prepare);
  const before = db.get(id).sourceState;
  await runtime.runRecord(id, record.id, 'execute', {digest: draft.digest});
  await settle();
  const run = launches.at(-1);
  db.put({...db.get(id), status: 'enabled'});
  db.reserve(id, run.id, record.id);
  runtime.report(id, run.id, 'blocked', 'Send not verified');
  await runtime.finish(id);
  assert.equal(db.get(id).status, 'enabled');
  assert.equal(db.result(id, record.id).status, 'uncertain');
  assert.deepEqual(db.get(id).sourceState, before);
  await runtime.tick();
  assert.equal(db.result(id, record.id).status, 'uncertain');
});

test('source blocking is visible without claiming the whole schedule stopped or promising retries', async (t) => {
  const {db, id, runtime, launches, finish} = fixture(t);
  db.enable(id);
  await runtime.tick();
  await settle();
  await finish(launches[0], 'blocked');
  const snapshot = db.snapshot(id),
    p = automationProgress(snapshot);
  assert.equal(p.title, 'Other sources are still tracked');
  assert.match(p.next, /not retried automatically/);
  assert.equal(snapshot.sources[0].lastResult, 'IP range blocked');
});

test('starting a source over drops its saved results page and queue but keeps other sources', async (t) => {
  const {db, id, runtime, launches, finish} = fixture(t);
  await runtime.runSource(id, urls[0]);
  await settle();
  const first = launches.at(-1);
  assert.ok(first.scanPlan);
  db.putRun({
    ...db.run(first.id),
    pageProgress: {currentPage: 4},
    scan: {
      complete: false,
      pendingUrls: ['https://blocked.test/next'],
      reason: 'Continue saved listings',
    },
  });
  await finish(first, 'blocked');
  await runtime.tick();
  runtime.sourceState(id, urls[1], {
    scan: {complete: false, pendingUrls: ['https://fast.test/next']},
  });
  assert.equal(db.sources(id)[0].scan.complete, false);
  assert.equal(db.sources(id)[0].scanState.active.id, first.scanPlan.id);
  await runtime.runSource(id, urls[0], {fresh: true});
  await settle();
  const next = launches.at(-1);
  assert.notEqual(next.id, first.id);
  assert.equal(next.sourceUrl, urls[0]);
  assert.equal(next.scan?.pendingUrls?.length ?? 0, 0, 'the old queue is not resumed');
  assert.equal(next.pageProgress ?? null, null);
  assert.notEqual(
    next.scanPlan.id,
    first.scanPlan.id,
    'a new scan cycle starts from the first page',
  );
  assert.deepEqual(db.get(id).sourceState[urls[1]].scan.pendingUrls, ['https://fast.test/next']);
});
