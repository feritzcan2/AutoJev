import test from 'node:test';
import assert from 'node:assert/strict';
import {checkSourceBrowser, checkUrl, sourceCheckOwner} from '../app/sources/browser-check.mjs';
import {SourceRetryChecks} from '../app/sources/retry-check.mjs';
import {technicalRetryDelay} from '../app/automation/recovery.mjs';

const reply = (value) => ({content: [{type: 'text', text: JSON.stringify(value)}]});

// A managed browser whose next open either fails in Chrome or shows a page.
function browser() {
  let next = 0;
  const client = {
    tabs: new Map(),
    automationRuns: new Map(),
    closed: [],
    fails: true,
    forgetTab(id) {
      client.tabs.delete(id);
      client.automationRuns.delete(id);
    },
    persistTabs: async () => {},
    async callTool({name, arguments: args}, owner) {
      if (name === 'browser_jev_open') {
        const id = `tab-${++next}`;
        client.tabs.set(id, {id, page: {close: async () => client.closed.push(id)}});
        client.automationRuns.set(id, owner);
        return reply(
          client.fails
            ? {
                tabId: id,
                url: 'chrome-error://chromewebdata/',
                navigationError: 'net::ERR_HTTP2_PROTOCOL_ERROR',
              }
            : {tabId: id, url: args.url},
        );
      }
      return reply({url: 'https://jobs.example/search?page=7', text: 'Ergebnisse'});
    },
  };
  return client;
}

const task = {
  id: 'task-1',
  sourceUrl: 'https://jobs.example/search',
  technicalRecovery: {urls: ['https://jobs.example/search?page=7']},
};

test('a failed check leaves its tab open until the next check', async () => {
  const client = browser();
  const first = await checkSourceBrowser(client, 'ws', task);
  assert.equal(first.ready, false);
  assert.match(first.evidence, /ERR_HTTP2_PROTOCOL_ERROR/);
  assert.deepEqual([...client.tabs.keys()], ['tab-1']);

  await checkSourceBrowser(client, 'ws', task);
  assert.deepEqual(client.closed, ['tab-1']);
  assert.deepEqual([...client.tabs.keys()], ['tab-2']);

  client.fails = false;
  assert.equal((await checkSourceBrowser(client, 'ws', task)).ready, true);
  assert.deepEqual(client.closed, ['tab-1', 'tab-2', 'tab-3']);
  assert.equal(client.tabs.size, 0);
});

test('a check never closes tabs other owners hold', async () => {
  const client = browser();
  client.tabs.set('run-tab', {
    id: 'run-tab',
    page: {close: async () => client.closed.push('run-tab')},
  });
  client.automationRuns.set('run-tab', 'run-1');
  await checkSourceBrowser(client, 'ws', task);
  await checkSourceBrowser(client, 'ws', task);
  assert.ok(client.tabs.has('run-tab'));
  assert.equal(client.automationRuns.get('tab-2'), sourceCheckOwner(task.id));
});

test('page checks wait 30 s, 2 min, 10 min, 30 min, then an hour longer each time', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(technicalRetryDelay),
    [30000, 120000, 600000, 1800000, 3600000, 7200000, 10800000],
  );
});

// One workspace with one source task waiting for a page check.
function retryChecks(loads) {
  const source = 'https://jobs.example/search',
    broken = 'https://jobs.example/search?page=7';
  let now = 1_000_000,
    automation = {id: 'ws', revision: 1, status: 'enabled', sources: [source], sourceState: {}},
    saved = {
      id: 'task-1',
      state: 'pending',
      sourceUrl: source,
      retryAt: now,
      technicalRecovery: {reason: 'technical_page', attempt: 1, urls: [broken]},
      scan: {
        complete: false,
        pendingUrls: [broken],
        work: {
          activeSearchId: 's1',
          searches: [
            {id: 's1', status: 'completed', pendingUrls: [broken], processedUrls: [source]},
          ],
        },
      },
    };
  const probed = [];
  const db = {
    get: () => automation,
    put: (value) => (automation = value),
    store: {workspaces: {tasks: {get: () => saved, put: (value) => (saved = value)}}},
  };
  const checks = new SourceRetryChecks(db, {
    now: () => now,
    probe: async (_id, task) => {
      const url = checkUrl(task);
      probed.push(url);
      return {ready: loads(url), evidence: loads(url) ? 'ok' : 'net::ERR_HTTP2_PROTOCOL_ERROR'};
    },
  });
  return {
    source,
    broken,
    probed,
    task: () => saved,
    automation: () => automation,
    async check() {
      now = saved.retryAt;
      checks.ready('ws', saved);
      await checks.pending.get(saved.id);
    },
  };
}

test('a page that fails three checks is skipped once the source itself loads', async () => {
  const run = retryChecks((url) => !url.includes('page=7'));
  for (let i = 0; i < 4; i++) await run.check();
  assert.deepEqual(run.probed, [run.broken, run.broken, run.broken, run.source]);
  const task = run.task();
  assert.equal(task.retryAt, null);
  assert.equal(task.technicalRecovery.probe.ready, true);
  assert.deepEqual(task.technicalRecovery.urls, []);
  assert.deepEqual(task.scan.pendingUrls, []);
  assert.ok(task.scan.work.searches[0].processedUrls.includes(run.broken));
  assert.deepEqual(run.automation().sourceState[run.source].scan, task.scan);
  assert.match(run.automation().sourceState[run.source].lastResult, /atlandı/);
});

test('the next page is checked 30 s after one is given up', async () => {
  const run = retryChecks(() => false);
  const delays = [];
  for (let i = 0; i < 4; i++) {
    const before = run.task().retryAt;
    await run.check();
    delays.push(run.task().retryAt - before);
  }
  assert.deepEqual(delays, [120000, 600000, 30000, 3600000]);
});

test('when the source itself fails too nothing is skipped and checks continue', async () => {
  const run = retryChecks(() => false);
  for (let i = 0; i < 7; i++) await run.check();
  assert.deepEqual(run.probed, [
    run.broken,
    run.broken,
    run.broken,
    run.source,
    run.source,
    run.source,
    run.source,
  ]);
  const task = run.task();
  assert.deepEqual(task.scan.pendingUrls, [run.broken]);
  assert.ok(task.retryAt > 0);
});
