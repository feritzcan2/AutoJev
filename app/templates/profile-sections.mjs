// @ts-check
import {scoringFields} from '../records/operation-definitions.mjs';

// Every template field belongs to one profile section. The section decides where
// the profile page shows the field and which reader receives it: candidate
// fields are facts about the user; the others say what to find and how to judge
// and act. A field without a section describes what to find.
export const PROFILE_SECTIONS = [
  {
    id: 'search',
    title: 'What you are looking for',
    description: 'The agent searches for results and evaluates them against these criteria.',
  },
  {
    id: 'candidate',
    title: 'About you',
    description: 'The agent uses only the details you give here and in your documents.',
  },
  {
    id: 'rules',
    title: 'Scoring',
    description: 'How results are eliminated and scored.',
  },
  {
    id: 'actions',
    title: 'Action permission',
    description: 'You choose which actions it may take.',
  },
];
export const PROFILE_SECTION_IDS = PROFILE_SECTIONS.map((s) => s.id);
// Fields in the 'board' section are settings the results board edits; the
// profile page omits them.
export const fieldSection = (field) => field?.section ?? 'search';

// Splits saved criteria into sections. The shared scoring fields are known
// without the template; other unknown keys count as search criteria.
export function profileView(automation, fields = []) {
  const byId = new Map([...scoringFields, ...fields].map((f) => [f.id, f]));
  /** @type {Record<string, {id: string, label: string, value: string}[]>} */
  const view = {search: [], candidate: [], rules: [], actions: [], board: []};
  for (const [id, value] of Object.entries(automation.criteria ?? {})) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const field = byId.get(id);
    view[fieldSection(field)].push({id, label: field?.label ?? id, value: value.trim()});
  }
  return view;
}

// The user's current facts: the free-text details and every candidate field.
export function candidateFacts(automation, fields = []) {
  return [
    automation.facts,
    ...profileView(automation, fields).candidate.map((f) => `${f.label}: ${f.value}`),
  ]
    .filter((x) => typeof x === 'string' && x.trim())
    .join('\n');
}
