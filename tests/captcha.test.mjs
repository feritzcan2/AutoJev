import test from 'node:test';
import assert from 'node:assert/strict';
import {captchaProvider, classifyCaptcha, detectCaptcha} from '../app/captcha/detection.mjs';

const active = {
  provider: 'recaptcha',
  part: 'challenge',
  visible: true,
  grid: true,
  instructions: 'Select bicycles',
  loaded: true,
  identity: 'document:widget',
  round: 'image:one',
};
test('only a visible provider challenge with actual instructions/grid is challenge evidence', () => {
  const idle = {
    provider: 'recaptcha',
    part: 'anchor',
    visible: true,
    unchecked: true,
    loaded: true,
  };
  assert.equal(classifyCaptcha({frames: [idle]}).state, 'idle');
  assert.equal(classifyCaptcha({frames: [{...idle, invisible: true}]}).state, 'none');
  assert.equal(classifyCaptcha({frames: [{...active, visible: false}]}).state, 'none');
  assert.equal(classifyCaptcha({frames: [{...idle, checked: true}, active]}).state, 'active');
  assert.equal(classifyCaptcha({frames: [{...idle, checked: true}]}).state, 'cleared');
  assert.equal(classifyCaptcha({frames: [idle], staleError: true}).state, 'error');
  assert.equal(
    classifyCaptcha({
      frames: [{provider: 'turnstile', part: 'widget', visible: true, loaded: true, token: false}],
    }).state,
    'unknown',
  );
  assert.equal(
    classifyCaptcha({frames: [{...idle, provider: 'turnstile', instructions: 'Verify'}]}).state,
    'active',
  );
  assert.equal(
    classifyCaptcha({frames: [active, {...active, identity: 'other'}]}).state,
    'unsupported',
  );
});
test('unreadable or late frames never count as absent or solved', () => {
  for (const input of [
    {pendingHosts: true},
    {frames: [{...active, grid: false, loaded: false}]},
    {frames: [{...active, grid: false, unavailable: true, loaded: false}]},
    {frames: [{provider: 'recaptcha', part: 'anchor', visible: true, loading: true}]},
  ])
    assert.ok(['unknown', 'checking'].includes(classifyCaptcha(input).state));
  assert.equal(
    classifyCaptcha({frames: [{...active, grid: false, audio: true}]}).state,
    'unsupported',
  );
  assert.equal(classifyCaptcha({frames: [{...active, blocked: true}]}).state, 'unsupported');
  assert.equal(classifyCaptcha({frames: [{...active, audio: true}]}).state, 'unsupported');
  for (const url of [
    'https://evil.test/recaptcha/api2/bframe',
    'https://google.com.evil.test/recaptcha/api2/bframe',
    'https://evil.test/?x=https://www.google.com/recaptcha/api2/bframe',
    'http://www.google.com/recaptcha/api2/bframe',
  ])
    assert.equal(captchaProvider(url), null);
  assert.equal(
    captchaProvider('https://www.recaptcha.net/recaptcha/enterprise/anchor?k=x&size=invisible')
      .enterprise,
    true,
  );
  assert.equal(
    captchaProvider('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/x')
      .provider,
    'turnstile',
  );
});
test('a never-answering page has a bounded unknown result and one outstanding read', async () => {
  let calls = 0;
  const page = {
    evaluate: () => {
      calls++;
      return new Promise(() => {});
    },
  };
  const results = await Promise.all([
    detectCaptcha(page, {timeoutMs: 5}),
    detectCaptcha(page, {timeoutMs: 5}),
  ]);
  assert.ok(results.every((r) => r.state === 'unknown'));
  assert.equal(calls, 1);
  assert.equal((await detectCaptcha(page, {timeoutMs: 5})).state, 'unknown');
  assert.equal(calls, 1);
});
