import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_SECTION_IDS,
  fieldSection,
  profileView,
  candidateFacts,
} from '../app/templates/profile-sections.mjs';
import {automationTemplate, reusableTemplate} from '../app/templates/catalog.mjs';
import {scoringSources} from '../app/scoring/profile.mjs';
import {jevCriteria} from '../app/jev/triage.mjs';
import {jevProfileStatus, saveJevProfile} from '../app/jev/qualification-profile.mjs';

const template = automationTemplate('job-search');
const automation = {
  templateId: 'job-search',
  goal: 'Backend roles in Berlin',
  facts: 'German C1',
  instructions: 'Prefer product companies.',
  criteria: {
    preferences: 'Staff backend, hybrid Berlin',
    experience: 'Nine years of .NET and AWS',
    application_facts: 'EU work permit; notice period 3 months',
    application_policy: 'Never apply twice to one company',
    ranking: 'Seniority match 40, stack 30',
    score_threshold: '70',
    save_score_threshold: '40',
  },
};

test('every built-in field belongs to a known section', () => {
  for (const field of template.fields)
    assert.ok(
      [...PROFILE_SECTION_IDS, 'board'].includes(fieldSection(field)),
      field.id + ' has no profile section',
    );
  const section = (id) => fieldSection(template.fields.find((f) => f.id === id));
  assert.equal(section('preferences'), 'search');
  assert.equal(section('experience'), 'candidate');
  assert.equal(section('hard_rules'), 'rules');
  assert.equal(section('score_threshold'), 'actions');
  assert.equal(section('save_score_threshold'), 'board');
});

test('the profile view splits criteria by section and knows scoring fields without a template', () => {
  const view = profileView(automation, template.fields);
  assert.deepEqual(
    view.candidate.map((f) => f.id),
    ['experience', 'application_facts'],
  );
  assert.deepEqual(
    view.search.map((f) => f.id),
    ['preferences'],
  );
  assert.deepEqual(
    profileView(automation).board.map((f) => f.id),
    ['save_score_threshold'],
  );
  assert.deepEqual(
    profileView(automation).candidate,
    [],
    'without the template an unknown field is a search criterion',
  );
  assert.match(candidateFacts(automation, template.fields), /^German C1\nExperience and skills: /);
});

test('scoring reads facts about the user as facts, not as preferences', () => {
  const sources = scoringSources(automation, undefined, template.fields);
  assert.match(sources.facts.text, /German C1/);
  assert.match(sources.facts.text, /Nine years of \.NET/);
  assert.match(sources.facts.text, /EU work permit/);
  assert.doesNotMatch(sources.preferences.text, /Nine years|EU work permit/);
  assert.match(sources.preferences.text, /Staff backend/);
  assert.match(sources.preferences.text, /Never apply twice/);
  assert.doesNotMatch(sources.preferences.text, /Seniority match|\b70\b|\b40\b/);
});

test('Jev receives candidate fields once, in the user profile', () => {
  const context = jevCriteria(automation, {text: 'CV', digest: 'cv'}, template);
  assert.equal(context.criteria.experience, undefined);
  assert.equal(context.criteria.preferences, automation.criteria.preferences);
  assert.match(context.userProfile.currentFacts.text, /Nine years of \.NET/);
  assert.equal(
    jevCriteria(automation, undefined, template).criteria.experience,
    automation.criteria.experience,
    'without a user profile the criteria stay complete',
  );
});

test('a changed candidate field makes the short Jev profile stale', () => {
  let saved = {...automation, id: 'w'};
  const db = {get: () => saved, put: (a) => (saved = a), now: () => 1},
    cv = {text: 'CV', digest: 'cv'};
  saveJevProfile(db, 'w', 'Nine years .NET; EU permit', 'agent', cv, template.fields);
  assert.equal(jevProfileStatus(saved, cv, template.fields), 'current');
  const changed = {
    ...saved,
    criteria: {...saved.criteria, experience: 'Two years of Python'},
  };
  assert.equal(jevProfileStatus(changed, cv, template.fields), 'stale');
  const search = {...saved, criteria: {...saved.criteria, preferences: 'Remote only'}};
  assert.equal(jevProfileStatus(search, cv, template.fields), 'current');
});

test('a profile without candidate fields keeps its earlier Jev basis', () => {
  let saved = {id: 'w', facts: 'German C1', criteria: {preferences: 'x'}};
  const db = {get: () => saved, put: (a) => (saved = a), now: () => 1},
    cv = {text: 'CV', digest: 'cv'};
  saveJevProfile(db, 'w', 'German C1', 'agent', cv);
  assert.equal(jevProfileStatus(saved, cv, template.fields), 'current');
});

test('custom templates may place a field in a section; unknown sections are dropped', () => {
  const custom = reusableTemplate({
    title: 'Flat search',
    description: 'Find a flat.',
    steps: ['Find flats'],
    fields: [
      {id: 'area', label: 'Area', question: 'Where?', required: true, section: 'search'},
      {id: 'income', label: 'Income', question: 'Income?', required: false, section: 'candidate'},
      {id: 'odd', label: 'Odd', question: 'Odd?', required: false, section: 'nowhere'},
    ],
  });
  const section = (id) => fieldSection(custom.fields.find((f) => f.id === id));
  assert.equal(section('income'), 'candidate');
  assert.equal(section('odd'), 'search');
});
