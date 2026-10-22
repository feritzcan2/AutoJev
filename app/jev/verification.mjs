// @ts-check
import {scanVerificationCheckboxes} from './verification-checkbox.mjs';
import {detectCaptcha, captchaEvidence} from '../captcha/detection.mjs';
// A verification checkbox on a page with other fillable fields belongs to that
// form. It is the form's last step before submit, not a gate before filling.
const hasFormFields = (page) =>
  page
    .evaluate(() =>
      [...document.querySelectorAll('input:not([type="hidden"]),textarea,select')].some(
        (e) =>
          !/^(?:submit|button|reset|image)$/i.test(e.getAttribute('type') ?? '') &&
          !/(?:g-recaptcha|h-captcha|cf-turnstile)-response/.test(e.getAttribute('name') ?? '') &&
          e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}),
      ),
    )
    .catch(() => false);
const formFirst = async (page, slot, evidence) =>
  !slot?.verificationCheckboxAttempt && (await hasFormFields(page))
    ? {...evidence, formFirst: true}
    : evidence;
// Evidence-only detection. Never treats a CAPTCHA widget's mere presence as a
// challenge, never retries Submit, and never solves/bypasses site verification.
export async function verificationEvidence(page, slot) {
  if (slot) {
    const detection = await detectCaptcha(page);
    slot.captchaDetection = detection;
    if (detection.state === 'active')
      slot.captchaDocument = {id: detection.documentId, url: detection.pageUrl};
    if (
      detection.state === 'cleared' ||
      (detection.documentId &&
        slot.captchaDocument &&
        (slot.captchaDocument.id !== detection.documentId ||
          slot.captchaDocument.url !== detection.pageUrl))
    )
      delete slot.captchaDocument;
    // A widget that vanished from a form usually passed in the background. The
    // rest of the form is still filled; the site's response to submit decides.
    if (detection.state === 'none' && slot.captchaDocument)
      return formFirst(page, slot, {
        state: 'checking',
        capability: 'pending',
        evidence:
          'The earlier CAPTCHA is no longer visible; the verification result is not proven yet. Check the current tab.',
      });
    if (
      detection.state === 'active' &&
      detection.target.provider === 'turnstile' &&
      !slot.verificationCheckboxAttempt
    )
      return formFirst(page, slot, {
        state: 'required',
        capability: 'supported',
        checkbox: true,
        evidence:
          'A visible verification checkbox inside Turnstile. Verify with a single click first.',
      });
    const evidence = captchaEvidence(detection);
    if (evidence) return evidence;
    if (
      detection.state === 'none' &&
      slot.verification &&
      (await page.evaluate(() => document.readyState !== 'complete'))
    )
      return {
        state: 'checking',
        capability: 'pending',
        evidence: 'The earlier verification could not be read again yet; the page is loading.',
      };
  }
  const evidence = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const error = text.match(
      /There was an error verifying your application[^\n]*|(?:captcha|human verification) (?:failed|error|expired)[^\n]*/i,
    )?.[0];
    const challenge = text.match(
      /verify (?:that )?you(?:'re| are) (?:a )?human|complete (?:the |this )?captcha|(?:drag|slide) [^\n]{0,120}(?:puzzle|piece|image|shape|verify|complete)/i,
    )?.[0];
    const frame = [...document.querySelectorAll('iframe')].find((e) => {
      const r = e.getBoundingClientRect();
      return (
        e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
        r.width > 40 &&
        r.height > 40 &&
        r.bottom > 0 &&
        r.top < innerHeight &&
        /(?:captcha|verification).*challenge|challenge.*(?:captcha|verification)/i.test(
          e.title + ' ' + e.getAttribute('aria-label'),
        )
      );
    });
    if (!error && !challenge && !frame) return null;
    return {
      evidence: (error || challenge || frame.title || frame.getAttribute('aria-label')).slice(
        0,
        800,
      ),
      state: challenge || frame ? 'required' : 'verification_error',
      capability:
        frame || /drag|slide/i.test(challenge ?? '')
          ? 'not_exposed'
          : challenge
            ? 'supported'
            : 'unknown',
      limitation: frame
        ? 'Jev cannot interact with controls inside this verification iframe.'
        : /drag|slide/i.test(challenge ?? '')
          ? 'Jev has no drag/slider action.'
          : null,
    };
  });
  const boxes = await scanVerificationCheckboxes(page);
  try {
    if (evidence?.capability === 'not_exposed' || evidence?.state === 'verification_error')
      return evidence;
    if (boxes.some((b) => !b.meta.checked))
      return await formFirst(page, slot, {
        state: 'required',
        capability: 'supported',
        evidence: 'Visible unchecked verification checkbox',
        checkbox: true,
        limitation:
          'Only the visible checkbox is supported, subject to the executing provider confirmation policy. Image/audio challenges remain manual.',
      });
    if (boxes.length && boxes.every((b) => b.meta.checked))
      return {
        state: 'cleared',
        capability: 'supported',
        evidence:
          'Verification checkbox is checked; validate the next site response. Stale inline error alone is not a new challenge.',
      };
    return evidence;
  } finally {
    await Promise.all(boxes.map((b) => b.handle.dispose().catch(() => {})));
  }
}
export function updateVerification(slot, evidence, now = Date.now()) {
  if (!evidence || evidence.state === 'cleared') {
    delete slot.verification;
    return evidence ?? null;
  }
  // The attempt budget belongs to one page. A widget seen on an earlier page in
  // this tab must not hand a later page off as blocked.
  const url = slot.page?.url?.() ?? null,
    old = slot.verification && (slot.verification.url ?? null) === url ? slot.verification : null;
  const state = {
    ...evidence,
    url,
    startedAt: old?.startedAt ?? now,
    attempts: old?.attempts ?? 0,
    screenshots: old?.screenshots ?? 0,
  };
  if (state.state === 'answer_applied') {
    state.handoff = false;
    state.message = state.evidence;
    slot.verification = state;
    return state;
  }
  if (state.formFirst) {
    // No attempt budget or deadline while the rest of the form is being filled.
    state.handoff = false;
    state.nextAction = 'fill_form_first';
    state.message = state.checkbox
      ? 'This verification checkbox belongs to the form. Fill and check every other field first; do not ask the user about the verification yet. Click the checkbox once only as the last step before submit.'
      : 'The form verification widget is no longer visible. Keep filling the form; do not ask the user about the verification. Submit once when the form is complete and read the site response.';
    slot.verification = state;
    return state;
  }
  state.deadlineAt = state.startedAt + 60000;
  state.handoff =
    state.capability === 'not_exposed' ||
    (state.checkbox && !!slot.verificationCheckboxAttempt) ||
    state.attempts >= 2 ||
    now >= state.deadlineAt;
  if (state.capability === 'pending' && !state.handoff) {
    state.nextAction = 'wait_for_verification';
    state.message =
      'The verification is loading; do not assume it is solved or that there is no CAPTCHA. Observe the current tab again.';
    slot.verification = state;
    return state;
  }
  state.nextAction = state.handoff
    ? 'ask_candidate_once'
    : state.state === 'verification_error'
      ? 'inspect_one_screenshot'
      : 'try_supported_visible_control';
  state.message =
    state.state === 'verification_error' && state.handoff
      ? 'Verification error remains, but that alone does not prove a CAPTCHA is required. Stop browser retries and never resubmit. If a fresh screenshot confirms a remaining challenge, ask one technical question; otherwise keep uncertain and report the observed technical blocker without inventing a CAPTCHA.'
      : state.handoff
        ? 'Do not request another Jev decision or repeat the submission. Ask only for the observed remaining verification step. ask_candidate with recovery.kind=captcha saves the question, preserves uncertain submission state and reports the task in one call; then end the turn.'
        : 'At most two supported visible verification attempts within 60 seconds. A visible verification checkbox target may be clicked once when the executing provider permits it (obtain at-action confirmation when required). Image/audio/drag challenges are unavailable. One screenshot only if needed; do not inspect/refill the whole form or repeat Submit.';
  slot.verification = state;
  return state;
}
export function verificationHandoff(slot) {
  return {
    browser: 'Jev Chrome',
    tabId: slot.id,
    url: slot.page.url(),
    status: 'verification_handoff',
    executed: false,
    verification: slot.verification,
    nextAction: 'ask_candidate_once',
    message: slot.verification.message,
  };
}
