import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {mkdtemp, mkdir, writeFile, rm, chmod, stat, symlink} from 'node:fs/promises';
import os from 'node:os';
import verifyUniversalInputs from '../scripts/verify-universal-inputs.cjs';
import prepareMacosBundle from '../scripts/prepare-macos-bundle.cjs';
import {engineBinaryPath, runtimeResourceRoot} from '../app/system/runtime-paths.mjs';
import {createUpdateManager} from '../app/system/update-manager.mjs';
test('packaged engine resolves outside asar and development uses an existing debug binary', () => {
  assert.equal(
    engineBinaryPath({
      root: '/Applications/AutoJev.app/Contents/Resources/app.asar',
      resourcesPath: '/resources',
      platform: 'win32',
    }),
    path.join('/resources', 'engine', 'jobloop-engine.exe'),
  );
  assert.equal(
    engineBinaryPath({root: '/src', platform: 'linux', exists: () => false}),
    path.join('/src', 'engine/target/release/jobloop-engine'),
  );
  assert.equal(
    engineBinaryPath({root: '/src', platform: 'linux', exists: () => true}),
    path.join('/src', 'engine/target/debug/jobloop-engine'),
  );
  assert.equal(
    runtimeResourceRoot({root: '/app/resources/app.asar'}),
    '/app/resources/app.asar.unpacked',
  );
});
test('update installation creates a backup before it quits; failure never installs', async () => {
  const updater = new EventEmitter(),
    calls = [];
  updater.quitAndInstall = () => calls.push('install');
  let backupFailure = true;
  const manager = createUpdateManager({
    app: {isPackaged: true, getVersion: () => '0.1.0'},
    platform: 'darwin',
    updater,
    beforeInstall: async () => {
      calls.push('backup');
      if (backupFailure) throw Error('backup failed');
    },
  });
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.autoDownload, false);
  updater.emit('update-downloaded', {version: '0.2.0'});
  await assert.rejects(manager.install(), /backup failed/);
  assert.deepEqual(calls, ['backup']);
  backupFailure = false;
  updater.emit('update-downloaded', {version: '0.2.0'});
  await manager.install();
  assert.deepEqual(calls, ['backup', 'backup', 'install']);
  manager.dispose();
  assert.equal(updater.listenerCount('error'), 0);
});
test('development and Linux deb packages do not initialize an updater', async () => {
  for (const [isPackaged, platform] of [
    [false, 'darwin'],
    [true, 'linux'],
  ]) {
    const manager = createUpdateManager({
      app: {isPackaged, getVersion: () => '0.1.0'},
      platform,
      env: {},
    });
    assert.equal(manager.snapshot().enabled, false);
    await assert.rejects(manager.install(), /not supported/);
  }
});
test('installer errors release maintenance whether thrown or emitted asynchronously', async () => {
  for (const asynchronous of [false, true]) {
    const updater = new EventEmitter();
    let released = 0;
    updater.quitAndInstall = () => {
      if (asynchronous) setImmediate(() => updater.emit('error', Error('installer failed')));
      else throw Error('installer failed');
    };
    const manager = createUpdateManager({
      app: {isPackaged: true, getVersion: () => '0.1.0'},
      platform: 'darwin',
      updater,
      beforeInstall: async () => () => {
        released++;
      },
    });
    updater.emit('update-downloaded', {version: '0.2.0'});
    if (asynchronous) {
      await manager.install();
      await new Promise((resolve) => setImmediate(resolve));
    } else await assert.rejects(manager.install(), /installer failed/);
    assert.equal(released, 1);
    manager.dispose();
  }
});
test('universal packaging refuses mixed source snapshots before creating an ESM-incompatible bootstrap', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jobloop-universal-'));
  try {
    for (const arch of ['x64', 'arm64']) {
      const resources = path.join(
        directory,
        `mac-universal-${arch}-temp/AutoJev.app/Contents/Resources`,
      );
      await mkdir(resources, {recursive: true});
      await writeFile(path.join(resources, 'app.asar'), 'immutable source');
    }
    const context = {
      appOutDir: path.join(directory, 'mac-universal-arm64-temp'),
      packager: {appInfo: {productFilename: 'AutoJev'}},
    };
    await verifyUniversalInputs(context);
    await writeFile(
      path.join(context.appOutDir, 'AutoJev.app/Contents/Resources/app.asar'),
      'concurrent edit',
    );
    await assert.rejects(verifyUniversalInputs(context), /immutable checkout/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test(
  'macOS bundles restore distribution permissions without following symlinks',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jobloop-package-permissions-'));
    try {
      const bundle = path.join(directory, 'AutoJev.app'),
        binaries = path.join(bundle, 'Contents/MacOS'),
        executable = path.join(binaries, 'AutoJev'),
        resource = path.join(bundle, 'Contents/Info.plist'),
        outside = path.join(directory, 'private-file');
      await mkdir(binaries, {recursive: true, mode: 0o700});
      await writeFile(executable, 'synthetic executable');
      await chmod(executable, 0o700);
      await writeFile(resource, 'synthetic resource', {mode: 0o600});
      await writeFile(outside, 'must remain private', {mode: 0o600});
      await symlink(outside, path.join(bundle, 'external-link'));
      await prepareMacosBundle({
        appOutDir: directory,
        electronPlatformName: 'darwin',
        packager: {appInfo: {productFilename: 'AutoJev'}},
      });
      for (const file of [bundle, path.join(bundle, 'Contents'), binaries, executable])
        assert.equal((await stat(file)).mode & 0o777, 0o755);
      assert.equal((await stat(resource)).mode & 0o777, 0o644);
      assert.equal((await stat(outside)).mode & 0o777, 0o600);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  },
);
