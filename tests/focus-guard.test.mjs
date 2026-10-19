import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_BEFORE_FOREGROUND,
  setForegroundPolicy,
  waitForForegroundTurn,
} from '../app/jev/focus-guard.mjs';
import {acquireTabRendering} from '../app/jev/rendering.mjs';

const hiddenSlot = (calls) => ({
  cdp: {send: async (method) => calls.push(method)},
  page: {
    evaluate: async () => true,
    bringToFront: async () => calls.push('bringToFront'),
  },
});

test('a hidden tab waits for a pause in typing before coming forward', async () => {
  let idle = 0;
  setForegroundPolicy({idleSeconds: () => idle});
  const calls = [];
  const pending = acquireTabRendering(hiddenSlot(calls), {foreground: true, timeoutMs: 500});
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(!calls.includes('bringToFront'), 'Chrome stayed behind while the person typed');
  idle = IDLE_BEFORE_FOREGROUND;
  const release = await pending;
  assert.ok(calls.includes('bringToFront'));
  await release();
  setForegroundPolicy({});
});

test('focus goes back to JobLoop when it had the keyboard', async () => {
  let refocused = 0;
  setForegroundPolicy({appFocused: () => true, refocusApp: () => refocused++});
  const calls = [];
  const release = await acquireTabRendering(hiddenSlot(calls), {foreground: true, timeoutMs: 500});
  await release();
  // Once right after the tab switch, once more after a write that had to stay in front.
  assert.ok(refocused >= 1);
  setForegroundPolicy({});
});

test('the wait ends after its limit so autopilot never stalls', async () => {
  setForegroundPolicy({idleSeconds: () => 0});
  const start = Date.now();
  await waitForForegroundTurn({pollMs: 20, maxWaitMs: 100});
  assert.ok(Date.now() - start < 1000);
  setForegroundPolicy({});
});

test('the wait stops when the task is cancelled', async () => {
  setForegroundPolicy({idleSeconds: () => 0});
  const controller = new AbortController();
  const waiting = waitForForegroundTurn({signal: controller.signal, pollMs: 20});
  controller.abort(Error('stopped'));
  await assert.rejects(waiting, /stopped/);
  setForegroundPolicy({});
});
