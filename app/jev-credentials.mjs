// Report validation metadata only: never expose values or page-generated error text.
function passwordValidation(e) {
  const visible = (n) =>
    n?.isConnected && n.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
  const root = e.getRootNode(),
    ids = [e.getAttribute('aria-describedby'), e.getAttribute('aria-errormessage')]
      .filter(Boolean)
      .join(' ')
      .split(/\s+/);
  const related = ids.map((id) => root.getElementById?.(id)).filter(visible);
  const box = e.closest('[class*=field],[class*=Field]') || e.parentElement;
  const errorNodes = [
    ...related,
    ...(box?.querySelectorAll('[role=alert],[class*=error],[class*=invalid]') || []),
  ].filter(visible);
  const siteRejected =
    e.getAttribute('aria-invalid') === 'true' ||
    errorNodes.some((n) =>
      /(?:password|şifre|passwort).{0,100}(?:invalid|incorrect|not meet|doesn't meet|too short|rejected|geçersiz|ungültig)|security requirements|(?:invalid|incorrect).{0,30}password/i.test(
        n.textContent || '',
      ),
    );
  return {
    invalid: !e.validity.valid || siteRejected,
    siteRejected,
    minLength: e.minLength > 0 ? e.minLength : undefined,
  };
}
import {randomUUID} from 'node:crypto';
export async function capturePasswordFields(slot, owner) {
  for (const f of slot.passwordFields?.values() ?? []) await f.handle.dispose().catch(() => {});
  slot.passwordFields = new Map();
  const handles = await slot.page.locator('input[type="password"]').elementHandles(),
    fields = [];
  for (const handle of handles) {
    const meta = await handle.evaluate((e) => {
      if (
        !e.isConnected ||
        e.disabled ||
        e.readOnly ||
        !e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
      )
        return null;
      return {
        label:
          e.getAttribute('aria-label') ||
          [...(e.labels || [])].map((l) => l.textContent.trim()).join(' ') ||
          e.name ||
          'Password',
        autocomplete: e.autocomplete,
        filled: Boolean(e.value),
      };
    });
    if (!meta) {
      await handle.dispose();
      continue;
    }
    meta.validation = await handle.evaluate(passwordValidation);
    const fieldId = randomUUID();
    slot.passwordFields.set(fieldId, {handle, owner, url: slot.page.url(), meta});
    fields.push({fieldId, ...meta});
  }
  return fields;
}
// Only expose readiness, never credential values. The browser supplies autofill.
export function savedLoginState() {
  const visible = (e) =>
    e.isConnected && e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
  const passwords = [...document.querySelectorAll('input[type=password]')].filter(visible);
  const buttons = [...document.querySelectorAll('button,input[type=submit],[role=button]')].filter(
    (e) =>
      visible(e) &&
      /^(sign\s*in|log\s*in|anmelden|einloggen|giriş yap|oturum aç)$/iu.test(
        (e.innerText || e.value || e.getAttribute('aria-label') || '').trim(),
      ),
  );
  if (
    passwords.length !== 1 ||
    buttons.length !== 1 ||
    passwords[0].autocomplete === 'new-password'
  )
    return null;
  const password = passwords[0],
    root = password.form || document;
  if (password.form && !password.form.contains(buttons[0])) return null;
  const accounts = [...root.querySelectorAll('input:not([type=password])')].filter(
    (e) =>
      visible(e) &&
      e.type !== 'hidden' &&
      (e.type === 'email' ||
        /username|email/.test(e.autocomplete) ||
        /email|e-mail|e-posta|username|benutzername/i.test(
          [
            e.name,
            e.id,
            e.getAttribute('aria-label'),
            ...[...(e.labels ?? [])].map((l) => l.innerText),
          ].join(' '),
        )),
  );
  const accountFilled = accounts.length === 1 && Boolean(accounts[0].value.trim()),
    passwordFilled = Boolean(password.value);
  const requiresUser = [...root.querySelectorAll('input')].some(
    (e) =>
      visible(e) &&
      /one-time-code|otp|captcha|verification.?code/i.test(
        [e.autocomplete, e.name, e.id].join(' '),
      ),
  );
  return {
    accountFilled,
    passwordFilled,
    requiresUser,
    ready:
      accountFilled &&
      passwordFilled &&
      !requiresUser &&
      !buttons[0].disabled &&
      buttons[0].getAttribute('aria-disabled') !== 'true',
  };
}
