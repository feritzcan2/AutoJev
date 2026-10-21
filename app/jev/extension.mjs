// Chrome connection through the AutoJob extension (extension/background.js).
// The app listens on a loopback WebSocket; the extension in the selected Chrome
// profile connects to it and drives only the tabs the app opens through the
// chrome.debugger API. Chrome never enters remote-debugging mode, so the user's
// other tabs carry no automation flag.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {WebSocketServer} from 'ws';

export const EXTENSION_ID = 'jmpiibcgkhgcbjgnncpicngllpppiiel';
export const EXTENSION_PROTOCOL = 1;
const TARGET_ID = /^[A-Fa-f0-9]{32}$/;
const CONTROL_TIMEOUT = 15000;
const CONNECTION_CLOSED = 'The Chrome connection closed.';

export const connectPageUrl = (relayUrl, extensionId = EXTENSION_ID) =>
  `chrome-extension://${extensionId}/connect.html?relay=${encodeURIComponent(relayUrl)}`;

export class ExtensionRelay {
  constructor({extensionId = EXTENSION_ID, homePage = ''} = {}) {
    this.extensionId = extensionId;
    this.homePage = homePage;
    this.path = `/jev/${randomBytes(24).toString('base64url')}`;
    this.waiters = new Set();
    this.available = null;
    this.sockets = new Set();
    this.closed = false;
  }
  static async listen(options) {
    const relay = new ExtensionRelay(options);
    await relay.listen();
    return relay;
  }
  async listen() {
    // The port is read once: a request still open on a kept-alive socket can
    // arrive after close(), when the server no longer has an address.
    this.server = createServer((req, res) => {
      const host = `127.0.0.1:${this.port}`;
      if (
        !this.closed &&
        req.method === 'GET' &&
        req.url === `${this.path}/home` &&
        req.headers.host === host
      ) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'",
        });
        res.end(this.homePage);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.websockets = new WebSocketServer({noServer: true, maxPayload: 256 * 1024 * 1024});
    this.server.on('upgrade', (request, socket, head) => {
      const host = `127.0.0.1:${this.port}`;
      if (
        this.closed ||
        request.headers.host !== host ||
        request.url !== this.path ||
        request.headers.origin !== `chrome-extension://${this.extensionId}`
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.websockets.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
  }
  get url() {
    return `ws://127.0.0.1:${this.port}${this.path}`;
  }
  // The AutoJob window's own tab; owned tabs open beside it.
  get homeUrl() {
    return `http://127.0.0.1:${this.port}${this.path}/home`;
  }
  accept(socket) {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => {
      this.sockets.delete(socket);
      if (this.available?.socket === socket) this.available = null;
    });
    socket.once('message', (data) => {
      let hello;
      try {
        hello = JSON.parse(data);
      } catch {}
      if (
        hello?.event !== 'hello' ||
        hello.protocol !== EXTENSION_PROTOCOL ||
        typeof hello.instanceId !== 'string'
      ) {
        socket.close(1002, 'Unexpected handshake');
        return;
      }
      // A newer extension connection replaces an unused older one.
      this.available?.socket.close();
      this.available = {socket, hello};
      for (const waiter of [...this.waiters]) waiter();
    });
  }
  // Hand the live extension connection to a transport. Without one, open the
  // connect page in the selected profile once and wait for the extension.
  async connect({open, signal, timeout = 30000} = {}) {
    signal?.throwIfAborted();
    if (this.closed) throw Error('The Jev connection server closed.');
    if (!this.available) {
      await open(connectPageUrl(this.url, this.extensionId));
      signal?.throwIfAborted();
      await this.waitForExtension({signal, timeout});
    }
    const {socket, hello} = this.available;
    this.available = null;
    return new JevExtensionTransport(socket, hello);
  }
  waitForExtension({signal, timeout}) {
    return new Promise((resolve, reject) => {
      if (this.available) {
        resolve();
        return;
      }
      const finish = (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.waiters.delete(finish);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(signal.reason);
      const timer = setTimeout(
        () =>
          finish(
            Error(
              'The AutoJob Chrome extension did not connect. Check that it is installed and enabled in the selected profile.',
            ),
          ),
        timeout,
      );
      this.waiters.add(finish);
      signal?.addEventListener('abort', abort, {once: true});
    });
  }
  close() {
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter(Error('The Jev connection server closed.'));
    for (const socket of this.sockets) socket.terminate();
    this.websockets?.close();
    this.server?.close();
    this.server?.closeAllConnections();
  }
}

const chromeProduct = (userAgent) => {
  const match = /Chrome\/([\d.]+)/.exec(userAgent);
  return `Chrome/${match ? match[1] : '0'}`;
};

// Playwright's ConnectionTransport over the extension. Playwright sees a
// browser whose only pages are the tabs this transport owns; Chrome tab ids
// stay internal and Jev keeps addressing tabs by their CDP target id.
//
// chrome.debugger allows one attachment per tab. Playwright's page session
// uses it directly; every further session Playwright asks for (newCDPSession
// on a page or frame, attachToBrowserTarget) is virtual and multiplexes onto
// that attachment, receiving the same events.
export class JevExtensionTransport {
  constructor(socket, hello) {
    this.socket = socket;
    this.instanceId = hello.instanceId;
    this.userAgent = typeof hello.userAgent === 'string' ? hello.userAgent : '';
    this.owned = new Set();
    this.attached = new Set();
    this.targets = new Map();
    this.tabIds = new Map();
    this.attaching = new Map();
    this.browserSessions = new Set();
    this.virtual = new Map();
    // Out-of-process iframes that were already loaded when they got attached.
    this.loadedFrames = new Set();
    this.sessions = 0;
    this.pending = new Map();
    this.sequence = 0;
    this.ready = false;
    this.connected = true;
    this.cancelled = false;
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      this.receive(message);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.connected = false;
      clearInterval(this.keepalive);
      for (const {reject, timer} of this.pending.values()) {
        if (timer) clearTimeout(timer);
        reject(Error(CONNECTION_CLOSED));
      }
      this.pending.clear();
      this.onclose?.();
    });
    // Messages keep the extension service worker alive while tabs are idle.
    this.keepalive = setInterval(() => this.rpc('ping').catch(() => {}), 20000);
    this.keepalive.unref?.();
  }
  rpc(method, params = {}, {timeout = 0} = {}) {
    if (!this.connected) return Promise.reject(Error(CONNECTION_CLOSED));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence,
        timer = timeout
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(Error(`Chrome ${method} timed out.`));
            }, timeout)
          : null;
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }
  control(method, params) {
    return this.rpc(method, params, {timeout: CONTROL_TIMEOUT});
  }
  async cdp(tabId, method, params = {}, sessionId, options) {
    const {result} = await this.rpc(
      'debugger.send',
      {tabId, ...(sessionId ? {sessionId} : {}), method, params},
      options,
    );
    return result;
  }
  // ---- ownership
  entry(tabId, openerId = null) {
    return {
      tabId,
      sessionId: `jev-tab-${tabId}`,
      openerId,
      info: null,
      children: new Set(),
      childTargets: new Map(),
      // Events of out-of-process frames, held until Playwright asks for them.
      childHeld: [],
    };
  }
  // The extension remembers the Chrome tab behind each target it debugged in
  // this Chrome run; anything else resolves to nothing.
  async resolve(targetId) {
    if (!TARGET_ID.test(targetId)) return null;
    try {
      const {tabId} = await this.control('tabs.resolve', {targetId});
      return Number.isInteger(tabId) ? tabId : null;
    } catch {
      return null;
    }
  }
  async tabExists(tabId) {
    try {
      await this.control('tabs.get', {tabId});
      return true;
    } catch {
      return false;
    }
  }
  async windowExists(windowId) {
    try {
      await this.control('windows.get', {windowId});
      return true;
    } catch {
      return false;
    }
  }
  // Restore a saved tab by id. The extension only accepts ids it handed out
  // in this Chrome run, so no personal tab can be adopted.
  async adopt(targetId, tabId) {
    if (!TARGET_ID.test(targetId) || !Number.isInteger(tabId)) throw Error('Invalid Jev tab.');
    await this.control('tabs.claim', {tabId});
    this.owned.add(targetId);
    this.targets.set(targetId, this.entry(tabId));
    this.tabIds.set(tabId, targetId);
    if (this.ready) await this.attach(targetId);
  }
  attach(targetId) {
    if (this.attached.has(targetId)) return Promise.resolve(targetId);
    const entry = this.targets.get(targetId);
    if (!entry) return Promise.reject(Error('Unknown Jev target'));
    return this.attachTab(entry.tabId, {expect: targetId, openerId: entry.openerId});
  }
  // One attachment per tab, however many callers ask while it is under way.
  attachTab(tabId, options = {}) {
    const running = this.attaching.get(tabId);
    if (running) return running;
    const run = this.attachTabNow(tabId, options).finally(() => this.attaching.delete(tabId));
    this.attaching.set(tabId, run);
    return run;
  }
  async attachTabNow(tabId, {expect = null, openerId = null} = {}) {
    const known = this.tabIds.get(tabId);
    if (known && this.attached.has(known)) return known;
    await this.control('debugger.attach', {tabId});
    let targetInfo;
    try {
      ({targetInfo} = await this.cdp(tabId, 'Target.getTargetInfo', {}, undefined, {
        timeout: CONTROL_TIMEOUT,
      }));
      if (expect && targetInfo.targetId !== expect)
        throw Error('The saved Jev tab shows another page; the tab is kept.');
    } catch (error) {
      await this.control('debugger.detach', {tabId}).catch(() => {});
      throw error;
    }
    const targetId = targetInfo.targetId,
      entry = this.targets.get(targetId) ?? this.entry(tabId, openerId);
    // Chrome's target info names the frame that opened the page. The tab-level
    // opener only stands in for tabs created through the tabs API, whose
    // opener Chrome reports as the window's active tab.
    if (this.targets.has(targetInfo.openerId)) entry.openerId = targetInfo.openerId;
    entry.info = {
      ...targetInfo,
      attached: true,
      ...(entry.openerId ? {openerId: entry.openerId} : {}),
    };
    // Playwright drops events of a session it has not seen attach, so the
    // tab's own events wait until its attachment is reported, as over CDP.
    entry.held = [];
    entry.childHeld = [];
    this.owned.add(targetId);
    this.targets.set(targetId, entry);
    this.tabIds.set(tabId, targetId);
    this.control('tabs.label', {tabId, targetId}).catch(() => {});
    // Cross-origin application forms run as out-of-process iframes. Attach
    // them from the owned tab before Playwright initializes the page, so a
    // frame that exists at attach time is paused and initialized rather than
    // missed with its URL and visible controls. Use Playwright's own
    // parameters: its call replaces this one, and a filter that leaves out
    // workers keeps every worker the page starts paused, so uploads and other
    // worker code hang.
    try {
      await this.cdp(
        tabId,
        'Target.setAutoAttach',
        {autoAttach: true, waitForDebuggerOnStart: true, flatten: true},
        undefined,
        {timeout: CONTROL_TIMEOUT},
      );
      // The tab may have closed meanwhile; a forgotten target stays forgotten.
      if (this.targets.get(targetId) !== entry)
        throw Error('The Jev tab closed while it was being attached.');
    } catch (error) {
      entry.held = null;
      throw error;
    }
    this.attached.add(targetId);
    this.emit({
      method: 'Target.attachedToTarget',
      params: {sessionId: entry.sessionId, targetInfo: entry.info, waitingForDebugger: false},
    });
    const held = entry.held;
    entry.held = null;
    for (const event of held) this.forward(entry, event);
    return targetId;
  }
  async createTab({windowId, openerTargetId = null, url = 'about:blank'} = {}) {
    const opener = openerTargetId ? this.targets.get(openerTargetId) : null;
    const {tab} = await this.control('tabs.create', {
      ...(Number.isInteger(windowId) ? {windowId} : {}),
      ...(opener ? {openerTabId: opener.tabId} : {}),
      url,
      active: false,
    });
    return this.attachTab(tab.id, {openerId: opener ? openerTargetId : null});
  }
  async createWindow(url) {
    const {window, tab} = await this.control('windows.create', {url, focused: true});
    const targetId = await this.attachTab(tab.id);
    return {windowId: window.id, targetId};
  }
  async windowOf(targetId) {
    const entry = this.targets.get(targetId);
    if (!entry) throw Error('Unknown Jev target');
    const {tab} = await this.control('tabs.get', {tabId: entry.tabId});
    return tab.windowId;
  }
  // Page.bringToFront through chrome.debugger neither reliably selects the tab
  // nor raises its window; the tabs and windows APIs do both.
  async activate(targetId) {
    const entry = this.targets.get(targetId);
    if (!entry) throw Error('Unknown Jev target');
    const {tab} = await this.control('tabs.update', {tabId: entry.tabId, active: true});
    await this.control('windows.update', {windowId: tab.windowId, focused: true});
  }
  async closeTarget(targetId) {
    const entry = this.targets.get(targetId);
    if (!entry) return false;
    await this.control('tabs.remove', {tabId: entry.tabId});
    return true;
  }
  tabIdsByTarget() {
    return Object.fromEntries([...this.targets].map(([id, entry]) => [id, entry.tabId]));
  }
  forget(targetId) {
    const entry = this.targets.get(targetId);
    if (!entry) return;
    const wasAttached = this.attached.delete(targetId);
    this.owned.delete(targetId);
    this.targets.delete(targetId);
    this.tabIds.delete(entry.tabId);
    if (wasAttached) this.detached(entry, targetId);
  }
  detached(entry, targetId) {
    for (const id of entry.children) this.loadedFrames.delete(id);
    for (const [id, session] of [...this.virtual])
      if (session.entry === entry) this.dropVirtual(id);
    this.emit({
      method: 'Target.detachedFromTarget',
      params: {sessionId: entry.sessionId, targetId},
    });
  }
  dropVirtual(id) {
    const session = this.virtual.get(id);
    if (!session) return;
    this.virtual.delete(id);
    const [targetId] = [...this.targets].find(([, entry]) => entry === session.entry) ?? [];
    this.emit({
      ...(session.parent ? {sessionId: session.parent} : {}),
      method: 'Target.detachedFromTarget',
      params: {sessionId: id, ...(targetId ? {targetId} : {})},
    });
  }
  sessionEntry(sessionId) {
    for (const entry of this.targets.values())
      if (entry.sessionId === sessionId || entry.children.has(sessionId)) return entry;
    return null;
  }
  // An owned tab, or a frame session attached under one.
  locate(targetId) {
    const entry = this.targets.get(targetId);
    if (entry) return {targetId, entry, real: undefined};
    for (const [id, candidate] of this.targets) {
      const real = candidate.childTargets.get(targetId);
      if (real) return {targetId: id, entry: candidate, real};
    }
    return null;
  }
  emit(message) {
    this.onmessage?.(message);
  }
  // ---- extension → app
  receive(message) {
    if (Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error
        ? pending.reject(Object.assign(Error(message.error.message), {code: message.error.code}))
        : pending.resolve(message.result);
      return;
    }
    switch (message.event) {
      case 'debugger.event':
        this.debuggerEvent(message);
        return;
      case 'debugger.detach':
        this.debuggerDetach(message);
        return;
      case 'tabs.created':
        this.tabCreated(message.tab ?? {});
        return;
      case 'tabs.removed':
        this.tabRemoved(message.tabId);
        return;
      case 'windows.removed':
        this.onWindowRemoved?.(message.windowId);
        return;
    }
  }
  debuggerEvent({tabId, sessionId, method, params}) {
    const targetId = this.tabIds.get(tabId),
      entry = targetId && this.targets.get(targetId);
    if (!entry) return;
    if (method === 'Target.attachedToTarget' && params?.sessionId) {
      entry.children.add(params.sessionId);
      if (params.targetInfo?.type === 'iframe' && !params.waitingForDebugger)
        this.loadedFrames.add(params.sessionId);
      if (params.targetInfo?.targetId)
        entry.childTargets.set(params.targetInfo.targetId, params.sessionId);
    } else if (method === 'Target.detachedFromTarget' && params?.sessionId) {
      entry.children.delete(params.sessionId);
      this.loadedFrames.delete(params.sessionId);
      for (const [target, session] of entry.childTargets)
        if (session === params.sessionId) entry.childTargets.delete(target);
      for (const [id, virtual] of [...this.virtual])
        if (virtual.entry === entry && virtual.real === params.sessionId) this.dropVirtual(id);
    }
    // The transport turns on auto-attach before Playwright knows the page, so
    // Chrome reports its frames early. Playwright ignores a frame it has not
    // seen in the page's frame tree, which leaves a frame paused for the
    // debugger and one that already loaded without its URL. Over CDP Chrome
    // reports them only once Playwright asks for auto-attach itself, so they
    // wait for that here too.
    const child =
      sessionId || ['Target.attachedToTarget', 'Target.detachedFromTarget'].includes(method);
    if (child && entry.childHeld) entry.childHeld.push({sessionId, method, params});
    else if (entry.held) entry.held.push({sessionId, method, params});
    else this.forward(entry, {sessionId, method, params});
  }
  releaseChildren(entry) {
    const held = entry.childHeld;
    entry.childHeld = null;
    for (const event of held ?? []) this.forward(entry, event);
  }
  forward(entry, {sessionId, method, params}) {
    this.emit({sessionId: sessionId ?? entry.sessionId, method, params});
    for (const [id, virtual] of this.virtual)
      if (virtual.entry === entry && virtual.real === sessionId)
        this.emit({sessionId: id, method, params});
  }
  debuggerDetach({tabId, reason}) {
    // Cancelling the Chrome infobar ends the whole connection; the app waits
    // for an explicit reconnect instead of reopening Chrome pages on its own.
    if (reason === 'canceled_by_user') {
      this.cancelled = true;
      this.close();
      return;
    }
    const targetId = this.tabIds.get(tabId);
    if (!targetId || !this.attached.delete(targetId)) return;
    this.detached(this.targets.get(targetId), targetId);
  }
  tabCreated(tab) {
    // The extension reports a tab only when an owned tab opened it (a popup or
    // a new-tab link); it belongs to the same task.
    const openerId = this.tabIds.get(tab.openerTabId);
    if (!openerId || !Number.isInteger(tab.id) || !this.ready) return;
    this.attachTab(tab.id, {openerId}).catch(() => {});
  }
  tabRemoved(tabId) {
    const targetId = this.tabIds.get(tabId);
    if (!targetId) return;
    this.forget(targetId);
    this.onTargetDestroyed?.(targetId);
  }
  // ---- Playwright → extension (ConnectionTransport)
  send(message) {
    const session = message.sessionId ? {sessionId: message.sessionId} : {};
    const loadedFrame =
      message.method === 'Page.getFrameTree' && this.loadedFrames.delete(message.sessionId);
    const pageAutoAttach =
      message.method === 'Target.setAutoAttach' &&
      [...this.targets.values()].find((entry) => entry.sessionId === message.sessionId);
    this.handle(message).then(
      (result) => {
        this.onmessage?.({id: message.id, ...session, result});
        if (pageAutoAttach) this.releaseChildren(pageAutoAttach);
        // Playwright learns an out-of-process frame's URL only from its next
        // navigation, so a frame that loaded before the attach keeps an empty
        // URL. Report the URL from its frame tree as a same-document
        // navigation, which sets only that URL.
        const frame = loadedFrame && result?.frameTree?.frame;
        if (frame?.url)
          this.onmessage?.({
            sessionId: message.sessionId,
            method: 'Page.navigatedWithinDocument',
            params: {frameId: frame.id, url: frame.url, navigationType: 'other'},
          });
      },
      (error) => {
        this.onmessage?.({
          id: message.id,
          ...session,
          error: {code: error.code ?? -32000, message: String(error.message || error)},
        });
        if (pageAutoAttach) this.releaseChildren(pageAutoAttach);
      },
    );
  }
  async handle({method, params = {}, sessionId}) {
    if (sessionId && !this.browserSessions.has(sessionId)) {
      const virtual = this.virtual.get(sessionId),
        entry = virtual?.entry ?? this.sessionEntry(sessionId);
      if (!entry) throw Error(`Session not found: ${sessionId}`);
      const real = virtual ? virtual.real : sessionId === entry.sessionId ? undefined : sessionId;
      if (method === 'Target.getTargetInfo' && !params.targetId && !real)
        return {targetInfo: entry.info};
      return this.cdp(entry.tabId, method, params, real);
    }
    switch (method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: chromeProduct(this.userAgent),
          revision: '',
          userAgent: this.userAgent,
          jsVersion: '',
        };
      case 'Target.setAutoAttach': {
        // Browser-level auto-attach is replaced by explicit attachment to owned tabs.
        this.ready = true;
        // A restored tab may still be releasing the previous app run's
        // debugger; one short retry, then the tab is left alone.
        await Promise.all(
          [...this.owned].map((id) =>
            this.attach(id)
              .catch(() => new Promise((r) => setTimeout(r, 500)).then(() => this.attach(id)))
              .catch(() => {
                this.forget(id);
                this.onTargetDestroyed?.(id);
              }),
          ),
        );
        return {};
      }
      case 'Target.getTargetInfo': {
        if (!params.targetId)
          return {
            targetInfo: {
              targetId: 'browser',
              type: 'browser',
              title: '',
              url: '',
              attached: true,
              canAccessOpener: false,
            },
          };
        const entry = this.targets.get(params.targetId);
        if (!entry?.info) throw Error('No target with given id found');
        return {targetInfo: entry.info};
      }
      case 'Target.getTargets':
        return {
          targetInfos: [...this.targets.values()].filter((e) => e.info).map((e) => e.info),
        };
      case 'Target.setDiscoverTargets':
        return {};
      case 'Target.attachToBrowserTarget': {
        const id = `jev-browser-${++this.sessions}`;
        this.browserSessions.add(id);
        return {sessionId: id};
      }
      case 'Target.attachToTarget': {
        const located = this.locate(params.targetId);
        if (!located) throw Error('No target with given id found');
        await this.attach(located.targetId);
        const id = `jev-cdp-${++this.sessions}`;
        this.virtual.set(id, {entry: located.entry, real: located.real, parent: sessionId ?? null});
        return {sessionId: id};
      }
      case 'Target.detachFromTarget': {
        if (this.virtual.has(params.sessionId)) {
          this.dropVirtual(params.sessionId);
          return {};
        }
        const entry = this.sessionEntry(params.sessionId);
        if (!entry) throw Error('No session with given id');
        return this.cdp(entry.tabId, method, params);
      }
      case 'Target.closeTarget':
        return {success: await this.closeTarget(params.targetId)};
      case 'Target.createTarget':
        return {targetId: await this.createTab({url: params.url || 'about:blank'})};
      case 'Browser.getWindowForTarget': {
        // chrome.debugger has no browser target; the tab's window answers.
        const located = this.locate(params.targetId ?? '');
        if (!located) throw Error('No target with given id found');
        const windowId = await this.windowOf(located.targetId),
          {window} = await this.control('windows.get', {windowId}),
          bounds = Object.fromEntries(
            ['left', 'top', 'width', 'height']
              .filter((key) => Number.isInteger(window[key]))
              .map((key) => [key, window[key]]),
          );
        return {windowId, bounds: {...bounds, windowState: window.state ?? 'normal'}};
      }
      case 'Browser.close':
        this.close();
        return {};
      default: {
        // Browser-scoped commands (Storage.*, Browser.*) answer the same from
        // any attached tab; chrome.debugger has no browser target.
        for (const [id, entry] of this.targets)
          if (this.attached.has(id)) return this.cdp(entry.tabId, method, params);
        throw Error(`${method} requires an attached Jev tab`);
      }
    }
  }
  close() {
    clearInterval(this.keepalive);
    if (this.connected) this.socket.close();
  }
}
