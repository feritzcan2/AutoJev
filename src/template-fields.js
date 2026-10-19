import {HARD_RULE_CHOICES, MAX_HARD_RULES, parseHardRules, formatHardRules} from './hard-rules.js';

// Elimination rules: one row per rule (choice + condition). The rows write the
// saved one-rule-per-line text into a hidden textarea named like any field.
export function rulesField(name, legend, value = '', hint = '') {
  const root = document.createElement('fieldset'),
    title = document.createElement('legend'),
    list = document.createElement('div'),
    add = document.createElement('button'),
    store = document.createElement('textarea');
  root.className = 'rules-field';
  title.textContent = legend;
  list.className = 'rules-list';
  add.type = 'button';
  add.className = 'quiet';
  add.textContent = 'Add rule';
  store.name = name;
  store.hidden = true;
  store.value = value ?? '';
  const sync = () => {
    store.value = formatHardRules(
      [...list.children].map((row) => ({
        ifNotStated: row.querySelector('select').value,
        rule: row.querySelector('input').value,
      })),
    );
    add.disabled = list.children.length >= MAX_HARD_RULES;
    store.dispatchEvent(new Event('input', {bubbles: true}));
  };
  const row = (rule = {ifNotStated: 'hold', rule: ''}) => {
    const item = document.createElement('div'),
      choice = document.createElement('select'),
      condition = document.createElement('input'),
      remove = document.createElement('button');
    item.className = 'rule-row';
    for (const [key, label] of Object.entries(HARD_RULE_CHOICES))
      choice.add(new Option(label, key));
    choice.value = rule.ifNotStated;
    choice.setAttribute('aria-label', 'When a listing does not mention it');
    condition.value = rule.rule;
    condition.maxLength = 400;
    condition.placeholder = 'E.g. Outside Berlin, the role is fully remote within Germany';
    condition.setAttribute('aria-label', 'Condition');
    remove.type = 'button';
    remove.className = 'quiet';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      item.remove();
      sync();
    });
    // Typing changes the text only; the hidden value follows on every edit.
    choice.addEventListener('change', sync);
    condition.addEventListener('input', sync);
    item.append(choice, condition, remove);
    list.append(item);
    return item;
  };
  for (const rule of parseHardRules(value)) row(rule);
  add.addEventListener('click', () => {
    row().querySelector('input').focus();
    sync();
  });
  add.disabled = list.children.length >= MAX_HARD_RULES;
  root.append(title);
  if (hint) {
    const help = document.createElement('small');
    help.textContent = hint;
    root.append(help);
  }
  root.append(list, add, store);
  return root;
}
export const RULES_HINT =
  'A listing that contradicts a rule is eliminated. For a listing that does not mention a rule: Accept counts it as met, Reject eliminates it, Hold keeps it for your decision instead of applying automatically.';

export function templateFields(root, fields, values = {}, prefix = 'criteria-') {
  root.replaceChildren();
  for (const field of fields) {
    // A replaced field shows only while it still holds text to move.
    if (field.legacy && !String(values[field.id] ?? '').trim()) continue;
    if (field.type === 'rules') {
      root.append(rulesField(prefix + field.id, field.label, values[field.id], RULES_HINT));
      continue;
    }
    const label = document.createElement('label');
    label.textContent = field.label;
    const select = ['choice', 'boolean'].includes(field.type),
      input = document.createElement(
        select ? 'select' : field.type && field.type !== 'text' ? 'input' : 'textarea',
      );
    input.name = prefix + field.id;
    input.required = field.required;
    input.maxLength = 6000;
    if (select) {
      input.add(new Option('Select…', ''));
      for (const [value, title] of field.type === 'boolean'
        ? [
            ['true', 'Yes'],
            ['false', 'No'],
          ]
        : (field.options ?? []).map((value) => [value, value]))
        input.add(new Option(title, value));
    } else if (input.tagName === 'INPUT') {
      input.type = ['number', 'money'].includes(field.type) ? 'number' : field.type;
      input.step = 'any';
    }
    input.placeholder = field.question;
    input.value = values[field.id] ?? '';
    label.append(input);
    root.append(label);
  }
}
export const templateValues = (form, fields, prefix = 'criteria-') =>
  Object.fromEntries(fields.map((f) => [f.id, form.elements[prefix + f.id]?.value ?? '']));
