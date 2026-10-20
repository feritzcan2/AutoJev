import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserConnections} from '../app/browser/connection.mjs';
import {BrowserTools} from '../app/browser/tools.mjs';
const flush = () => new Promise((resolve) => setImmediate(resolve));
test('one connection handshake, backoff, disconnect and retry without agent calls', async () => {
  let count = 0,
    now = 100,
    resolve,
    reject;
  const c = new BrowserConnections({
    now: () => now,
    connect: () => {
      count++;
      return new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
    },
  });
  assert.equal(c.prepare('a').state, 'connecting');
  c.prepare('a');
  await flush();
  assert.equal(count, 1);
  reject(Error('Chrome closed'));
  await flush();
  assert.equal(c.status('a').state, 'waiting');
  c.prepare('a');
  await flush();
  assert.equal(count, 1);
  now += 2000;
  c.prepare('a');
  await flush();
  resolve();
  await flush();
  assert.equal(c.status('a').ready, true);
  c.disconnected('a');
  assert.equal(c.status('a').ready, false);
  now += 2000;
  c.prepare('a');
  await flush();
  resolve();
  await flush();
  assert.equal(count, 3);
  c.close();
  c.disconnected('a');
  assert.equal(c.status('a').ready, true);
});
test('a window wait is visible, and Reconnect replaces the window and retries at once', async () => {
  let count = 0,
    waiting = false,
    reject;
  const c = new BrowserConnections({
    connect: () => {
      count++;
      return new Promise((_, fail) => (reject = fail));
    },
    reopen: () => {
      if (!waiting) return false;
      waiting = false;
      reject(Error('The Chrome setup window was closed.'));
      return true;
    },
  });
  c.prepare('a');
  await flush();
  c.windowWait('a', 'irem');
  assert.equal(c.status('a').windowWait, true);
  assert.match(c.status('a').message, /AutoJob · Jev.*profile irem/);
  // Reconnect with no window wait in progress keeps the current attempt.
  c.prepare('a', {force: true});
  await flush();
  assert.equal(count, 1);
  waiting = true;
  c.prepare('a', {force: true});
  await flush();
  await flush();
  assert.equal(count, 2);
  assert.equal(c.status('a').state, 'connecting');
  assert.equal(c.status('a').windowWait, undefined);
  // A wait for focus that timed out stays marked for the sidebar.
  reject(Object.assign(Error('The selected Chrome profile is not ready.'), {windowWait: true}));
  await flush();
  assert.equal(c.status('a').state, 'waiting');
  assert.equal(c.status('a').windowWait, true);
});

test('a late handshake cannot mark a newly selected Chrome profile ready', async () => {
  let resolve;
  const c = new BrowserConnections({connect: () => new Promise((r) => (resolve = r))});
  c.prepare('candidate');
  await flush();
  c.reset('candidate');
  resolve();
  await flush();
  assert.equal(c.status('candidate').state, 'idle');
  c.prepare('candidate');
  await flush();
  resolve();
  await flush();
  assert.equal(c.status('candidate').ready, true);
});

test('preparing initializes the selected profile before publishing a ready connection', async () => {
  let profile = 'Default',
    connects = 0;
  const browser = new BrowserTools('/unused', () => ({profile: {directory: profile}}));
  browser.connect = async () => ({
    client: {
      context: async () => {
        connects++;
      },
    },
  });
  for (const selected of ['Default', 'Profile 2']) {
    profile = selected;
    browser.prepare('candidate');
    await browser.connections.pending.get('candidate');
    assert.equal(browser.status('candidate').ready, true);
    browser.prepare('candidate');
    await flush();
  }
  assert.equal(connects, 2);
});
