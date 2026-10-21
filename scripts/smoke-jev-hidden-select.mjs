// Isolated Chrome with a local fixture: a transparent native select laid over a
// styled caption is observed as a control with its option names, while selects
// hidden by CSS or covered by another widget stay out. No live site is used.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev/browser.mjs';
import {controlState} from './jev-control-state.mjs';
import {inPageWorld} from './jev-page-world.mjs';
const remember = controlState();
const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-hidden-select-'));
const client = new JevBrowser(dir, {
  connection: 'separate',
  headless: true,
  config: async () => ({}),
  choose: async () => {
    throw Error('No model call expected');
  },
});
const call = async (name, args, owner = 'test') =>
  remember(JSON.parse((await client.callTool({name, arguments: args}, owner)).content[0].text));
const options = `<option value="relevance">Most relevant</option><option value="recent">Most recent</option><option value="salary_asc">Salary (low - high)</option>`;
try {
  const context = await client.context(),
    page = await context.newPage(),
    slot = await client.track(context, page),
    tabId = slot.id;
  await page.setContent(`<style>
  .sort{position:relative;display:inline-block;padding:6px 12px;border:1px solid #888}
  .sort select{position:absolute;inset:0;opacity:0;width:100%;height:100%}
  .covered{position:relative;display:inline-block;padding:6px 12px}
  .covered select{position:absolute;inset:0;opacity:0;z-index:0}
  .covered .cover{position:absolute;inset:0;z-index:1;background:#eee}
 </style>
 <p>Jobs 457</p>
 <div class="sort"><span>Most relevant</span><select id="sort" onchange="window.sorted=this.value">${options}</select></div>
 <label>Region<select id="region"><option>Any</option><option>Berlin</option></select></label>
 <select id="gone" style="display:none">${options}</select>
 <div class="covered"><span>Covered</span><select id="covered">${options}</select><div class="cover"></div></div>
 <ul>${Array.from({length: 120}, (_, i) => `<li><a href="https://example.test/jobs/${i}">Job ${i}</a></li>`).join('')}</ul>`);
  const observed = await call('browser_observe', {tabId});
  // Controls carry no DOM node; match them through the select-only fields.
  const selects = observed.controls.filter((c) => c.nativeSelect);
  const sort = selects.find(
      (c) =>
        c.selectedLabel === 'Most relevant' &&
        c.options.includes('Most recent') &&
        c.label !== 'Region',
    ),
    region = selects.find((c) => c.label === 'Region');
  assert.ok(sort, 'the transparent sort select is observed');
  assert.equal(sort.role, 'combobox');
  assert.equal(sort.recommendedTool, 'browser_interact select');
  assert.deepEqual(sort.options, ['Most relevant', 'Most recent', 'Salary (low - high)']);
  assert.equal(sort.optionCount, 3);
  assert.ok(region, 'a labelled select keeps its label');
  assert.equal(region.selectedLabel, 'Any');
  assert.deepEqual(region.options, ['Any', 'Berlin']);
  assert.equal(selects.length, 2, 'hidden and covered selects stay out');
  const listed = await call('browser_list_options', {tabId, controlId: sort.controlId});
  assert.equal(listed.optionCount, 3);
  assert.equal(listed.options[1].label, 'Most recent');
  const picked = await call('browser_choose_option', {
    tabId,
    controlId: sort.controlId,
    option: 'Most recent',
  });
  assert.equal(picked.selection?.verified, true, JSON.stringify(picked).slice(0, 300));
  assert.equal(await inPageWorld(page, () => window.sorted), 'recent');
  const after =
    picked.controls.find((c) => c.controlId === sort.controlId) ??
    (await call('browser_observe', {tabId})).controls.find(
      (c) => c.nativeSelect && c.options?.includes('Most recent') && c.label !== 'Region',
    );
  assert.equal(after.selectedLabel, 'Most recent');
  console.log(
    'JEV_HIDDEN_SELECT_PASS',
    JSON.stringify({selects: selects.length, controls: observed.controls.length}),
  );
} finally {
  await client.close().catch(() => {});
  await rm(dir, {recursive: true, force: true});
}
