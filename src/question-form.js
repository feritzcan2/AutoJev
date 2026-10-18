import {asksForLogin} from '../app/automation/login-question.mjs';
const node = (tag, value) => {
  const e = document.createElement(tag);
  if (value !== undefined) e.textContent = value;
  return e;
};
export function questionForm(candidate, q, submit) {
  const form = node('form');
  form.className = 'candidate-question-form';
  const key = `jobloop-question:${candidate}:${q.id}`;
  let draft = {};
  try {
    draft = JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {}
  const formFields = node('div');
  formFields.className = 'question-fields';
  const freeBox = node('div'),
    freeInput = node('textarea'),
    freeLabel = node('label', 'Write your answer');
  freeInput.setAttribute('aria-label', 'Write your answer');
  freeInput.maxLength = 10000;
  freeInput.placeholder = 'Write your answer in your own words…';
  freeLabel.append(freeInput);
  freeBox.append(freeLabel);
  let mode = 'form';
  const modeKey = key + ':mode',
    textKey = key + ':text';
  try {
    mode = ['text', 'instruct'].includes(localStorage.getItem(modeKey))
      ? localStorage.getItem(modeKey)
      : 'form';
    freeInput.value = localStorage.getItem(textKey) ?? '';
  } catch {}
  const fields = q.fields ?? [{id: 'answer', label: q.question, type: 'text', required: true}],
    readers = new Map(),
    customKey = key + ':custom';
  let customDraft = {};
  try {
    customDraft = JSON.parse(localStorage.getItem(customKey) ?? '{}');
  } catch {}
  const save = () => {
    const values = Object.fromEntries([...readers].map(([id, read]) => [id, read()]));
    try {
      localStorage.setItem(key, JSON.stringify(values));
      localStorage.setItem(customKey, JSON.stringify(customDraft));
    } catch {}
  };
  for (const f of fields) {
    const box = node('fieldset'),
      legend = node('legend', f.label + (f.required ? ' *' : ''));
    box.append(legend);
    if (f.help) box.append(node('p', f.help));
    if (f.type === 'multiselect') {
      const checks = f.options.map((option) => {
        const label = node('label'),
          input = node('input');
        input.type = 'checkbox';
        input.value = option;
        input.checked = Array.isArray(draft[f.id]) && draft[f.id].includes(option);
        input.onchange = save;
        label.append(input, node('span', option));
        box.append(label);
        return input;
      });
      readers.set(f.id, () => checks.filter((i) => i.checked).map((i) => i.value));
    } else if (f.type === 'boolean' || f.type === 'select') {
      const select = node('select');
      select.setAttribute('aria-label', f.label);
      select.required = f.required;
      select.append(new Option('Select…', ''));
      for (const option of f.type === 'boolean' ? ['Yes', 'No'] : f.options)
        select.append(new Option(option, f.type === 'boolean' ? String(option === 'Yes') : option));
      let customValue = '__custom_answer__';
      while ([...select.options].some((option) => option.value === customValue)) customValue += '_';
      select.append(new Option('I’ll write my own', customValue));
      const state = (customDraft[f.id] ??= {enabled: false, text: ''}),
        customInput = node('textarea');
      customInput.setAttribute('aria-label', `${f.label} — your own answer`);
      customInput.placeholder = 'Write your answer in your own words…';
      customInput.maxLength = 5000;
      customInput.value = state.text ?? '';
      if (state.enabled) select.value = customValue;
      else if (draft[f.id] !== undefined && draft[f.id] !== null)
        select.value = String(draft[f.id]);
      const syncCustom = () => {
        state.enabled = select.value === customValue;
        customInput.hidden = !state.enabled;
        customInput.disabled = !state.enabled;
        customInput.required = !!f.required && state.enabled;
        customInput.setCustomValidity(
          state.enabled && f.required && !customInput.value.trim() ? 'Write your answer.' : '',
        );
      };
      select.onchange = () => {
        syncCustom();
        save();
        if (state.enabled) customInput.focus();
      };
      customInput.oninput = () => {
        state.text = customInput.value;
        syncCustom();
        save();
      };
      syncCustom();
      box.append(select, customInput);
      readers.set(f.id, () =>
        state.enabled
          ? customInput.value.trim() || null
          : select.value === ''
            ? null
            : f.type === 'boolean'
              ? select.value === 'true'
              : select.value,
      );
    } else {
      const input = node(f.type === 'text' ? 'textarea' : 'input');
      if (f.type !== 'text') input.type = f.type;
      if (f.type === 'number') input.step = 'any';
      input.required = f.required;
      input.setAttribute('aria-label', f.label);
      input.value = draft[f.id] ?? '';
      input.oninput = save;
      box.append(input);
      readers.set(f.id, () =>
        input.value === '' ? null : f.type === 'number' ? Number(input.value) : input.value,
      );
    }
    formFields.append(box);
  }
  const error = node('p');
  error.className = 'question-form-error';
  error.setAttribute('role', 'alert');
  const button = node('button', q.fields ? 'Send answers' : 'Answer');
  button.className = 'primary';
  button.type = 'submit';
  if (q.fields) {
    const modes = node('div');
    modes.className = 'question-answer-modes';
    const structured = node('button', 'Fill in the form'),
      written = node('button', 'Answer in writing'),
      instruct = node('button', 'Instruct the agent');
    for (const b of [structured, written, instruct]) b.type = 'button';
    // An instruction reaches the agent as a request for this task, not as a
    // saved answer, so it never turns into a fact for other records.
    const setMode = (value) => {
      mode = value;
      const free = mode !== 'form',
        label = mode === 'instruct' ? 'Tell the agent what to do' : 'Write your answer';
      formFields.hidden = free;
      freeBox.hidden = !free;
      for (const fieldset of formFields.querySelectorAll('fieldset')) fieldset.disabled = free;
      freeInput.disabled = !free;
      freeInput.required = free;
      freeLabel.firstChild.textContent = label;
      freeInput.setAttribute('aria-label', label);
      freeInput.placeholder =
        mode === 'instruct'
          ? 'For example: write a cover letter for this listing from my CV and upload it…'
          : 'Write your answer in your own words…';
      structured.setAttribute('aria-pressed', String(mode === 'form'));
      written.setAttribute('aria-pressed', String(mode === 'text'));
      instruct.setAttribute('aria-pressed', String(mode === 'instruct'));
      button.textContent =
        mode === 'instruct' ? 'Send instruction' : mode === 'text' ? 'Send answer' : 'Send answers';
      error.textContent = '';
      try {
        localStorage.setItem(modeKey, mode);
      } catch {}
    };
    structured.onclick = () => setMode('form');
    written.onclick = () => {
      setMode('text');
      freeInput.focus();
    };
    freeInput.oninput = () => {
      try {
        localStorage.setItem(textKey, freeInput.value);
      } catch {}
    };
    instruct.onclick = () => {
      setMode('instruct');
      freeInput.focus();
    };
    modes.append(structured, written, instruct);
    form.append(modes, formFields, freeBox);
    setMode(mode);
  } else {
    mode = 'form';
    form.append(formFields);
  }
  form.append(error, button);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    const values = Object.fromEntries([...readers].map(([id, read]) => [id, read()]));
    for (const f of fields)
      if (mode === 'form' && f.required && Array.isArray(values[f.id]) && !values[f.id].length) {
        error.textContent = `${f.label}: select at least one option`;
        return;
      }
    // Mixed choice/written replies use the existing free-text answer path so a
    // custom answer is never coerced into a boolean or an allowed option.
    const hasCustom = fields.some((f) => customDraft[f.id]?.enabled),
      writtenAnswers = () =>
        fields
          .filter((f) => values[f.id] !== null && values[f.id] !== undefined && values[f.id] !== '')
          .map((f) => {
            const value = values[f.id];
            return `${f.label}: ${typeof value === 'boolean' ? (value ? 'Yes' : 'No') : Array.isArray(value) ? value.join(', ') : value}`;
          })
          .join('\n');
    button.disabled = true;
    error.textContent = '';
    try {
      await submit(
        q.fields && mode === 'instruct'
          ? {instruction: freeInput.value}
          : q.fields && mode === 'text'
            ? freeInput.value
            : q.fields
              ? hasCustom
                ? writtenAnswers()
                : values
              : values.answer,
      );
      localStorage.removeItem(key);
      localStorage.removeItem(modeKey);
      localStorage.removeItem(textKey);
      localStorage.removeItem(customKey);
    } catch (e) {
      error.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  if (asksForLogin(q)) {
    const recheck = node('button', 'Recheck sign-in status');
    recheck.type = 'button';
    recheck.className = 'quiet';
    recheck.onclick = async () => {
      if (button.disabled || recheck.disabled) return;
      button.disabled = true;
      recheck.disabled = true;
      error.textContent = '';
      try {
        await submit(
          'Recheck the current sign-in status. Open the listing, follow the real application link and read the page you reach again. Do not assume the earlier sign-in block still applies. This reply does not confirm that sign-in happened and does not approve submitting the application.',
        );
        localStorage.removeItem(key);
        localStorage.removeItem(modeKey);
        localStorage.removeItem(textKey);
      } catch (e) {
        error.textContent = e.message;
      } finally {
        button.disabled = false;
        recheck.disabled = false;
      }
    };
    form.append(recheck);
  }
  return form;
}
