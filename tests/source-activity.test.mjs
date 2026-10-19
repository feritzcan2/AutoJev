import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentStepLabel,
  noteSourceActivity,
  sourceActivity,
} from '../app/sources/source-activity.mjs';
import {sourceActivityText} from '../app/sources/activity-text.mjs';

test('agent steps read as what they do, not as internal tool names', () => {
  assert.equal(
    agentStepLabel('browser_run_task', {operation: 'scan_results'}),
    'reading a results page',
  );
  assert.equal(
    agentStepLabel('browser_run_task', {taskId: 't', reviewedBatchId: 'b'}),
    'continuing after the batch review',
  );
  assert.equal(agentStepLabel('record_automation_results', {}), 'saving scores');
  assert.equal(agentStepLabel('browser_scroll'), 'scroll', 'an unlisted tool loses its prefix');
  for (const tool of [
    'browser_run_task',
    'browser_observe',
    'read_listing_brief',
    'browser_click_target',
  ])
    assert.doesNotMatch(agentStepLabel(tool, {operation: 'collect_details'}), /jev/i);
});

test('a step merges into the run activity and old runs are dropped', () => {
  noteSourceActivity('r1', {step: 'listing', done: 0, total: 3}, 1000);
  noteSourceActivity('r1', {waitUntil: 5000}, 2000);
  assert.deepEqual(sourceActivity('r1'), {
    step: 'listing',
    done: 0,
    total: 3,
    waitUntil: 5000,
    at: 2000,
  });
  noteSourceActivity('r2', {step: 'page'}, 2000 + 7 * 60 * 60000);
  assert.equal(sourceActivity('r1'), null);
  noteSourceActivity('r2', null);
  assert.equal(sourceActivity('r2'), null);
});

test('a wait names what it waits for', () => {
  const now = Date.parse('2026-10-19T15:00:00Z'),
    waitUntil = now + 10 * 60000;
  assert.match(
    sourceActivityText({step: 'page', search: 'Go', waitUntil}, now),
    /waiting for the site’s pace until/,
  );
  assert.match(
    sourceActivityText(
      {step: 'page', search: 'Go', waitUntil, waitFor: 'the limit of 60 pages an hour'},
      now,
    ),
    /^Now: Reading a results page for “Go” · waiting for the limit of 60 pages an hour until /,
  );
});
