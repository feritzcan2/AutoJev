const string = {type: 'string', minLength: 1, maxLength: 2000};
export const questionFieldsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'label', 'type'],
    properties: {
      id: {...string, maxLength: 64},
      label: string,
      type: {type: 'string', enum: ['text', 'boolean', 'select', 'multiselect', 'date', 'number']},
      required: {type: 'boolean'},
      help: string,
      // A likely answer from the CV, saved facts or documents; the user confirms or edits it.
      suggested: string,
      options: {type: 'array', minItems: 2, maxItems: 20, items: {...string, maxLength: 200}},
    },
  },
};
// Asked by the app when a verify task ends without portal proof. The
// user knows the outcome; the chosen option resolves the record.
export const OUTCOME_FIELD = {
  id: 'outcome',
  type: 'select',
  label: 'Was this record submitted?',
  required: true,
  help: 'Not submitted makes the record sendable again; Submitted marks it complete.',
  options: ['Submitted', 'Not submitted, can be sent again', 'Don’t know, leave it uncertain'],
};
export function normalizeFields(fields) {
  if (fields === undefined || fields === null) return null;
  if (!Array.isArray(fields) || !fields.length || fields.length > 10)
    throw Error('A form must have 1–10 fields');
  const ids = new Set();
  return fields.map((f) => {
    if (!f || typeof f !== 'object' || !/^\w[\w-]{0,63}$/.test(f.id ?? '') || ids.has(f.id))
      throw Error('Field ids must be unique');
    ids.add(f.id);
    if (
      typeof f.label !== 'string' ||
      !f.label.trim() ||
      f.label.length > 2000 ||
      !['text', 'boolean', 'select', 'multiselect', 'date', 'number'].includes(f.type)
    )
      throw Error('Invalid form field');
    if (f.required !== undefined && typeof f.required !== 'boolean')
      throw Error('Invalid required flag');
    if (f.help !== undefined && (typeof f.help !== 'string' || f.help.length > 2000))
      throw Error('Invalid field help text');
    if (f.suggested !== undefined && (typeof f.suggested !== 'string' || f.suggested.length > 2000))
      throw Error('Invalid suggested answer');
    const field = {
      id: f.id,
      label: f.label.trim(),
      type: f.type,
      required: f.required !== false,
      ...(f.help ? {help: f.help} : {}),
      ...(f.suggested?.trim() ? {suggested: f.suggested.trim()} : {}),
    };
    if (['select', 'multiselect'].includes(f.type)) {
      if (
        !Array.isArray(f.options) ||
        f.options.length < 2 ||
        f.options.length > 20 ||
        f.options.some((v) => typeof v !== 'string' || !v.trim() || v.length > 200) ||
        new Set(f.options).size !== f.options.length
      )
        throw Error('Unique answer options are required');
      field.options = f.options;
    }
    return field;
  });
}
export function validateAnswers(fields, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw Error('Form answers are required');
  if (Object.keys(values).some((id) => !fields.some((f) => f.id === id)))
    throw Error('Unknown answer field');
  const result = {};
  for (const f of fields) {
    const v = values[f.id],
      empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) {
      if (f.required) throw Error(`${f.label}: an answer is required`);
      continue;
    }
    let valid = false;
    if (f.type === 'text') valid = typeof v === 'string' && v.trim().length > 0 && v.length <= 5000;
    if (f.type === 'boolean') valid = typeof v === 'boolean';
    if (f.type === 'number') valid = typeof v === 'number' && Number.isFinite(v);
    if (f.type === 'select') valid = f.options.includes(v);
    if (f.type === 'multiselect')
      valid =
        Array.isArray(v) &&
        v.length <= f.options.length &&
        new Set(v).size === v.length &&
        v.every((item) => f.options.includes(item));
    if (f.type === 'date')
      valid =
        typeof v === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(v) &&
        Number.isFinite(Date.parse(v)) &&
        new Date(v).toISOString().slice(0, 10) === v;
    if (!valid) throw Error(`${f.label}: a valid answer is required`);
    result[f.id] = v;
  }
  const summary = fields
    .filter((f) => Object.hasOwn(result, f.id))
    .map(
      (f) =>
        `${f.label}: ${typeof result[f.id] === 'boolean' ? (result[f.id] ? 'Yes' : 'No') : Array.isArray(result[f.id]) ? result[f.id].join(', ') : result[f.id]}`,
    )
    .join('\n');
  if (!summary || summary.length > 10000) throw Error('The answer is empty or too long');
  return {values: result, summary};
}
