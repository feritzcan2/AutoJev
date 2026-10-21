import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BrowserTools} from '../app/browser/tools.mjs';
import {JevBrowser} from '../app/jev/browser.mjs';

const hash = (url) => createHash('sha256').update(url).digest('hex');

function jevFixture() {
  const browser = new JevBrowser('/unused', {connection: 'test'}),
    closed = [],
    reported = [];
  browser.opening = Promise.resolve({});
  browser.homeId = 'home';
  browser.persistTabs = async () => {};
  browser.onTabsClosed = async (ids) => reported.push(...ids);
  const add = (
    id,
    {
      run = 'finished',
      workspace = 'workspace',
      draft = false,
      changed = false,
      pending = false,
    } = {},
  ) => {
    const original = `https://example.test/${id}`,
      url = () => (changed ? original + '/changed' : original);
    let isClosed = false;
    browser.tabs.set(id, {
      id,
      page: {
        url,
        isClosed: () => isClosed,
        frames: () => [{locator: () => ({evaluate: async () => !draft})}],
        close: async () => {
          isClosed = true;
          closed.push(id);
        },
      },
    });
    browser.automationRuns.set(id, run);
    browser.automationWorkspaces.set(id, workspace);
    browser.urlHashes.set(id, hash(original));
    return {pending};
  };
  return {browser, closed, reported, add};
}

test('completed source scan closes only its known disposable tabs', async () => {
  const f = jevFixture();
  f.add('home');
  f.add('results');
  f.add('detail');
  f.add('draft', {draft: true});
  f.add('changed', {changed: true});
  f.add('question');
  f.add('other-run', {run: 'other'});
  f.add('other-workspace', {workspace: 'other'});
  const result = await f.browser.closeFinishedAutomationRunTabs(['finished'], 'workspace', {
    keepForms: true,
    pendingTabIds: ['question'],
  });
  assert.deepEqual(result.closed, ['results', 'detail']);
  assert.deepEqual(result.retained, ['draft', 'changed', 'question']);
  assert.deepEqual(f.reported, ['results', 'detail']);
  for (const id of ['home', 'draft', 'changed', 'question', 'other-run', 'other-workspace'])
    assert.ok(f.browser.tabs.has(id), id);
});

test('finished work closes same-site URL rewrites and earlier turn tabs, keeping pages moved to another site', async () => {
  const f = jevFixture();
  f.add('rewritten', {changed: true});
  f.add('earlier', {run: 'previous'});
  f.add('elsewhere');
  f.add('running', {run: 'active'});
  f.browser.tabs.get('rewritten').observed = {url: 'https://example.test/rewritten'};
  const elsewhere = f.browser.tabs.get('elsewhere');
  elsewhere.observed = {url: 'https://example.test/elsewhere'};
  elsewhere.page.url = () => 'https://personal.test/inbox';
  const result = await f.browser.closeFinishedAutomationRunTabs(
    ['finished', 'previous'],
    'workspace',
    {keepForms: true},
  );
  assert.deepEqual(result, {closed: ['rewritten', 'earlier'], retained: ['elsewhere']});
  assert.ok(f.browser.tabs.has('running'));
});

test('a record the user ended closes every tab of its runs, including pages moved to another site', async () => {
  const f = jevFixture();
  f.add('home');
  f.add('listing');
  f.add('form', {draft: true});
  f.add('employer');
  f.add('check');
  f.add('other-run', {run: 'other'});
  const employer = f.browser.tabs.get('employer');
  employer.observed = {url: 'https://example.test/employer'};
  employer.page.url = () => 'https://careers.employer.test/apply';
  f.browser.tabs.get('check').verification = {state: 'required'};
  const result = await f.browser.closeFinishedAutomationRunTabs(['finished'], 'workspace', {
    keepForms: true,
    pendingTabIds: ['form'],
    closeAll: true,
  });
  assert.deepEqual(result, {closed: ['listing', 'form', 'employer', 'check'], retained: []});
  for (const id of ['home', 'other-run']) assert.ok(f.browser.tabs.has(id), id);
});

test('verified record completion closes its exact form tab, preserving other tasks', async () => {
  const f = jevFixture();
  f.add('home');
  f.add('confirmation', {draft: true});
  f.add('other-run', {run: 'other'});
  assert.deepEqual(await f.browser.closeFinishedAutomationRunTabs(['finished'], 'workspace'), {
    closed: ['confirmation'],
    retained: [],
  });
  assert.deepEqual(f.closed, ['confirmation']);
  assert.ok(f.browser.tabs.has('other-run'));
});

test('access reset closes retained source tabs including solved challenges, preserving personal, record and newer-run tabs', async () => {
  const f = jevFixture(),
    source = 'https://source.test/';
  for (const id of [
    'home',
    'challenge',
    'form',
    'changed',
    'previous',
    'personal',
    'record',
    'other-source',
    'new-run',
    'other-workspace',
  ]) {
    f.add(id, {
      draft: id === 'form',
      changed: id === 'changed',
      run: id === 'previous' ? 'previous' : id === 'new-run' ? 'new' : 'finished',
      workspace: id === 'other-workspace' ? 'elsewhere' : 'workspace',
    });
    if (id !== 'personal')
      f.browser.automationSources.set(id, id === 'other-source' ? 'https://another.test/' : source);
    f.browser.automationTabs.set(id, id === 'record' ? 'record:known-record' : 'source:' + source);
  }
  f.browser.tabs.get('challenge').verification = {state: 'required'};
  const result = await f.browser.closeFinishedAutomationRunTabs(
    ['finished', 'previous'],
    'workspace',
    {resetSource: source},
  );
  assert.deepEqual(result.closed, ['challenge', 'form', 'changed', 'previous']);
  assert.deepEqual(result.retained, []);
  for (const id of ['home', 'personal', 'record', 'other-source', 'new-run', 'other-workspace'])
    assert.ok(f.browser.tabs.has(id), id);
});

test('source reset retries failed tab closes without falsely reporting cleanup complete', async () => {
  const f = jevFixture(),
    source = 'https://source.test/';
  f.add('challenge');
  f.browser.automationSources.set('challenge', source);
  const slot = f.browser.tabs.get('challenge'),
    close = slot.page.close;
  slot.page.close = async () => {
    throw Error('Disconnected');
  };
  const options = {resetSource: source};
  assert.deepEqual(
    await f.browser.closeFinishedAutomationRunTabs(['finished'], 'workspace', options),
    {closed: [], retained: ['challenge']},
  );
  slot.page.close = close;
  assert.deepEqual(
    await f.browser.closeFinishedAutomationRunTabs(['finished'], 'workspace', options),
    {closed: ['challenge'], retained: []},
  );
});

test('finished tabs in an existing Chrome stay as blank spares that the next task reuses', async () => {
  // Chrome restores a minimized window when a tab is added; reusing a spare adds none.
  const browser = new JevBrowser('/unused', {connection: 'existing'}),
    closed = [],
    ids = ['stuck', 'first', 'second', 'third'];
  browser.opening = Promise.resolve({});
  browser.browser = {isConnected: () => true};
  browser.transport = {owned: new Set(ids), forget: (id) => browser.transport.owned.delete(id)};
  browser.persistTabs = async () => {};
  for (const id of ids) {
    let url = `https://example.test/${id}`,
      isClosed = false;
    browser.tabs.set(id, {
      id,
      history: ['old'],
      observed: {url},
      page: {
        url: () => url,
        isClosed: () => isClosed,
        goto: async (target) => {
          // A page that cannot leave is closed and does not take a spare place.
          if (id === 'stuck') throw Error('Timeout 5000ms exceeded');
          url = target;
        },
        close: async () => {
          isClosed = true;
          closed.push(id);
        },
      },
    });
    browser.automationRuns.set(id, 'finished');
    browser.automationWorkspaces.set(id, 'workspace');
    browser.automationTabs.set(id, 'record:' + id);
    browser.urlHashes.set(id, hash(url));
  }
  assert.deepEqual(await browser.closeFinishedAutomationRunTabs(['finished'], 'workspace'), {
    closed: ids,
    retained: [],
  });
  assert.deepEqual(closed, ['stuck', 'third']);
  assert.deepEqual([...browser.spareTabs], ['first', 'second']);
  for (const map of [browser.automationRuns, browser.automationWorkspaces, browser.automationTabs])
    assert.equal(map.has('first'), false);
  const tools = new BrowserTools('/unused');
  tools.connectedClient = async () => browser;
  assert.deepEqual(await tools.workspaceTabs('workspace'), [], 'spares are no workspace tab');
  const reused = browser.takeSpareTab();
  assert.equal(reused.id, 'first');
  assert.deepEqual(reused.history, []);
  assert.equal(reused.observed, undefined);
  assert.equal(browser.takeSpareTab().id, 'second');
  assert.equal(browser.takeSpareTab(), null);
});
