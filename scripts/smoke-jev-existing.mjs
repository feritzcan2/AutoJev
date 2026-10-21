// Existing Chrome contract over the AutoJob extension: shared login, separate
// windows, scoped tabs, safe disconnect, restart recovery.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev/browser.mjs';
import {JevTabs} from '../app/jev/tabs.mjs';
import {startJevFixture} from './jev-demo.mjs';
import {launchExtensionChrome} from './jev-extension-fixture.mjs';
const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-existing-test-')),
  fixture = await startJevFixture(),
  chrome = await launchExtensionChrome(path.join(directory, 'chrome'));
const {context, openUrl} = chrome,
  personal = context.pages()[0];
await personal.goto(fixture.url);
await context.addCookies([{name: 'test_login', value: 'existing-session', url: fixture.url}]);
const aDirectory = path.join(directory, 'candidate-a'),
  bDirectory = path.join(directory, 'candidate-b'),
  profile = {directory: 'Test'};
let installed = false;
const options = (extra = {}) => ({
  profile,
  openUrl,
  extensionInstalled: async () => installed,
  ...extra,
});
const a = new JevBrowser(aDirectory, options()),
  b = new JevBrowser(bDirectory, options());
let restarted, coldTools, otherProcess;
const call = async (client, name, args = {}, state = {}) =>
  JSON.parse((await client.callTool({name, arguments: args}, 'local', state)).content[0].text);
const windowOf = (client, id) => client.transport.windowOf(id);
try {
  // Without the extension nothing opens in Chrome; the message tells how to install it.
  await assert.rejects(() => call(a, 'browser_tabs'), /chrome:\/\/extensions/);
  assert.equal(chrome.opened, 0);
  installed = true;
  assert.deepEqual((await call(a, 'browser_tabs')).tabs, []);
  assert.equal(chrome.opened, 1, 'one connect page per connection');
  const first = await call(a, 'browser_open_page', {url: fixture.url});
  assert.equal(chrome.opened, 1);
  assert.equal(
    await a.tab(first.tabId).page.evaluate(() => document.cookie),
    'test_login=existing-session',
    'Jev tabs share the profile login',
  );
  const screenshot = await a.callTool({
    name: 'browser_page_screenshot',
    arguments: {tabId: first.tabId},
  });
  assert.equal(screenshot.content[1].mimeType, 'image/png');
  assert.equal(
    Buffer.from(screenshot.content[1].data, 'base64').subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
  );
  await personal.bringToFront();
  const second = await call(a, 'browser_open_page', {url: fixture.url});
  const third = await call(b, 'browser_open_page', {url: fixture.url});
  assert.equal(chrome.opened, 2);
  assert.equal(await windowOf(a, first.tabId), await windowOf(a, second.tabId));
  assert.notEqual(await windowOf(a, first.tabId), await windowOf(b, third.tabId));
  assert.deepEqual(
    (await call(a, 'browser_tabs')).tabs.map((t) => t.tabId).sort(),
    [first.tabId, second.tabId].sort(),
  );
  assert.deepEqual(
    (await call(b, 'browser_tabs')).tabs.map((t) => t.tabId),
    [third.tabId],
  );
  await assert.rejects(() => call(b, 'browser_observe', {tabId: first.tabId}), /not found/);
  await assert.rejects(
    () => b.callTool({name: 'browser_page_screenshot', arguments: {tabId: first.tabId}}),
    /not found/,
  );
  // Pages opened by a Jev tab join the same task; personal tabs never do.
  const known = new Set(a.tabs.keys());
  await a.tab(first.tabId).page.evaluate((url) => {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.textContent = 'popup';
    document.body.append(anchor);
    anchor.click();
  }, fixture.url);
  for (let i = 0; i < 200 && a.tabs.size === known.size; i++)
    await new Promise((r) => setTimeout(r, 50));
  const popupId = [...a.tabs.keys()].find((id) => !known.has(id));
  assert.ok(popupId, 'a page opened by a Jev tab joins the Jev tabs');
  assert.equal(a.tabs.get(popupId).openerId, first.tabId);
  assert.equal((await call(a, 'browser_tabs')).tabs.length, 3);
  await a.tab(popupId).page.close();
  for (let i = 0; i < 200 && a.transport.owned.has(popupId); i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call(a, 'browser_tabs')).tabs.length, 2);
  // A real filled draft survives both socket loss and an application restart.
  await a.tab(first.tabId).page.locator('#query').fill('unsent draft');
  a.choose = (page) => ({
    operation: 'TYPE_TEXT',
    action: page.actions.find((a) => a.kind === 'fill'),
    confidence: 1,
  });
  const decision = await call(a, 'browser_next', {tabId: first.tabId, goal: 'Change query'});
  const disconnected = new Promise((resolve) => a.browser.once('disconnected', resolve));
  a.transport.close();
  await disconnected;
  assert.equal((await call(a, 'browser_observe', {tabId: first.tabId})).tabId, first.tabId);
  await assert.rejects(
    () =>
      call(a, 'browser_act', {
        tabId: first.tabId,
        decisionId: decision.decisionId,
        text: 'must not execute',
      }),
    /no valid Jev decision/,
  );
  assert.equal(await a.tab(first.tabId).page.locator('#query').inputValue(), 'unsent draft');
  assert.equal(chrome.opened, 3);
  await a.close();
  restarted = new JevBrowser(aDirectory, options());
  await restarted.focus(first.tabId);
  assert.equal(
    await restarted.tab(first.tabId).page.locator('#query').inputValue(),
    'unsent draft',
  );
  assert.equal(chrome.opened, 4);
  await assert.rejects(() => call(restarted, 'browser_observe', {tabId: third.tabId}), /not found/);
  // A tab closed in Chrome cannot be confused with another open copy of the same URL.
  await restarted.tab(second.tabId).page.close();
  await assert.rejects(
    () => call(restarted, 'browser_observe', {tabId: second.tabId}),
    /not found|closed/,
  );
  const {BrowserTools} = await import('../app/browser/tools.mjs');
  coldTools = new BrowserTools(directory, () =>
    options({checkpoints: [{browser: 'Jev Chrome', tabId: first.tabId}]}),
  );
  await coldTools.focus('legacy-candidate', {browser: 'Jev Chrome', tabId: first.tabId});
  assert.equal(
    (await coldTools.connect('legacy-candidate')).client.tab(first.tabId).page.url(),
    fixture.url,
  );
  // The extension vouches for a checkpointed tab, not the registry: a record
  // from another Chrome run neither blocks the tab nor lends its window.
  const oldDirectory = path.join(directory, 'old-process'),
    tabIds = (await coldTools.connect('legacy-candidate')).client.transport.tabIdsByTarget();
  await new JevTabs(oldDirectory, profile.directory).save(
    'earlier-chrome-run',
    [first.tabId],
    {[first.tabId]: 1},
    {homeId: first.tabId, windowId: 1},
  );
  otherProcess = new JevBrowser(
    oldDirectory,
    options({checkpoints: [{browser: 'Jev Chrome', tabId: first.tabId}]}),
  );
  const before = chrome.opened;
  assert.ok((await call(otherProcess, 'browser_tabs')).tabs.some((t) => t.tabId === first.tabId));
  assert.notEqual(otherProcess.homeId, first.tabId);
  assert.equal(chrome.opened, before + 1);
  await otherProcess.close();
  // Ownership moved to the newest connection; the previous owner lost the tab.
  for (let i = 0; i < 100 && restarted.tabs.has(first.tabId); i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(restarted.tabs.has(first.tabId), false);
  // A registry that missed a live checkpoint must not make the saved draft vanish.
  await new JevTabs(oldDirectory, profile.directory).save(otherProcess.instanceId, [], {
    [first.tabId]: tabIds[first.tabId],
  });
  otherProcess = new JevBrowser(
    oldDirectory,
    options({checkpoints: [{browser: 'Jev Chrome', tabId: first.tabId}]}),
  );
  assert.ok((await call(otherProcess, 'browser_tabs')).tabs.some((t) => t.tabId === first.tabId));
  assert.equal(
    await otherProcess.tab(first.tabId).page.locator('#query').inputValue(),
    'unsent draft',
  );
  assert.equal(chrome.opened, before + 2);
  await otherProcess.close();
  const closedByB = await b.close({closeTabs: true});
  assert.deepEqual(closedByB.closed.sort(), [third.tabId, b.homeId ?? third.tabId].sort());
  await restarted.close();
  await coldTools.close();
  assert.equal(personal.isClosed(), false);
  assert.equal(personal.url(), fixture.url);
  const urls = context.pages().map((p) => p.url());
  assert.equal(
    urls.filter((u) => u === fixture.url).length,
    2,
    'first tab and personal tab remain',
  );
  console.log('JEV_EXISTING_LOGIN_WINDOWS_SCOPE_RECONNECT_RESTART_DRAFT_RECOVERY_PASS');
} finally {
  await otherProcess?.close().catch(() => {});
  await coldTools?.close().catch(() => {});
  await restarted?.close().catch(() => {});
  await a.close().catch(() => {});
  await b.close().catch(() => {});
  await context.close();
  await fixture.close();
  await rm(directory, {recursive: true, force: true});
}
