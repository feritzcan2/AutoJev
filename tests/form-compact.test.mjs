import test from 'node:test';
import assert from 'node:assert/strict';
import {compactFields} from '../app/jev/form.mjs';

const page = 'https://example.test/apply';
const field = (extra) => ({
  label: '',
  question: '',
  help: '',
  required: null,
  invalid: false,
  language: 'en',
  filled: false,
  frameUrl: page,
  ...extra,
});

test('radio and checkbox options are grouped under one question without repeated page values', () => {
  const q = 'How many years of TypeScript?';
  const result = compactFields(
    [
      field({label: 'Email', question: 'Email', type: 'email', required: true, controlId: 'c1'}),
      field({label: '1-2', question: q, option: '1-2', type: 'radio', controlId: 'c2'}),
      field({label: '8+', question: q, option: '8+', type: 'radio', controlId: 'c3', filled: true}),
      field({label: 'I agree', question: 'Privacy', option: 'I agree', type: 'checkbox'}),
      field({
        label: 'Note',
        type: 'textarea',
        frameUrl: 'https://forms.test/frame',
        language: 'de',
      }),
    ],
    page,
  );
  assert.deepEqual(result, {
    language: 'en',
    fields: [
      {label: 'Email', required: true, type: 'email', filled: false, controlId: 'c1'},
      {
        question: q,
        type: 'radio',
        filled: true,
        options: [
          {option: '1-2', controlId: 'c2', filled: false},
          {option: '8+', controlId: 'c3', filled: true},
        ],
      },
      {
        question: 'Privacy',
        type: 'checkbox',
        filled: false,
        options: [{option: 'I agree', filled: false}],
      },
      {
        label: 'Note',
        type: 'textarea',
        filled: false,
        language: 'de',
        frameUrl: 'https://forms.test/frame',
      },
    ],
  });
});

test('a required group is missing only while none of its options is selected', () => {
  const q = 'Work permit?';
  const options = (checked) =>
    compactFields(
      ['Yes', 'No'].map((o) =>
        field({
          label: o,
          question: q,
          option: o,
          type: 'radio',
          required: true,
          filled: o === checked,
        }),
      ),
      page,
    ).fields[0];
  assert.equal(options(null).required, true);
  assert.equal(options(null).filled, false);
  assert.equal(options('No').filled, true);
});
