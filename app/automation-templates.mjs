// @ts-check
import {jobSearchTemplate} from './templates/job-search/template.mjs';
import {exampleTemplates} from './templates/examples.mjs';
import {saveScoreThreshold} from './score-thresholds.mjs';
import {withAgentDefaults} from './agent-settings.mjs';
import {templateContract} from './template-contract.mjs';
export const automationTemplates = [jobSearchTemplate, ...exampleTemplates];
export function automationTemplate(id) {
  const template = automationTemplates.find((t) => t.id === id);
  if (!template) throw Error('Template bulunamadı');
  return templateContract(structuredClone(template));
}
export const defaultAutomationSettings = withAgentDefaults();

export function webUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error('Geçerli bir web adresi gir');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('Kullanıcı bilgisi içermeyen HTTP veya HTTPS adresi gerekli');
  if (!url.hash) url.hash = '';
  return url.toString();
}
export function boundedText(value, label, max = 12000, {empty = false} = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max)
    throw Error(`${label}: ${empty ? '0' : '1'}–${max} karakter gerekli`);
  return value.trim();
}
export function normalizeSourceUrls(sources) {
  if (!Array.isArray(sources) || sources.length > 20) throw Error('En fazla 20 kaynak ekle');
  return [...new Set(sources.map(webUrl))];
}
export function planInput(template, input, previous = {}) {
  const criteria = input.criteria ?? previous.criteria ?? {};
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria))
    throw Error('Kriterler geçersiz');
  const allowed = new Set(template.fields.map((f) => f.id));
  for (const key of Object.keys(criteria))
    if (!allowed.has(key))
      throw Error('Bilinmeyen kriter: ' + key + '. Geçerli alanlar: ' + [...allowed].join(', '));
  saveScoreThreshold(criteria);
  const sources = normalizeSourceUrls(input.sources ?? previous.sources ?? []);
  for (const f of template.fields) {
    const value = criteria[f.id];
    if (value == null || value === '') continue;
    if (
      ['number', 'money'].includes(f.type) &&
      (!Number.isFinite(Number(value)) || String(value).trim() === '')
    )
      throw Error(f.label + ': sayı gerekli');
    if (f.type === 'boolean' && !['true', 'false'].includes(value))
      throw Error(f.label + ': evet/hayır gerekli');
    if (f.type === 'choice' && !f.options?.includes(value))
      throw Error(f.label + ': geçerli seçenek gerekli');
    if (
      f.type === 'date' &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw Error(f.label + ': geçerli tarih gerekli');
    if (f.type === 'url') webUrl(value);
  }
  return {
    title: boundedText(input.title ?? previous.title ?? template.title, 'Ad', 150),
    goal: boundedText(input.goal ?? previous.goal ?? '', 'Amaç', 6000, {empty: true}),
    criteria: Object.fromEntries(
      Object.entries(criteria).map(([key, value]) => [
        key,
        boundedText(value, key, 6000, {empty: true}),
      ]),
    ),
    sources,
    instructions: boundedText(input.instructions ?? previous.instructions ?? '', 'İşleyiş', 12000, {
      empty: true,
    }),
    facts: boundedText(input.facts ?? previous.facts ?? '', 'Kişisel bilgiler', 12000, {
      empty: true,
    }),
  };
}
export function missingProfileFields(
  automation,
  template = automationTemplate(automation.templateId),
) {
  return [
    ...(!automation.goal ? ['Amaç'] : []),
    ...template.fields.filter((f) => f.required && !automation.criteria[f.id]).map((f) => f.label),
  ];
}
export function missingPlanFields(
  automation,
  template = automationTemplate(automation.templateId),
) {
  return [
    ...missingProfileFields(automation, template),
    ...(!automation.sources.length ? ['En az bir kaynak adresi'] : []),
  ];
}
export function reusableTemplate(input, normalize = templateContract) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Template geçersiz');
  if (
    !Array.isArray(input.fields) ||
    input.fields.length > 20 ||
    !Array.isArray(input.steps) ||
    input.steps.length < 1 ||
    input.steps.length > 12
  )
    throw Error('Template soruları ve adımları eksik');
  const fields = input.fields.map((f) => {
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(f.id) || typeof f.required !== 'boolean')
      throw Error('Geçersiz soru alanı');
    return {
      id: f.id,
      label: boundedText(f.label, 'Alan adı', 150),
      question: boundedText(f.question, 'Soru', 1000),
      required: f.required,
      type: ['text', 'number', 'money', 'date', 'url', 'boolean', 'choice'].includes(f.type)
        ? f.type
        : 'text',
      ...(f.options ? {options: f.options.map((v) => boundedText(v, 'Seçenek', 150))} : {}),
    };
  });
  if (new Set(fields.map((f) => f.id)).size !== fields.length)
    throw Error('Soru alanları benzersiz olmalı');
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
    title: boundedText(input.title, 'Template adı', 150),
    description: boundedText(input.description, 'Açıklama', 1000),
    fields,
    steps: input.steps.map((step) => boundedText(step, 'Adım', 500)),
    guidance: boundedText(input.guidance ?? '', 'İşleyiş', 12000, {empty: true}),
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
      title: 'İşlem akışı',
      columns: [
        column('source', 'Kaynak'),
        column('title', 'İlan'),
        column('score', 'Puan', 'number'),
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
    throw Error('Tablo 2–10 sütun içermeli');
  const keys = new Set();
  const columns = input.columns.map((c) => {
    if (
      !c ||
      typeof c.key !== 'string' ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(c.key) ||
      reserved.has(c.key) ||
      keys.has(c.key)
    )
      throw Error('Geçersiz veya yinelenen sütun anahtarı');
    keys.add(c.key);
    if (!types.has(c.type) || (builtins.has(c.key) && c.type !== 'text'))
      throw Error('Geçersiz sütun türü');
    return {key: c.key, label: boundedText(c.label, 'Sütun adı', 60), type: c.type};
  });
  if (![...builtins].every((key) => keys.has(key)))
    throw Error('Kaynak ve başlık sütunları korunmalı');
  return {title: boundedText(input.title, 'Tablo adı', 120), columns};
}
// Collector display values may be shortened; callers retain full evidence in RAM.
// Explicit cell updates still pass through the strict validator below.
export function automationTextCells(values, table) {
  return table.columns
    .filter((c) => c.type === 'text' && !builtins.has(c.key) && Object.hasOwn(values, c.key))
    .map((c) => {
      const value = values[c.key].trim();
      return {
        key: c.key,
        value:
          value.length <= cellTextLimit
            ? value
            : value.slice(0, cellTextLimit - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…',
      };
    });
}
export function automationCells(input, table) {
  if (!Array.isArray(input) || input.length > 10) throw Error('En fazla 10 hücre güncellenebilir');
  const cells = {},
    columns = new Map(table.columns.map((c) => [c.key, c]));
  for (const entry of input) {
    if (builtins.has(entry?.key)) continue;
    const c = columns.get(entry?.key);
    if (!c || builtins.has(c.key) || Object.hasOwn(cells, c.key))
      throw Error(
        `Hücre için tanımlı, benzersiz bir özel sütun gerekli. Geçersiz anahtar: ${String(entry?.key)}. source ve title uygulama tarafından doldurulur; cells içine ekleme. Yazılabilir sütunlar: ${table.columns
          .filter((column) => !builtins.has(column.key))
          .map((column) => column.key)
          .join(', ')}. Kaydı bu sütunlarla tekrar gönder.`,
      );
    let value = boundedText(entry.value, 'Hücre değeri', cellTextLimit, {empty: true});
    if (value && ['number', 'money'].includes(c.type)) {
      if (!/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)))
        throw Error('Sayısal hücre noktalı ondalık sayı olmalı');
      value = String(Number(value));
    }
    if (
      value &&
      c.type === 'date' &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw Error('Tarih YYYY-MM-DD biçiminde olmalı');
    if (value && c.type === 'url') value = webUrl(value);
    cells[c.key] = value;
  }
  return cells;
}
