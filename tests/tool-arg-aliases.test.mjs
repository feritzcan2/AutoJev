import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRecordToolArgs} from '../app/scoring/record-scoring.mjs';

test('observation id keys are accepted in place of ref for browser tools', () => {
  assert.deepEqual(
    normalizeRecordToolArgs('browser_interact', {operation: 'click', controlId: 'c-1'}),
    {operation: 'click', ref: 'c-1'},
  );
  assert.deepEqual(
    normalizeRecordToolArgs('browser_interact', {operation: 'type', fieldId: 'f-1', text: 'x'}),
    {operation: 'type', ref: 'f-1', text: 'x'},
  );
  assert.deepEqual(
    normalizeRecordToolArgs('browser_upload_document', {uploadId: 'u-1', filePath: 'a.pdf'}),
    {ref: 'u-1', filePath: 'a.pdf'},
  );
  // An explicit ref wins; two aliases or a non-string alias stay for validation.
  assert.deepEqual(
    normalizeRecordToolArgs('browser_interact', {operation: 'click', ref: 'r', controlId: 'c'}),
    {operation: 'click', ref: 'r', controlId: 'c'},
  );
  assert.deepEqual(
    normalizeRecordToolArgs('browser_interact', {
      operation: 'click',
      controlId: 'c',
      targetId: 't',
    }),
    {operation: 'click', controlId: 'c', targetId: 't'},
  );
  assert.deepEqual(
    normalizeRecordToolArgs('browser_interact', {operation: 'click', controlId: 3}),
    {
      operation: 'click',
      controlId: 3,
    },
  );
  // Other tools are untouched.
  assert.deepEqual(normalizeRecordToolArgs('browser_read', {controlId: 'c'}), {controlId: 'c'});
});
