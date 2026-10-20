import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const data = await mkdtemp(path.join(tmpdir(), 'jobloop-background-ui-'));
const app = await electron.launch({
  executablePath: process.env.JOBLOOP_ELECTRON_BINARY || require('electron'),
  args: [process.cwd()],
  env: {...process.env, JOBLOOP_DATA_DIR: data, JOBLOOP_UPDATE_CHECK: 'off'},
});
const exited = new Promise((resolve) => app.process().on('exit', resolve));
try {
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.jobloop));
  const workspace = await page.evaluate(() =>
    window.jobloop.workspaceCreate('custom', {title: 'Background Fixture', goal: 'Synthetic'}),
  );
  await page.reload();
  await page.waitForFunction(() => Boolean(window.jobloop));
  // An unpackaged build never registers a login item.
  const status = await page.evaluate(() => window.jobloop.backgroundStatus());
  assert.equal(status.supported, false);
  await assert.rejects(
    page.evaluate(() => window.jobloop.setOpenAtLogin(true)),
    /installed app/,
  );
  await page.locator('[data-view=config]').click();
  await page.locator('a[href="#config-background"]').click();
  await page.locator('#config-background-panel [data-help]:not(:empty)').waitFor();
  assert.equal(await page.locator('#config-background [data-login]').isDisabled(), true);
  // Closing the window hides it; the app keeps running until it quits.
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForTimeout(500);
  assert.deepEqual(
    await app.evaluate(({BrowserWindow}) =>
      BrowserWindow.getAllWindows().map((w) => ({visible: w.isVisible()})),
    ),
    [{visible: false}],
  );
  await app.evaluate(({app}) => app.emit('activate'));
  await page.waitForTimeout(300);
  assert.equal(
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()),
    true,
  );
  await app.evaluate(
    ({BrowserWindow}, id) =>
      BrowserWindow.getAllWindows()[0].webContents.send('open-workspace', {workspaceId: id}),
    workspace.id,
  );
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#candidates').inputValue(), workspace.id);
  assert.deepEqual(errors, []);
  await app.evaluate(({app}) => setTimeout(() => app.quit(), 10));
  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 20000)),
  ]);
  assert.notEqual(code, 'timeout', 'Quit must end the app even though closing only hides it.');
  console.log('Background mode smoke passed.');
} finally {
  if (app.process().exitCode === null) await app.close().catch(() => {});
}
