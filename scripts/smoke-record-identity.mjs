import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'record-identity-smoke-'));
let submissions = 0;
const server = createServer((req, res) => {
  if (req.method !== 'GET') submissions++;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const late = req.url === '/delayed',
    id = req.url?.includes('second') ? 'second' : 'first';
  res.end(
    `<!doctype html><head><title>Synthetic home ${id}</title><link rel="canonical" href="/entity?id=${id}"></head><body><main ${late ? 'aria-busy="true"' : ''}><h1>Synthetic home ${id}</h1><p>${late ? 'Loading…' : 'Two rooms in Berlin.'}</p></main>${late ? '<script>setTimeout(()=>{document.querySelector("main").innerHTML="<h1>Synthetic home first</h1><p>Two rooms in Berlin.</p>";document.querySelector("main").setAttribute("aria-busy","false")},700)</script>' : ''}</body>`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = new BrowserTools(directory, () => ({
    connection: 'separate',
    headless: true,
    choose: () => {
      throw Error('No model needed');
    },
  })),
  adapter = automationBrowser(browser, {mode: 'jev'});
const core = new WorkspaceDatabase(':memory:'),
  db = new AutomationStore(core),
  a = db.create('housing', {
    goal: 'Homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: 'Two rooms'},
  });
db.review(a.id);
const run = db.begin(a.id, 'run');
try {
  const ids = [];
  for (const route of ['/entity?id=first', '/a-pretty-address', '/delayed', '/second']) {
    const response = await adapter.call(a.id, 'browser_navigate', {url: origin + route}, run.id),
      page = response.jevPage;
    assert.equal(page.reading.readiness.loading, false);
    assert.ok(page.canonicalUrl);
    assert.match(page.text, /Two rooms/);
    db.browserEvidence.rememberIdentity(run, {
      url: page.url,
      canonicalUrl: page.canonicalUrl,
      readiness: page.reading.readiness,
    });
    ids.push(db.record(a.id, run.id, {url: page.url, title: page.title, summary: page.text}).id);
  }
  assert.equal(new Set(ids.slice(0, 3)).size, 1);
  assert.notEqual(ids[3], ids[0]);
  assert.equal(db.results(a.id).length, 2);
  assert.equal(submissions, 0);
  console.log(
    'RECORD_IDENTITY_PASS',
    JSON.stringify({canonicalVariants: 3, distinctEntities: 2, delayedContent: true, submissions}),
  );
} finally {
  core.close();
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(directory, {recursive: true, force: true});
}
