import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {chromeWindowMarker} from '../app/jev/chrome.mjs';
import {JevBrowser} from '../app/jev/browser.mjs';

const focus = (marker, focused = true, origin = new URL(marker.url).origin) =>
  fetch(marker.url + (focused ? '/focused' : '/blurred'), {
    method: 'POST',
    headers: {Origin: origin},
  });

test('window readiness requires focus from its own page, and a late focus can recover a timed out wait', async (t) => {
  const marker = await chromeWindowMarker({observeFocus: true});
  t.after(() => marker.close());
  const response = await fetch(marker.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /document\.hasFocus\(\)/);
  assert.equal((await focus(marker, true, 'https://unrelated.example')).status, 404);
  await assert.rejects(marker.waitForReady({timeout: 20}), /profile is not ready/);
  await focus(marker);
  await marker.waitForReady({timeout: 20});
  await focus(marker, false);
  await assert.rejects(marker.waitForReady({timeout: 20}), /profile is not ready/);
  await focus(marker);
  await marker.waitForReady({timeout: 20});
});

test('a visible window whose page never had focus is ready until the page loses focus', async (t) => {
  const marker = await chromeWindowMarker({observeFocus: true});
  t.after(() => marker.close());
  const html = await (await fetch(marker.url)).text(),
    script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
  const page = {visibility: 'visible', focused: false},
    listeners = {},
    on = (type, listener) => (listeners[type] = listener),
    reports = [];
  let delivered = Promise.resolve();
  vm.runInNewContext(script, {
    location: {pathname: new URL(marker.url).pathname},
    document: {
      get visibilityState() {
        return page.visibility;
      },
      hasFocus: () => page.focused,
      addEventListener: on,
    },
    addEventListener: on,
    fetch: (url, options) => {
      reports.push(url.split('/').at(-1));
      // Deliver in order, as one page's reports would arrive.
      delivered = delivered.then(() => focus(marker, url.endsWith('/focused')));
      return delivered;
    },
  });
  // Browser UI kept keyboard focus in the new window; the page is still the active one.
  assert.deepEqual(reports, ['focused']);
  await delivered;
  await marker.waitForReady({timeout: 1000});
  page.visibility = 'hidden';
  listeners.visibilitychange();
  page.visibility = 'visible';
  listeners.visibilitychange();
  assert.deepEqual(reports, ['focused', 'blurred', 'focused']);
  page.focused = true;
  listeners.focus();
  page.focused = false;
  listeners.blur();
  assert.deepEqual(reports, ['focused', 'blurred', 'focused', 'blurred']);
  await delivered;
  await assert.rejects(marker.waitForReady({timeout: 20}), /profile is not ready/);
});

test('window readiness is cancellable and markers cannot complete one another', async (t) => {
  const first = await chromeWindowMarker({observeFocus: true}),
    second = await chromeWindowMarker({observeFocus: true});
  t.after(() => {
    first.close();
    second.close();
  });
  await focus(second);
  await second.waitForReady();
  const abort = new AbortController(),
    pending = first.waitForReady({signal: abort.signal}),
    rejected = assert.rejects(pending, {name: 'AbortError'});
  abort.abort();
  await rejected;
  await assert.rejects(first.waitForReady({signal: abort.signal}), {name: 'AbortError'});
  const closing = first.waitForReady(),
    closed = assert.rejects(closing, /closed/);
  first.close();
  await closed;
});

test('a failed connection retries the same selected window instead of opening more windows', async (t) => {
  let windows = 0,
    marker;
  const browser = new JevBrowser('/unused', {
    profile: {directory: 'Profile 2'},
    openWindow: async (url, profile) => {
      assert.equal(profile.directory, 'Profile 2');
      windows++;
      marker = {url};
      await focus(marker);
    },
    endpoint: async () => {
      throw Error('Synthetic endpoint unavailable');
    },
  });
  t.after(() => browser.close());
  await assert.rejects(browser.context(), /Synthetic endpoint unavailable/);
  await assert.rejects(browser.context(), /Synthetic endpoint unavailable/);
  assert.equal(windows, 1);
  await browser.close();
  await assert.rejects(fetch(marker.url));
});

test('a retry whose reused window is not ready still reports why the previous attempt failed', async (t) => {
  let marker,
    attempts = 0;
  const browser = new JevBrowser('/unused', {
    profile: {directory: 'Profile 2'},
    readyTimeout: 50,
    openWindow: async (url) => {
      marker = {url};
      await focus(marker);
    },
    endpoint: async () => {
      if (++attempts === 1) throw Error('Synthetic tab record failure');
      throw Error('Synthetic endpoint unavailable');
    },
  });
  t.after(() => browser.close());
  await assert.rejects(
    browser.context(),
    /Could not connect to Chrome: Synthetic tab record failure$/,
  );
  // The user switched away: the reused window now reports that it lost focus.
  await focus(marker, false);
  await assert.rejects(
    browser.context(),
    /profile is not ready\..* The previous attempt failed: Synthetic tab record failure$/,
  );
  await focus(marker);
  await assert.rejects(
    browser.context(),
    /Could not connect to Chrome: Synthetic endpoint unavailable$/,
  );
  assert.equal(attempts, 2);
});

test('a retry opens a new window when the previous one was closed or never loaded', async (t) => {
  const markers = [];
  let load = true;
  const browser = new JevBrowser('/unused', {
    profile: {directory: 'Profile 2'},
    readyTimeout: 50,
    openWindow: async (url) => {
      markers.push({url});
      if (load) await fetch(url);
    },
    endpoint: async () => {
      throw Error('Synthetic endpoint unavailable');
    },
  });
  t.after(() => browser.close());
  // Loaded but not in front: the retry keeps waiting for the same window.
  await assert.rejects(browser.context(), /profile is not ready/);
  await assert.rejects(browser.context(), /profile is not ready/);
  assert.equal(markers.length, 1);
  // The user closed it: the next attempt opens a new window, and the old page is gone.
  await fetch(markers[0].url + '/closed', {
    method: 'POST',
    headers: {Origin: new URL(markers[0].url).origin},
  });
  load = false;
  await assert.rejects(browser.context(), /profile is not ready/);
  assert.equal(markers.length, 2);
  await assert.rejects(fetch(markers[0].url));
  // Chrome never loaded that one either: the retry opens another.
  load = true;
  await assert.rejects(browser.context(), /profile is not ready/);
  assert.equal(markers.length, 3);
  await focus(markers[2]);
  await assert.rejects(browser.context(), /Synthetic endpoint unavailable/);
  assert.equal(markers.length, 3);
});
