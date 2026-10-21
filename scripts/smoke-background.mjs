import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
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
  // Electron has no tray menu getter; keep the last menu the app sets.
  await app.evaluate(({Tray}) => {
    const setContextMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.trayMenu = menu;
      return setContextMenu.call(this, menu);
    };
  });
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
  if (process.platform === 'darwin')
    assert.equal(await app.evaluate(({app}) => app.dock.isVisible()), false);
  // The menu's Open AutoJob and notification clicks show the window the same way.
  await app.evaluate(({BrowserWindow}) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.show();
    w.focus();
  });
  await page.waitForTimeout(800);
  if (process.platform === 'darwin')
    assert.equal(await app.evaluate(({app}) => app.dock.isVisible()), true);
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForTimeout(500);
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
  // A scan problem notification opens the Sources page.
  await app.evaluate(
    ({BrowserWindow}, id) =>
      BrowserWindow.getAllWindows()[0].webContents.send('open-workspace', {
        workspaceId: id,
        view: 'sources',
      }),
    workspace.id,
  );
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-automation-pane=sources]').isVisible(), true);
  assert.deepEqual(errors, []);
  // A waiting yes/no question is answered from the tray menu.
  const db = new DatabaseSync(path.join(data, 'jobloop.sqlite')),
    question = {
      id: 'tray-question',
      text: 'Example GmbH, Backend Engineer.\nSign in on the open tab.',
      recordId: null,
      sourceUrl: null,
      fields: [{id: 'loggedIn', label: 'Have you signed in?', type: 'boolean', required: true}],
      answer: null,
      createdAt: Date.now(),
    };
  db.prepare("UPDATE automations SET data=json_set(data,'$.questions',json(?)) WHERE id=?").run(
    JSON.stringify([question]),
    workspace.id,
  );
  await page.waitForTimeout(6000);
  const item = await app.evaluate(() => {
    const entry = globalThis.trayMenu.items.find((i) => i.submenu);
    entry.submenu.items.find((i) => i.label === 'Yes').click();
    return {label: entry.label, items: entry.submenu.items.map((i) => i.label)};
  });
  assert.match(item.label, /^Background Fixture: Example GmbH/);
  assert.deepEqual(item.items.slice(1), [
    'Have you signed in?',
    '',
    'Yes',
    'No',
    'Open in AutoJob',
  ]);
  await page.waitForTimeout(1000);
  assert.equal(
    db
      .prepare(
        "SELECT json_extract(data,'$.questions[0].answer') AS answer FROM automations WHERE id=?",
      )
      .get(workspace.id).answer,
    'Have you signed in?: Yes',
  );
  db.close();
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
