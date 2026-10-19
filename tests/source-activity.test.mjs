import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentStepLabel,
  noteSourceActivity,
  sourceActivity,
} from '../app/sources/source-activity.mjs';

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
