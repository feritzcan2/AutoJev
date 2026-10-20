import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserTools} from '../app/browser/tools.mjs';

const bounded = () => {
  const browser = new BrowserTools('/unused');
  browser.stepMs = 20;
  browser.stepGraceMs = 20;
  browser.resets = [];
  browser.resetCandidate = async (id) => browser.resets.push(id);
  return browser;
};

test('a browser step that honours cancellation is stopped and frees the workspace queue', async () => {
  const browser = bounded(),
    worker = browser.forWorker('second');
  const stuck = browser.enqueue(
    'workspace',
    (signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  );
  const next = worker.enqueue('workspace', () => 'next step ran');
  await assert.rejects(stuck, {code: 'BROWSER_STEP_TIMEOUT', message: /was stopped/});
  assert.equal(await next, 'next step ran');
  assert.deepEqual(browser.resets, []);
});

test('a browser step that ignores cancellation drops the connection and frees the queue', async () => {
  const browser = bounded();
  const stuck = browser.enqueue('workspace', () => new Promise(() => {}));
  const next = browser.enqueue('workspace', () => 'next step ran');
  await assert.rejects(stuck, {code: 'BROWSER_STEP_TIMEOUT', message: /dropped the Chrome/});
  assert.equal(await next, 'next step ran');
  assert.deepEqual(browser.resets, ['workspace']);
});

test('a browser step inside the bound keeps its own result', async () => {
  const browser = bounded();
  browser.stepMs = 1000;
  assert.equal(await browser.enqueue('workspace', async () => 'done'), 'done');
  await assert.rejects(
    browser.enqueue('workspace', async () => {
      throw Error('own failure');
    }),
    /own failure/,
  );
  assert.deepEqual(browser.resets, []);
});
