import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevTabs, restoredTargets} from '../app/jev/tabs.mjs';

test('restore candidates are exact saved/checkpoint Jev targets, never other browsers or malformed ids', () => {
  const a = 'A'.repeat(32),
    b = 'B'.repeat(32),
    c = 'C'.repeat(32),
    d = 'D'.repeat(32);
  const saved = {targets: [a, d, 'not-a-target']};
  const checkpoints = [
    {browser: 'Jev Chrome', tabId: b},
    {browser: 'Jev Chrome', tabId: c},
    {browser: 'Chrome', tabId: '123'},
  ];
  assert.deepEqual(restoredTargets(saved, checkpoints), [a, d, b, c]);
  assert.deepEqual(restoredTargets(null, checkpoints), [b, c]);
  assert.deepEqual(restoredTargets({targets: [a]}, []), [a]);
});

test('the tab registry keeps Chrome tab ids per target and ignores records of the old port connection', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-tabs-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const registry = new JevTabs(directory, 'Profile 2');
  assert.equal(await registry.read(), null);
  const a = 'A'.repeat(32);
  await registry.save('run-1', [a, a], {[a]: 12}, {homeId: a, windowId: 3});
  const saved = await registry.read();
  assert.equal(saved.version, 2);
  assert.equal(saved.instanceId, 'run-1');
  assert.deepEqual(saved.targets, [a]);
  assert.deepEqual(saved.tabIds, {[a]: 12});
  assert.equal(saved.windowId, 3);
  await writeFile(
    registry.file,
    JSON.stringify({
      version: 1,
      profile: 'Profile 2',
      endpoint: 'ws://127.0.0.1:1/devtools/browser/x',
      contextId: 'ctx',
      targets: [a],
    }),
  );
  assert.equal(await registry.read(), null);
  await writeFile(registry.file, JSON.stringify({version: 2, profile: 'Profile 2'}));
  await assert.rejects(registry.read(), /tab record is invalid/);
});
test('a tab record from another app version does not block the connection; a damaged one does', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jev-tabs-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const tabs = new JevTabs(directory, 'Default');
  assert.equal(await tabs.read(), null);
  const other = {version: 3, profile: 'Default', targets: []};
  await writeFile(tabs.file, JSON.stringify(other));
  assert.equal(await tabs.read(), null);
  assert.deepEqual(JSON.parse(await readFile(tabs.file, 'utf8')), other);
  await tabs.save('run-1', ['A'.repeat(32)], {['A'.repeat(32)]: 4});
  assert.deepEqual((await tabs.read()).targets, ['A'.repeat(32)]);
  await writeFile(tabs.file, JSON.stringify({version: 2, profile: 'Default', targets: ['bad']}));
  await assert.rejects(tabs.read(), /tab record is invalid/);
  await writeFile(tabs.file, '{');
  await assert.rejects(tabs.read(), /Could not read the Jev tab record/);
});
