import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';

const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  directory = await mkdtemp(path.join(os.tmpdir(), 'minimum-save-score-ui-'));
const core = new WorkspaceDatabase(path.join(directory, 'jobloop.sqlite')),
  db = new AutomationStore(core);
const workspace = db.create('custom', {
  title: 'Minimum puan kontrolü',
  goal: 'Sentetik sonuçları takip et',
  criteria: {
    outcome: 'Sonuçları bul',
    rules: 'Kaydedilmiş tercihlere göre puanla',
    completion: 'Kaynağın sonuna ulaş',
    score_threshold: '80',
  },
  sources: ['https://example.test/results'],
});
db.review(workspace.id);
db.pause(workspace.id);
core.close();
const application = await electron.launch({
  executablePath: process.env.JOBLOOP_ELECTRON_BINARY || require('electron'),
  args: [root],
  env: {...process.env, JOBLOOP_DATA_DIR: directory},
});
try {
  const page = await application.firstWindow({timeout: 20000}),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await application.evaluate(
    async (_, url) => {
      const vm = process.getBuiltinModule('node:vm'),
        load = vm.runInThisContext('(url)=>import(url)', {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        }),
        {Engine} = await load(url),
        request = Engine.prototype.request;
      Engine.prototype.request = function (op, args = {}) {
        if (['start', 'resize', 'message', 'stop'].includes(op)) return Promise.resolve({});
        return request.call(this, op, args);
      };
    },
    pathToFileURL(path.join(root, 'app/engine.mjs')).href,
  );
  await page.locator(`#candidates option[value="${workspace.id}"]`).waitFor({state: 'attached'});
  await page.selectOption('#candidates', workspace.id);
  await page.locator('[data-view=board]').click();
  const board = page.locator('[data-automation-pane=board]'),
    minimum = board.getByLabel('Minimum kayıt puanı', {exact: true});
  await minimum.waitFor({state: 'visible'});
  assert.equal(await minimum.inputValue(), '');
  assert.equal(
    await page
      .locator('[data-automation-pane=profile]')
      .getByLabel('Minimum kayıt puanı', {exact: true})
      .count(),
    0,
  );
  const saved = async (value) =>
    page.waitForFunction(
      async ({id, value}) =>
        (await window.jobloop.workspaceSnapshot(id)).automation.criteria.save_score_threshold ===
        value,
      {id: workspace.id, value},
    );
  await minimum.fill('60');
  await board.getByRole('button', {name: 'Kaydet', exact: true}).click();
  await saved('60');
  await page.locator('[data-view=profile]').click();
  await page.locator('#automation-plan-form [name=goal]').fill('Güncellenmiş sentetik amaç');
  await page.locator('[data-view=board]').click();
  await minimum.fill('65');
  await board.getByRole('button', {name: 'Kaydet', exact: true}).click();
  await saved('65');
  assert.equal(
    (await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), workspace.id)).automation
      .goal,
    'Sentetik sonuçları takip et',
  );
  await page.locator('[data-view=profile]').click();
  assert.equal(
    await page.locator('#automation-plan-form [name=goal]').inputValue(),
    'Güncellenmiş sentetik amaç',
  );
  await page.locator('#automation-profile-save').click();
  await page.waitForFunction(
    async (id) =>
      (await window.jobloop.workspaceSnapshot(id)).automation.goal === 'Güncellenmiş sentetik amaç',
    workspace.id,
  );
  assert.equal(
    (await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), workspace.id)).automation
      .criteria.save_score_threshold,
    '65',
  );
  await page.locator('[data-view=board]').click();
  await minimum.fill('');
  await board.getByRole('button', {name: 'Kaydet', exact: true}).click();
  await saved('');
  await page.reload();
  await minimum.waitFor({state: 'visible'});
  assert.equal(await minimum.inputValue(), '');
  await minimum.fill('60');
  await board.getByRole('button', {name: 'Kaydet', exact: true}).click();
  await saved('60');
  await page.evaluate((id) => window.jobloop.automationRun(id, 'run'), workspace.id);
  await page.waitForFunction(
    async (id) =>
      (await window.jobloop.workspaceSnapshot(id)).activeRuns.some(
        (run) => run.kind !== 'interview',
      ),
    workspace.id,
  );
  const before = await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), workspace.id);
  await minimum.fill('70');
  await board.getByRole('button', {name: 'Kaydet', exact: true}).click();
  await saved('70');
  const after = await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), workspace.id);
  assert.deepEqual(
    after.activeRuns.map((run) => run.id),
    before.activeRuns.map((run) => run.id),
  );
  assert.equal(after.automation.revision, before.automation.revision);
  assert.equal(await page.locator('#automation-profile-save-dialog').isVisible(), false);
  await page.screenshot({path: path.join(directory, 'minimum-save-score-board.png')});
  assert.deepEqual(errors, []);
  console.log('MINIMUM_SAVE_SCORE_UI_PASS', directory);
} finally {
  await application.close();
}
