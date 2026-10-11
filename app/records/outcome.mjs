// @ts-check
import {browserRenderedText} from '../browser/rendered-text.mjs';
const normalize = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// Negative evidence must be an explicit site status for this exact record.
// An unfinished form or absence of a success message cannot release a hold.
export function validateNotSubmitted(item, proof, page) {
  if (!page || page.readiness?.loading)
    throw Error('A current, loaded page is required to verify it was not submitted');
  if (
    ![item.url, item.actionUrl]
      .filter(Boolean)
      .some((url) => new URL(url).origin === new URL(page.url).origin)
  )
    throw Error('Evidence of non-submission must come from the record or action site');
  const identity = normalize(proof?.recordEvidence),
    text = normalize(browserRenderedText(page));
  if (identity.length < 6 || !text.includes(identity))
    throw Error('The assigned record must be on the current page');
  if (
    ![item.url, item.actionUrl, item.title, item.key].some((value) =>
      normalize(value).includes(identity),
    )
  )
    throw Error('The evidence of non-submission does not match the assigned record');
  const pattern =
    proof?.kind === 'draft'
      ? /\b(draft|not submitted|unsubmitted|entwurf|nicht (?:abgesendet|eingereicht)|taslak|gönderilmedi)\b/
      : proof?.kind === 'rejected'
        ? /\b(submission (?:failed|error)|error (?:submitting|sending)|failed to (?:submit|send)|not sent|was not submitted|could not (?:be )?(?:send|sent|submit|submitted)|unable to submit|fehler beim (?:senden|absenden|übermitteln)|konnte nicht (?:gesendet|übermittelt) werden|gönderilemedi|gönderim başarısız)\b/
        : null;
  const status = pattern?.exec(text)?.[0];
  if (!status)
    throw Error(
      'An explicit draft/not-submitted state is required; a missing CV or the absence of a success message is not enough',
    );
  return {
    kind: proof.kind,
    quote: typeof proof.quote === 'string' ? proof.quote.slice(0, 1000) : status,
    recordEvidence: proof.recordEvidence,
    url: page.url,
  };
}
