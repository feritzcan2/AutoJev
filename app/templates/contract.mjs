// @ts-check
import {browserDefinition} from './browser-definition.mjs';
import {normalizeTemplateSources} from './sources.mjs';
import {normalizeRecordOperations, withScoringFields} from '../records/operation-definitions.mjs';
import {normalizeMailContract} from './mail-contract.mjs';
const key = /^[a-z][a-z0-9_-]{0,59}$/;
const text = (value, label, max = 6000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw Error('Invalid ' + label);
  return value.trim();
};
export function templateContract(input, driver = browserDefinition) {
  const execution = input.execution ?? {driver: driver.id};
  if (execution.driver !== driver.id) throw Error('Unsupported template driver');
  const maxWorkers = execution.maxWorkers ?? 8;
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8)
    throw Error('The worker limit must be 1–8');
  const defaults = driver.workflow;
  const workflow = (input.workflow ?? defaults).map((step) => {
    if (
      !key.test(step.id) ||
      !driver.capabilities[step.capability] ||
      !['source', 'record'].includes(step.scope) ||
      !Array.isArray(step.after ?? [])
    )
      throw Error('Invalid template step');
    return {
      id: step.id,
      capability: step.capability,
      effect: driver.capabilities[step.capability].effect,
      scope: step.scope,
      instructions: text(step.instructions, 'step instructions'),
      after: [...new Set(step.after ?? [])],
    };
  });
  if (
    !workflow.length ||
    workflow.length > 20 ||
    new Set(workflow.map((s) => s.id)).size !== workflow.length
  )
    throw Error('Steps must be unique and number 1–20');
  const visited = new Set(),
    visiting = new Set(),
    byId = new Map(workflow.map((s) => [s.id, s]));
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id) || !byId.has(id)) throw Error('Invalid template step dependency');
    visiting.add(id);
    for (const parent of byId.get(id).after) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of workflow) visit(step.id);
  const records = input.records ?? {},
    states = (records.states ?? driver.records.states).map((s) => {
      if (!key.test(s.id)) throw Error('Invalid record state');
      return {id: s.id, label: text(s.label, 'state name', 100)};
    });
  if (
    !states.length ||
    states.length > 40 ||
    new Set(states.map((s) => s.id)).size !== states.length
  )
    throw Error('Record states must be unique');
  const stateIds = new Set(states.map((s) => s.id));
  const actions = (records.actions ?? []).map((a) => {
    if (
      !key.test(a.id) ||
      !stateIds.has(a.to) ||
      !Array.isArray(a.from) ||
      !a.from.length ||
      a.from.some((s) => !stateIds.has(s))
    )
      throw Error('Invalid record transition');
    return {id: a.id, label: text(a.label, 'action name', 100), from: a.from, to: a.to};
  });
  if (actions.length > 30 || new Set(actions.map((a) => a.id)).size !== actions.length)
    throw Error('Actions must be unique');
  if (records.initial && !stateIds.has(records.initial))
    throw Error('The initial state must be defined');
  const bindings = records.bindings ?? driver.records.bindings;
  for (const [name, value] of Object.entries(bindings))
    if (
      !key.test(name) ||
      !key.test(value) ||
      ['__proto__', 'constructor', 'prototype'].includes(value)
    )
      throw Error('Invalid field binding');
  const identity = records.identity ?? 'key';
  if (!['url', 'key'].includes(identity)) throw Error('Invalid record identity rule');
  const recordOperations = normalizeRecordOperations(input.recordOperations, driver);
  if (workflow.some((step) => Object.values(recordOperations).some((op) => op.id === step.id)))
    throw Error('A record operation id cannot repeat in the workflow');
  return {
    ...input,
    version: 2,
    kind: driver.kind,
    ...(driver.id === 'browser' ? {fields: withScoringFields(input.fields ?? [])} : {}),
    mail: normalizeMailContract(input.mail),
    defaultSources: normalizeTemplateSources(input.defaultSources),
    execution: {driver: execution.driver, maxWorkers},
    workflow,
    recordOperations,
    records: {
      states,
      actions,
      bindings,
      identity,
      initial: records.initial ?? states[0].id,
      dismissLabel: text(records.dismissLabel ?? 'Dismiss record', 'dismiss button', 100),
    },
  };
}
export function findOperation(template, id) {
  return (
    template.workflow.find((s) => s.id === id) ??
    Object.values(template.recordOperations ?? {}).find((s) => s.id === id)
  );
}
export function operationFor(template, id) {
  const operation = findOperation(template, id);
  if (!operation) throw Error('Template step not found');
  return operation;
}
