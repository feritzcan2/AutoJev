import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringPolicy, SCORING_INSTRUCTIONS} from '../app/scoring/policy.mjs';
import {scoringSources} from '../app/scoring/profile.mjs';
import {recordAssessment} from '../app/scoring/record-scoring.mjs';
import {automationTemplates, automationTemplate, planInput} from '../app/templates/catalog.mjs';
const profile = {
  revision: 5,
  goal: 'Find a quiet flat',
  criteria: {
    ranking: 'Quiet street and balcony matter most.',
    score_threshold: '70',
    location: 'Berlin',
  },
  facts: 'Two adults, no pets.',
};

test('the scoring policy is the same for every template: a rubric text and a threshold', () => {
  assert.equal(scoringPolicy(profile).threshold, 70);
  assert.equal(scoringPolicy({criteria: {}}).threshold, 60);
  for (const criteria of [
    {score_threshold: '101'},
    {score_threshold: '0'},
    {score_threshold: '70.5'},
  ])
    assert.throws(() => scoringPolicy({criteria}));
  assert.notEqual(scoringPolicy(profile).digest, scoringPolicy({...profile, revision: 6}).digest);
  assert.notEqual(
    scoringPolicy(profile).digest,
    scoringPolicy({...profile, criteria: {...profile.criteria, ranking: 'Price matters most.'}})
      .digest,
  );
  assert.equal(scoringPolicy(profile).weights, undefined);
  assert.match(SCORING_INSTRUCTIONS, /criteria\.ranking/);
  assert.match(SCORING_INSTRUCTIONS, /scoringPolicy\.threshold/);
  assert.doesNotMatch(SCORING_INSTRUCTIONS, /candidate|employer|seniority|technical|job/i);
});

test('every template scores records and offers the shared scoring fields', () => {
  for (const {id} of automationTemplates) {
    const template = automationTemplate(id);
    assert.equal(template.recordOperations.score.capability, 'browser.evaluate', id);
    assert.deepEqual(
      template.fields.filter((f) => ['ranking', 'score_threshold'].includes(f.id)).map((f) => f.id),
      ['ranking', 'score_threshold'],
      id,
    );
    assert.equal(template.fields.find((f) => f.id === 'save_score_threshold').type, 'number', id);
    assert.equal(
      template.fields.some((f) => f.id.startsWith('weight_')),
      false,
      id,
    );
  }
});

test('minimum save score is optional, independent of actions, and validated when saving the profile', () => {
  const template = automationTemplate('housing');
  for (const value of [undefined, '', '0', '60', '100']) {
    const criteria = value === undefined ? {} : {save_score_threshold: value};
    const policy = scoringPolicy({criteria});
    assert.equal(policy.saveThreshold, value === undefined || value === '' ? null : Number(value));
    assert.equal(policy.threshold, 60);
    assert.doesNotThrow(() => planInput(template, {criteria}));
  }
  for (const value of ['-1', '101', '60.5', 'invalid']) {
    assert.throws(
      () => scoringPolicy({criteria: {save_score_threshold: value}}),
      /Minimum score to save/,
    );
    assert.throws(
      () => planInput(template, {criteria: {save_score_threshold: value}}),
      /Minimum score to save/,
    );
  }
  const criteria = {...profile.criteria, save_score_threshold: '43'};
  assert.notEqual(scoringPolicy(profile).digest, scoringPolicy({...profile, criteria}).digest);
  assert.doesNotMatch(scoringSources({...profile, criteria}).preferences.text, /43/);
});

test('scoring preferences come from the goal and saved criteria of any template', () => {
  const preferences = scoringSources(profile).preferences.text;
  assert.match(preferences, /quiet flat/);
  assert.match(preferences, /Berlin/);
  assert.doesNotMatch(
    preferences,
    /balcony|70/,
    'the rubric and threshold are not user preferences',
  );
  assert.equal(scoringSources(profile).facts.text, 'Two adults, no pets.');
});

test('record writes save the supplied score without a mandatory breakdown', () => {
  const url = 'https://example.test/flat',
    a = {...profile, templateId: 'housing'},
    run = {
      id: 'run',
      automationId: 'one',
      revision: 5,
      observations: [{url, evidence: 'Quiet flat with balcony'}],
    };
  const db = {get: () => a, template: () => ({fields: [{id: 'ranking'}]}), now: () => 1};
  const input = {
    status: 'scored',
    score: 88,
    summary: 'Quiet street.',
    evidenceUrl: url,
    evidence: 'Quiet flat with balcony',
    strengths: [],
    gaps: [],
    uncertainties: [],
  };
  const saved = recordAssessment(db, 'one', run, input);
  assert.equal(saved.score, 88);
  assert.equal(saved.rubric, profile.criteria.ranking);
  assert.equal(recordAssessment(db, 'one', run, {score: 75}).score, 75);
  delete input.score;
  assert.throws(() => recordAssessment(db, 'one', run, input), /score/);
});
