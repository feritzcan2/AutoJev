import test from 'node:test';
import assert from 'node:assert/strict';
import {factSuggestion} from '../src/question-form.js';

const facts = [
  'Phone: +90 555 000 00 00',
  'Notice period: 1 month',
  'Salary expectation: 85,000 a year',
  'Salary currency: EUR',
  'Work permit: Needs visa sponsorship',
  'Relocation: Yes',
  'Languages: English C1, Turkish native',
].join('\n');
const value = (q, f = facts) => factSuggestion(q, f)?.value ?? '';

test('a notice period answers start-date questions', () => {
  for (const q of [
    'What is your notice period?',
    'Earliest possible start date',
    'When can you start?',
  ])
    assert.deepEqual(factSuggestion(q, facts), {value: '1 month', label: 'Notice period'});
});
test('salary carries its saved currency after the amount', () => {
  assert.equal(value('Expected annual salary'), '85,000 EUR a year');
  const salary = (amount) => `Salary expectation: ${amount}\nSalary currency: EUR`;
  assert.equal(value('salary', salary('70k-80k')), '70k-80k EUR');
  assert.equal(value('salary', salary('€70,000')), '€70,000');
  assert.equal(value('salary', salary('70000 EUR')), '70000 EUR');
  assert.equal(value('salary', salary('negotiable')), 'negotiable');
});
test('relocation and visa questions are not mistaken for availability', () => {
  assert.equal(value('Are you available to relocate?'), 'Yes');
  assert.equal(value('Do you require visa sponsorship?'), 'Needs visa sponsorship');
});
test('questions without a saved fact get no suggestion', () => {
  assert.equal(factSuggestion('Why do you want this job?', facts), null);
  assert.equal(factSuggestion('Phone number', ''), null);
});
