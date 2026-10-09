import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {registerAutomationServices} from '../app/automation-services.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';

test('Jev evaluates API evidence using configured model access without connecting to Chrome', async () => {
  let requests = 0;
  const browser = automationBrowser({
    options: () => ({
      config: async () => ({
        apiKey: 'synthetic-test-key',
        fetchImpl: async (_url, options) => {
          requests++;
          const body = JSON.parse(options.body);
          assert.equal(body.state.text, 'Synthetic API listing');
          return {
            ok: true,
            json: async () => ({
              answers: {fit: {choice: 'possible', confidence: 1, probabilities: {possible: 1}}},
            }),
          };
        },
      }),
    }),
    prepare: () => {
      throw Error('Chrome must not be prepared');
    },
    connect: () => {
      throw Error('Chrome must not connect');
    },
  });
  const answer = await browser.evaluateJev(
    'workspace',
    {text: 'Synthetic API listing'},
    {fit: {type: 'choice', criteria: {possible: 'Readable detail'}}},
  );
  assert.equal(answer.answers.fit.choice, 'possible');
  assert.equal(requests, 1);
});

function fixture(t, connect) {
  const store = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(store),
    a = db.create('custom', {sources: ['https://source.test/search?q=initial']});
  const browsers = new BrowserTools('/unused', (id) => ({profile: db.get(id).chromeProfile})),
    handlers = new Map(),
    events = [],
    calls = [];
  browsers.connect = async () => ({client: {context: connect}});
  browsers.call = async (id, name, args) => {
    calls.push({id, name, args});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'ready',
            tabId: 'owned-tab',
            url: db.get(id).sources[0],
            tabs: [],
          }),
        },
      ],
    };
  };
  const services = registerAutomationServices({
    data: '/unused',
    db,
    browsers,
    handle: (name, fn) => handlers.set(name, fn),
    emit: (...args) => events.push(args),
    launch: async () => ({close: async () => {}}),
  });
  t.after(async () => {
    await services.close();
    browsers.connections.close();
    store.close();
  });
  return {
    db,
    id: a.id,
    browsers,
    services,
    events,
    calls,
    open: () => handlers.get('automation-browser')(a.id),
  };
}

test('a selected profile readiness timeout returns its waiting status and a retry can open the source', async (t) => {
  let ready = false,
    attempts = 0;
  const f = fixture(t, async () => {
    attempts++;
    if (!ready) throw Error('Seçili Chrome profili hazır değil.');
  });
  for (let i = 0; i < 2; i++) {
    const status = await f.open();
    assert.equal(status.state, 'waiting');
    assert.equal(status.ready, false);
    assert.match(status.message, /profili hazır değil/);
    assert.equal(f.calls.length, 0);
  }
  assert.equal(attempts, 2);
  assert.equal(f.events.at(-1)[1].automationId, f.id);
  ready = true;
  const result = await f.open();
  assert.equal(f.browsers.status(f.id).ready, true);
  assert.equal(result.pageContext.tabId, 'owned-tab');
  assert.equal(
    f.calls.find((c) => c.name === 'browser_jev_open').args.url,
    f.db.get(f.id).sources[0],
  );
});

test('a cancelled handshake returns the reset state without navigating', async (t) => {
  let finish;
  const pending = new Promise((resolve) => (finish = resolve)),
    f = fixture(t, () => pending);
  const opening = f.open();
  assert.equal(f.browsers.status(f.id).state, 'connecting');
  f.browsers.connections.reset(f.id);
  finish();
  const status = await opening;
  assert.equal(status.state, 'idle');
  assert.equal(status.ready, false);
  assert.deepEqual(f.calls, []);
});

test('source changes during the connection wait use the current source after readiness', async (t) => {
  let finish;
  const pending = new Promise((resolve) => (finish = resolve)),
    f = fixture(t, () => pending);
  const opening = f.open(),
    url = 'https://other-source.test/listings/updated';
  f.db.save(f.id, {sources: [url]});
  finish();
  await opening;
  assert.equal(f.calls.find((c) => c.name === 'browser_jev_open').args.url, url);
});

test('connecting while a worker is active preserves its tabs', async (t) => {
  const f = fixture(t, async () => {});
  await f.services.runtime.setup(f.id);
  const status = await f.open();
  assert.equal(status.ready, true);
  assert.deepEqual(f.calls, []);
});

test('a ready connection still reports invalid source configuration', async (t) => {
  const f = fixture(t, async () => {});
  f.db.save(f.id, {sources: []});
  await assert.rejects(f.open(), /en az bir kaynak/);
  assert.deepEqual(f.calls, []);
});
