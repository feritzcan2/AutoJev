// Bot signals over the AutoJob extension in a headed Chrome: Jev fills the
// probe form (scripts/bot-signals-probe.html) in a background tab and presses
// Send; the page itself reports what a bot-protection script would see. No
// CDP Runtime trace, no automation globals, pointer movement before every
// click, human press times, key events for typed text and wheel scrolling.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {JevBrowser} from '../app/jev/browser.mjs';
import {launchPlainExtensionChrome} from './jev-extension-fixture.mjs';

const probe = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'bot-signals-probe.html'),
  'utf8',
);
const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-bot-signals-'));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(probe);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/contact`;
const chrome = await launchPlainExtensionChrome(path.join(directory, 'chrome'));
const client = new JevBrowser(path.join(directory, 'jev'), {
  profile: {directory: 'Test'},
  openUrl: chrome.openUrl,
  extensionInstalled: chrome.extensionInstalled,
  activateChrome: chrome.activateChrome,
});
const call = async (name, args) =>
  JSON.parse((await client.callTool({name, arguments: args}, 'fixture')).content[0].text);
try {
  for (let attempt = 1; ; attempt++)
    try {
      await call('browser_tabs', {});
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  const opened = await call('browser_open_page', {url}),
    tabId = opened.tabId,
    page = client.tab(tabId).page;
  let observed = await call('browser_observe', {tabId});
  const control = (label) => observed.controls.find((c) => c.label === label);
  const fieldsOf = async (label) => {
    const revealed = await call('browser_reveal', {tabId, controlId: control(label).controlId});
    assert.equal(revealed.status, 'ready', revealed.message);
    return revealed.fillFields;
  };
  const fields = await fieldsOf('Full name'),
    field = (label) => fields.find((f) => f.label === label).fieldId;
  const message = 'Hello, I would like to hear more about the role.\nPlease call me after five.';
  const filled = await call('browser_fill_fields', {
    tabId,
    fields: [
      {fieldId: field('Full name'), text: 'Ada Lovelace'},
      {fieldId: field('Email'), text: 'ada@example.org'},
      {fieldId: field('Message'), text: message},
    ],
  });
  assert.equal(filled.status, 'ready', JSON.stringify(filled.results));
  // The consent box and Send sit below a long notice: scroll to them.
  observed = await call('browser_observe', {tabId});
  const scroller = observed.scrollTargets?.[0];
  if (scroller)
    await call('browser_scroll', {tabId, controlId: scroller.controlId, direction: 'down'});
  observed = await call('browser_observe', {tabId});
  const consent = observed.controls.find((c) => /agree/i.test(c.label));
  assert.ok(consent, JSON.stringify(observed.controls.map((c) => c.label)));
  const chosen = await call('browser_select_choice', {tabId, controlId: consent.controlId});
  assert.equal(chosen.selection?.verified, true, JSON.stringify(chosen));
  const send = (await call('browser_observe', {tabId})).clickTargets.find(
    (t) => t.label === 'Send',
  );
  assert.ok(send);
  assert.equal(
    (await call('browser_click_target', {tabId, targetId: send.targetId})).executed,
    true,
  );
  const report = await page.evaluateInPageWorld(() => window.botSignalsReport());
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.webdriver, false);
  assert.equal(report.runtimeEnableTrap, false, 'no CDP Runtime domain serialises console calls');
  assert.deepEqual(report.automationGlobals, [], 'no automation globals in the page');
  assert.ok(report.clicks.length >= 3, 'the fields, the box and Send were clicked');
  assert.ok(
    report.clicks.every((c) => c.trusted && c.movesBefore >= 2 && c.holdMs >= 30),
    'every click follows pointer movement and is held like a person holds it',
  );
  assert.equal(report.fields.name.length, 'Ada Lovelace'.length);
  assert.ok(report.fields.name.keydowns >= report.fields.name.length, 'the name was typed');
  assert.ok(report.fields.email.keydowns >= report.fields.email.length, 'the email was typed');
  assert.ok(report.fields.name.keyGapSpreadMs > 5, 'keys do not arrive at a fixed beat');
  assert.equal(report.fields.message.length, message.length);
  assert.ok(report.wheelEvents > 0, 'the page was scrolled with the wheel');
  if (report.translateChanges.length) console.log('Known DOM trace:', report.translateChanges);
  console.log('BOT_SIGNALS_PASS');
} finally {
  await client.close().catch(() => {});
  await chrome.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, {recursive: true, force: true});
}
