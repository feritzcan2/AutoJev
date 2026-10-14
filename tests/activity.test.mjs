import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ageLabel, elapsedLabel} from '../src/activity.js';

test('activity age labels do not fabricate timestamps', () => {
  const start = Date.parse('2026-01-01T10:00:00Z'),
    at = new Date(start).toISOString();
  assert.equal(ageLabel(at, start + 12000), 'Last update: 12 seconds ago');
  assert.equal(ageLabel(null), 'No activity reported yet');
  assert.equal(ageLabel('not a date'), 'Update time unknown');
});

test('running turns count up from their start', () => {
  const start = Date.parse('2026-01-01T10:00:00Z'),
    at = new Date(start).toISOString();
  assert.equal(elapsedLabel(at, start + 42000), 'Running for 42 seconds');
  assert.equal(elapsedLabel(at, start + 5 * 60000), 'Running for 5 minutes');
  assert.equal(elapsedLabel(at, start + 2 * 3600000), 'Running for 2 hours');
});
