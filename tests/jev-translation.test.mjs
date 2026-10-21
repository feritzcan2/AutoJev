import test from 'node:test';
import assert from 'node:assert/strict';
import {installNoTranslate, markNoTranslate} from '../app/jev/translation.mjs';
import {concealedByPage, concealedMessage, stalled} from '../app/jev/navigation.mjs';

function fakeDocument({head = true} = {}) {
  const metas = [],
    listeners = {},
    root = {attributes: {}, setAttribute: (k, v) => (root.attributes[k] = v)},
    headNode = {
      querySelector: (selector) =>
        metas.find((m) => selector.includes(`content="${m.content}"`)) ?? null,
      prepend: (meta) => metas.unshift(meta),
    };
  const document = {
    documentElement: root,
    head: head ? headNode : null,
    createElement: () => ({}),
    addEventListener: (name, fn) => (listeners[name] = fn),
  };
  return {document, root, metas, listeners, attachHead: () => (document.head = headNode)};
}

test('owned tabs mark the document notranslate as soon as a head exists', (t) => {
  const observers = [];
  const previous = {document: globalThis.document, MutationObserver: globalThis.MutationObserver};
  globalThis.MutationObserver = class {
    constructor(fn) {
      this.fn = fn;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  t.after(() => Object.assign(globalThis, previous));

  const ready = fakeDocument();
  globalThis.document = ready.document;
  markNoTranslate();
  markNoTranslate();
  assert.equal(ready.root.attributes.translate, 'no');
  assert.deepEqual(ready.metas, [{name: 'google', content: 'notranslate'}]);
  assert.equal(observers.length, 0, 'a ready document needs no observer');

  const early = fakeDocument({head: false});
  globalThis.document = early.document;
  markNoTranslate();
  assert.equal(early.metas.length, 0);
  assert.equal(observers.length, 1);
  early.attachHead();
  observers[0].fn();
  assert.deepEqual(early.metas, [{name: 'google', content: 'notranslate'}]);
  assert.equal(observers[0].disconnected, true);
  early.listeners.DOMContentLoaded();
  assert.equal(early.metas.length, 1, 'the load handler does not add a second meta');
});

test('the notranslate script installs once per tab in its own world and tolerates a page that rejects evaluation', async () => {
  const calls = [];
  const slot = {
    cdp: {
      send: async (method, params) => {
        calls.push([method, params]);
        if (method === 'Page.getFrameTree') return {frameTree: {frame: {id: 'main'}}};
        if (method === 'Page.createIsolatedWorld') return {executionContextId: 7};
        if (method === 'Runtime.evaluate') throw Error('navigating');
        return {};
      },
    },
  };
  await installNoTranslate(slot);
  await installNoTranslate(slot);
  assert.deepEqual(
    calls.map(([method]) => method),
    [
      'Page.addScriptToEvaluateOnNewDocument',
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ],
  );
  const [, init] = calls[0];
  assert.ok(init.worldName, 'the init script never runs in the page world');
  assert.equal(init.source, `(${markNoTranslate})()`);
  assert.equal(calls[2][1].worldName, init.worldName);
  assert.equal(calls[3][1].contextId, 7);
});

test('a reveal on a control the page keeps hidden names the concealment instead of suggesting reveal', async () => {
  const evaluated = [];
  const slot = {
    page: {
      evaluate: async (fn, node) => {
        evaluated.push(node);
        return node === 'hidden';
      },
    },
  };
  assert.equal(await concealedByPage(slot, 'hidden'), true);
  assert.equal(await concealedByPage(slot, 'offscreen'), false);
  assert.deepEqual(evaluated, ['hidden', 'offscreen']);
  const failing = {page: {evaluate: async () => Promise.reject(Error('detached'))}};
  assert.equal(await concealedByPage(failing, 'any'), false);
  assert.match(concealedMessage, /clickTargets/);
  assert.doesNotMatch(concealedMessage, /[çğışöü]/i, 'agent-facing text is English');
  assert.notEqual(concealedMessage, stalled.message);
});

test('a current document whose script context never answers does not hold the tab setup', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let initScripts = 0;
  const slot = {
    cdp: {
      send: (method) => {
        if (method === 'Page.addScriptToEvaluateOnNewDocument') initScripts++;
        else if (method === 'Page.getFrameTree')
          return Promise.resolve({frameTree: {frame: {id: 'main'}}});
        else if (method === 'Page.createIsolatedWorld')
          return Promise.resolve({executionContextId: 1});
        else if (method === 'Runtime.evaluate') return new Promise(() => {});
        return Promise.resolve({});
      },
    },
  };
  let done = false;
  const setup = installNoTranslate(slot).then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initScripts, 1);
  assert.equal(done, false);
  t.mock.timers.tick(5000);
  await setup;
  assert.equal(done, true);
});
