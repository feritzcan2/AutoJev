import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  EXTENSION_ID,
  EXTENSION_PROTOCOL,
  ExtensionRelay,
  JevExtensionTransport,
  connectPageUrl,
} from '../app/jev/extension.mjs';
import {BrowserConnections} from '../app/browser/connection.mjs';
import {BrowserTools} from '../app/browser/tools.mjs';
import {JevBrowser} from '../app/jev/browser.mjs';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const relayUrlOf = (connectUrl) => new URL(connectUrl).searchParams.get('relay');

// Enough of extension/background.js to exercise the app side: tabs, windows,
// debugger attachments and the events Chrome would raise.
class FakeExtension {
  constructor({instanceId = 'run-1'} = {}) {
    this.instanceId = instanceId;
    this.tabs = new Map();
    this.windows = new Set([1]);
    this.nextTab = 100;
    this.nextWindow = 2;
    this.attached = new Set();
    this.commands = [];
    this.sockets = [];
  }
  addTab({windowId = 1, openerTabId, url = 'about:blank', target = null} = {}) {
    const id = this.nextTab++;
    this.tabs.set(id, {
      id,
      windowId,
      openerTabId,
      url,
      target: target ?? id.toString(16).padStart(32, '0'),
    });
    return this.tabs.get(id);
  }
  connect(connectUrl, {origin = `chrome-extension://${EXTENSION_ID}`, hello = true} = {}) {
    const socket = new WebSocket(relayUrlOf(connectUrl), {origin});
    this.sockets.push(socket);
    socket.on('message', (data) => this.handle(socket, JSON.parse(data)));
    return new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('unexpected-response', (_, response) =>
        reject(Error(`Unexpected response ${response.statusCode}`)),
      );
      socket.once('open', () => {
        if (hello)
          socket.send(
            JSON.stringify({
              event: 'hello',
              protocol: EXTENSION_PROTOCOL,
              instanceId: this.instanceId,
              userAgent: 'Mozilla/5.0 Chrome/154.0.0.0',
              version: '1.0.0',
            }),
          );
        resolve(socket);
      });
    });
  }
  emit(socket, event) {
    socket.send(JSON.stringify(event));
  }
  handle(socket, {id, method, params}) {
    this.commands.push({method, params});
    const reply = (result) => socket.send(JSON.stringify({id, result}));
    const fail = (message) => socket.send(JSON.stringify({id, error: {code: -32000, message}}));
    const tab = (tabId) => {
      const found = this.tabs.get(tabId);
      if (!found) throw Error(`No tab with id: ${tabId}`);
      return found;
    };
    try {
      switch (method) {
        case 'ping':
          return reply({});
        case 'tabs.get':
        case 'tabs.claim':
        case 'tabs.label':
          tab(params.tabId);
          return reply(method === 'tabs.get' ? {tab: this.tabs.get(params.tabId)} : {});
        case 'tabs.resolve': {
          const found = [...this.tabs.values()].find((t) => t.target === params.targetId);
          if (!found) throw Error('Unknown AutoJev target');
          return reply({tabId: found.id});
        }
        case 'tabs.create':
          return reply({tab: this.addTab(params)});
        case 'tabs.remove':
          tab(params.tabId);
          this.tabs.delete(params.tabId);
          this.attached.delete(params.tabId);
          this.emit(socket, {event: 'tabs.removed', tabId: params.tabId, windowId: 1});
          return reply({});
        case 'windows.create': {
          const windowId = this.nextWindow++;
          this.windows.add(windowId);
          return reply({window: {id: windowId}, tab: this.addTab({windowId, url: params.url})});
        }
        case 'windows.get':
          if (!this.windows.has(params.windowId)) throw Error('No window with id');
          return reply({window: {id: params.windowId, focused: true}});
        case 'debugger.attach':
          tab(params.tabId);
          this.attached.add(params.tabId);
          return reply({});
        case 'debugger.detach':
          this.attached.delete(params.tabId);
          return reply({});
        case 'debugger.send': {
          const {target, url} = tab(params.tabId);
          if (!this.attached.has(params.tabId)) throw Error('Debugger is not attached');
          if (params.method === 'Target.setAutoAttach') this.onAutoAttach?.(socket, params.tabId);
          if (params.method === 'Page.getFrameTree' && this.frameTrees?.[params.sessionId])
            return reply({result: this.frameTrees[params.sessionId]});
          if (params.method === 'Target.getTargetInfo')
            return reply({
              result: {
                targetInfo: {
                  targetId: target,
                  type: 'page',
                  title: '',
                  url,
                  attached: true,
                  canAccessOpener: false,
                  browserContextId: 'ctx',
                },
              },
            });
          return reply({result: {}});
        }
        default:
          throw Error(`Unknown method ${method}`);
      }
    } catch (error) {
      fail(error.message);
    }
  }
  close() {
    for (const socket of this.sockets) socket.terminate();
  }
}

async function relayFixture(t) {
  const relay = await ExtensionRelay.listen(),
    extension = new FakeExtension();
  t.after(() => {
    extension.close();
    relay.close();
  });
  return {relay, extension};
}

test('the relay only accepts the AutoJev extension on its own token path', async (t) => {
  const {relay, extension} = await relayFixture(t);
  const url = connectPageUrl(relay.url);
  assert.match(url, new RegExp(`^chrome-extension://${EXTENSION_ID}/connect\\.html\\?relay=`));
  await assert.rejects(extension.connect(url, {origin: 'https://evil.example'}), /403/);
  await assert.rejects(
    extension.connect(connectPageUrl(relay.url.replace(/\/jev\/.*$/, '/jev/wrong-token')), {}),
    /403/,
  );
  const socket = await extension.connect(url, {hello: false});
  socket.send(JSON.stringify({event: 'hello', protocol: 99, instanceId: 'x'}));
  await new Promise((resolve) => socket.once('close', resolve));
});

test('connecting opens the connect page once and reuses a connection the extension already made', async (t) => {
  const {relay, extension} = await relayFixture(t);
  const opened = [];
  const connecting = relay.connect({
    open: async (url) => {
      opened.push(url);
      await extension.connect(url);
    },
  });
  const transport = await connecting;
  t.after(() => transport.close());
  assert.equal(opened.length, 1);
  assert.equal(transport.instanceId, 'run-1');
  // A restarted service worker reconnects on its own: no new page is needed.
  await extension.connect(opened[0]);
  for (let i = 0; i < 100 && !relay.available; i++) await new Promise((r) => setTimeout(r, 5));
  const again = await relay.connect({
    open: async () => assert.fail('a live extension connection must be reused'),
  });
  t.after(() => again.close());
  assert.equal(again.instanceId, 'run-1');
  await assert.rejects(
    relay.connect({open: async () => {}, timeout: 20}),
    /extension did not connect/,
  );
  const abort = new AbortController();
  const cancelled = assert.rejects(relay.connect({open: async () => {}, signal: abort.signal}), {
    name: 'AbortError',
  });
  abort.abort();
  await cancelled;
});

async function transportFixture(t) {
  const {relay, extension} = await relayFixture(t);
  const transport = await relay.connect({open: (url) => extension.connect(url)});
  t.after(() => transport.close());
  const forwarded = [];
  transport.onmessage = (message) => forwarded.push(message);
  const call = (message) => {
    transport.send(message);
    return new Promise((resolve) => {
      const check = () => {
        const reply = forwarded.find((m) => m.id === message.id);
        reply ? resolve(reply) : setImmediate(check);
      };
      check();
    });
  };
  return {relay, extension, transport, forwarded, call};
}

test('owned tabs attach when Playwright enables auto-attach, with their out-of-process form frames and nothing else', async (t) => {
  const {extension, transport, forwarded, call} = await transportFixture(t);
  const saved = extension.addTab({url: 'https://jobs.example/form'}),
    personal = extension.addTab({url: 'https://bank.example'});
  await transport.adopt(saved.target, saved.id);
  assert.equal(extension.attached.size, 0, 'adopting a saved tab does not debug it yet');
  await assert.rejects(transport.adopt('A'.repeat(32), 999), /No tab with id/);
  const version = await call({id: 1, method: 'Browser.getVersion'});
  assert.equal(version.result.product, 'Chrome/154.0.0.0');
  assert.deepEqual(
    await call({id: 2, method: 'Target.setAutoAttach', params: {autoAttach: true}}),
    {
      id: 2,
      result: {},
    },
  );
  assert.deepEqual([...extension.attached], [saved.id]);
  const sent = extension.commands.filter((c) => c.method === 'debugger.send');
  assert.deepEqual(
    sent.map((c) => c.params.method),
    ['Target.getTargetInfo', 'Target.setAutoAttach'],
  );
  // Playwright's own parameters: a filter that leaves out workers keeps them paused.
  assert.deepEqual(sent[1].params.params, {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  const attachedEvent = forwarded.find((m) => m.method === 'Target.attachedToTarget');
  assert.equal(attachedEvent.params.sessionId, `jev-tab-${saved.id}`);
  assert.equal(attachedEvent.params.targetInfo.targetId, saved.target);
  assert.equal(attachedEvent.params.targetInfo.browserContextId, 'ctx');
  assert.equal(forwarded.indexOf(attachedEvent) < forwarded.findIndex((m) => m.id === 2), true);
  // Page commands go to the owned tab; the personal tab is never named.
  await call({
    id: 3,
    sessionId: `jev-tab-${saved.id}`,
    method: 'Page.navigate',
    params: {url: 'x'},
  });
  const navigate = extension.commands.at(-1);
  assert.deepEqual(navigate.params, {tabId: saved.id, method: 'Page.navigate', params: {url: 'x'}});
  assert.equal(
    extension.commands.some((c) => c.params?.tabId === personal.id),
    false,
  );
  const socket = extension.sockets.at(-1);
  extension.emit(socket, {
    event: 'debugger.event',
    tabId: saved.id,
    method: 'Target.attachedToTarget',
    params: {sessionId: 'frame-1', targetInfo: {type: 'iframe'}, waitingForDebugger: true},
  });
  extension.emit(socket, {
    event: 'debugger.event',
    tabId: saved.id,
    sessionId: 'frame-1',
    method: 'Page.frameNavigated',
    params: {},
  });
  await flush();
  await flush();
  assert.deepEqual(
    forwarded
      .filter((m) => m.method?.startsWith('Page.frame') || m.method === 'Target.attachedToTarget')
      .map((m) => m.sessionId),
    [undefined, `jev-tab-${saved.id}`, 'frame-1'],
  );
  await call({id: 4, sessionId: 'frame-1', method: 'Runtime.runIfWaitingForDebugger'});
  assert.deepEqual(extension.commands.at(-1).params, {
    tabId: saved.id,
    sessionId: 'frame-1',
    method: 'Runtime.runIfWaitingForDebugger',
    params: {},
  });
  const info = await call({
    id: 5,
    sessionId: `jev-tab-${saved.id}`,
    method: 'Target.getTargetInfo',
  });
  assert.equal(info.result.targetInfo.targetId, saved.target);
  const unknown = await call({id: 6, sessionId: 'nope', method: 'Page.enable'});
  assert.match(unknown.error.message, /Session not found/);
  // Playwright's newCDPSession: a browser session attaches to the tab or to
  // one of its frames; chrome.debugger allows one attachment, so these
  // sessions share it and see its events.
  const {sessionId: browserSession} = (await call({id: 7, method: 'Target.attachToBrowserTarget'}))
    .result;
  const {sessionId: pageSession} = (
    await call({
      id: 8,
      sessionId: browserSession,
      method: 'Target.attachToTarget',
      params: {targetId: saved.target, flatten: true},
    })
  ).result;
  assert.notEqual(pageSession, `jev-tab-${saved.id}`);
  await call({
    id: 9,
    sessionId: pageSession,
    method: 'Runtime.evaluate',
    params: {expression: '1'},
  });
  assert.deepEqual(extension.commands.at(-1).params, {
    tabId: saved.id,
    method: 'Runtime.evaluate',
    params: {expression: '1'},
  });
  extension.emit(socket, {
    event: 'debugger.event',
    tabId: saved.id,
    method: 'Page.loadEventFired',
    params: {timestamp: 1},
  });
  await flush();
  await flush();
  assert.deepEqual(
    forwarded.filter((m) => m.method === 'Page.loadEventFired').map((m) => m.sessionId),
    [`jev-tab-${saved.id}`, pageSession],
  );
  await call({
    id: 10,
    sessionId: browserSession,
    method: 'Target.detachFromTarget',
    params: {sessionId: pageSession},
  });
  assert.deepEqual(forwarded.at(-2), {
    sessionId: browserSession,
    method: 'Target.detachedFromTarget',
    params: {sessionId: pageSession, targetId: saved.target},
  });
  const frameTarget = 'F'.repeat(32);
  extension.emit(socket, {
    event: 'debugger.event',
    tabId: saved.id,
    method: 'Target.attachedToTarget',
    params: {sessionId: 'frame-2', targetInfo: {type: 'iframe', targetId: frameTarget}},
  });
  await flush();
  await flush();
  const {sessionId: frameSession} = (
    await call({
      id: 11,
      sessionId: browserSession,
      method: 'Target.attachToTarget',
      params: {targetId: frameTarget, flatten: true},
    })
  ).result;
  await call({id: 12, sessionId: frameSession, method: 'DOM.getDocument'});
  assert.deepEqual(extension.commands.at(-1).params, {
    tabId: saved.id,
    sessionId: 'frame-2',
    method: 'DOM.getDocument',
    params: {},
  });
});

test('events a tab raises while it attaches reach Playwright after its own attachment', async (t) => {
  const {extension, forwarded, call} = await transportFixture(t);
  // Chrome reports already existing frames as soon as auto-attach is enabled.
  extension.onAutoAttach = (socket, tabId) =>
    extension.emit(socket, {
      event: 'debugger.event',
      tabId,
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'frame-early',
        waitingForDebugger: true,
        targetInfo: {targetId: 'E'.repeat(32), type: 'iframe'},
      },
    });
  await call({id: 1, method: 'Target.setAutoAttach', params: {autoAttach: true}});
  await call({id: 2, method: 'Target.createTarget', params: {url: 'https://jobs.example/apply'}});
  await flush();
  const attached = forwarded.filter((m) => m.method === 'Target.attachedToTarget');
  assert.deepEqual(
    attached.map((m) => [m.sessionId, m.params.sessionId]),
    [
      [undefined, attached[0].params.sessionId],
      [attached[0].params.sessionId, 'frame-early'],
    ],
  );
});

test('a Jev call that never settles drops the connection and frees Jev', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-stuck-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const jev = new JevBrowser(directory, {connection: 'existing'});
  let closed = 0;
  jev.transport = {close: () => closed++};
  jev.toolCallLimitMs = 30;
  jev.toolCancelGraceMs = 10;
  jev.runTool = () => new Promise(() => {});
  await assert.rejects(jev.callTool({name: 'browser_jev_tabs', arguments: {}}), {
    code: 'BROWSER_DISCONNECTED',
  });
  assert.equal(jev.busy, false);
  assert.equal(closed, 1);
  // A cancelled call is given a short grace period, not the whole limit.
  jev.toolCallLimitMs = 60000;
  const abort = new AbortController(),
    started = Date.now(),
    pending = jev.callTool({name: 'browser_jev_tabs', arguments: {}}, 'local', {
      signal: abort.signal,
    });
  abort.abort(Error('stopped'));
  await assert.rejects(pending, /stopped/);
  assert.equal(Date.now() - started < 1000, true);
  assert.equal(jev.busy, false);
  assert.equal(closed, 2);
  // A call that answers in time keeps the connection.
  jev.runTool = async () => ({content: []});
  assert.deepEqual(await jev.callTool({name: 'browser_jev_tabs', arguments: {}}), {content: []});
  assert.equal(closed, 2);
});

test('an out-of-process frame that loaded before the attach gets its URL', async (t) => {
  const {extension, forwarded, call} = await transportFixture(t);
  await call({id: 1, method: 'Target.setAutoAttach', params: {autoAttach: true}});
  await call({id: 2, method: 'Target.createTarget', params: {url: 'https://jobs.example/apply'}});
  const tabId = [...extension.attached][0];
  const socket = extension.sockets.at(-1);
  const attached = (sessionId, waitingForDebugger) =>
    extension.emit(socket, {
      event: 'debugger.event',
      tabId,
      method: 'Target.attachedToTarget',
      params: {sessionId, waitingForDebugger, targetInfo: {targetId: sessionId, type: 'iframe'}},
    });
  attached('loaded', false);
  attached('new', true);
  await flush();
  await flush();
  extension.frameTrees = {
    loaded: {frameTree: {frame: {id: 'F1', url: 'https://forms.example/apply'}}},
    new: {frameTree: {frame: {id: 'F2', url: 'https://forms.example/apply'}}},
  };
  await call({id: 3, sessionId: 'loaded', method: 'Page.getFrameTree'});
  await call({id: 4, sessionId: 'new', method: 'Page.getFrameTree'});
  await call({id: 5, sessionId: 'loaded', method: 'Page.getFrameTree'});
  assert.deepEqual(
    forwarded.filter((m) => m.method === 'Page.navigatedWithinDocument'),
    [
      {
        sessionId: 'loaded',
        method: 'Page.navigatedWithinDocument',
        params: {frameId: 'F1', url: 'https://forms.example/apply', navigationType: 'other'},
      },
    ],
  );
});

test('new tabs and popups of owned tabs join the connection; closing a tab retires it', async (t) => {
  const {extension, transport, forwarded, call} = await transportFixture(t);
  const destroyed = [];
  transport.onTargetDestroyed = (id) => destroyed.push(id);
  await call({id: 1, method: 'Target.setAutoAttach', params: {autoAttach: true}});
  const {windowId, targetId: home} = await transport.createWindow('about:blank');
  assert.equal(await transport.windowExists(windowId), true);
  const child = await transport.createTab({windowId, openerTargetId: home});
  assert.equal(await transport.windowOf(child), windowId);
  const childEntry = transport.targets.get(child);
  assert.equal(childEntry.info.openerId, home);
  const created = extension.commands.find((c) => c.method === 'tabs.create');
  assert.deepEqual(created.params, {
    windowId,
    openerTabId: transport.targets.get(home).tabId,
    url: 'about:blank',
    active: false,
  });
  // A popup opened by a page arrives as a Chrome tab event.
  const popup = extension.addTab({
    windowId,
    openerTabId: childEntry.tabId,
    url: 'https://jobs.example/apply',
  });
  extension.emit(extension.sockets.at(-1), {event: 'tabs.created', tab: popup});
  for (let i = 0; i < 50 && !transport.attached.has(popup.target); i++) await flush();
  assert.equal(transport.owned.has(popup.target), true);
  assert.equal(transport.targets.get(popup.target).info.openerId, child);
  // Unrelated tabs never arrive, and closing an owned tab retires it everywhere.
  assert.equal(transport.owned.size, 3);
  assert.deepEqual(
    await call({id: 2, method: 'Target.closeTarget', params: {targetId: popup.target}}),
    {
      id: 2,
      result: {success: true},
    },
  );
  for (let i = 0; i < 50 && !destroyed.length; i++) await flush();
  assert.deepEqual(destroyed, [popup.target]);
  assert.equal(transport.owned.has(popup.target), false);
  assert.equal(
    forwarded.filter((m) => m.method === 'Target.detachedFromTarget').at(-1).params.targetId,
    popup.target,
  );
  assert.deepEqual(transport.tabIdsByTarget(), {
    [home]: transport.targets.get(home).tabId,
    [child]: childEntry.tabId,
  });
  assert.deepEqual(await call({id: 3, method: 'Target.getTargets'}), {
    id: 3,
    result: {targetInfos: [transport.targets.get(home).info, childEntry.info]},
  });
});

test('cancelling the Chrome infobar ends the connection and waits for an explicit reconnect', async (t) => {
  const {extension, transport, call} = await transportFixture(t);
  await call({id: 1, method: 'Target.setAutoAttach', params: {autoAttach: true}});
  const {targetId} = await transport.createWindow('about:blank');
  const closed = new Promise((resolve) => (transport.onclose = resolve));
  extension.emit(extension.sockets.at(-1), {
    event: 'debugger.detach',
    tabId: transport.targets.get(targetId).tabId,
    reason: 'canceled_by_user',
  });
  await closed;
  assert.equal(transport.cancelled, true);
  assert.equal(transport.connected, false);
  await assert.rejects(transport.createWindow('about:blank'), /closed/);
  let now = 0,
    attempts = 0;
  const connections = new BrowserConnections({
    connect: async () => {
      attempts++;
    },
    now: () => now,
  });
  t.after(() => connections.close());
  connections.prepare('candidate');
  await flush();
  connections.disconnected('candidate', {manual: true});
  assert.match(connections.status('candidate').message, /cancelled in Chrome/);
  now += 3600000;
  connections.prepare('candidate');
  await flush();
  assert.equal(attempts, 1, 'a cancelled connection never reopens Chrome pages by itself');
  connections.prepare('candidate', {force: true});
  await flush();
  assert.equal(attempts, 2);
});

test('a workspace without the extension never opens Chrome, and cancelling a pending connection stops waiting', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobloop-extension-'));
  const opened = [];
  let installed = false;
  const browsers = new BrowserTools(directory, () => ({
    profile: {directory: 'Profile 2'},
    extensionInstalled: async (profile) => {
      assert.equal(profile, 'Profile 2');
      return installed;
    },
    openUrl: async (url, profile) => {
      assert.equal(profile.directory, 'Profile 2');
      opened.push(url);
    },
  }));
  t.after(async () => {
    await browsers.close();
    await rm(directory, {recursive: true, force: true});
  });
  browsers.prepare('candidate');
  await browsers.connections.pending.get('candidate');
  assert.equal(opened.length, 0);
  assert.match(browsers.status('candidate').message, /chrome:\/\/extensions/);
  installed = true;
  browsers.prepare('candidate', {force: true});
  for (let i = 0; i < 50 && !opened.length; i++) await flush();
  assert.equal(opened.length, 1);
  assert.equal(browsers.status('candidate').state, 'connecting');
  const pending = browsers.connections.pending.get('candidate');
  await browsers.resetCandidate('candidate');
  await pending;
  assert.equal(browsers.status('candidate').state, 'idle');
  assert.equal(opened.length, 1);
});
