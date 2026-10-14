import {setTimeout as delay} from 'node:timers/promises';
import {CaptchaError} from './capsolver-client.mjs';

// The coordinator never holds a browser queue lock during HTTP or waiting.
// capture/apply/observe are provided by the caller and recheck ownership inside
// the short queued section. There is one lease per tab, even across workers.
export class CaptchaCoordinator {
  constructor(settings, {timeoutMs = 90000, settleMs = 350, maxRounds = 4} = {}) {
    Object.assign(this, {settings, timeoutMs, settleMs, maxRounds});
    this.pending = new WeakMap();
    this.attempted = new WeakMap();
    this.budgets = new WeakMap();
  }
  wait(slot) {
    return this.pending.get(slot)?.promise;
  }
  async run(slot, context) {
    const existing = this.pending.get(slot);
    if (existing) {
      if (existing.owner !== context.owner)
        throw Error('The verification belongs to another task.');
      return existing.promise;
    }
    if (!this.settings.status().enabled) return null;
    const lease = {owner: context.owner};
    this.pending.set(slot, lease);
    lease.promise = this.solve(slot, context).finally(() => {
      if (this.pending.get(slot) === lease) this.pending.delete(slot);
    });
    return lease.promise;
  }
  async solve(
    slot,
    {
      owner,
      signal,
      observe,
      capture,
      apply,
      verify,
      allowed = () => true,
      active = () => true,
      changed = () => {},
    },
  ) {
    const revision = this.settings.revision,
      timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new CaptchaError('CAPTCHA_TIMEOUT', 'The CAPTCHA solving time ran out.')),
      this.timeoutMs,
    );
    const abort = AbortSignal.any([
      timeout.signal,
      this.settings.changes.signal,
      ...(signal ? [signal] : []),
    ]);
    const check = () => {
      abort.throwIfAborted();
      if (!active() || this.settings.revision !== revision)
        throw new CaptchaError(
          'CAPTCHA_CANCELLED',
          'The verification task stopped or the tab changed.',
        );
    };
    const status = (state, message) => {
      slot.captchaProgress = {state, message};
      changed();
    };
    let last, attempt;
    try {
      check();
      last = await observe();
      // Unknown frames get bounded re-observation. No paid task or page reload.
      for (let n = 0; ['unknown', 'checking'].includes(last.state) && n < 10; n++) {
        status('checking', 'Loading the verification area…');
        await delay(this.settleMs, undefined, {signal: abort});
        check();
        last = await observe();
      }
      if (last.state !== 'active') return null;
      const first = last.target;
      await delay(this.settleMs, undefined, {signal: abort});
      check();
      last = await observe();
      if (
        last.state !== 'active' ||
        last.target.identity !== first.identity ||
        last.target.round !== first.round
      )
        return null;
      if (!allowed(last.target))
        throw new CaptchaError(
          'CAPTCHA_AUTHORITY',
          'This verification may submit a form. The task needs submit authorization and a recorded action step.',
        );
      const key = JSON.stringify([owner, revision, last.target.identity]),
        previous = this.attempted.get(slot);
      if (previous?.key === key) return previous.result;
      attempt = {
        key,
        result: {
          state: 'handoff',
          message: 'Automatic solving was already tried for this verification.',
        },
      };
      this.attempted.set(slot, attempt);
      const budgetKey = JSON.stringify([owner, revision, last.documentId]);
      let budget = this.budgets.get(slot);
      if (budget?.key !== budgetKey) {
        budget = {key: budgetKey, requests: 0};
        this.budgets.set(slot, budget);
      }
      const rounds = new Set();
      for (let round = 0; round < this.maxRounds; round++) {
        check();
        if (!allowed(last.target))
          throw new CaptchaError(
            'CAPTCHA_AUTHORITY',
            'The action authorization for the verification changed.',
          );
        const target = last.target;
        if (rounds.has(target.round))
          throw new CaptchaError(
            'CAPTCHA_NO_PROGRESS',
            'The CAPTCHA did not change; no new paid request was sent for the same image.',
          );
        rounds.add(target.round);
        const captured = await capture(target);
        check();
        if (budget.requests >= this.maxRounds)
          throw new CaptchaError(
            'CAPTCHA_ROUNDS',
            'The CAPTCHA request limit for this task and page was reached.',
          );
        const apiKey = this.settings.reserve();
        budget.requests++;
        status('solving', 'Solving the CAPTCHA…');
        const solution = await this.settings.client.solve(apiKey, captured.task, {signal: abort});
        check();
        if (!allowed(target))
          throw new CaptchaError(
            'CAPTCHA_AUTHORITY',
            'The action authorization for the verification changed.',
          );
        const applied = await apply(target, captured, solution, check);
        check();
        if (applied.state === 'cleared') {
          attempt.result = applied;
          return applied;
        }
        if (applied.state === 'answer_applied') {
          attempt.result = {...applied, identity: target.identity};
          return attempt.result;
        }
        status('checking', 'Checking the CAPTCHA result…');
        await delay(this.settleMs, undefined, {signal: abort});
        check();
        await verify(target, check); // A provider Verify click may invoke a site callback.
        for (let n = 0; n < 12; n++) {
          await delay(this.settleMs, undefined, {signal: abort});
          check();
          last = await observe();
          if (last.state === 'cleared') {
            attempt.result = {
              state: 'cleared',
              message:
                'The verification check completed. The task result still needs a separate check.',
            };
            return attempt.result;
          }
          if (last.state === 'active' && last.target.round !== target.round && !last.target.dynamic)
            break;
          // Absence alone, especially during a redirect, is not a success claim.
          if (last.state === 'none') break;
        }
        if (last.state !== 'active' || last.target.identity !== first.identity)
          throw new CaptchaError(
            'CAPTCHA_UNCERTAIN',
            'The site result after verification could not be verified yet; check the current tab.',
          );
      }
      throw new CaptchaError('CAPTCHA_ROUNDS', 'The CAPTCHA image round limit was reached.');
    } catch (error) {
      const result = {
        state: 'handoff',
        message:
          signal?.aborted || !active()
            ? 'The verification task was stopped.'
            : this.settings.revision !== revision
              ? 'The CAPTCHA setting changed; solving was stopped.'
              : timeout.signal.aborted
                ? 'The CAPTCHA solving time ran out.'
                : error instanceof CaptchaError
                  ? error.message
                  : 'The CAPTCHA could not be completed reliably. Check the current tab.',
      };
      if (attempt) attempt.result = result;
      return result;
    } finally {
      clearTimeout(timer);
      delete slot.captchaProgress;
      changed();
    }
  }
}
