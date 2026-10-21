import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  installedExtensionDirectory,
  prepareExtensionFolder,
  registerExternalExtension,
  resetExtensionFolder,
} from '../app/jev/extension-folder.mjs';
import {extensionMissingMessage} from '../app/jev/chrome.mjs';

test('the extension copy in app data follows the bundled files', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'autojob-extension-')),
    source = path.join(base, 'bundled'),
    target = path.join(base, 'data', 'chrome-extension');
  t.after(() => {
    resetExtensionFolder();
    return rm(base, {recursive: true, force: true});
  });
  await mkdir(path.join(source, 'icons'), {recursive: true});
  await writeFile(path.join(source, 'manifest.json'), '{"version":"1"}');
  await writeFile(path.join(source, 'icons', 'a.png'), 'png');
  await prepareExtensionFolder({source, target});
  assert.equal(installedExtensionDirectory(), target);
  assert.match(
    extensionMissingMessage(),
    new RegExp(target.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')),
  );
  assert.equal(await readFile(path.join(target, 'icons', 'a.png'), 'utf8'), 'png');
  await writeFile(path.join(source, 'manifest.json'), '{"version":"2"}');
  await rm(path.join(source, 'icons', 'a.png'));
  await writeFile(path.join(target, 'stale.js'), 'old');
  await prepareExtensionFolder({source, target});
  assert.equal(await readFile(path.join(target, 'manifest.json'), 'utf8'), '{"version":"2"}');
  assert.deepEqual((await readdir(target)).sort(), ['icons', 'manifest.json']);
  assert.deepEqual(await readdir(path.join(target, 'icons')), []);
});

test('a Web Store extension is offered to Chrome through its per-user entry', async () => {
  const written = [],
    ran = [];
  const base = await mkdtemp(path.join(tmpdir(), 'autojob-home-'));
  try {
    assert.equal(
      await registerExternalExtension({
        extensionId: 'abc',
        platform: 'darwin',
        home: base,
        write: async (file, text) =>
          written.push([path.relative(base, file).split(path.sep).join('/'), JSON.parse(text)]),
      }),
      true,
    );
  } finally {
    await rm(base, {recursive: true, force: true});
  }
  assert.deepEqual(written, [
    [
      'Library/Application Support/Google/Chrome/External Extensions/abc.json',
      {external_update_url: 'https://clients2.google.com/service/update2/crx'},
    ],
  ]);
  await registerExternalExtension({
    extensionId: 'abc',
    platform: 'win32',
    run: async (...args) => ran.push(args),
  });
  assert.equal(ran[0][0], 'reg');
  assert.ok(ran[0][1].includes('HKCU\\Software\\Google\\Chrome\\Extensions\\abc'));
  assert.equal(await registerExternalExtension({extensionId: 'abc', platform: 'linux'}), false);
});
