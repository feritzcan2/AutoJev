// @ts-check
// A sign-in link is not an authentication barrier. Check rendered content,
// excluding hidden controls and URLs, before asking the user to log in.
import {browserRenderedText} from '../browser/rendered-text.mjs';
export const LOGGED_IN_FIELD = {
  id: 'loggedIn',
  type: 'boolean',
  label: 'Have you signed in on the open tab?',
  required: true,
  help: 'Send Yes after signing in. Do not share passwords or verification codes.',
};
// Matches a request to log in, not a statement that the user is logged in
// ("giriş yapmış", "oturum açık"). The Turkish and German alternatives match
// questions stored by earlier versions and text on third-party pages.
export function asksForLogin(question) {
  if (question.accessCheck?.kind === 'login') return true;
  const text = [
    question.text ?? question.question,
    ...(question.fields ?? []).flatMap((f) => [f.label, f.help]),
  ]
    .filter(Boolean)
    .join(' ');
  return /giriş\s+yap(?:ın|manız|malı|ılmalı|tınız|ması|abilir)|oturum\s+aç(?:ın|manız|malı|ılmalı|tınız|ması|abilir)|oturum(?:u|unuz|unuzu|unuzun)?\s+(?:yok|olma|gerek)|hesab(?:ınıza|ına)\s+gir|\blog\s*in\b|\bsign\s*in\b|\banmeld(?:en|ung)\b/iu.test(
    text,
  );
}
function credentialField(page, text) {
  let value;
  try {
    value = JSON.parse(page.text.replace(/^Page URL: [^\n]+\n/, ''));
  } catch {}
  const password = /(?:\bpassword\b|\bpasswort\b|parola|şifre)/iu,
    code = /(?:verification code|one[- ]time (?:code|password)|doğrulama kodu)/iu;
  const visible = (field) => field.visible !== false;
  // Email also appears in public forms and newsletters. Prefer actual input
  // metadata when available, so prose and hidden controls cannot imply login.
  const hasPassword = Array.isArray(value?.passwordFields)
    ? value.passwordFields.some(visible)
    : Array.isArray(value?.controls)
      ? value.controls.some(
          (c) => visible(c) && c.role === 'textbox' && password.test(c.label ?? ''),
        )
      : password.test(text);
  const hasCode = Array.isArray(value?.controls)
    ? value.controls.some((c) => visible(c) && c.role === 'textbox' && code.test(c.label ?? ''))
    : code.test(text);
  return hasPassword || hasCode;
}
export function validateLoginQuestion(page, proof) {
  if (page.readiness?.loading)
    throw Error(
      'The page is still loading. Do not assume a login barrier; check the current page with browser_read.',
    );
  if (!proof || proof.snapshotId !== page.id)
    throw Error(
      'A login question requires an accessCheck with the latest snapshot.id. A /signup link or an earlier report is not evidence.',
    );
  const text = browserRenderedText(page)
    .replace(/^.*\blink\s+"[^\n]*$/gm, '')
    .replace(/^Link:.*$/gm, '')
    .replace(/https?:\/\/\S+/g, '');
  const quote =
    typeof proof.evidence === 'string'
      ? proof.evidence.trim().slice(0, 600)
      : 'The current page requires sign-in.';
  const field = credentialField(page, text);
  // Word boundaries: "designing" is not "sign in".
  const form =
    /\b(?:log\s*in|sign\s*in|sign\s*up)\b|create (?:a |your )?(?:new )?account|\banmeld|giriş yap|oturum aç|hesap oluştur/iu.test(
      text,
    );
  const gate =
    /(?:must|need to|please|required to)\s+(?:log\s*in|sign\s*in)\b|\b(?:log\s*in|sign\s*in)\s+to\s+(?:continue|apply|access)|(?:giriş yapmanız|oturum açmanız)\s+gerekiyor|(?:devam etmek|başvurmak)\s+için\s+(?:giriş|oturum)|bitte\s+(?:einloggen|anmelden)|(?:scan|scanne).{0,40}qr.{0,40}(?:log\s*in|sign\s*in|anmeld)/iu.test(
      text,
    );
  if (!gate && !(field && form))
    throw Error(
      'The current page shows no sign-in form or explicit sign-in requirement. A sign-in/sign-up link alone is not a barrier. Follow the listing’s actual apply button and verify the resulting page with browser_read.',
    );
  return {kind: 'login', url: page.url, evidence: quote, snapshotId: page.id};
}
