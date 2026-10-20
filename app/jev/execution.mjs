// Keep one browser helper alive across short MCP requests. Polling never
// starts a second helper and finishing the request never cancels the first.
//
// Each poll costs the agent a full-context model turn, so a tool call waits in
// place as long as the provider's MCP transport allows. Claude Code moves an
// MCP tool call still running after 120 seconds to the background and hands
// the agent its own task ID instead of the result, so its window stays below
// that; Codex gets tool_timeout_sec=300 at launch. Unknown providers keep a
// conservative window.
export const JEV_WAIT_MS = {claude: 100000, codex: 240000, default: 30000};
// The client's real limit is only known from behavior: when a provider drops
// a tool call before the app answers, later waits stay under the time it
// tolerated, for this app session. The dropped call itself loses nothing; the
// helper keeps running and the next poll collects it.
const WAIT_MARGIN_MS = 5000,
  MIN_WAIT_MS = 15000,
  clientLimits = new Map();
export function observeClientAbort(provider, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  clientLimits.set(provider, Math.min(clientLimits.get(provider) ?? Infinity, elapsedMs));
}
export function jevWaitMsFor(provider) {
  const configured = JEV_WAIT_MS[provider] ?? JEV_WAIT_MS.default,
    limit = clientLimits.get(provider);
  return limit === undefined
    ? configured
    : Math.max(MIN_WAIT_MS, Math.min(configured, limit - WAIT_MARGIN_MS));
}
export const resetClientLimits = () => clientLimits.clear();
export class JevExecution {
  // waitMs may be a function so a session learns a shorter client limit mid-run.
  constructor({waitMs = 15000} = {}) {
    this.waitMs = waitMs;
    this.current = null;
  }
  get waitWindow() {
    return typeof this.waitMs === 'function' ? this.waitMs() : this.waitMs;
  }
  get busy() {
    return Boolean(this.current && !this.current.settled);
  }
  receipt() {
    const task = this.current;
    return {
      status: 'running',
      taskId: task.taskId ?? null,
      operation: task.operation,
      next: task.taskId
        ? 'Jev continues automatically until review, an issue or completion. Use read_browser_task to wait for its result; do not run shell sleep, restart the operation or use the browser.'
        : 'Jev is starting. Repeat browser_run_task with the same input to retrieve its taskId; this will reuse the existing operation.',
    };
  }
  async wait() {
    const task = this.current;
    let timer;
    try {
      await Promise.race([
        task.promise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.waitWindow);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!task.settled) return this.receipt();
    task.delivered = true;
    if (task.error) throw task.error;
    return task.value;
  }
  async run(input, execute) {
    if (this.busy) return this.receipt();
    if (this.current && !this.current.delivered) return this.wait();
    const task = {
      taskId: input.taskId,
      operation: input.operation,
      settled: false,
      delivered: false,
    };
    this.current = task;
    task.promise = Promise.resolve()
      .then(async () => {
        let next = input;
        for (;;) {
          const value = await execute((value) => {
            task.taskId = value.id;
            task.operation = value.input.operation;
          }, next);
          if (value.status !== 'continue') return value;
          if (!value.taskId || value.taskId !== task.taskId)
            throw Error('The Jev continuation task changed.');
          next = {taskId: value.taskId};
          // Yield to cancellation and other workers between transport slices. No
          // main-model turn is needed to advance the same helper.
          await new Promise(setImmediate);
        }
      })
      .then(
        (value) => {
          task.value = value;
        },
        (error) => {
          task.error = error;
        },
      )
      .finally(() => {
        task.settled = true;
      });
    return this.wait();
  }
  // A request still running, or finished with a result nobody received yet.
  get pending() {
    return Boolean(this.current && (!this.current.settled || !this.current.delivered));
  }
  owns(taskId) {
    return this.pending && this.current.taskId === taskId;
  }
}
