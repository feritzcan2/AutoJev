// Local fixture: a widget keeps aria-busy forever while the page around it is
// complete. The document read must settle on it; a page whose content keeps
// arriving under aria-busy must still report loading.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev/browser.mjs';

const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-stuck-busy-'));
const client = new JevBrowser(dir, {
  connection: 'separate',
  headless: true,
  config: async () => ({}),
  choose: async () => {
    throw Error('No model call expected');
  },
});
const read = async (tabId) =>
  JSON.parse(
    (
      await client.callTool(
        {name: 'browser_observe', arguments: {tabId, scope: 'document'}},
        'test',
      )
    ).content[0].text,
  );
const links = Array.from(
  {length: 30},
  (_, i) => `<li><a href="https://example.test/jobs/${i}">Job ${i}</a></li>`,
).join('');
try {
  const context = await client.context(),
    page = await context.newPage(),
    slot = await client.track(context, page),
    tabId = slot.id;
  await page.setContent(
    `<header><div aria-busy="true" style="width:40px;height:20px">…</div></header><h1>61 jobs</h1><ul>${links}</ul>`,
  );
  let started = Date.now();
  const stuck = await read(tabId);
  assert.equal(stuck.reading.readiness.loading, false, JSON.stringify(stuck.reading.readiness));
  assert.equal(stuck.reading.readiness.settledBusy, true);
  assert.ok(stuck.links.some((l) => l.url === 'https://example.test/jobs/29'));
  const settleMs = Date.now() - started;
  await page.setContent(
    `<div id="list" aria-busy="true"><ul>${links}</ul></div><script>let n=0;setInterval(()=>{const li=document.createElement('li');li.textContent='more '+(n++);document.querySelector('#list ul').append(li);},300);</script>`,
  );
  started = Date.now();
  const growing = await read(tabId);
  assert.equal(growing.reading.readiness.loading, true, 'content still arriving stays loading');
  console.log('JEV_STUCK_BUSY_PASS', JSON.stringify({settleMs, growingMs: Date.now() - started}));
} finally {
  await client.close().catch(() => {});
  await rm(dir, {recursive: true, force: true});
}
