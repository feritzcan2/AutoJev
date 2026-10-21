import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  chromeDataError,
  chromeUserDataDirectory,
  listChromeProfiles,
} from '../app/browser/chrome-profiles.mjs';
import {findChrome} from '../app/browser/chrome-installation.mjs';
import {extensionInstalledInProfile, openChromeUrl} from '../app/jev/chrome.mjs';

test('Chrome profile storage resolves the native per-user directory on each platform', () => {
  assert.equal(
    chromeUserDataDirectory({platform: 'darwin', home: '/Users/example', env: {}}),
    '/Users/example/Library/Application Support/Google/Chrome',
  );
  assert.equal(
    chromeUserDataDirectory({
      platform: 'linux',
      home: '/home/example',
      env: {XDG_CONFIG_HOME: '/custom/config'},
    }),
    '/custom/config/google-chrome',
  );
  assert.equal(
    chromeUserDataDirectory({
      platform: 'win32',
      home: 'C:\\Users\\example',
      env: {LOCALAPPDATA: 'D:\\Local'},
    }),
    'D:\\Local\\Google\\Chrome\\User Data',
  );
  assert.equal(
    chromeUserDataDirectory({platform: 'win32', home: 'C:\\Users\\example', env: {}}),
    'C:\\Users\\example\\AppData\\Local\\Google\\Chrome\\User Data',
  );
});
test('Chrome installation discovery includes per-user macOS and Linux stable packages', async () => {
  const file = '/Users/example/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(
    await findChrome({
      platform: 'darwin',
      home: '/Users/example',
      env: {},
      accessImpl: async (candidate) => {
        if (candidate !== file) throw Error();
      },
      statImpl: async () => ({isFile: () => true}),
    }),
    file,
  );
  assert.equal(
    await findChrome({
      platform: 'linux',
      home: '/home/example',
      env: {PATH: '/usr/bin'},
      accessImpl: async (candidate) => {
        if (candidate !== '/usr/bin/google-chrome-stable') throw Error();
      },
      statImpl: async () => ({isFile: () => true}),
    }),
    '/usr/bin/google-chrome-stable',
  );
});
test('the AutoJob extension counts as installed only with an enabled settings record in the selected profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jobloop-chrome-'));
  const extensionId = 'jmpiibcgkhgcbjgnncpicngllpppiiel';
  try {
    await mkdir(path.join(directory, 'Profile 1'), {recursive: true});
    const preferences = path.join(directory, 'Profile 1', 'Preferences');
    assert.equal(await extensionInstalledInProfile('Profile 1', {directory}), false);
    await writeFile(preferences, JSON.stringify({extensions: {settings: {[extensionId]: {}}}}));
    assert.equal(await extensionInstalledInProfile('Profile 1', {directory}), false);
    await writeFile(
      preferences,
      JSON.stringify({extensions: {settings: {[extensionId]: {location: 4, state: 0}}}}),
    );
    assert.equal(await extensionInstalledInProfile('Profile 1', {directory}), false);
    await writeFile(
      preferences,
      JSON.stringify({extensions: {settings: {[extensionId]: {location: 4, state: 1}}}}),
    );
    assert.equal(await extensionInstalledInProfile('Profile 1', {directory}), true);
    assert.equal(await extensionInstalledInProfile('Default', {directory}), false);
    assert.equal(await extensionInstalledInProfile('../Profile 1', {directory}), false);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
test('macOS privacy block on Chrome data names Full Disk Access', () => {
  const denied = Object.assign(Error('EPERM: operation not permitted'), {code: 'EPERM'});
  const blocked = chromeDataError(denied, {platform: 'darwin'});
  assert.equal(blocked.code, 'CHROME_DATA_BLOCKED');
  assert.match(blocked.message, /Full Disk Access/);
  assert.equal(chromeDataError(denied, {platform: 'win32'}), denied);
  const missing = Object.assign(Error('missing'), {code: 'ENOENT'});
  assert.equal(chromeDataError(missing, {platform: 'darwin'}), missing);
});
test('launch uses the discovered installation and selected profile as arguments, never shell text', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jobloop-chrome-'));
  try {
    await writeFile(
      path.join(directory, 'Local State'),
      JSON.stringify({
        profile: {
          last_used: 'Default',
          info_cache: {
            Default: {name: 'Personal'},
            'Profile 1': {name: 'Work'},
            '../outside': {name: 'Invalid'},
          },
        },
      }),
    );
    assert.deepEqual(
      (await listChromeProfiles({directory})).map((profile) => profile.directory),
      ['Default', 'Profile 1'],
    );
    let called = 0;
    const executable = '/Users/example/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const options = {
      directory,
      findChromeImpl: async () => executable,
      execImpl: async (file, args, settings) => {
        called++;
        assert.equal(file, executable);
        assert.deepEqual(args, [
          '--profile-directory=Profile 1',
          'chrome-extension://jmpiibcgkhgcbjgnncpicngllpppiiel/connect.html?relay=x',
        ]);
        assert.equal(settings.shell, undefined);
      },
    };
    const url = 'chrome-extension://jmpiibcgkhgcbjgnncpicngllpppiiel/connect.html?relay=x';
    await openChromeUrl(url, {directory: 'Profile 1'}, options);
    assert.equal(called, 1);
    await assert.rejects(() => openChromeUrl(url, {directory: '../outside'}, options), /not found/);
    assert.equal(called, 1);
    await assert.rejects(
      () =>
        openChromeUrl(url, {directory: 'Default'}, {...options, findChromeImpl: async () => null}),
      /Chrome was not found/,
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
