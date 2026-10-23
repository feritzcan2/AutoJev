// @ts-check
// Why a record task stopped, in a few words the record card shows. The full
// story stays in the run summary behind "Details".
export const BLOCKER_CATEGORIES = [
  'not_eligible',
  'needs_answer',
  'needs_login',
  'needs_code',
  'needs_payment',
  'verification',
  'listing_closed',
  'email_only',
  'site_problem',
  'technical',
];
export const BLOCKER_REASON_MAX = 160;
export const BLOCKER_ACTION_MAX = 100;

export const blockerSchema = {
  type: 'object',
  description:
    'Required when status is blocked or failed. The record card shows only this; summary holds the full details.',
  properties: {
    category: {
      type: 'string',
      enum: BLOCKER_CATEGORIES,
      description:
        'not_eligible: the listing or form excludes the user (location, work authorization, criteria). needs_answer: a fact only the user knows. needs_login: sign-in or account. needs_code: the site sent a security/verification code to the user’s email or phone and waits for it, before or after the submit click. needs_payment: a paid step. verification: a CAPTCHA the user must solve. listing_closed: removed or no longer accepting applications. email_only: the employer takes applications only by email, with no form to fill. site_problem: the site itself errors or does not load. technical: a browser tool or form control did not work.',
    },
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: BLOCKER_REASON_MAX,
      description:
        'One plain sentence: what stopped the task. No IDs, tab numbers or step history. Example: "The form requires US work authorization; the listing said worldwide."',
    },
    userAction: {
      type: 'string',
      minLength: 1,
      maxLength: BLOCKER_ACTION_MAX,
      description:
        'What the user should do next, as a short imperative. Example: "Skip this record", "Log in on the open tab, then retry".',
    },
  },
  required: ['category', 'reason', 'userAction'],
  additionalProperties: false,
};

// A record task that stops must say why in the card's terms; a completed one
// clears an earlier reason.
export function recordBlocker(status, blocker) {
  if (!['blocked', 'failed'].includes(status)) return null;
  const missing =
    'Add blocker {category, reason, userAction} when a record task is blocked or failed: a category, one short sentence why, and the next step for the user. Keep the full details in summary.';
  if (!blocker || typeof blocker !== 'object') throw Error(missing);
  const clean = (value) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  const category = clean(blocker.category),
    reason = clean(blocker.reason),
    userAction = clean(blocker.userAction);
  if (!BLOCKER_CATEGORIES.includes(category))
    throw Error(`blocker.category must be one of: ${BLOCKER_CATEGORIES.join(', ')}.`);
  if (!reason || !userAction) throw Error(missing);
  if (reason.length > BLOCKER_REASON_MAX || userAction.length > BLOCKER_ACTION_MAX)
    throw Error(
      `Shorten blocker: reason at most ${BLOCKER_REASON_MAX} and userAction at most ${BLOCKER_ACTION_MAX} characters. Put details in summary.`,
    );
  return {category, reason, userAction};
}
