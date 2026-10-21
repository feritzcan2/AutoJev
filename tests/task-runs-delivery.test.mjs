import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRuns} from '../app/automation/task-runs.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An interactive chat run whose input never makes the agent work.
function fixture({interactive = true} = {}) {
  const runs = new Map();
  const runtime = new TaskRuns(
    {
      recover() {},
      config: () => ({}),
      deliveryGraceMs: 20,
      begin: (id, input, workerId) => {
        const run = {
          id: 'run',
          workerId,
          status: 'running',
          state: 'Starting',
          interactive,
          awaitingMessage: false,
          messageId: 'm1',
        };
        runs.set(run.id, run);
        return run;
      },
      run: (id) => runs.get(id),
      save: (run) => runs.set(run.id, run),
      finish: (id, runId, status, summary) =>
        runs.set(runId, {...runs.get(runId), status, summary}),
    },
    {launch: async () => ({close: async () => {}, message: async () => {}})},
  );
  const event = (value) => runtime.event('w', value, 'run');
  return {runs, runtime, event};
}

test('a chat message the agent never starts on is marked undelivered and unlocks the chat', async () => {
  const f = fixture();
  await f.runtime.start('w', 'interview', 'conversation');
  f.event({event: 'state', state: 'Some(Idle)'});
  await wait(40);
  assert.equal(f.runs.get('run').awaitingMessage, true);
  assert.equal(f.runs.get('run').undelivered.messageId, 'm1');
  // A late start clears the mark and the chat waits for the reply again.
  f.event({event: 'state', state: 'Some(Working)'});
  assert.equal(f.runs.get('run').undelivered, undefined);
  assert.equal(f.runs.get('run').awaitingMessage, false);
  await f.runtime.finish('w', 'interrupted', 'done', 'conversation');
});

test('a failed provider delivery is reported at once', async () => {
  const f = fixture();
  await f.runtime.start('w', 'interview', 'conversation');
  f.event({event: 'delivery', state: 'Some(Blocked)'});
  assert.equal(f.runs.get('run').awaitingMessage, true);
  assert.ok(f.runs.get('run').undelivered);
  await f.runtime.finish('w', 'interrupted', 'done', 'conversation');
});

test('a delivered message that makes the agent work is never marked', async () => {
  const f = fixture();
  await f.runtime.start('w', 'interview', 'conversation');
  f.event({event: 'state', state: 'Some(Working)'});
  await wait(40);
  assert.equal(f.runs.get('run').undelivered, undefined);
  assert.equal(f.runs.get('run').awaitingMessage, false);
  await f.runtime.finish('w', 'interrupted', 'done', 'conversation');
});

test('a provider prompt in the terminal keeps waiting instead of failing the message', async () => {
  const f = fixture();
  await f.runtime.start('w', 'interview', 'conversation');
  f.event({event: 'state', state: 'Some(AwaitingInput)'});
  await wait(40);
  assert.equal(f.runs.get('run').undelivered, undefined);
  await f.runtime.finish('w', 'interrupted', 'done', 'conversation');
});

test('a worker round ends when the engine reports its message undelivered', async () => {
  const f = fixture({interactive: false});
  await f.runtime.start('w', 'scan');
  f.event({
    event: 'delivery_failed',
    state: 'Some(Stalled)',
    screen: 'output\n\n> task message\n  ? for shortcuts  \n',
  });
  await wait(10);
  assert.equal(f.runs.get('run').status, 'failed');
  assert.match(f.runs.get('run').summary, /did not reach the agent/);
  assert.deepEqual(f.runs.get('run').deliveryFailure, {
    state: 'Some(Stalled)',
    screen: 'output\n> task message\n  ? for shortcuts',
  });
});
