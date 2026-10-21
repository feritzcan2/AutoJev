// Connection work belongs to the app, not to an agent turn. One in-flight
// handshake per candidate, with bounded backoff and no polling model calls.
export const browserWaitResult = () => ({
  status: 'browser_wait',
  nextAction: 'end_turn',
  message:
    'The app is waiting for the Chrome connection. Do not create a question, a blocked status or a task report. End the turn; the same task resumes automatically once the connection is ready.',
});
const EXTENSION_WATCH_MS = 15 * 60000;
export class BrowserConnections {
  constructor({connect, changed = () => {}, now = () => Date.now()}) {
    Object.assign(this, {connect, changed, now});
    this.states = new Map();
    this.pending = new Map();
    this.epochs = new Map();
    this.closed = false;
  }
  status(id) {
    return this.states.get(id) ?? {state: 'idle', ready: false, attempts: 0};
  }
  set(id, state) {
    if (this.closed) return;
    this.states.set(id, state);
    this.changed(id, state);
    return state;
  }
  // A connection the user cancelled in Chrome waits for an explicit reconnect;
  // any other loss retries on its own.
  disconnected(id, {manual = false} = {}) {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    const old = this.status(id);
    this.set(id, {
      ...old,
      state: 'waiting',
      ready: false,
      retryAt: manual ? Infinity : this.now() + 2000,
      message: manual
        ? 'The Jev connection was cancelled in Chrome. Press Reconnect to continue.'
        : 'The Chrome connection was lost. The same task is waiting for the connection.',
    });
  }
  prepare(id, {force = false} = {}) {
    const state = this.status(id);
    if (
      this.closed ||
      state.ready ||
      this.pending.has(id) ||
      (!force && state.retryAt > this.now())
    )
      return state;
    const epoch = this.epochs.get(id) ?? 0;
    const publish = (state) => {
      if ((this.epochs.get(id) ?? 0) === epoch) this.set(id, state);
    };
    const attempt = (state.attempts ?? 0) + 1;
    this.set(id, {
      state: 'connecting',
      ready: false,
      attempts: attempt,
      message: 'Connecting to Chrome…',
    });
    const pending = Promise.resolve()
      .then(() => this.connect(id))
      .then(
        () => publish({state: 'ready', ready: true, attempts: 0, connectedAt: this.now()}),
        (error) => {
          // While the user installs the extension, its check is a local file
          // read: look again every two seconds for a while, then back off.
          const missing = error.code === 'EXTENSION_MISSING',
            missingSince = missing ? (state.missingSince ?? this.now()) : undefined,
            watching = missing && this.now() - missingSince < EXTENSION_WATCH_MS;
          publish({
            state: 'waiting',
            ready: false,
            attempts: attempt,
            retryAt:
              this.now() +
              (watching ? 2000 : Math.min(30000, 2000 * 2 ** Math.min(attempt - 1, 4))),
            message: String(error.message).split('\n')[0].slice(0, 600),
            ...(missing ? {code: error.code, missingSince} : {}),
          });
        },
      )
      .finally(() => this.pending.delete(id));
    this.pending.set(id, pending);
    return this.status(id);
  }
  reset(id) {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.states.delete(id);
  }
  close() {
    this.closed = true;
  }
}
