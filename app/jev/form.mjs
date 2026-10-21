import {observedId, actionIdentity} from './ids.mjs';
import {installFormSemantics} from './form-semantics.mjs';
import {humanFill, wheelReveal} from '../browser/human-input.mjs';

// Read-only preflight, including rendered fields below the fold. Never invokes
// checkValidity/reportValidity (which dispatch events), changes focus or submits.
export async function inspectApplicationForm(page, slot = null) {
  const fields = [],
    unavailableFrames = [],
    submitControls = [];
  let truncated = false;
  for (const frame of page.frames()) {
    try {
      if (frame.parentFrame()) {
        const element = await frame.frameElement();
        try {
          if (
            !(await element.evaluate(
              (e) =>
                e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
                !e.closest('[inert],[aria-hidden="true"]'),
            ))
          )
            continue;
        } finally {
          await element.dispose();
        }
      }
      await frame.evaluate(installFormSemantics);
      const result = await frame.evaluate(() => {
        const visible = (e) =>
          e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
          !e.closest('[inert],[aria-hidden="true"]');
        const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
        const refs = (e, name) =>
          (e.getAttribute(name) ?? '')
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ');
        const queryAll = (root, selector) => [
          ...root.querySelectorAll(selector),
          ...[...root.querySelectorAll('*')]
            .filter((e) => e.shadowRoot)
            .flatMap((e) => queryAll(e.shadowRoot, selector)),
        ];
        const modalSurface = (e) =>
          visible(e) &&
          [e, ...queryAll(e, '*')].some((n) => {
            if (!visible(n)) return false;
            const r = n.getBoundingClientRect();
            return r.width > 1 && r.height > 1;
          });
        // Same rule as the page reader: only a layer over the page scopes the
        // form, never a closed <dialog>, an inline widget or a field's popup.
        const fixedLayer = (n) => getComputedStyle(n).position === 'fixed';
        const ids = (c) =>
          [c.getAttribute('aria-controls'), c.getAttribute('aria-owns')].join(' ').split(/\s+/);
        const ownedPopup = (d) =>
          !d.matches('[aria-modal="true"]') &&
          queryAll(document, '[aria-controls],[aria-owns]').some(
            (c) =>
              !d.contains(c) &&
              ids(c).some((id) => {
                const t =
                  id && (c.getRootNode().getElementById?.(id) ?? document.getElementById(id));
                return Boolean(t) && d.contains(t);
              }),
          );
        const overlay = (e) => {
          if (e.tagName === 'DIALOG' && !e.open) return false;
          if (e.matches('dialog:modal')) return true;
          if (ownedPopup(e)) return false;
          for (let p = e; p?.nodeType === 1; p = p.parentElement ?? p.getRootNode()?.host)
            if (fixedLayer(p)) return true;
          const r = e.getBoundingClientRect();
          return (
            (r.width <= 1 || r.height <= 1) &&
            queryAll(e, '*').some((n) => visible(n) && fixedLayer(n))
          );
        };
        const modal = queryAll(document, 'dialog[open],[role="dialog"],[aria-modal="true"]')
            .filter((e) => modalSurface(e) && overlay(e))
            .at(-1),
          root = modal ?? document;
        // Styled checkboxes and radios often hide the native input behind a visible label.
        // A transparent combobox input counts when the box around it is shown.
        const shown = (e) =>
          visible(e) ||
          Boolean(window.__jobloopFileSurface(e)) ||
          window.__jobloopDrawnToggle(e) ||
          (['checkbox', 'radio'].includes(e.type) && [...(e.labels ?? [])].some(visible)) ||
          Boolean(
            window.__jevFast?.combo?.(e)?.control && visible(window.__jevFast.combo(e).control),
          );
        // Custom dropdowns: a non-input combobox, or a labelled button that
        // opens a listbox/tree popup. Its answer is the trigger's own text.
        const trigger = (e) =>
          !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) &&
          (e.getAttribute('role') === 'combobox' ||
            ((e.tagName === 'BUTTON' || e.getAttribute('role') === 'button') &&
              ['listbox', 'tree', 'true'].includes(e.getAttribute('aria-haspopup')) &&
              (e.hasAttribute('aria-labelledby') || e.labels?.length > 0)));
        const caption = (e) => {
          const text = clean(
            [...e.childNodes]
              .map((n) =>
                n.nodeType === Node.TEXT_NODE
                  ? n.textContent
                  : n.nodeType === Node.ELEMENT_NODE &&
                      visible(n) &&
                      !n.matches('[role="listbox"],[role="tree"]')
                    ? n.innerText
                    : '',
              )
              .join(' '),
          );
          const placeholders = [
            e,
            ...e.querySelectorAll('[data-placeholder],[aria-placeholder],[placeholder]'),
          ].flatMap((n) =>
            ['aria-placeholder', 'data-placeholder', 'placeholder'].map((a) => n.getAttribute(a)),
          );
          return placeholders.includes(text) ? '' : text;
        };
        const nodes = queryAll(
          root,
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),textarea,select,[role="combobox"],[role="checkbox"],[role="radio"],[aria-haspopup],button[type="button"],[role="button"]',
        ).filter(
          (e) =>
            shown(e) &&
            (!e.matches('button[type="button"],[role="button"]') ||
              trigger(e) ||
              window.__jobloopPicker(e)) &&
            !e.matches(':disabled') &&
            e.getAttribute('aria-disabled') !== 'true' &&
            (!e.matches('[aria-haspopup]:not([role="combobox"])') ||
              ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName) ||
              trigger(e)),
        );
        return {
          documentOrigin: performance.timeOrigin,
          truncated: nodes.length > 200,
          submitControls: queryAll(root, 'button,input[type="submit"],[role="button"]')
            .filter(visible)
            .filter((e) =>
              /submit|send application|bewerb|apply|başvur|gönder/i.test(
                clean(e.getAttribute('aria-label') || e.innerText || e.value || ''),
              ),
            )
            .slice(0, 10)
            .map((e) => ({
              node: window.__jevFast?.ids.get(e),
              label: clean(e.getAttribute('aria-label') || e.innerText || e.value),
              disabled: e.disabled || e.getAttribute('aria-disabled') === 'true',
            })),
          fields: nodes.slice(0, 200).map((e) => {
            const semantic = window.__jobloopFieldContext(e),
              label = semantic.label;
            const dropdown = trigger(e),
              picker = !dropdown && window.__jobloopPicker(e);
            const type = dropdown
              ? 'combobox'
              : picker
                ? 'picker'
                : e.getAttribute('role') || e.type || e.tagName.toLowerCase();
            const required = semantic.required;
            // Visible error text first: it is what the page shows after a failed submit.
            const shownError = window.__jobloopFieldError(e);
            const message = clean(
              shownError || e.validationMessage || refs(e, 'aria-errormessage'),
            );
            const invalid =
              Boolean(shownError) ||
              e.getAttribute('aria-invalid') === 'true' ||
              e.validity?.valid === false;
            const field = {
              node: window.__jevFast?.ids.get(e),
              ...semantic,
              label,
              type,
              required,
              invalid,
              ...(message ? {validationMessage: message} : {}),
            };
            if (picker) field.value = caption(e);
            if (type === 'file') {
              field.files = [...(e.files ?? [])].map((f) => ({name: f.name, size: f.size}));
              field.accept = e.accept || null;
              field.multiple = Boolean(e.multiple);
            }
            if (type !== 'password' && Number.isInteger(e.maxLength) && e.maxLength >= 0)
              field.maxLength = e.maxLength;
            const language =
              e.closest('[lang]')?.getAttribute('lang') || document.documentElement.lang;
            if (language) field.language = language;
            // A searchable combobox input is empty after a choice; the choice
            // shows next to it.
            if (type !== 'password')
              field.filled = dropdown
                ? Boolean(caption(e))
                : picker
                  ? // Page vocabulary for an unchosen picker caption.
                    !/^(?:select|choose|pick|please (?:select|choose)|bitte (?:wählen|auswählen)|auswählen|wählen sie|seçiniz|seçin|sélectionnez|choisissez|seleccione|selecciona)\b/i.test(
                      caption(e),
                    ) && Boolean(caption(e))
                  : window.__jevFast?.combo?.(e)?.values.length
                    ? true
                    : ['checkbox', 'radio'].includes(type)
                      ? Boolean(e.checked || e.getAttribute('aria-checked') === 'true')
                      : type === 'file'
                        ? Boolean(e.files?.length)
                        : typeof e.value === 'string'
                          ? Boolean(e.value.trim())
                          : null;
            return field;
          }),
        };
      });
      const current =
        slot && frame === page.mainFrame() && slot.observed?.page_key[0] === result.documentOrigin;
      truncated ||= result.truncated;
      // The same observed node gives the submit button its click targetId (in
      // view) or its controlId (for reveal); long pages never need a text slice.
      submitControls.push(
        ...result.submitControls.map(({node, ...control}) => {
          const targetId = current
            ? [...(slot.clickTargets ?? [])].find(
                ([, saved]) => saved.owner === slot.owner && saved.action?.node === node,
              )?.[0]
            : undefined;
          const controlId = current
            ? [...(slot.controls ?? [])].find(
                ([, saved]) =>
                  saved.kind === 'control' && saved.node === node && saved.owner === slot.owner,
              )?.[0]
            : undefined;
          return {
            ...control,
            ...(targetId ? {targetId} : {}),
            ...(controlId ? {controlId} : {}),
            frameUrl: frame.url(),
          };
        }),
      );
      fields.push(
        ...result.fields.map(({node, ...f}) => {
          const controlId = current
            ? [...(slot.controls ?? [])].find(
                ([, saved]) =>
                  saved.kind === 'control' && saved.node === node && saved.owner === slot.owner,
              )?.[0]
            : undefined;
          const fieldId = current
            ? [...(slot.fillFields ?? [])].find(
                ([, saved]) => saved.action.node === node && saved.owner === slot.owner,
              )?.[0]
            : undefined;
          return {
            ...f,
            ...(controlId ? {controlId} : {}),
            ...(fieldId ? {fieldId} : {}),
            frameUrl: frame.url(),
          };
        }),
      );
    } catch {
      unavailableFrames.push(frame.url());
    }
  }
  const compact = compactFields(fields, page.url());
  return {
    ...compact,
    missingRequired: compact.fields
      .filter(
        (f) => (f.required === true && f.filled === false) || (f.invalid && f.validationMessage),
      )
      .map(({label, question, type, frameUrl, validationMessage}) => ({
        label,
        question,
        type,
        frameUrl,
        ...(validationMessage ? {validationMessage} : {}),
      })),
    submitControls: submitControls.map(({frameUrl, ...c}) =>
      frameUrl === page.url() ? c : {...c, frameUrl},
    ),
    unavailableFrames,
    truncated,
    readOnly: true,
    ...(compact.fields.some((f) => f.frameUrl)
      ? {
          embedded:
            'Fields with a frameUrl sit in a form embedded from another page and cannot be filled from this tab. Open that frameUrl with browser_open and fill and submit the form in the new tab. It is this same application form, not a second application.',
        }
      : {}),
    notice:
      'Rendered fields on the current step only. A field without required is unknown, not optional. missingRequired also lists fields that show a validation message; fix those before submitting again. Radio and checkbox options are grouped under their question; click an option with its controlId. A combobox is a custom dropdown: choose with autocomplete, its controlId and the exact option. A picker is a button that opens a list: click it, then click the option. A submit control with targetId is clickable now; with only controlId, browser_interact reveal it first and inspect again. Later steps may add fields. This inspection is not submission-outcome evidence.',
  };
}

// Drops repeated and default values so a long form stays small: one question per
// radio/checkbox group, no page-level frameUrl or language on every field.
export function compactFields(fields, pageUrl) {
  const language = fields.find((f) => f.frameUrl === pageUrl)?.language ?? fields[0]?.language;
  // File types are listed once in uploads.
  const strip = ({
    frameUrl,
    language: own,
    help,
    required,
    invalid,
    question,
    label,
    accept,
    multiple,
    files,
    ...f
  }) => ({
    ...(label ? {label} : {}),
    ...(question && question !== label ? {question} : {}),
    ...(help ? {help} : {}),
    ...(required != null ? {required} : {}),
    ...(invalid ? {invalid} : {}),
    ...(multiple ? {multiple} : {}),
    ...(files?.length ? {files} : {}),
    ...f,
    ...(own && own !== language ? {language: own} : {}),
    ...(frameUrl !== pageUrl ? {frameUrl} : {}),
  });
  const result = [];
  let group = null;
  for (const field of fields) {
    const choice = ['checkbox', 'radio'].includes(field.type) && field.question;
    if (
      choice &&
      group?.question === field.question &&
      group.type === field.type &&
      group.frameUrl === field.frameUrl
    )
      group.items.push(field);
    else {
      group = choice ? {...field, items: [field]} : null;
      result.push(group ?? strip(field));
    }
  }
  return {
    ...(language ? {language} : {}),
    fields: result.map((entry) => {
      if (!entry.items) return entry;
      const {items, option, controlId, fieldId, label, ...first} = entry;
      const {question, ...rest} = strip({
        ...first,
        required: items.some((f) => f.required === true) ? true : first.required,
        invalid: items.some((f) => f.invalid),
        filled: items.some((f) => f.filled),
      });
      return {
        question,
        ...rest,
        options: items.map((f) => ({
          option: f.option || f.label,
          ...(f.controlId ? {controlId: f.controlId} : {}),
          ...(f.fieldId ? {fieldId: f.fieldId} : {}),
          filled: f.filled,
        })),
      };
    }),
  };
}

// Only ordinary, observed text fields. Dropdowns, consent, credentials, files and
// submission remain separate reviewed operations. Keep actual element handles.
function inspectField(e) {
  const type = e.tagName === 'TEXTAREA' ? 'textarea' : e.type;
  // Search suggestions do not require selecting a predefined answer. Google,
  // for example, exposes its free-text query as a textarea with role=combobox.
  // Keep application autocompletes on the exact-option selection path.
  const search =
    e.type === 'search' ||
    e.getAttribute('role') === 'searchbox' ||
    Boolean(e.closest('[role="search"]'));
  if (
    !(
      e.tagName === 'TEXTAREA' ||
      (e.tagName === 'INPUT' &&
        ['text', 'search', 'number', 'email', 'tel', 'url', 'date'].includes(type))
    ) ||
    (!search &&
      (window.__jevFast?.autocomplete(e) ||
        e.getAttribute('role') === 'combobox' ||
        e.hasAttribute('list') ||
        e.hasAttribute('aria-autocomplete'))) ||
    !e.isConnected ||
    e.readOnly ||
    e.matches(':disabled') ||
    e.closest('[aria-disabled="true"],[aria-readonly="true"],[inert],[aria-hidden="true"]') ||
    !e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
  )
    return null;
  const r = e.getBoundingClientRect(),
    x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const next = hit.shadowRoot.elementFromPoint(x, y);
    if (!next || next === hit) break;
    hit = next;
  }
  for (let host = e.getRootNode()?.host; host; host = host.getRootNode()?.host)
    if (host.closest('[aria-disabled="true"],[aria-readonly="true"],[inert],[aria-hidden="true"]'))
      return null;
  if (
    !r.width ||
    !r.height ||
    x < 0 ||
    y < 0 ||
    x >= innerWidth ||
    y >= innerHeight ||
    !e.contains(hit)
  )
    return null;
  return {
    type,
    value: e.value,
    required: e.required,
    maxLength: e.maxLength,
    min: e.min,
    max: e.max,
    step: e.step,
    valid: e.validity.valid,
    signature: [
      e.tagName,
      type,
      e.id,
      e.name,
      e.getAttribute('role'),
      e.getAttribute('placeholder'),
      e.autocomplete,
      e.pattern,
      e.maxLength,
      e.required,
      e.form?.action ?? null,
      e.form?.method ?? null,
      e.min,
      e.max,
      e.step,
    ],
  };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Scroll/viewport changes during focus or textarea resize are not field edits.
// Keep document identity, URL and every input's identity/value/state guarded.
const sameFormState = (a, b) => !!a && !!b && equal([a[0], a[1], a[6]], [b[0], b[1], b[6]]);
const sameText = (actual, expected, type) =>
  actual === expected ||
  (type === 'tel' &&
    /^\+?[\d\s().-]+$/.test(actual) &&
    /^\+?[\d\s().-]+$/.test(expected) &&
    actual.replace(/[\s().-]/g, '') === expected.replace(/[\s().-]/g, ''));
export async function clearFillFields(slot) {
  const fields = slot.fillFields;
  slot.fillFields = new Map();
  if (fields) await Promise.all([...fields.values()].map((f) => f.input.dispose().catch(() => {})));
}
export async function captureFillFields(slot, owner, previous = new Map()) {
  const fields = [];
  for (const action of slot.observed.actions.filter((a) => a.kind === 'fill').slice(0, 40)) {
    const handle = await slot.page.evaluateHandle(
        (node) => window.__jevFast?.nodes.get(node),
        action.node,
      ),
      input = handle.asElement();
    const details = input ? await input.evaluate(inspectField) : null;
    if (!details) {
      await handle.dispose();
      continue;
    }
    const identity = JSON.stringify([actionIdentity(slot.observed, action), details]);
    const saved = [...previous].find(
      ([, entry]) => entry.owner === owner && entry.identity === identity,
    );
    const fieldId = saved?.[0] ?? observedId('f');
    slot.fillFields.set(fieldId, {input, action, details, owner, identity});
    fields.push({
      fieldId,
      label: action.label,
      type: details.type,
      value: details.value,
      required: details.required,
      maxLength: details.maxLength,
      ...(details.type === 'date'
        ? {format: 'YYYY-MM-DD', min: details.min, max: details.max, step: details.step}
        : {}),
    });
  }
  return fields;
}
// Ignore framework node replacement, but preserve semantic identity, order and
// every non-secret field value. Unexpected fields/user edits still stop a batch.
function semanticFormState() {
  const query = (root) => [
    ...root.querySelectorAll('input,textarea,select'),
    ...[...root.querySelectorAll('*')]
      .filter((n) => n.shadowRoot)
      .flatMap((n) => query(n.shadowRoot)),
  ];
  return [
    performance.timeOrigin,
    location.href,
    query(document)
      .filter((e) => !['password', 'hidden'].includes(e.type))
      .map((e) => [
        e.tagName,
        e.type,
        e.id,
        e.name,
        e.getAttribute('aria-label'),
        [...(e.labels || [])].map((l) => l.textContent.trim()).join(' '),
        e.form?.id,
        e.form?.action,
        e.disabled,
        e.readOnly,
        e.required,
        e.value,
        e.checked,
        e.selectedIndex,
      ]),
  ];
}
async function recoverField(slot, entry) {
  // Only stable IDs/names captured from an observed field may recover a clone.
  const [, , id, name] = entry.details.signature;
  if (!id && !name) return false;
  const handle = await slot.page.evaluateHandle(
    ({id, name}) => {
      const query = (root) => [
        ...root.querySelectorAll('input,textarea'),
        ...[...root.querySelectorAll('*')]
          .filter((n) => n.shadowRoot)
          .flatMap((n) => query(n.shadowRoot)),
      ];
      const matches = query(document).filter((e) => (id ? e.id === id : e.name === name));
      return matches.length === 1 ? matches[0] : null;
    },
    {id, name},
  );
  const input = handle.asElement(),
    details = input ? await input.evaluate(inspectField) : null;
  const label = input
    ? await input.evaluate((e) => window.__jobloopFieldContext?.(e)?.label)
    : null;
  if (
    !details ||
    !equal(details.signature, entry.details.signature) ||
    label !== entry.action.label
  ) {
    await handle.dispose();
    return false;
  }
  await entry.input.dispose().catch(() => {});
  entry.input = input;
  return true;
}
export async function fillKnownFields(slot, fields, owner, reader) {
  if (fields.some((field) => slot.controls?.has(field.fieldId)))
    return {
      status: 'invalid_target',
      results: fields.map(({fieldId}) => ({fieldId, status: 'not_attempted'})),
      message:
        'A controlId is not a writable fieldId. Find the field in the returned controls; if it is not visible, make it visible with browser_interact reveal, then use the fieldId from the current fillFields. Do not retry typing with the same controlId.',
    };
  // Removed, consumed or foreign-session IDs cannot write.
  if (fields.some((field) => !slot.fillFields?.has(field.fieldId)))
    return {
      status: 'stale',
      results: fields.map(({fieldId}) => ({fieldId, status: 'not_attempted'})),
      message:
        'The field ids are stale; use the returned current fillFields list. No extra observe is needed.',
    };
  // Validate the complete mapping before touching any field, then consume it.
  const entries = fields.map((field) => {
    const saved = slot.fillFields?.get(field.fieldId);
    if (!saved || saved.owner !== owner)
      throw Error(
        'A current field id of this session is required; use the fillFields list from the last observation.',
      );
    if (saved.details.type === 'date') {
      const valid =
        /^\d{4}-\d{2}-\d{2}$/.test(field.text) &&
        Number.isFinite(Date.parse(field.text)) &&
        new Date(field.text).toISOString().slice(0, 10) === field.text;
      if (!valid)
        throw Error(
          'The date must be a valid calendar date in YYYY-MM-DD format; no field was filled.',
        );
      if (
        (saved.details.min && field.text < saved.details.min) ||
        (saved.details.max && field.text > saved.details.max)
      )
        throw Error('The date is outside the min/max limits of the field; no field was filled.');
    }
    if (saved.details.maxLength >= 0 && field.text.length > saved.details.maxLength)
      throw Error('The text exceeds the length the field allows; no field was filled.');
    return {...saved, ...field};
  });
  const handles = new Map(fields.map(({fieldId}) => [fieldId, slot.fillFields.get(fieldId)]));
  for (const {fieldId} of fields) slot.fillFields.delete(fieldId);
  slot.pending = null;
  const expected = structuredClone(slot.observed.page_key),
    guards = slot.observed.guards;
  const results = entries.map((e) => ({
    fieldId: e.fieldId,
    label: e.action.label,
    status: 'not_attempted',
  }));
  let status = 'ready';
  let semanticExpected = await slot.page.evaluate(semanticFormState);
  // Short answers are typed key by key; once this call has typed for a minute
  // the rest arrives at once, so a long form stays within the call's bound.
  const typingUntil = Date.now() + 60000;
  try {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i],
        result = results[i];
      let began = false;
      try {
        const current = await slot.page.evaluate(reader);
        if (i > 0 && !(await entry.input.evaluate((e) => e.isConnected).catch(() => false)))
          await recoverField(slot, entry);
        const details = await entry.input.evaluate(inspectField);
        const semanticCurrent = await slot.page.evaluate(semanticFormState);
        if (
          !current ||
          !details ||
          !(i === 0
            ? sameFormState(current.page_key, expected)
            : equal(semanticCurrent, semanticExpected)) ||
          !(i === 0 ? equal(current.guards[entry.action.node], guards[entry.action.node]) : true) ||
          !equal(details.signature, entry.details.signature)
        ) {
          result.status = status = 'stale';
          break;
        }
        if (sameText(details.value, entry.text, details.type)) {
          result.status = details.valid ? 'unchanged' : 'invalid';
          if (!details.valid) {
            status = 'invalid';
            break;
          }
          continue;
        }
        began = true;
        await wheelReveal(slot.page, entry.input).catch(() => false);
        await humanFill(slot.page, entry.input, entry.text, {deadline: typingUntil});
        await entry.input.evaluate((e) => e.blur());
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!(await entry.input.evaluate((e) => e.isConnected).catch(() => false)))
          await recoverField(slot, entry);
        const after = await entry.input.evaluate((e) =>
          e.isConnected ? {value: e.value, valid: e.validity.valid} : null,
        );
        if (!after) {
          result.status = status = 'uncertain';
          break;
        }
        if (!sameText(after.value, entry.text, details.type)) {
          result.status = status = 'uncertain';
          break;
        }
        if (!after.valid) {
          result.status = status = 'invalid';
          break;
        }
        result.status = 'filled';
        const state = expected[6].find((field) => field[0] === entry.action.node);
        if (state) state[1] = after.value;
        const nextSemantic = await slot.page.evaluate(semanticFormState);
        const desired = structuredClone(semanticExpected);
        const matches = desired[2].filter((f) =>
          entry.details.signature[2]
            ? f[2] === entry.details.signature[2]
            : entry.details.signature[3]
              ? f[3] === entry.details.signature[3]
              : false,
        );
        if (matches.length === 1) {
          matches[0][11] = after.value;
          if (!equal(desired, nextSemantic) && i < entries.length - 1) {
            status = 'stale';
            break;
          }
        } else if (
          !sameFormState((await slot.page.evaluate(reader)).page_key, expected) &&
          i < entries.length - 1
        ) {
          status = 'stale';
          break;
        }
        semanticExpected = nextSemantic;
        slot.history.push({
          action: entry.action.label,
          kind: 'fill',
          operation: 'TYPE_TEXT',
          text: entry.text,
        });
      } catch {
        result.status = status = began ? 'uncertain' : 'stale';
        break;
      }
    }
    // A later change/blur can clear an earlier input. Verify the complete result,
    // including the last field, before returning success. Never retry mutations.
    const final = await slot.page.evaluate(reader).catch(() => null);
    const formChanged = !sameFormState(final?.page_key, expected);
    if (status === 'ready' && (!final || !equal(final.page_key.slice(0, 2), expected.slice(0, 2))))
      status = 'stale';
    for (let i = 0; i < entries.length; i++)
      if (['filled', 'unchanged'].includes(results[i].status)) {
        if (!(await entries[i].input.evaluate((e) => e.isConnected).catch(() => false)))
          await recoverField(slot, entries[i]);
        const verified = await entries[i].input
          .evaluate((e) => (e.isConnected ? {value: e.value, valid: e.validity.valid} : null))
          .catch(() => null);
        if (!verified || !sameText(verified.value, entries[i].text, entries[i].details.type)) {
          results[i].status = 'uncertain';
          status = 'uncertain';
        } else if (!verified.valid) {
          results[i].status = 'invalid';
          if (status !== 'uncertain') status = 'invalid';
        }
      }
    slot.history = slot.history.slice(-60);
    const verifiedCount = results.filter((r) => ['filled', 'unchanged'].includes(r.status)).length;
    return {
      status,
      results,
      verifiedCount,
      formChanged,
      message:
        status === 'ready'
          ? 'The requested field values were verified. Use the returned current observation; do not fill these fields again. Nothing was submitted.'
          : `${verifiedCount}/${results.length} fields verified. Inspect only the unverified or not_attempted fields; do not fill filled/unchanged fields again. The current field map is in this result.`,
    };
  } finally {
    await Promise.all(
      [...handles.values(), ...entries].map((f) => f.input.dispose().catch(() => {})),
    );
  }
}
