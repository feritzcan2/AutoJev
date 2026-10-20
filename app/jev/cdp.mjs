import WebSocket from 'ws';
const INTERNAL_ID_BASE = 1000000000;

// Playwright normally auto-attaches every personal tab and waits for all of them
// to initialize. Expose only task-owned windows to its CDP connection instead.
export class JevCdpTransport {
  constructor(socket) {
    this.socket = socket;
    this.owned = new Set();
    this.attached = new Set();
    this.pending = new Map();
    this.callTimeoutMs = 15000;
    // Out-of-process iframes that were already loaded when they got attached:
    // their session ids, then Playwright's Page.getFrameTree requests for them.
    this.loadedFrames = new Set();
    this.frameTrees = new Map();
    this.sequence = INTERNAL_ID_BASE;
    socket.onmessage = (event) => this.receive(JSON.parse(event.data));
    socket.onclose = () => {
      for (const {reject, timer} of this.pending.values()) {
        clearTimeout(timer);
        reject(Error('The Chrome connection closed.'));
      }
      this.pending.clear();
      this.onclose?.();
    };
  }
  static async connect(endpoint, {signal} = {}) {
    signal?.throwIfAborted();
    // Chrome holds the WebSocket upgrade until the user approves. Keep that
    // request alive; a timeout/retry creates another permission dialog. The
    // native Node WebSocket also has an implicit HTTP headers timeout, so use
    // ws with no handshake deadline. Lifecycle cancellation still closes it.
    const socket = new WebSocket(endpoint, {handshakeTimeout: 0});
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = () => {};
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.close();
        reject(error);
      };
      const abort = () => fail(signal.reason);
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      socket.onerror = () => fail(Error('Could not connect to Chrome.'));
      socket.onclose = () => fail(Error('The Chrome connection closed before it was established.'));
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
    });
    return new JevCdpTransport(socket);
  }
  call(method, params = {}, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(Error('The Chrome connection closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence,
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Error(`Chrome ${method} timed out.`));
        }, this.callTimeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  async ownWindow(marker) {
    for (let i = 0; i < 100; i++) {
      const {targetInfos} = await this.call('Target.getTargets');
      const target = targetInfos.find((target) => target.type === 'page' && target.url === marker);
      if (target) {
        this.owned.add(target.targetId);
        if (this.ready) await this.attach(target.targetId);
        return target.targetId;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error('The new Jev window was not found; existing tabs are kept.');
  }
  async attach(targetId) {
    if (this.attached.has(targetId)) return;
    this.attached.add(targetId);
    let sessionId;
    try {
      ({sessionId} = await this.call('Target.attachToTarget', {targetId, flatten: true}));
      // Cross-origin application forms can run as out-of-process iframes.
      // Attach their targets from the owned page session, without attaching
      // unrelated tabs in the user's Chrome profile.
      // Let Playwright initialize the frame session before navigation runs;
      // otherwise it can miss the frame URL and its visible controls.
      // Use Playwright's own parameters: this call can arrive after Playwright's
      // and replaces it, and a filter that leaves out workers keeps every
      // worker the page starts paused, so uploads and other worker code hang.
      await this.call(
        'Target.setAutoAttach',
        {autoAttach: true, waitForDebuggerOnStart: true, flatten: true},
        sessionId,
      );
    } catch (error) {
      this.attached.delete(targetId);
      // Playwright already saw the attach; detaching tells it the page is gone
      // instead of leaving it waiting for a page that does not answer.
      if (sessionId) await this.call('Target.detachFromTarget', {sessionId}).catch(() => {});
      throw error;
    }
  }
  receive(message) {
    const pending = this.pending.get(message.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error
        ? pending.reject(Error(message.error.message))
        : pending.resolve(message.result);
      return;
    }
    // A response can arrive after our timeout removed its callback. It still
    // belongs to this transport, not to Playwright's independent request map.
    if (message.id > INTERNAL_ID_BASE) return;
    if (
      message.method === 'Target.attachedToTarget' &&
      message.params.targetInfo?.type === 'iframe' &&
      !message.params.waitingForDebugger
    )
      this.loadedFrames.add(message.params.sessionId);
    if (!message.sessionId && message.method === 'Target.targetDestroyed') {
      const id = message.params.targetId;
      const owned = this.owned.delete(id);
      this.attached.delete(id);
      if (owned) this.onTargetDestroyed?.(id);
    }
    if (
      !message.sessionId &&
      ['Target.targetCreated', 'Target.targetInfoChanged'].includes(message.method)
    ) {
      const target = message.params.targetInfo;
      if (
        target.type === 'page' &&
        this.owned.has(target.openerId) &&
        !this.owned.has(target.targetId)
      ) {
        this.owned.add(target.targetId);
        if (this.ready) this.attach(target.targetId).catch(() => {});
      }
      return;
    }
    this.onmessage?.(message);
    // Playwright learns an out-of-process frame's URL only from its next
    // navigation, so a frame that loaded before the attach keeps an empty URL.
    // Report the URL from its frame tree as a same-document navigation, which
    // sets only that URL.
    const tree = this.frameTrees.get(message.id);
    if (tree && tree === message.sessionId) {
      this.frameTrees.delete(message.id);
      const frame = message.result?.frameTree?.frame;
      if (frame?.url)
        this.onmessage?.({
          sessionId: tree,
          method: 'Page.navigatedWithinDocument',
          params: {frameId: frame.id, url: frame.url, navigationType: 'other'},
        });
    }
  }
  send(message) {
    if (message.method === 'Page.getFrameTree' && this.loadedFrames.delete(message.sessionId))
      this.frameTrees.set(message.id, message.sessionId);
    // Browser-level auto-attach is replaced by explicit attachment to owned tabs.
    // A restored tab that does not answer (a hung page) is left out instead of
    // failing the whole connection; it stays open in Chrome, no longer owned.
    if (!message.sessionId && message.method === 'Target.setAutoAttach') {
      (async () => {
        this.ready = true;
        await this.call('Target.setDiscoverTargets', {discover: true});
        await Promise.all(
          [...this.owned].map((targetId) =>
            this.attach(targetId).catch(() => this.owned.delete(targetId)),
          ),
        );
        this.onmessage?.({id: message.id, result: {}});
      })().catch((error) =>
        this.onmessage?.({id: message.id, error: {code: -32000, message: error.message}}),
      );
      return;
    }
    if (!message.sessionId && message.method === 'Browser.close') {
      this.close();
      return;
    }
    this.socket.send(JSON.stringify(message));
  }
  close() {
    this.socket.close();
  }
}
