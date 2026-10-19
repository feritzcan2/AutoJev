import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHardRules, normalizeHardRules, hardRuleEligibility} from '../src/hard-rules.js';
import {scoringPolicy} from '../app/scoring/policy.mjs';
import {recordAssessment, recordResultInput} from '../app/scoring/record-scoring.mjs';
import {automationTemplate, planInput} from '../app/templates/catalog.mjs';

const rulesText = [
  'Reject if not stated: Outside Berlin, the role is fully remote within Germany',
  'Accept if not stated: In Berlin, the role is not office-only',
  'Hold if not stated: German at C1 or higher is not required',
].join('\n');

test('elimination rules are one line each with their own not-stated choice', () => {
  assert.deepEqual(
    parseHardRules(rulesText).map((r) => [r.n, r.ifNotStated]),
    [
      [1, 'reject'],
      [2, 'accept'],
      [3, 'hold'],
    ],
  );
  // A line without a choice holds; list markers and case are tolerated.
  assert.equal(
    normalizeHardRules(
      '- No US work authorization required\n2. accept IF NOT STATED: Full time\n\n',
    ),
    'Hold if not stated: No US work authorization required\nAccept if not stated: Full time',
  );
  assert.throws(() => normalizeHardRules(Array(13).fill('A rule').join('\n')), /at most 12/);
});

test('code, not the agent, turns per-rule answers into eligibility', () => {
  const rules = parseHardRules(rulesText);
  const answer = (results) => results.map((result, i) => ({rule: i + 1, result}));
  assert.equal(
    hardRuleEligibility(rules, answer(['pass', 'unknown', 'pass'])).eligibility,
    'verified',
  );
  // Silence about a Reject rule eliminates; silence about a Hold rule waits.
  const rejected = hardRuleEligibility(rules, answer(['unknown', 'pass', 'pass']));
  assert.equal(rejected.eligibility, 'mismatch');
  assert.match(rejected.eligibilityReason, /Not stated: Outside Berlin/);
  assert.equal(
    hardRuleEligibility(rules, answer(['pass', 'pass', 'unknown'])).eligibility,
    'unverified',
  );
  assert.equal(
    hardRuleEligibility(rules, answer(['pass', 'fail', 'pass'])).eligibility,
    'mismatch',
  );
  assert.throws(() => hardRuleEligibility(rules, undefined), /answer each of the 3/);
  assert.throws(() => hardRuleEligibility(rules, answer(['pass', 'pass'])), /rule\(s\) 3/);
  assert.throws(() => hardRuleEligibility(rules, [{rule: 9, result: 'pass'}]), /hardRules number/);
});

test('scoring with elimination rules ignores the agent eligibility and needs every answer', () => {
  const a = {revision: 2, criteria: {ranking: 'Fit', hard_rules: rulesText}};
  const db = {get: () => a, now: () => 1};
  const run = {id: 'run', revision: 2};
  const policy = scoringPolicy(a);
  assert.equal(policy.hardRules.length, 3);
  assert.equal(policy.unstatedConditions, undefined);
  const saved = recordAssessment(db, 'one', run, {
    score: 80,
    eligibility: 'verified',
    rules: [
      {rule: 1, result: 'unknown'},
      {rule: 2, result: 'pass'},
      {rule: 3, result: 'pass', evidence: 'English only'},
    ],
  });
  assert.equal(saved.eligibility, 'mismatch');
  assert.equal(saved.ruleResults.length, 3);
  assert.throws(() => recordAssessment(db, 'one', run, {score: 80}), /arguments\.rules/);
  // An unreadable record needs no rule answers.
  assert.equal(
    recordAssessment(db, 'one', run, {status: 'unavailable', score: null}).eligibility,
    'unverified',
  );
  // Scan saves carry the answers as a top-level field.
  assert.deepEqual(
    recordResultInput({url: 'https://x.test/1', score: 70, rules: [{rule: 1, result: 'pass'}]})
      .assessment.rules,
    [{rule: 1, result: 'pass'}],
  );
  // Without rules the old eligibility path stays.
  const plain = {revision: 2, criteria: {ranking: 'Fit'}};
  assert.equal(
    recordAssessment({get: () => plain, now: () => 1}, 'one', run, {score: 80}).eligibility,
    'unverified',
  );
});

test('every template offers elimination rules and saving normalizes them', () => {
  const template = automationTemplate('job-search');
  assert.equal(template.fields.find((f) => f.id === 'hard_rules')?.type, 'rules');
  const plan = planInput(template, {
    goal: 'Jobs',
    criteria: {preferences: 'Backend', hard_rules: 'Full time\nreject if not stated: In Germany'},
  });
  assert.equal(
    plan.criteria.hard_rules,
    'Hold if not stated: Full time\nReject if not stated: In Germany',
  );
});

test('the old hard requirements field stays valid but is marked for the setup agent to move', () => {
  const template = automationTemplate('job-search');
  assert.equal(template.fields.find((f) => f.id === 'constraints')?.legacy, true);
  assert.doesNotMatch(template.onboarding, /- constraints:/);
  assert.equal(
    planInput(template, {goal: 'Jobs', criteria: {preferences: 'Backend', constraints: ''}})
      .criteria.constraints,
    '',
  );
});
