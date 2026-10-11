import {setTimeout as delay} from 'node:timers/promises';

const messages = {
  ERROR_ZERO_BALANCE: 'The CapSolver balance is insufficient.',
  ERROR_KEY_DOES_NOT_EXIST: 'The CapSolver key was not accepted.',
  ERROR_CAPTCHA_UNSOLVABLE: 'CapSolver could not solve this verification.',
  ERROR_INVALID_TASK_DATA: 'CapSolver did not accept the verification details.',
};
export class CaptchaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
// The endpoint is fixed. Neither page content nor agent input can redirect a key.
export class CapsolverClient {
  constructor({fetchImpl = fetch, pollMs = 3000, requestMs = 15000} = {}) {
    Object.assign(this, {fetchImpl, pollMs, requestMs});
  }
  async request(method, apiKey, input = {}, signal) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.requestMs),
      abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(`https://api.capsolver.com/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({clientKey: apiKey, ...input}),
        redirect: 'error',
        signal: abort,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new CaptchaError(
          'CAPTCHA_HTTP',
          `The CapSolver connection could not be completed (HTTP ${response.status}).`,
        );
      }
      const reader = response.body.getReader(),
        parts = [];
      let size = 0;
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 262144)
            throw new CaptchaError('CAPTCHA_RESPONSE', 'The CapSolver response is invalid.');
          parts.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      let value;
      try {
        value = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        throw new CaptchaError('CAPTCHA_RESPONSE', 'Could not read the CapSolver response.');
      }
      if (!value || typeof value !== 'object' || !Number.isInteger(value.errorId))
        throw new CaptchaError('CAPTCHA_RESPONSE', 'The CapSolver response is invalid.');
      // Never echo server errorDescription: it can contain submitted data/secrets.
      if (value.errorId !== 0)
        throw new CaptchaError(
          Object.hasOwn(messages, value.errorCode) ? value.errorCode : 'CAPTCHA_PROVIDER',
          messages[value.errorCode] ?? 'CapSolver could not complete the solve request.',
        );
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CaptchaError) throw error;
      throw new CaptchaError(
        'CAPTCHA_NETWORK',
        'The CapSolver connection did not complete in time.',
      );
    }
  }
  async balance(apiKey, signal) {
    const value = await this.request('getBalance', apiKey, {}, signal);
    if (!Number.isFinite(value.balance) || value.balance < 0)
      throw new CaptchaError('CAPTCHA_RESPONSE', 'The CapSolver balance response is invalid.');
    return value.balance;
  }
  async solve(apiKey, task, {signal, onTask = () => {}} = {}) {
    let value = await this.request('createTask', apiKey, {task}, signal);
    if (typeof value.taskId === 'string' && value.taskId.length <= 200) onTask(value.taskId);
    for (let polls = 0; ; polls++) {
      signal?.throwIfAborted();
      if (value.status === 'ready') {
        if (!value.solution || typeof value.solution !== 'object')
          throw new CaptchaError('CAPTCHA_RESPONSE', 'The CapSolver solution response is invalid.');
        return value.solution;
      }
      if (
        polls >= 30 ||
        !['idle', 'processing', undefined].includes(value.status) ||
        typeof value.taskId !== 'string' ||
        value.taskId.length > 200
      )
        throw new CaptchaError('CAPTCHA_RESPONSE', 'Could not get the CapSolver task result.');
      await delay(this.pollMs, undefined, {signal});
      value = {
        ...(await this.request('getTaskResult', apiKey, {taskId: value.taskId}, signal)),
        taskId: value.taskId,
      };
    }
  }
}
