// Jev's extension transport on a tab that was already open, as after an app
// restart: page workers run, and an out-of-process frame that loaded before
// the attach reports its URL.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import http from 'node:http';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {ExtensionRelay} from '../app/jev/extension.mjs';
import {launchExtensionChrome} from './jev-extension-fixture.mjs';
const require = createRequire(import.meta.url),
  {chromium} = createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    req.url === '/frame'
      ? '<p>form frame</p>'
      : `<iframe src="http://localhost:${server.address().port}/frame"></iframe>`,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-attach-test-'));
const chrome = await launchExtensionChrome(directory),
  relay = await ExtensionRelay.listen();
let browser;
try {
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  // The previous app run opened the tab, then let it go.
  const first = await relay.connect({open: chrome.openUrl});
  const targetId = await first.createTab(),
    tabId = first.targets.get(targetId).tabId;
  await first.control('debugger.detach', {tabId});
  await first.control('tabs.update', {tabId, url: pageUrl});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  first.close();
  const transport = await relay.connect({open: chrome.openUrl});
  assert.equal(await transport.resolve(targetId), tabId);
  await transport.adopt(targetId, tabId);
  browser = await chromium.connectOverCDP(transport, {timeout: 30000, noDefaults: true});
  const page = browser
    .contexts()[0]
    .pages()
    .find((p) => p.url() === pageUrl);
  assert.ok(page, 'the open tab is attached');
  await page.waitForTimeout(500);
  assert.ok(
    page.frames().some((f) => f.url() === `http://localhost:${server.address().port}/frame`),
    'the frame that loaded before the attach has its URL',
  );
  const worker = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const blob = new Blob(['postMessage("ran")'], {type: 'text/javascript'});
        const w = new Worker(URL.createObjectURL(blob));
        w.onmessage = (event) => resolve(event.data);
        setTimeout(() => resolve('paused'), 4000);
      }),
  );
  assert.equal(worker, 'ran', 'a worker started by the page runs');
  console.log('PASS smoke-jev-cdp-attach');
} finally {
  await browser?.close().catch(() => {});
  relay.close();
  await chrome.context.close().catch(() => {});
  server.close();
  await rm(directory, {recursive: true, force: true}).catch(() => {});
}
