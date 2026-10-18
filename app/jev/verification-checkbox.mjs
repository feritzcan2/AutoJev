import {observedId} from './ids.mjs';
import {captchaProvider} from '../captcha/detection.mjs';
import {humanClick} from '../captcha/human-click.mjs';
const anchor =
  /https:\/\/(?:www\.)?(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/anchor(?:\?|$)|https:\/\/[^/]*hcaptcha\.com\/.*(?:checkbox|frame=checkbox)/i;
export async function scanVerificationCheckboxes(page) {
  const found = [];
  found.diagnostics = [];
  for (const frame of page.frames()) {
    if (!anchor.test(frame.url()) && captchaProvider(frame.url())?.provider !== 'turnstile')
      continue;
    let host,
      stage = 'frame_host';
    try {
      host = await frame.frameElement();
      stage = 'frame_visibility';
      if (
        !(await host.evaluate(
          (e) =>
            e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
            !e.closest('[inert],[aria-hidden="true"]'),
        ))
      ) {
        found.diagnostics.push({stage, result: 'hidden'});
        continue;
      }
      stage = 'checkbox_lookup';
      const handles = await frame
        .locator('[role="checkbox"],input[type="checkbox"]')
        .elementHandles();
      if (!handles.length) found.diagnostics.push({stage, result: 'empty'});
      for (const handle of handles) {
        let retained = false;
        try {
          stage = 'checkbox_visibility';
          const meta = await handle.evaluate((e) =>
            e.isConnected && e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
              ? {
                  label: (
                    e.getAttribute('aria-label') ||
                    (e.getAttribute('aria-labelledby') || '')
                      .split(/\s+/)
                      .map((id) => e.getRootNode().getElementById?.(id)?.textContent || '')
                      .join(' ') ||
                    e.textContent ||
                    'Verification checkbox'
                  ).trim(),
                  checked: e.getAttribute('aria-checked') === 'true' || e.checked === true,
                  origin: performance.timeOrigin,
                }
              : null,
          );
          if (meta) {
            found.push({frame, handle, meta});
            retained = true;
          } else found.diagnostics.push({stage, result: 'hidden'});
        } finally {
          if (!retained) await handle.dispose().catch(() => {});
        }
      }
    } catch {
      found.diagnostics.push({stage, result: 'unavailable'});
    } finally {
      await host?.dispose().catch(() => {});
    }
  }
  if (!found.length && !found.diagnostics.length) {
    // Distinguish an absent widget from a visible host missing from Playwright's frame tree.
    const visibleHosts = await page
      .locator('iframe')
      .evaluateAll(
        (es) =>
          es.filter(
            (e) =>
              /recaptcha|hcaptcha/i.test(e.title + ' ' + e.getAttribute('src')) &&
              e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
              e.getBoundingClientRect().width > 1 &&
              e.getBoundingClientRect().height > 1,
          ).length,
      )
      .catch(() => 0);
    if (visibleHosts)
      found.diagnostics.push({stage: 'frame_discovery', result: 'no_matching_frame', visibleHosts});
  }
  return found;
}
export async function captureVerificationTargets(slot) {
  await Promise.all(
    [...(slot.verificationTargets?.values() ?? [])].map((t) => t.handle.dispose().catch(() => {})),
  );
  slot.verificationTargets = new Map();
  const targets = [];
  const scan = await scanVerificationCheckboxes(slot.page);
  slot.verificationDiagnostics = scan.diagnostics;
  for (const t of scan) {
    if (t.meta.checked) {
      await t.handle.dispose();
      continue;
    }
    const targetId = observedId('verify');
    slot.verificationTargets.set(targetId, {...t, owner: slot.owner, url: slot.page.url()});
    targets.push({
      targetId,
      label: t.meta.label,
      role: 'checkbox',
      checked: 'false',
      context: 'Verification checkbox — follow executing provider confirmation policy',
      verification: true,
    });
  }
  return targets;
}
export async function clickVerificationCheckbox(slot, targetId, owner) {
  const t = slot.verificationTargets?.get(targetId);
  if (!t) return null;
  if (t.owner !== owner) throw Error('A current verification target is required.');
  slot.verificationTargets.delete(targetId);
  try {
    if (slot.verificationCheckboxAttempt === t.frame.url())
      return {
        status: 'verification_handoff',
        executed: false,
        message:
          'This verification checkbox was already tried once. Do not repeat it; wait for the current challenge or for the user to verify.',
      };
    if (
      t.url !== slot.page.url() ||
      (!anchor.test(t.frame.url()) && captchaProvider(t.frame.url())?.provider !== 'turnstile') ||
      !(await t.handle.evaluate(
        (e, origin) => e.isConnected && performance.timeOrigin === origin,
        t.meta.origin,
      ))
    )
      return {status: 'stale', executed: false};
    const checked = await t.handle.evaluate(
      (e) => e.getAttribute('aria-checked') === 'true' || e.checked === true,
    );
    if (checked) return {status: 'ready', executed: false, verificationChecked: true};
    slot.verificationCheckboxAttempt = t.frame.url();
    // Same pointer path a person takes: move in, hover, press, release. The
    // centre must still hit the checkbox itself, or nothing is clicked.
    await t.handle.scrollIntoViewIfNeeded({timeout: 2500});
    const box = await t.handle.boundingBox();
    if (
      !box ||
      !(await t.handle.evaluate((e) => {
        const r = e.getBoundingClientRect(),
          hit = e.getRootNode().elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === e || e.contains(hit);
      }))
    )
      throw Error('The verification checkbox is not clickable.');
    await humanClick(slot.page, box.x + box.width / 2, box.y + box.height / 2);
    return {
      status: 'checking',
      executed: true,
      message:
        'The visible verification checkbox was clicked once. Do not solve an image/audio challenge or click again; check the returned verification state. This does not mean the application was submitted.',
    };
  } catch {
    return {
      status: 'verification_handoff',
      executed: 'unknown',
      message: 'Could not verify the verification checkbox click; do not retry.',
    };
  } finally {
    await t.handle.dispose().catch(() => {});
  }
}
