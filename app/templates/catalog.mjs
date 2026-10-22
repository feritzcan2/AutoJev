// @ts-check
import {jobSearchTemplate} from './job-search/template.mjs';
import {exampleTemplates} from './examples.mjs';
import {saveScoreThreshold} from '../scoring/thresholds.mjs';
import {withAgentDefaults} from '../agents/settings.mjs';
import {templateContract} from './contract.mjs';
import {normalizeHardRules} from '../../src/hard-rules.js';
import {PROFILE_SECTION_IDS} from './profile-sections.mjs';
export const automationTemplates = [jobSearchTemplate, ...exampleTemplates];
export function automationTemplate(id) {
  const template = automationTemplates.find((t) => t.id === id);
  if (!template) throw Error('Template not found');
  return templateContract(structuredClone(template));
}
export const defaultAutomationSettings = withAgentDefaults();

export function webUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('Enter a valid web address');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('An HTTP or HTTPS address without user credentials is required');
  if (!url.hash) url.hash = '';
  return url.toString();
}
export function boundedText(value, label, max = 12000, {empty = false} = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max)
    throw Error(`${label}: ${empty ? '0' : '1'}–${max} characters required`);
  return value.trim();
}
export function normalizeSourceUrls(sources) {
  if (!Array.isArray(sources) || sources.length > 20) throw Error('Add at most 20 sources');
  return [...new Set(sources.map(webUrl))];
}
export function planInput(template, input, previous = {}) {
  const criteria = input.criteria ?? previous.criteria ?? {};
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria))
    throw Error('Invalid criteria');
  const allowed = new Set(template.fields.map((f) => f.id));
  for (const key of Object.keys(criteria))
    if (!allowed.has(key))
      throw Error('Unknown criterion: ' + key + '. Valid fields: ' + [...allowed].join(', '));
  saveScoreThreshold(criteria);
  const sources = normalizeSourceUrls(input.sources ?? previous.sources ?? []);
  for (const f of template.fields) {
    const value = criteria[f.id];
    if (value == null || value === '') continue;
    if (
      ['number', 'money'].includes(f.type) &&
      (!Number.isFinite(Number(value)) || String(value).trim() === '')
    )
      throw Error(f.label + ': a number is required');
    if (f.type === 'boolean' && !['true', 'false'].includes(value))
      throw Error(f.label + ': yes/no is required');
    if (f.type === 'choice' && !f.options?.includes(value))
      throw Error(f.label + ': a valid option is required');
    if (
      f.type === 'date' &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw Error(f.label + ': a valid date is required');
    if (f.type === 'url') webUrl(value);
    // A value recipes write into search addresses must be one plain value: a
    // note such as "Berlin (residence); remote worldwide" made every search
    // that took it return nothing (2026-10-20). A value saved before this rule
    // is checked only when it changes, so other settings can still be saved.
    if (
      f.searchValue &&
      value !== previous.criteria?.[f.id] &&
      (/[;()\n]/.test(value) || String(value).trim().length > 80)
    )
      throw Error(
        `${f.label}: one value as job sites write it (for example "${f.example}"), at most 80 characters, without notes in brackets or after ";". Leave it empty to search without it, and put other notes in the profile text.`,
      );
  }
  return {
    title: boundedText(input.title ?? previous.title ?? template.title, 'Name', 150),
    goal: boundedText(input.goal ?? previous.goal ?? '', 'Goal', 6000, {empty: true}),
    criteria: Object.fromEntries(
      Object.entries(criteria).map(([key, value]) => {
        const text = boundedText(value, key, 6000, {empty: true});
        return [
          key,
          template.fields.find((f) => f.id === key)?.type === 'rules'
            ? normalizeHardRules(text)
            : text,
        ];
      }),
    ),
    sources,
    instructions: boundedText(
      input.instructions ?? previous.instructions ?? '',
      'Instructions',
      12000,
      {
        empty: true,
      },
    ),
    facts: boundedText(input.facts ?? previous.facts ?? '', 'Personal facts', 12000, {
      empty: true,
    }),
  };
}
export function missingProfileFields(
  automation,
  template = automationTemplate(automation.templateId),
) {
  return [
    ...(!automation.goal ? ['Goal'] : []),
    ...template.fields.filter((f) => f.required && !automation.criteria[f.id]).map((f) => f.label),
  ];
}
export function missingPlanFields(
  automation,
  template = automationTemplate(automation.templateId),
) {
  return [
    ...missingProfileFields(automation, template),
    ...(!automation.sources.length ? ['At least one source address'] : []),
  ];
}
export function reusableTemplate(input, normalize = templateContract) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid template');
  if (
    !Array.isArray(input.fields) ||
    input.fields.length > 20 ||
    !Array.isArray(input.steps) ||
    input.steps.length < 1 ||
    input.steps.length > 12
  )
    throw Error('Template questions and steps are missing');
  const fields = input.fields.map((f) => {
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(f.id) || typeof f.required !== 'boolean')
      throw Error('Invalid question field');
    return {
      id: f.id,
      label: boundedText(f.label, 'Field name', 150),
      question: boundedText(f.question, 'Question', 1000),
      required: f.required,
      type: ['text', 'number', 'money', 'date', 'url', 'boolean', 'choice'].includes(f.type)
        ? f.type
        : 'text',
      ...(f.options ? {options: f.options.map((v) => boundedText(v, 'Option', 150))} : {}),
      ...(PROFILE_SECTION_IDS.includes(f.section) ? {section: f.section} : {}),
    };
  });
  if (new Set(fields.map((f) => f.id)).size !== fields.length)
    throw Error('Question fields must be unique');
  return normalize({
    version: 2,
    kind: input.kind ?? 'web',
    execution: input.execution,
    workflow: input.workflow,
    recordOperations: input.recordOperations,
    records: input.records,
    mail: input.mail,
    defaultSources: input.defaultSources,
    icon: '✳',
    title: boundedText(input.title, 'Template name', 150),
    description: boundedText(input.description, 'Description', 1000),
    fields,
    steps: input.steps.map((step) => boundedText(step, 'Step', 500)),
    guidance: boundedText(input.guidance ?? '', 'Instructions', 12000, {empty: true}),
    ...(input.assessmentHints
      ? {assessmentHints: boundedText(input.assessmentHints, 'Assessment hints', 2000)}
      : {}),
    defaultMode: 'observe',
    ...(input.table ? {table: automationTable(input.table)} : {}),
  });
}

const types = new Set(['text', 'number', 'money', 'date', 'url']);
const builtins = new Set(['source', 'title']);
const cellTextLimit = 2000;
const reserved = new Set([
  'status',
  'updatedAt',
  'actions',
  '__proto__',
  'constructor',
  'prototype',
]);
const column = (key, label, type = 'text') => ({key, label, type});
export function defaultAutomationTable(templateId) {
  const template = automationTemplates.find((t) => t.id === templateId);
  return structuredClone(
    template?.table ?? {
      title: 'Workflow',
      columns: [
        column('source', 'Source'),
        column('title', 'Listing'),
        column('score', 'Score', 'number'),
      ],
    },
  );
}

export function automationTable(input) {
  if (
    !input ||
    !Array.isArray(input.columns) ||
    input.columns.length < 2 ||
    input.columns.length > 10
  )
    throw Error('The table must have 2–10 columns');
  const keys = new Set();
  const columns = input.columns.map((c) => {
    if (
      !c ||
      typeof c.key !== 'string' ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(c.key) ||
      reserved.has(c.key) ||
      keys.has(c.key)
    )
      throw Error('Invalid or duplicate column key');
    keys.add(c.key);
    if (!types.has(c.type) || (builtins.has(c.key) && c.type !== 'text'))
      throw Error('Invalid column type');
    return {key: c.key, label: boundedText(c.label, 'Column name', 60), type: c.type};
  });
  if (![...builtins].every((key) => keys.has(key)))
    throw Error('The source and title columns must be kept');
  return {title: boundedText(input.title, 'Table name', 120), columns};
}
// Collector display values may be shortened; callers retain full evidence in RAM.
// Explicit cell updates still pass through the strict validator below.
export function automationTextCells(values, table) {
  return (
    table.columns
      // A site may not name every value (a card without its company).
      .filter(
        (c) =>
          c.type === 'text' &&
          !builtins.has(c.key) &&
          typeof values[c.key] === 'string' &&
          values[c.key].trim(),
      )
      .map((c) => {
        const value = values[c.key].trim();
        return {
          key: c.key,
          value:
            value.length <= cellTextLimit
              ? value
              : value.slice(0, cellTextLimit - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…',
        };
      })
  );
}
export function automationCells(input, table) {
  if (!Array.isArray(input) || input.length > 10) throw Error('At most 10 cells can be updated');
  const cells = {},
    columns = new Map(table.columns.map((c) => [c.key, c]));
  for (const entry of input) {
    if (builtins.has(entry?.key)) continue;
    const c = columns.get(entry?.key);
    if (!c || builtins.has(c.key) || Object.hasOwn(cells, c.key))
      throw Error(
        `Each cell needs a defined, unique custom column. Invalid key: ${String(entry?.key)}. The app fills source and title; do not add them to cells. Writable columns: ${table.columns
          .filter((column) => !builtins.has(column.key))
          .map((column) => column.key)
          .join(', ')}. Send the record again with these columns.`,
      );
    let value = boundedText(entry.value, 'Cell value', cellTextLimit, {empty: true});
    if (value && ['number', 'money'].includes(c.type)) {
      if (!/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
        throw Error('A numeric cell must be a decimal number with a dot');
      value = String(Number(value));
    }
    if (
      value &&
      c.type === 'date' &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw Error('The date must be in YYYY-MM-DD format');
    if (value && c.type === 'url') value = webUrl(value);
    cells[c.key] = value;
  }
  return cells;
}
