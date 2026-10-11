// @ts-check
import {observedId} from './ids.mjs';
const excluded =
  /captcha|recaptcha|hcaptcha|challenge|oauth|accounts\.google|login\.microsoftonline/i;
export async function usableFormFrame(frame, page) {
  if (frame === page.mainFrame()) return false;
  for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
    if (excluded.test(current.url())) return false;
    const host = await current.frameElement();
    try {
      if (
        !(await host.evaluate(
          (e, url) =>
            !e.hasAttribute('sandbox') &&
            !/captcha|challenge|oauth/i.test(e.id + ' ' + e.title + ' ' + e.src) &&
            /^https?:|^about:srcdoc$/.test(e.src || url) &&
            !e.closest('[inert],[aria-hidden="true"]') &&
            e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}),
          current.url(),
        ))
      )
        return false;
    } finally {
      await host.dispose();
    }
  }
  return true;
}
function describe(e) {
  if (
    !e.isConnected ||
    e.matches(':disabled') ||
    e.readOnly ||
    e.closest('[inert],[aria-hidden="true"],[aria-disabled="true"]') ||
    !e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
  )
    return null;
  const refs = (e.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .map((id) => e.getRootNode().getElementById?.(id)?.textContent || '')
    .join(' ');
  const label = (
    e.getAttribute('aria-label') ||
    refs ||
    [...(e.labels || [])].map((l) => l.textContent).join(' ') ||
    e.innerText ||
    e.name ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
  const type = e.type || e.getAttribute('role') || e.tagName.toLowerCase();
  if (['password', 'hidden', 'file', 'reset'].includes(type)) return null;
  const kind =
    e.tagName === 'SELECT'
      ? 'select'
      : ['checkbox', 'radio'].includes(type)
        ? 'choice'
        : e.tagName === 'TEXTAREA' ||
            (e.tagName === 'INPUT' && ['text', 'email', 'tel', 'url', 'date'].includes(type))
          ? 'fill'
          : e.matches(
                'button,[role=button],input[type=submit],input[type=button],[role=combobox],[role=option]',
              )
            ? 'click'
            : null;
  if (!kind) return null;
  return {
    label,
    kind,
    type,
    required: !!e.required || e.getAttribute('aria-required') === 'true',
    expanded: e.getAttribute('aria-expanded') ?? undefined,
    autocomplete: e.getAttribute('aria-autocomplete') ?? undefined,
    selected: e.getAttribute('aria-selected') ?? undefined,
    value: kind === 'fill' || kind === 'select' ? e.value : undefined,
    checked: kind === 'choice' ? e.checked : undefined,
    options:
      kind === 'select'
        ? [...e.options]
            .filter((o) => !o.disabled && !o.closest('optgroup[disabled]'))
            .map((o) => ({label: o.label, value: o.value}))
        : undefined,
    min: e.min || undefined,
    max: e.max || undefined,
    signature: [
      performance.timeOrigin,
      location.href,
      e.tagName,
      type,
      e.id,
      e.name,
      label,
      e.form?.action,
      e.required,
      e.getAttribute('role'),
    ],
  };
}
export async function observeFormFrame(slot, frameId, owner) {
  const saved = slot.embeddedFrames?.get(frameId);
  if (
    !saved ||
    saved.owner !== owner ||
    saved.rawUrl !== saved.frame.url() ||
    !(await usableFormFrame(saved.frame, slot.page))
  )
    throw Error('A current, accessible frameId is required.');
  const prior = slot.frameActionTargets ?? new Map();
  slot.frameActionTargets = new Map();
  await Promise.all([...prior.values()].map((t) => t.handle.dispose().catch(() => {})));
  const controls = [];
  for (const handle of await saved.frame
    .locator('input,textarea,select,button,[role=button],[role=combobox],[role=option]')
    .elementHandles()) {
    const meta = await handle.evaluate(describe);
    if (!meta) {
      await handle.dispose();
      continue;
    }
    const targetId = observedId('embedded');
    slot.frameActionTargets.set(targetId, {
      handle,
      meta,
      owner,
      frame: saved.frame,
      frameUrl: saved.frame.url(),
      pageUrl: slot.page.url(),
    });
    const {signature, ...visible} = meta;
    controls.push({targetId, ...visible});
  }
  return {
    browser: 'Jev Chrome',
    tabId: slot.id,
    frameId,
    frameUrl: saved.url,
    inPlace: true,
    text: (await saved.frame.locator('body').innerText()).slice(0, 16000),
    controls,
    nextAction: 'browser_jev_frame_act',
    message:
      'These targets work only inside the embedded form. Do not mix them with main page ids. After each action, use only the newly returned targets.',
  };
}
export async function actFormFrame(slot, args, owner) {
  const t = slot.frameActionTargets?.get(args.targetId);
  if (!t || t.owner !== owner) throw Error('A current embedded form target is required.');
  if (
    t.pageUrl !== slot.page.url() ||
    t.frameUrl !== t.frame.url() ||
    !(await usableFormFrame(t.frame, slot.page))
  )
    throw Error('The embedded form changed; no action was taken.');
  const meta = await t.handle.evaluate(describe);
  if (!meta || JSON.stringify(meta) !== JSON.stringify(t.meta))
    return {
      status: 'stale',
      executed: false,
      message: 'The embedded field changed; use the current targets.',
    };
  if (args.action !== meta.kind) throw Error('Use an action that fits the target type.');
  if (meta.kind === 'fill' && typeof args.text !== 'string')
    throw Error('A verified text answer is required.');
  if (meta.kind === 'select' && !meta.options.some((o) => o.value === args.value))
    throw Error('An observed option value is required.');
  if (meta.kind === 'choice' && typeof args.checked !== 'boolean')
    throw Error('The requested checked state is required.');
  slot.frameActionTargets.delete(args.targetId);
  try {
    if (meta.kind === 'fill') {
      await t.handle.fill(args.text, {timeout: 2500});
      if (meta.autocomplete === 'list' || meta.autocomplete === 'both') {
        const suggestion = t.frame.locator('[role="option"]').first();
        // Many ARIA comboboxes (including Greenhouse/React Select) reveal their
        // filtered options only after ArrowDown, even though fill fires input.
        if (!(await suggestion.isVisible().catch(() => false)))
          await t.handle.press('ArrowDown', {timeout: 2500}).catch(() => {});
        await suggestion.waitFor({state: 'visible', timeout: 2500}).catch(() => {});
        const suggestionsVisible = await suggestion.isVisible().catch(() => false);
        const verified = await t.handle.evaluate(
          (e, text) => e.isConnected && e.value === text,
          args.text,
        );
        return {
          status: 'needs_selection',
          executed: true,
          verified,
          suggestionsVisible,
          message: suggestionsVisible
            ? 'This field needs a suggestion to be selected. Choose the verified city from the visible role=option targets in the returned embedded form controls; typing text alone does not complete the form.'
            : 'No suggestions are visible yet. Type a short prefix of the city name and try again (e.g. Berl); this field is not valid until a suggestion is selected.',
        };
      }
      await t.handle.evaluate((e) => e.blur());
      const verified = await t.handle.evaluate(
        (e, text) => e.isConnected && e.value === text && e.validity.valid,
        args.text,
      );
      return {status: verified ? 'ready' : 'uncertain', executed: true, verified};
    }
    if (meta.kind === 'select') await t.handle.selectOption({value: args.value}, {timeout: 2500});
    else if (meta.kind === 'choice') await t.handle.setChecked(args.checked, {timeout: 2500});
    else await t.handle.click({timeout: 2500});
    if (meta.kind === 'click')
      return {
        status: 'ready',
        executed: true,
        message: 'The click was made; verify the new form or the submission confirmation from the returned observation.',
      };
    const verified = await t.handle.evaluate(
      (e, a) =>
        e.isConnected && (a.action === 'choice' ? e.checked === a.checked : e.value === a.value),
      args,
    );
    return {status: verified ? 'ready' : 'uncertain', executed: true, verified};
  } catch {
    return {
      status: 'uncertain',
      executed: 'unknown',
      message: 'Could not verify the embedded form action; inspect the current state without repeating the same action.',
    };
  } finally {
    await t.handle.dispose().catch(() => {});
  }
}
