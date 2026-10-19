import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
// The workspace search terms on Sources: added once, shown as the default of
// every keyword source, kept out of a source's own terms field.
const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const data = await mkdtemp(path.join(os.tmpdir(), 'search-terms-')),
  env = {...process.env, JOBLOOP_DATA_DIR: data};
delete env.ELECTRON_RUN_AS_NODE;
const core = new WorkspaceDatabase(path.join(data, 'jobloop.sqlite'));
new AutomationStore(core);
core.close();
const app = await electron.launch({
  executablePath: require('electron'),
  args: [process.cwd()],
  env,
});
app.process().stderr.on('data', (data) => process.stderr.write(data));
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await app.evaluate(({ipcMain}) => {
    ipcMain.removeHandler('automation-setup');
    ipcMain.handle('automation-setup', () => ({test: true}));
  });
  await page
    .locator('#onboarding')
    .getByRole('button', {name: 'I want to set it up in a chat'})
    .click();
  await page.waitForFunction(() => document.querySelector('#candidates')?.value);
  await page.locator('aside nav [data-view=sources]').click();
  const bar = page.locator('.source-terms');
  await bar.getByText('None yet').waitFor();
  await bar.getByRole('button', {name: 'Add terms'}).click();
  await bar.locator('[name=searchTerms]').fill('Staff Backend Engineer, Platform Engineer');
  await bar.getByRole('button', {name: 'Save'}).click();
  await bar.getByText('Staff Backend Engineer · Platform Engineer').waitFor();
  assert.match(await bar.textContent(), /Used by \d+ sources/);
  if (process.env.SCREENSHOT) await page.screenshot({path: process.env.SCREENSHOT + '-bar.png'});

  const id = await page.evaluate(() => document.querySelector('#candidates').value);
  const linkedIn = (
    await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), id)
  ).sources.find((s) => s.name === 'LinkedIn');
  assert.equal(linkedIn.sharedTerms, true);
  assert.deepEqual(linkedIn.recipe.terms, ['Staff Backend Engineer', 'Platform Engineer']);

  const row = page.locator(`.source-row[data-source-id="${linkedIn.url}"]`);
  await row.locator('.source-row-menu').click();
  await row.locator('.source-edit').click();
  const terms = page.locator(`.source-editor[data-source-id="${linkedIn.url}"] [name=terms]`);
  assert.equal(await terms.inputValue(), '');
  assert.equal(
    await terms.getAttribute('placeholder'),
    'Staff Backend Engineer, Platform Engineer',
  );
  if (process.env.SCREENSHOT) await page.screenshot({path: process.env.SCREENSHOT + '-editor.png'});
  console.log('SEARCH_TERMS_UI_PASS');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await app.close();
}
