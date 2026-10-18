import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevTabs, restoredTargets, sameBrowserInstance} from '../app/jev/tabs.mjs';
test('restore exact saved/checkpoint targets in a verified browser profile, never same-URL personal tabs', () => {
  const a = 'A'.repeat(32),
    b = 'B'.repeat(32),
    c = 'C'.repeat(32),
    d = 'D'.repeat(32);
  const saved = {endpoint: 'old-debugger', targets: [a, d]};
  const checkpoints = [
    {browser: 'Jev Chrome', tabId: b},
    {browser: 'Jev Chrome', tabId: c},
    {browser: 'Chrome', tabId: '123'},
  ];
  const live = new Map([
    [a, {browserContextId: 'irem'}],
    [b, {browserContextId: 'irem'}],
    [c, {browserContextId: 'other'}],
    ['E'.repeat(32), {browserContextId: 'irem', url: 'https://same.example/form'}],
  ]);
  assert.deepEqual(restoredTargets(saved, checkpoints, live, 'irem'), [a, b]);
  assert.deepEqual(restoredTargets(saved, checkpoints, live, null), []);
  assert.deepEqual(restoredTargets({targets: []}, checkpoints, live, 'irem'), [b]);
  assert.deepEqual(restoredTargets(saved, checkpoints, new Map(), 'irem'), []);
});
test('an address change can preserve browser identity; a new Chrome process cannot', () => {
  assert.equal(
    sameBrowserInstance(
      'ws://127.0.0.1:123/devtools/browser/browser-a',
      'ws://localhost:456/devtools/browser/browser-a',
    ),
    true,
  );
  assert.equal(
    sameBrowserInstance(
      'ws://127.0.0.1:123/devtools/browser/browser-a',
      'ws://127.0.0.1:123/devtools/browser/browser-b',
    ),
    false,
  );
  assert.equal(sameBrowserInstance('ws://localhost', 'ws://localhost'), false);
});
test('a tab record from another app version does not block the connection; a damaged one does', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-tabs-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const tabs = new JevTabs(directory, 'Default');
  assert.equal(await tabs.read(), null);
  const other = {version: 2, profile: 'Default', instanceId: 'x', targets: [], tabIds: {}};
  await writeFile(tabs.file, JSON.stringify(other));
  assert.equal(await tabs.read(), null);
  assert.deepEqual(JSON.parse(await readFile(tabs.file, 'utf8')), other);
  await tabs.save('ws://127.0.0.1:1/devtools/browser/a', 'context', ['A'.repeat(32)]);
  assert.deepEqual((await tabs.read()).targets, ['A'.repeat(32)]);
  await writeFile(tabs.file, JSON.stringify({version: 1, profile: 'Default', targets: ['bad']}));
  await assert.rejects(tabs.read(), /tab record is invalid/);
  await writeFile(tabs.file, '{');
  await assert.rejects(tabs.read(), /Could not read the Jev tab record/);
});
