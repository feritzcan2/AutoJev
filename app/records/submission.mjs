// @ts-check
// The final submit click of an application is the one browser action that
// cannot be undone. The app, not the agent's prompt, enforces three rules
// around it: only an execute task may click it, a reservation must exist
// first, and it is clicked once. After the click the fresh page is classified
// with site-independent wording so the outcome is recorded from evidence.

const SUBMIT_LABEL =
  /\b(submit|send|absenden|abschicken|abgeben|senden|gönder|envoyer|enviar|invia|verzenden)\b/i;
const NOT_SUBMIT = /\b(cancel|back|previous|zurück|abbrechen|iptal|geri|search|suche|ara)\b/i;

const CONFIRMED =
  /thank you for (?:applying|your application|submitting)|application (?:has been |was )?(?:submitted|received|sent)|(?:we|we've|we have) received your application|successfully (?:submitted|applied|sent)|your application is submitted|bewerbung (?:wurde |ist )?(?:erfolgreich )?(?:gesendet|abgeschickt|eingegangen|übermittelt|abgesendet)|vielen dank für (?:ihre|deine) bewerbung|başvuru(?:nuz|n)? (?:alındı|gönderildi|iletildi|tamamlandı)|candidature (?:envoyée|a été envoyée)|solicitud enviada/i;
const FAILED =
  /error (?:submitting|sending)|submission (?:failed|error)|failed to (?:submit|send)|could not (?:be )?(?:submit|submitted|send|sent)|unable to submit|something went wrong|fehler beim (?:senden|absenden|übermitteln)|konnte nicht (?:gesendet|übermittelt) werden|gönderilemedi|bir hata oluştu|gönderim başarısız/i;
const VALIDATION =
  /\b(?:is required|required field|this field is required|please (?:fill|complete|enter|select|upload|provide)|pflichtfeld|bitte (?:ausfüllen|auswählen|eingeben)|zorunlu alan|lütfen (?:doldurun|seçin|girin))\b/i;

export function isSubmitLabel(label) {
  const text = String(label ?? '').trim();
  return Boolean(text) && SUBMIT_LABEL.test(text) && !NOT_SUBMIT.test(text);
}

// The worker snapshot text is "Page URL: …\n<page JSON>" with clickTargets.
export function clickTargetLabel(snapshot, ref) {
  const text = snapshot?.text;
  if (typeof text !== 'string' || !ref) return null;
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const page = JSON.parse(text.slice(start));
      const target = (page.clickTargets ?? []).find((t) => t?.targetId === ref);
      if (target) return target.label ?? null;
    } catch {}
  }
  const escaped = String(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    match = new RegExp(`"targetId":"${escaped}","label":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return match ? match[1] : null;
}

// The worker snapshot text is "Page URL: …\n<page JSON>"; the rendered page
// text and the field maps live inside that JSON.
function pageOf(text) {
  const raw = String(text ?? ''),
    start = raw.indexOf('{');
  if (start >= 0)
    try {
      const page = JSON.parse(raw.slice(start));
      if (page && typeof page === 'object') return page;
    } catch {}
  return null;
}
const renderedLines = (text) => {
  const page = pageOf(text),
    body = typeof page?.text === 'string' ? page.text : String(text ?? '');
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};
const fieldCount = (text) => {
  const page = pageOf(text);
  return page ? (page.fillFields?.length ?? 0) + (page.uploads?.length ?? 0) : null;
};

// Classify the page after the submit click from wording that is new since the
// click: a survey's own "please select all that apply" or a "required" marker
// that was already on the form is not the site's reaction to the click.
export function classifySubmission(text, before = '') {
  const lines = renderedLines(text),
    previous = new Set(before ? renderedLines(before) : []),
    fresh = previous.size ? lines.filter((line) => !previous.has(line)) : lines;
  const beforeFields = before ? fieldCount(before) : null,
    afterFields = fieldCount(text),
    formGone = Boolean(beforeFields && afterFields === 0);
  /** @type {[string, RegExp][]} */
  const patterns = [
    ['confirmed', CONFIRMED],
    ['error', FAILED],
    ['validation', VALIDATION],
  ];
  for (const [outcome, pattern] of patterns) {
    const line = fresh.find((candidate) => pattern.test(candidate));
    if (line) return {outcome, quote: line.slice(0, 240), formGone};
  }
  return {outcome: 'unknown', quote: null, formGone};
}

// Throws the agent-facing reason when the click must not happen.
export function assertSubmitAllowed(run, label) {
  const name = JSON.stringify(String(label ?? '').slice(0, 80));
  if (run.recordOperation !== 'execute')
    throw Error(
      `${name} may be a submit button. Only an application (execute) task may submit; do not click it in this task.`,
    );
  if (!run.actionId)
    throw Error(
      `${name} may be a submit button. Call reserve_automation_action first, then click this button once.`,
    );
  const previous = run.submission;
  if (previous && previous.outcome !== 'validation')
    throw Error(
      `Submission was already attempted (outcome: ${previous.outcome}). Do not click again. Read the page and record it with record_automation_outcome: completed if a confirmation is visible, otherwise uncertain.`,
    );
}

// Attached to the submit result when the page text alone did not confirm the
// submission: the visible page as the user would see it.
export const SUBMIT_SCREENSHOT_NOTE =
  'The attached image shows the visible page right after the click. Judge it together with the text: a visible confirmation message means the application went through; a visible field error means that field needs a fix. Evidence quotes come from the page text (browser_search), not from the image. If the image and the text disagree, record uncertain. Never click submit again.';

export function submissionGuidance(submission) {
  if (submission.verification)
    return 'A verification challenge (CAPTCHA) appeared after the click. Do not solve it, do not click submit again. Call record_automation_outcome with status=uncertain, then finish_automation_run with status=blocked; the app asks the user to solve it in the open tab and to report the outcome.';
  switch (submission.outcome) {
    case 'confirmed':
      return 'The page shows a confirmation. Call record_automation_outcome with status=completed and this quote as evidence.';
    case 'error':
      return 'The site reported a submission error. Do not click submit again. Call record_automation_outcome with status=uncertain and this quote as evidence; the app asks the user for the real outcome.';
    case 'validation':
      return 'The form reports a missing or invalid field. Fix only that field, then click submit once more.';
    default:
      return submission.formGone
        ? 'The form disappeared after the click and no error text appeared, which usually means the site accepted the submission. Read the page (browser_read, then browser_search for words like thank, received, submitted, bewerbung) for the confirmation; record completed with that quote, otherwise uncertain and say that the form closed without an error. Never click submit again.'
        : 'No confirmation or error text was found. Call browser_read with waitSeconds up to 15 (at most 4 times) for a late confirmation; then record completed only with visible confirmation, otherwise uncertain. Never click submit again.';
  }
}
