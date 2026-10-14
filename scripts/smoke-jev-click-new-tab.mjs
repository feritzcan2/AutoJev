import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev/browser.mjs';
// A click that opens the next page in a new tab reports that tab; an
// ordinary click reports none.
const directory = await mkdtemp(path.join(tmpdir(), 'jev-new-tab-'));
const client = new JevBrowser(directory, {
  connection: 'separate',
  headless: true,
  config: async () => ({}),
  choose: async () => {
    throw Error('No model required');
  },
});
const call = async (name, args) =>
  JSON.parse((await client.callTool({name, arguments: args}, 'test')).content[0].text);
try {
  const context = await client.context(),
    page = await context.newPage(),
    slot = await client.track(context, page),
    tabId = slot.id;
  await page.setContent(
    `<button id="open" onclick="const w=window.open('about:blank');w.document.write('<h1>Employer application</h1>')">Apply on company website</button><button onclick="document.body.dataset.n=(+document.body.dataset.n||0)+1">Show more</button>`,
  );
  let observed = await call('browser_jev_observe', {tabId});
  const plain = observed.clickTargets.find((t) => t.label === 'Show more');
  const same = await call('browser_jev_click', {tabId, targetId: plain.targetId});
  assert.equal(same.openedTab, undefined);
  observed = await call('browser_jev_observe', {tabId});
  const apply = observed.clickTargets.find((t) => t.label === 'Apply on company website');
  const clicked = await call('browser_jev_click', {tabId, targetId: apply.targetId});
  assert.ok(clicked.openedTab?.tabId, JSON.stringify(clicked).slice(0, 300));
  assert.notEqual(clicked.openedTab.tabId, tabId);
  const child = await call('browser_jev_observe', {tabId: clicked.openedTab.tabId});
  assert.match(JSON.stringify(child), /Employer application/);
  console.log('JEV_CLICK_NEW_TAB_PASS');
} finally {
  await client.close();
  await rm(directory, {recursive: true, force: true});
}
