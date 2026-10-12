import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareCloudflareCheckbox,
  clickCloudflareCheckbox,
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

test('a checkbox in a background tab is clicked after the tab is brought forward and paints', async () => {
  let front = false;
  const clicks = [],
    provider =
      'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/0/auto/light/normal';
  const meta = {origin: 1, x: 20, y: 30, label: 'Verify you are human'};
  const host = {
    boundingBox: async () => ({x: 100, y: 200, width: 300, height: 65}),
    evaluate: async () => ({sx: 1, sy: 1, left: 0, top: 0}),
    dispose: async () => {},
  };
  const target = {
    meta,
    read: () => meta,
    evaluate: async () => meta,
    frame: {url: () => provider, frameElement: async () => host},
    dispose: async () => {},
  };
  // A hidden tab never delivers animation frames until it is in the foreground.
  const page = {
    evaluate: (fn) =>
      String(fn).includes('requestAnimationFrame')
        ? front
          ? Promise.resolve(true)
          : new Promise(() => {})
        : Promise.resolve(!front),
    bringToFront: async () => {
      front = true;
    },
    mouse: {click: async (x, y) => clicks.push([x, y])},
  };
  const slot = {
    page,
    cdp: {send: async () => ({})},
    cloudflareCheckbox: target,
    cloudflareDiagnostic: {},
  };
  assert.equal(await clickCloudflareCheckbox(slot, () => {}), true);
  assert.equal(front, true);
  assert.deepEqual(clicks, [[120, 230]]);
  assert.equal(slot.cloudflareDiagnostic.reason, 'click_dispatched');
});
