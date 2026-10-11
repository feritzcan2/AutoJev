import {captchaHash, detectCaptcha, gridSelector} from './detection.mjs';
import {CaptchaError} from './capsolver-client.mjs';
import {turnstileBridge} from './turnstile-registration.mjs';

const stale = () =>
  new CaptchaError('CAPTCHA_STALE', 'The verification changed; the old solution was not applied.');
export async function captureCaptcha(page, target) {
  if (target.provider === 'image') {
    const image = await target.frame
      .locator('img')
      .nth(target.imageIndex)
      .screenshot({type: 'png', timeout: 2500});
    return {
      kind: 'image',
      task: {type: 'ImageToTextTask', body: image.toString('base64')},
      imageHash: captchaHash(image.toString('base64')),
    };
  }
  if (target.provider === 'recaptcha' && target.grid && target.questionId) {
    const image = await target.frame.locator(gridSelector).screenshot({type: 'png', timeout: 2500});
    return {
      kind: 'grid',
      task: {
        type: 'ReCaptchaV2Classification',
        image: image.toString('base64'),
        question: target.questionId,
      },
      imageHash: captchaHash(image.toString('base64')),
    };
  }
  if (!target.sitekey || target.enterprise)
    throw new CaptchaError(
      'CAPTCHA_UNSUPPORTED',
      'There is not enough information to solve this CAPTCHA.',
    );
  if (target.managed)
    throw new CaptchaError(
      'CAPTCHA_UNSUPPORTED',
      'Cloudflare Challenge data cannot be sent to the Turnstile token API.',
    );
  if (target.fullPage && !target.callback)
    throw new CaptchaError(
      'CAPTCHA_UNSUPPORTED',
      'Could not read the callback that passes the verification result to the site.',
    );
  if (!target.fullPage && target.tokenCount !== 1)
    throw new CaptchaError(
      'CAPTCHA_UNSUPPORTED',
      'Could not verify a single CAPTCHA answer field.',
    );
  if (target.provider === 'turnstile')
    return {
      kind: target.fullPage ? 'turnstile_callback' : 'token',
      task: {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL: page.url(),
        websiteKey: target.sitekey,
        ...(target.action || target.cdata
          ? {
              metadata: {
                ...(target.action ? {action: target.action} : {}),
                ...(target.cdata ? {cdata: target.cdata} : {}),
              },
            }
          : {}),
      },
    };
  if (target.provider === 'recaptcha')
    return {
      kind: 'token',
      task: {
        type: 'ReCaptchaV2TaskProxyLess',
        websiteURL: page.url(),
        websiteKey: target.sitekey,
        isInvisible: !!target.invisible,
        ...(target.dataS ? {recaptchaDataSValue: target.dataS} : {}),
      },
    };
  throw new CaptchaError(
    'CAPTCHA_UNSUPPORTED',
    'This CAPTCHA type is outside the scope of automatic solving.',
  );
}

// Called only in the workspace queue, with ownership/authority revalidated by
// the coordinator. Callback delivery is limited to a verified full-page widget
// in a read-only source tab; ordinary forms retain their submission checkpoint.
export async function applyCaptcha(
  page,
  target,
  capture,
  solution,
  {check = () => {}, allowBarrierCallback = false, beforeCallback = () => {}} = {},
) {
  const fresh = await detectCaptcha(page),
    current = fresh.target;
  check();
  if (fresh.state === 'cleared') return {state: 'cleared'};
  if (
    fresh.state !== 'active' ||
    !current ||
    current.identity !== target.identity ||
    current.round !== target.round
  )
    throw stale();
  if (capture.kind === 'grid') {
    if (
      solution.type !== 'multi' ||
      solution.size !== Math.sqrt(target.count) ||
      !Array.isArray(solution.objects) ||
      solution.objects.some((i) => !Number.isInteger(i) || i < 0 || i >= target.count) ||
      new Set(solution.objects).size !== solution.objects.length
    )
      throw new CaptchaError(
        'CAPTCHA_RESPONSE',
        'The CapSolver image selection response is invalid.',
      );
    const table = current.frame.locator(gridSelector),
      image = await table.screenshot({type: 'png', timeout: 2500});
    if (captchaHash(image.toString('base64')) !== capture.imageHash) throw stale();
    check();
    const selected = new Set(current.selected),
      desired = new Set(solution.objects);
    for (let i = 0; i < target.count; i++)
      if (selected.has(i) !== desired.has(i)) {
        const cell = table.locator('td').nth(i);
        if ((await cell.locator('img').evaluate((e) => e.currentSrc)) !== target.images[i])
          throw stale();
        check();
        await cell.click({timeout: 2000});
      }
    // Verification belongs to the provider's own frame. It may run the site's
    // completion callback, so the coordinator requires submission authority.
    return {state: 'grid_selected', selected: solution.objects.length};
  }
  if (capture.kind === 'image') {
    if (typeof solution.text !== 'string' || !solution.text.trim() || solution.text.length > 100)
      throw new CaptchaError('CAPTCHA_RESPONSE', 'The CapSolver text response is invalid.');
    const image = await current.frame
      .locator('img')
      .nth(current.imageIndex)
      .screenshot({type: 'png', timeout: 2500});
    if (captchaHash(image.toString('base64')) !== capture.imageHash) throw stale();
    if (await current.frame.locator('input').nth(current.inputIndex).inputValue()) throw stale();
    check();
    await current.frame
      .locator('input')
      .nth(current.inputIndex)
      .fill(solution.text, {timeout: 2000});
    return {
      state: 'answer_applied',
      message:
        'The CAPTCHA answer was typed; the form was not submitted. Verify the site result in the normal task flow.',
    };
  }
  const token = solution.gRecaptchaResponse ?? solution.token;
  if (typeof token !== 'string' || token.length < 20 || token.length > 20000)
    throw new CaptchaError('CAPTCHA_RESPONSE', 'The CapSolver token response is invalid.');
  check();
  if (capture.kind === 'turnstile_callback') {
    if (
      !allowBarrierCallback ||
      !current.fullPage ||
      current.requiresSubmissionPermission ||
      !current.callback ||
      current.managed
    )
      throw new CaptchaError(
        'CAPTCHA_AUTHORITY',
        'The callback may only run during an access check of a verified reading tab.',
      );
    beforeCallback();
    const delivered = await current.parent.evaluate(
      ({key, id, token}) => globalThis[key]?.deliver(id, token) === true,
      {key: turnstileBridge, id: current.registration, token},
    );
    if (!delivered) throw stale();
    return {
      state: 'answer_applied',
      callbackInvoked: true,
      message: 'The solution was passed to the site verification; waiting for access to open.',
    };
  }
  const applied = await current.parent.evaluate(
    ({provider, token}) => {
      const fields = [
        ...document.querySelectorAll(
          provider === 'turnstile'
            ? 'input[name="cf-turnstile-response"]'
            : '[name="g-recaptcha-response"]',
        ),
      ];
      if (fields.length !== 1 || fields[0].value) return false;
      fields[0].value = token;
      return true;
    },
    {provider: current.provider, token},
  );
  if (!applied) throw stale();
  return {
    state: 'answer_applied',
    message:
      'The CAPTCHA answer was placed; the site has not confirmed acceptance yet. If you are authorized to submit, continue in the normal flow; do not repeat the earlier submission.',
  };
}

export async function verifyCaptchaGrid(page, target, {check = () => {}} = {}) {
  const current = await detectCaptcha(page);
  check();
  if (current.state === 'cleared') return 'cleared';
  if (current.state === 'checking' || current.state === 'unknown') return 'checking';
  if (current.state !== 'active' || current.target?.identity !== target.identity) throw stale();
  if (current.target.dynamic || current.target.images.some((url, i) => url !== target.images[i]))
    return 'changed';
  const button = current.target.frame.locator('#recaptcha-verify-button');
  if ((await button.count()) !== 1 || !(await button.isVisible()) || !(await button.isEnabled()))
    throw new CaptchaError('CAPTCHA_UNSUPPORTED', 'The CAPTCHA verify button is not ready.');
  check();
  await button.click({timeout: 2000});
  return 'checking';
}
