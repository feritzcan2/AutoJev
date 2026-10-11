import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareCloudflareCheckbox,
  cloudflareCheckboxMessage,
} from '../app/captcha/cloudflare-checkbox.mjs';

// A challenge page whose Turnstile host frame is still hidden: the provider is
// running its own check and may pass or render the checkbox a few seconds later.
function challengeSlot({hostVisible = false} = {}) {
  const host = {
    getAttribute: async () =>
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/0/auto/light/normal',
    evaluate: async () => hostVisible,
    dispose: async () => {},
  };
  const main = {parentFrame: () => null},
    child = {
      parentFrame: () => main,
      url: () => 'about:blank',
      frameElement: async () => host,
      waitForURL: async () => {
        throw Error('frame never loads in this test');
      },
    };
  const page = {
    evaluate: async () => 1,
    locator: () => ({evaluateAll: async () => false}),
    frames: () => [main, child],
    context: () => ({
      newCDPSession: async () => {
        throw Error('not needed');
      },
    }),
  };
  return {page};
}

test('a hidden provider frame keeps checkbox discovery pending within its deadline instead of starting the site wait at once', async () => {
  const slot = challengeSlot();
  assert.equal(await prepareCloudflareCheckbox(slot), true);
  assert.equal(slot.cloudflareDiagnostic.reason, 'frame_hidden');
  assert.equal(slot.cloudflareDiagnostic.checks, 1);
  assert.equal(
    await prepareCloudflareCheckbox(slot),
    true,
    'a later observation keeps waiting for the provider',
  );
  assert.equal(slot.cloudflareDiagnostic.checks, 2);
  slot.cloudflareDiscovery.until = Date.now() - 1;
  assert.equal(
    await prepareCloudflareCheckbox(slot),
    false,
    'the bounded discovery window still ends',
  );
  assert.match(
    cloudflareCheckboxMessage({reason: 'frame_hidden', elapsedMs: 30000}),
    /30 s\..*\(frame_hidden\)/,
  );
});
