// Jev's CDP transport on a tab that was already open: page workers run, and an
// out-of-process frame that loaded before the attach reports its URL.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import http from 'node:http';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {JevCdpTransport} from '../app/jev/cdp.mjs';
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
const chrome = spawn(
  chromium.executablePath(),
  ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'],
  {stdio: 'ignore'},
);
let browser;
try {
  let lines;
  for (let i = 0; i < 100 && !lines; i++) {
    lines = await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8').catch(() => null);
    if (!lines) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const [port, route] = lines.trim().split('\n'),
    base = `http://127.0.0.1:${port}`,
    pageUrl = `http://127.0.0.1:${server.address().port}/`;
  const target = await (await fetch(`${base}/json/new?${pageUrl}`, {method: 'PUT'})).json();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const transport = await JevCdpTransport.connect(`ws://127.0.0.1:${port}${route}`);
  transport.owned.add(target.id);
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
  chrome.kill();
  server.close();
  await rm(directory, {recursive: true, force: true}).catch(() => {});
}
