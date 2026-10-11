// AutoJev bridge. The desktop app reaches Chrome through this extension's
// debugger API instead of Chrome's remote-debugging port: Chrome then debugs
// only the tabs the app opened, and the rest of the profile stays untouched.
//
// Wire format (JSON over a loopback WebSocket the app listens on):
//   app → extension  {id, method, params}        answered by {id, result} | {id, error}
//   extension → app  {event, ...}                 one-way notifications
const PROTOCOL = 1;
const DEBUGGER_VERSION = '1.3';
// Each app connection is a client. A client only sees the tabs it opened,
// restored by id, or received as popups of those tabs.
const clients = new Set();
const attachedBy = new Map(); // tabId -> client
let connectTabId = null;
// Tabs AutoJev opened in this Chrome run. Only these can be restored by id,
// so a saved id can never land on a personal tab.
const known = new Set();
const knownLoaded = chrome.storage.session
  .get('knownTabs')
  .then(({knownTabs}) => {
    for (const id of knownTabs ?? []) known.add(id);
  })
  .catch(() => {});
async function remember(tabId, keep = true) {
  await knownLoaded;
  keep ? known.add(tabId) : known.delete(tabId);
  await chrome.storage.session.set({knownTabs: [...known]}).catch(() => {});
}
// CDP target ids of AutoJev tabs, so a saved or checkpointed target is found
// again after the app restarts within the same Chrome run.
const targetTabs = new Map();
const targetsLoaded = chrome.storage.session
  .get('targetTabs')
  .then(({targetTabs: stored}) => {
    for (const [target, tabId] of stored ?? []) targetTabs.set(target, tabId);
  })
  .catch(() => {});
async function labelTarget(targetId, tabId) {
  await targetsLoaded;
  targetTabs.set(targetId, tabId);
  await chrome.storage.session.set({targetTabs: [...targetTabs]}).catch(() => {});
}
async function unlabelTab(tabId) {
  await targetsLoaded;
  for (const [target, id] of [...targetTabs]) if (id === tabId) targetTabs.delete(target);
  await chrome.storage.session.set({targetTabs: [...targetTabs]}).catch(() => {});
}

const callback = (resolve, reject) => (value) =>
  chrome.runtime.lastError ? reject(cdpError(chrome.runtime.lastError.message)) : resolve(value);
// chrome.debugger reports protocol failures as a JSON string in lastError.
function cdpError(message) {
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed.message === 'string')
      return Object.assign(Error(parsed.message), {code: parsed.code});
  } catch {}
  return Error(message);
}
const debuggerApi = {
  attach: (tabId) =>
    new Promise((resolve, reject) =>
      chrome.debugger.attach({tabId}, DEBUGGER_VERSION, callback(resolve, reject)),
    ),
  detach: (tabId) =>
    new Promise((resolve, reject) => chrome.debugger.detach({tabId}, callback(resolve, reject))),
  send: (tabId, sessionId, method, params) =>
    new Promise((resolve, reject) =>
      chrome.debugger.sendCommand(
        sessionId ? {tabId, sessionId} : {tabId},
        method,
        params ?? {},
        callback(resolve, reject),
      ),
    ),
};

async function instanceId() {
  const stored = await chrome.storage.session.get('instanceId');
  if (typeof stored.instanceId === 'string') return stored.instanceId;
  const id = crypto.randomUUID();
  await chrome.storage.session.set({instanceId: id});
  return id;
}

function isRelayUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'ws:' &&
      url.hostname === '127.0.0.1' &&
      /^\/jev\/[A-Za-z0-9_-]{16,}$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const publicTab = (tab) => ({
  id: tab.id,
  windowId: tab.windowId,
  openerTabId: tab.openerTabId,
  active: tab.active,
});

function ownedTab(client, tabId) {
  if (!Number.isInteger(tabId) || !client.tabs.has(tabId))
    throw Error('Tab is not managed by this AutoJev connection');
  return tabId;
}
function attachedTab(client, tabId) {
  if (attachedBy.get(ownedTab(client, tabId)) !== client) throw Error('Tab is not attached');
  return tabId;
}

const methods = {
  ping: async () => ({}),
  // Existence and placement only; a restored id never reveals the page it shows.
  'tabs.get': async (client, {tabId}) => {
    if (!Number.isInteger(tabId)) throw Error('Invalid tab id');
    const tab = await chrome.tabs.get(tabId);
    return {tab: publicTab(tab)};
  },
  'tabs.label': async (client, {tabId, targetId}) => {
    ownedTab(client, tabId);
    if (!/^[A-Fa-f0-9]{32}$/.test(targetId)) throw Error('Invalid target id');
    await labelTarget(targetId, tabId);
    return {};
  },
  'tabs.resolve': async (client, {targetId}) => {
    await targetsLoaded;
    const tabId = targetTabs.get(targetId);
    if (tabId === undefined) throw Error('Unknown AutoJev target');
    await chrome.tabs.get(tabId);
    return {tabId};
  },
  'tabs.claim': async (client, {tabId}) => {
    if (!Number.isInteger(tabId)) throw Error('Invalid tab id');
    await knownLoaded;
    if (!known.has(tabId)) throw Error('Tab was not opened by AutoJev');
    await chrome.tabs.get(tabId);
    client.tabs.add(tabId);
    return {};
  },
  'tabs.create': async (client, {windowId, openerTabId, url, active = false}) => {
    const tab = await chrome.tabs.create({
      ...(Number.isInteger(windowId) ? {windowId} : {}),
      ...(Number.isInteger(openerTabId) ? {openerTabId: ownedTab(client, openerTabId)} : {}),
      url,
      active: Boolean(active),
    });
    client.tabs.add(tab.id);
    await remember(tab.id);
    return {tab: publicTab(tab)};
  },
  'tabs.update': async (client, {tabId, url, active}) => {
    const tab = await chrome.tabs.update(ownedTab(client, tabId), {
      ...(typeof url === 'string' ? {url} : {}),
      ...(typeof active === 'boolean' ? {active} : {}),
    });
    return {tab: publicTab(tab)};
  },
  'tabs.remove': async (client, {tabId}) => {
    await chrome.tabs.remove(ownedTab(client, tabId));
    return {};
  },
  'windows.create': async (client, {url, focused = true}) => {
    const window = await chrome.windows.create({url, focused: Boolean(focused), type: 'normal'});
    const tab = window.tabs?.[0];
    if (!tab) throw Error('Chrome did not report the new window tab');
    client.tabs.add(tab.id);
    await remember(tab.id);
    return {window: {id: window.id}, tab: publicTab(tab)};
  },
  'windows.get': async (client, {windowId}) => {
    if (!Number.isInteger(windowId)) throw Error('Invalid window id');
    const window = await chrome.windows.get(windowId);
    return {window: {id: window.id, focused: window.focused}};
  },
  'windows.update': async (client, {windowId, focused}) => {
    if (!Number.isInteger(windowId)) throw Error('Invalid window id');
    await chrome.windows.update(windowId, {focused: Boolean(focused)});
    return {};
  },
  'debugger.attach': async (client, {tabId}) => {
    ownedTab(client, tabId);
    const owner = attachedBy.get(tabId);
    if (owner === client) return {};
    // One attachment per tab: ownership moves to the newest connection. A
    // live previous owner sees the tab detach; a closed one may still be
    // releasing it.
    if (owner) {
      attachedBy.delete(tabId);
      if (owner.socket.readyState === WebSocket.OPEN)
        send(owner, {event: 'debugger.detach', tabId, reason: 'replaced_with_another_client'});
      await debuggerApi.detach(tabId).catch(() => {});
    }
    await debuggerApi.attach(tabId);
    attachedBy.set(tabId, client);
    return {};
  },
  'debugger.detach': async (client, {tabId}) => {
    attachedTab(client, tabId);
    attachedBy.delete(tabId);
    await debuggerApi.detach(tabId);
    return {};
  },
  'debugger.send': async (client, {tabId, sessionId, method, params}) => {
    attachedTab(client, tabId);
    if (typeof method !== 'string') throw Error('Invalid protocol method');
    return {result: await debuggerApi.send(tabId, sessionId, method, params)};
  },
};

function send(client, message) {
  if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(message));
}
async function handle(client, message) {
  const {id, method, params} = message ?? {};
  if (!Number.isInteger(id) || typeof method !== 'string') return;
  try {
    const run = Object.hasOwn(methods, method) ? methods[method] : null;
    if (!run) throw Error(`Unknown method ${method}`);
    send(client, {id, result: await run(client, params ?? {})});
  } catch (error) {
    send(client, {
      id,
      error: {code: error.code ?? -32000, message: String(error.message || error)},
    });
  }
}

async function cleanup(client) {
  if (!clients.delete(client)) return;
  for (const [tabId, owner] of [...attachedBy]) {
    if (owner !== client) continue;
    attachedBy.delete(tabId);
    await debuggerApi.detach(tabId).catch(() => {});
  }
  const stored = await chrome.storage.session.get('relayUrl').catch(() => ({}));
  if (stored.relayUrl === client.relayUrl) await chrome.storage.session.remove('relayUrl');
}

function connect(relayUrl, {fromTabId = null} = {}) {
  if (!isRelayUrl(relayUrl)) return Promise.reject(Error('Invalid AutoJev relay address'));
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const client = {socket, relayUrl, tabs: new Set()};
    let opened = false;
    socket.onopen = async () => {
      opened = true;
      clients.add(client);
      send(client, {
        event: 'hello',
        protocol: PROTOCOL,
        instanceId: await instanceId(),
        userAgent: navigator.userAgent,
        version: chrome.runtime.getManifest().version,
      });
      await chrome.storage.session.set({relayUrl});
      if (fromTabId !== null) chrome.tabs.remove(fromTabId).catch(() => {});
      resolve();
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handle(client, message);
    };
    socket.onclose = () => {
      cleanup(client);
      if (!opened) reject(Error('AutoJev did not accept the connection'));
    };
    socket.onerror = () => {};
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'connect') return false;
  const tabId = sender.tab?.id ?? null;
  // One pending connect page at a time: a retry replaces the previous page.
  if (connectTabId !== null && connectTabId !== tabId)
    chrome.tabs.remove(connectTabId).catch(() => {});
  connectTabId = tabId;
  connect(message.relayUrl, {fromTabId: tabId}).then(
    () => {
      if (connectTabId === tabId) connectTabId = null;
      sendResponse({ok: true});
    },
    (error) => sendResponse({error: String(error.message || error)}),
  );
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const client = attachedBy.get(source.tabId);
  if (!client) return;
  send(client, {
    event: 'debugger.event',
    tabId: source.tabId,
    ...(source.sessionId ? {sessionId: source.sessionId} : {}),
    method,
    params,
  });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const client = attachedBy.get(source.tabId);
  if (!client) return;
  attachedBy.delete(source.tabId);
  send(client, {event: 'debugger.detach', tabId: source.tabId, reason});
});
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return;
  for (const client of clients)
    if (client.tabs.has(tab.openerTabId)) {
      client.tabs.add(tab.id);
      remember(tab.id);
      send(client, {event: 'tabs.created', tab: publicTab(tab)});
    }
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  attachedBy.delete(tabId);
  remember(tabId, false);
  unlabelTab(tabId);
  for (const client of clients)
    if (client.tabs.delete(tabId))
      send(client, {event: 'tabs.removed', tabId, windowId: info.windowId});
});
chrome.windows.onRemoved.addListener((windowId) => {
  for (const client of clients) send(client, {event: 'windows.removed', windowId});
});

// A restarted service worker reconnects to the app that is still running.
chrome.storage.session.get('relayUrl').then(({relayUrl}) => {
  if (typeof relayUrl === 'string')
    connect(relayUrl).catch(() => chrome.storage.session.remove('relayUrl'));
});
