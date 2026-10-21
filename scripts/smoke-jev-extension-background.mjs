// Background tabs over the AutoJob extension in a headed Chrome: Jev reads and
// fills forms in tabs that stay in the background, behind the user's own tab,
// across URL formats; delayed, short and never-finishing documents are told
// apart; Go to tab selects the Jev tab and raises its window.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev/browser.mjs';
import {launchPlainExtensionChrome} from './jev-extension-fixture.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-extension-background-'));
const form =
  '<title>Form fixture</title><h1>Form</h1><form onsubmit="event.preventDefault();window.sends++"><div style="height:1800px"></div><label>Contact<input name="contact"></label><label hidden>Hidden<input name="hidden"></label><label>Disabled<input name="disabled" disabled></label><button type="submit">Submit</button></form><script>window.sends=0</script>';
// The user's own tab reports its state; nothing in the test controls it.
let personalState = null;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url.startsWith('/report')) {
    personalState = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    return res.end();
  }
  if (req.url.startsWith('/personal'))
    return res.end(
      '<title>Personal</title><label>Personal draft<input value="UNSENT_DRAFT"></label><script>setInterval(()=>fetch("/report?"+new URLSearchParams({visibility:document.visibilityState,value:document.querySelector("input").value,webdriver:String(navigator.webdriver)})),200)</script>',
    );
  if (req.url.startsWith('/never')) {
    // Headers and a shell arrive; the document never completes.
    res.write('<title>Loading</title><h1>Shell</h1>');
    return;
  }
  if (req.url.startsWith('/api')) {
    setTimeout(
      () =>
        res.end('<h1>Delayed listing</h1><p>DELAYED_CONTENT arrived after the page opened.</p>'),
      2500,
    );
    return;
  }
  if (req.url.startsWith('/delayed'))
    return res.end(
      '<title>Delayed</title><main id="m" aria-busy="true"><p>Loading…</p></main><script>fetch("/api").then(r=>r.text()).then(t=>{const m=document.getElementById("m");m.innerHTML=t;m.removeAttribute("aria-busy")})</script>',
    );
  if (req.url.startsWith('/short')) return res.end('<title>Short</title><p>Short but complete</p>');
  res.end(form);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const chrome = await launchPlainExtensionChrome(path.join(directory, 'chrome'));
const personal = {
  async state() {
    const since = Date.now();
    personalState = null;
    while (!personalState && Date.now() - since < 5000)
      await new Promise((resolve) => setTimeout(resolve, 50));
    return personalState;
  },
};
const client = new JevBrowser(path.join(directory, 'jev'), {
  profile: {directory: 'Test'},
  openUrl: chrome.openUrl,
  extensionInstalled: chrome.extensionInstalled,
  activateChrome: chrome.activateChrome,
});
const call = async (name, args) =>
  JSON.parse((await client.callTool({name, arguments: args}, 'fixture')).content[0].text);
const visibility = (page) => page.evaluate(() => document.visibilityState);
// Whether Chrome has the tab selected. Page visibility also turns hidden when
// another app covers Chrome on the desktop, so it says nothing about selection.
const selected = async (tabId) =>
  (
    await client.transport.control('tabs.get', {
      tabId: client.transport.targets.get(tabId).tabId,
    })
  ).tab.active;
try {
  // A fresh test profile may still be installing the extension when the
  // connect page opens; the app retries a failed connection the same way.
  for (let attempt = 1; ; attempt++)
    try {
      await call('browser_tabs', {});
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  // The user opens their own tab; it lands in the focused (AutoJob) window.
  await chrome.openUrl(url + '/personal');
  assert.ok(await personal.state(), 'the personal tab opened');
  for (const route of ['/123', '/offers/title', '/?item=abc', '/#/detail/1']) {
    const opened = await call('browser_open_page', {url: url + route}),
      tabId = opened.tabId,
      page = client.tab(tabId).page;
    if (route === '/offers/title')
      await page.evaluate(() => {
        const element = document.querySelector('form');
        element.setAttribute('role', 'dialog');
        element.style = 'height:300px;overflow:auto';
      });
    if (route === '/?item=abc')
      await page.evaluate(() => {
        const element = document.querySelector('form'),
          host = document.createElement('section');
        element.replaceWith(host);
        host.attachShadow({mode: 'open'}).append(element);
      });
    assert.equal(await selected(tabId), false, `${route}: the Jev tab opens in the background`);
    assert.equal(await visibility(page), 'hidden', route);
    const observed = await call('browser_observe', {tabId});
    const target = observed.controls.find((c) => c.label === 'Contact');
    assert.ok(target, route);
    const revealed = await call('browser_reveal', {tabId, controlId: target.controlId});
    assert.equal(revealed.status, 'ready', revealed.message);
    const field = revealed.fillFields.find((f) => f.label === 'Contact');
    const filled = await call('browser_fill_fields', {
      tabId,
      fields: [{fieldId: field.fieldId, text: 'Synthetic answer'}],
    });
    assert.equal(filled.status, 'ready', JSON.stringify(filled.results));
    assert.equal(await page.locator('[name=contact]').inputValue(), 'Synthetic answer');
    assert.equal(await page.evaluate(() => window.sends), 0);
    assert.ok(!filled.fillFields.some((f) => ['Hidden', 'Disabled'].includes(f.label)));
    assert.equal(await selected(tabId), false, `${route}: the Jev tab stays in the background`);
    assert.equal(await visibility(page), 'hidden', route);
    const own = await personal.state();
    assert.equal(own.value, 'UNSENT_DRAFT');
    assert.equal(own.webdriver, 'false', 'the user tab carries no automation flag');
  }
  // Content that renders after the page opened is waited for.
  const delayed = await call('browser_open_page', {url: url + '/delayed'});
  const delayedText = JSON.stringify(delayed);
  assert.match(delayedText, /DELAYED_CONTENT/);
  // A genuinely short document is complete.
  const short = await call('browser_open_page', {url: url + '/short'});
  assert.match(JSON.stringify(short), /Short but complete/);
  // A document that never finishes is reported as still loading, not as an empty page.
  const never = await call('browser_open_page', {url: url + '/never'});
  assert.equal(never.status, 'loading', JSON.stringify(never));
  // A tab the user opened in the AutoJob window is never taken over.
  assert.ok(
    [...client.tabs.values()].every((slot) => !slot.page.url().endsWith('/personal')),
    'the personal tab is not a Jev tab',
  );
  // A popup of a Jev tab joins it.
  const before = client.transport.owned.size;
  await client.tab(short.tabId).page.evaluate((target) => globalThis.open(target), url + '/short');
  for (let i = 0; i < 50 && client.transport.owned.size === before; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.transport.owned.size, before + 1, 'the popup is a Jev tab');
  for (const id of client.transport.owned)
    if (id !== client.homeId)
      assert.equal(await selected(id), false, 'no Jev tab took the selection');
  // Go to tab selects the Jev tab and raises its window.
  await client.focus(delayed.tabId);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await selected(delayed.tabId), true);
  // Whether the window then comes in front of the app the user clicked in is
  // up to the operating system; it is logged, not asserted.
  const windowId = await client.transport.windowOf(delayed.tabId);
  console.log(
    'Jev window focused:',
    (await client.transport.control('windows.get', {windowId})).window.focused,
  );
  console.log('JEV_EXTENSION_BACKGROUND_PASS');
} finally {
  await client.close().catch(() => {});
  await chrome.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, {recursive: true, force: true});
}
