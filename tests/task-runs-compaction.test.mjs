import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRuns} from '../app/automation/task-runs.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Record tasks (execute, prepare, verify) have no policy continuation of their own.
function fixture() {
  const runs = new Map(),
    messages = [];
  const runtime = new TaskRuns(
    {
      recover() {},
      config: () => ({}),
      idleGraceMs: 10,
      begin: (id, input, workerId) => {
        const run = {id: 'run', workerId, status: 'running', state: 'Starting'};
        runs.set(run.id, run);
        return run;
      },
      run: (id) => runs.get(id),
      save: (run) => runs.set(run.id, run),
      finish: (id, runId, status, summary) =>
        runs.set(runId, {...runs.get(runId), status, summary}),
    },
    {
      launch: async () => ({
        close: async () => {},
        state: () => runs.get('run').state,
        message: async (text) => {
          messages.push(text);
          runs.set('run', {...runs.get('run'), state: 'Working'});
        },
      }),
    },
  );
  const state = (value, extra = {}) =>
    runtime.event('w', {event: 'state', state: value, ...extra}, 'run');
  return {runs, messages, runtime, state};
}

test('a record task idle after the app compaction gets a continuation instead of failing', async () => {
  const f = fixture();
  await f.runtime.start('w');
  f.state('Working');
  f.state('Idle', {compacted: true});
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /finish_automation_run/);
  assert.equal(f.runs.get('run').status, 'running');
  // A later idle without a new compaction is a real unreported stop.
  f.state('Working');
  f.state('Idle');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  assert.equal(f.messages.length, 1);
  assert.equal(f.runs.get('run').status, 'failed');
  await f.runtime.close?.();
});

test('a record task idle without compaction still fails as unreported', async () => {
  const f = fixture();
  await f.runtime.start('w');
  f.state('Working');
  f.state('Idle');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  assert.equal(f.messages.length, 0);
  assert.equal(f.runs.get('run').status, 'failed');
  await f.runtime.close?.();
});
