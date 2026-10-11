import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// First run with no workspace: CV upload, profile from the setup agent, review, start.
// Provider decisions, the file dialog and readiness are mocked; UI, IPC, database,
// documents and the MCP tool server are real.
const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const data = await mkdtemp(path.join(tmpdir(), 'onboarding-')),
  cv = path.join(data, 'cv-fixture.txt');
await writeFile(cv, 'Deniz Yilmaz\nSenior Backend Engineer, Berlin\n.NET, AWS, 9 years\n');
const env = {...process.env, JOBLOOP_DATA_DIR: data};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require('electron'),
  args: [process.cwd()],
  env,
});
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.setViewportSize({width: 1280, height: 900});
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(
    async ({ipcMain, dialog}, {engine, browser, file, loader}) => {
      const vm = process.getBuiltinModule('node:vm'),
        load = vm.runInThisContext(loader, {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        });
      const {Engine} = await load(engine),
        original = Engine.prototype.request;
      globalThis.starts = [];
      Engine.prototype.request = function (op, args = {}) {
        if (op === 'start') {
          globalThis.starts.push(args);
          return Promise.resolve({});
        }
        if (['message', 'resize', 'stop'].includes(op)) return Promise.resolve({});
        return original.call(this, op, args);
      };
      const {BrowserTools} = await load(browser);
      BrowserTools.prototype.status = () => ({ready: true, state: 'ready'});
      const ready = (id, label) => ({id, label, state: 'ready', detail: 'Hazır.'});
      ipcMain.removeHandler('readiness');
      ipcMain.handle('readiness', (_, input) => ({
        ready: input.provider !== 'opencode',
        provider: input.provider,
        checks: [
          input.provider === 'opencode'
            ? {id: 'agent', label: 'OpenCode', state: 'error', detail: 'OpenCode kurulu değil.'}
            : ready('agent', input.provider),
          ready('login', 'Agent oturumu'),
          ready('chrome', 'Google Chrome'),
          ready('chrome-debug', 'Chrome bağlantısı'),
          globalThis.jevMissing
            ? {id: 'jev', label: 'Jev anahtarı', state: 'error', detail: 'Anahtarı kaydet.'}
            : ready('jev', 'Jev anahtarı'),
        ],
      }));
      ipcMain.removeHandler('jev-settings-status');
      ipcMain.handle('jev-settings-status', () => ({configured: !globalThis.jevMissing}));
      globalThis.jevMissing = true;
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [file]});
    },
    {
      engine: pathToFileURL(path.resolve('app/agents/engine.mjs')).href,
      browser: pathToFileURL(path.resolve('app/browser/tools.mjs')).href,
      file: cv,
      loader: '(url)=>import(url)',
    },
  );
  const screen = page.locator('#onboarding');
  await screen.waitFor();
  assert.equal(await screen.getAttribute('data-step'), 'start');
  await screen.locator('.choice[data-state=ready]').first().waitFor();
  const providers = screen.locator('input[name=onboarding-provider]');
  assert.ok((await providers.count()) >= 2, 'Supported agents are offered');
  assert.equal(
    await screen.locator('.choice[data-state=ready] input').first().isChecked(),
    true,
    'A ready agent is preselected',
  );
  assert.equal(await screen.getByText('Vazgeç').count(), 0, 'First run cannot be cancelled');
  await page.screenshot({path: path.join(data, '1-start.png')});

  let rpc = 0;
  // Plays the setup agent of the latest welcome-screen turn through the real tool server.
  const agentFillsProfile = async (id, {title, goal, criteria, reply}) => {
    const start = await app.evaluate(() =>
        globalThis.starts.filter((s) => /Profile from the CV/.test(s.prompt)).at(-1),
      ),
      tool = async (name, args = {}) => {
        assert.ok(start, 'The setup agent receives the CV task');
        const response = await fetch(start.endpoint, {
            method: 'POST',
            headers: {Authorization: 'Bearer ' + start.token, 'Content-Type': 'application/json'},
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: ++rpc,
              method: 'tools/call',
              params: {name, arguments: args},
            }),
          }),
          body = await response.json();
        assert.ok(!body.error && !body.result?.isError, JSON.stringify(body));
        return JSON.parse(body.result.content[0].text);
      };
    const created = await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), id);
    assert.ok(
      created.documents.some((d) => d.path.startsWith('documents/')),
      'The CV is a workspace document',
    );
    assert.equal(created.automation.agentSettings.provider, 'claude', 'The chosen agent is saved');
    await tool('get_automation_context');
    await tool('save_automation_plan', {
      title,
      goal,
      criteria: Object.entries(criteria).map(([key, value]) => ({key, value})),
      sources: created.automation.sources,
      instructions: '',
      facts: '',
    });
    await tool('reply_to_user', {message: reply});
    await tool('finish_automation_run', {
      status: 'completed',
      summary: 'Profil CV’den dolduruldu.',
    });
    await page.waitForFunction(
      () => document.querySelector('#onboarding').dataset.step === 'review',
    );
  };
  const pickCv = async () => {
    await screen.getByRole('button', {name: 'CV seç'}).click();
    await page.waitForFunction(
      () => document.querySelector('#onboarding').dataset.step === 'reading',
    );
    return page.evaluate(() => localStorage.getItem('selected-workspace'));
  };

  const id = await pickCv();
  assert.ok(await page.getByText('CV’n okunuyor').isVisible());
  await page.screenshot({path: path.join(data, '2-reading.png')});
  await agentFillsProfile(id, {
    title: 'Deniz Yilmaz',
    goal: 'Senior backend roles in Berlin or remote in Germany',
    criteria: {
      preferences: 'Senior Backend Engineer, .NET',
      country: 'DE',
      location: 'Berlin, Germany',
      experience: '9 years .NET and AWS',
      application_facts: 'English C1',
    },
    reply: 'CV’nden rolünü ve konumunu doldurdum. Maaş ve çalışma iznini ekle.',
  });
  const form = screen.locator('form');
  await page.getByText('Maaş ve çalışma iznini ekle.').waitFor();
  assert.equal(await form.locator('[name=title]').inputValue(), 'Deniz Yilmaz');
  assert.equal(await form.locator('[name=country]').inputValue(), 'DE');
  assert.equal(
    await form.locator('[name=preferences]').inputValue(),
    'Senior Backend Engineer, .NET',
  );
  assert.ok(
    await form.locator('.onboarding-checks').getByText('StepStone').isVisible(),
    'Boards for the CV country are suggested',
  );
  await form.locator('[name=country]').fill('DK');
  assert.equal(await form.locator('.onboarding-checks').getByText('StepStone').count(), 0);
  assert.ok(await form.locator('.onboarding-checks').getByText('Jobindex').isVisible());
  await form.locator('[name=country]').fill('DE');
  await form.locator('[name=constraints]').fill('En az 80.000 EUR, AB çalışma izni var');
  await form.getByText('Jev anahtarı').waitFor();
  await page.screenshot({path: path.join(data, '3-review.png')});
  await screen.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await page.screenshot({path: path.join(data, '3-review-bottom.png')});

  await form.getByRole('button', {name: 'Kaydet ve aramayı başlat'}).click();
  await screen.locator('.onboarding-error').getByText('TypeSafe API anahtarını kaydet').waitFor();
  assert.equal(await screen.isVisible(), true, 'A missing Jev key blocks the start');
  await app.evaluate(() => {
    globalThis.jevMissing = false;
  });
  await form.getByRole('button', {name: 'Kaydet ve aramayı başlat'}).click();
  await screen.waitFor({state: 'hidden'});
  await page.waitForFunction((id) => document.querySelector('#candidates').value === id, id);
  const a = (await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), id)).automation;
  assert.equal(a.title, 'Deniz Yilmaz');
  assert.equal(a.criteria.constraints, 'En az 80.000 EUR, AB çalışma izni var');
  assert.equal(a.reviewedRevision, a.revision, 'The profile is saved and reviewed');
  assert.equal(a.status, 'enabled', 'The first search starts');
  assert.ok(
    a.sources.some((url) => url.includes('stepstone')),
    'The chosen country board joins',
  );
  assert.equal(await page.locator('[data-view=board].selected').count(), 1);
  await page.screenshot({path: path.join(data, '4-board.png')});

  await page.reload();
  await page.locator('#candidates').waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await screen.isVisible(), false, 'A started search does not show the welcome again');

  // A new profile from the sidebar gets the same CV flow while the first one keeps running.
  await page.locator('#new').click();
  await screen.waitFor();
  assert.equal(await screen.getAttribute('data-step'), 'start');
  await screen.getByRole('button', {name: 'Vazgeç'}).waitFor();
  const second = await pickCv();
  assert.notEqual(second, id);
  await agentFillsProfile(second, {
    title: 'Ayse Kaya',
    goal: 'Product designer roles in Copenhagen',
    criteria: {preferences: 'Product Designer', country: 'DK', location: 'Copenhagen, Denmark'},
    reply: 'Rolünü ve şehrini CV’nden doldurdum.',
  });
  assert.equal(await form.locator('[name=title]').inputValue(), 'Ayse Kaya');
  assert.equal(await form.locator('[name=constraints]').inputValue(), '', 'No values leak in');
  assert.ok(await form.locator('.onboarding-checks').getByText('Jobindex').isVisible());
  await form.getByRole('button', {name: 'Kaydet ve aramayı başlat'}).click();
  await screen.waitFor({state: 'hidden'});
  await page.waitForFunction((id) => document.querySelector('#candidates').value === id, second);
  for (const [workspace, title] of [
    [id, 'Deniz Yilmaz'],
    [second, 'Ayse Kaya'],
  ]) {
    const saved = (await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), workspace))
      .automation;
    assert.equal(saved.title, title);
    assert.equal(saved.status, 'enabled', title + ' keeps searching');
  }
  await page.screenshot({path: path.join(data, '5-second-profile.png')});

  // Leaving a new profile removes the empty one and returns to the profile open before.
  await page.locator('#new').click();
  await screen.waitFor();
  await screen.getByRole('button', {name: 'Vazgeç'}).click();
  await screen.waitFor({state: 'hidden'});
  await page.waitForFunction(async (id) => {
    const items = await window.jobloop.workspaces();
    return items.length === 2 && document.querySelector('#candidates').value === id;
  }, second);
  const setups = await app.evaluate(() => globalThis.starts.length);
  await page.locator('#new').click();
  await screen.waitFor();
  await screen.getByRole('button', {name: 'Sohbetle kurmak istiyorum'}).click();
  await screen.waitFor({state: 'hidden'});
  await page.locator('aside nav [data-view=setup-agent].selected').waitFor();
  const chatStarted = await app.evaluate(async (_, count) => {
    for (let i = 0; i < 100 && globalThis.starts.length === count; i++)
      await new Promise((r) => setTimeout(r, 50));
    return globalThis.starts.length > count;
  }, setups);
  assert.ok(chatStarted, 'Choosing the chat starts the setup agent');
  assert.equal((await page.evaluate(() => window.jobloop.workspaces())).length, 3);
  assert.deepEqual(errors, []);
  console.log('onboarding smoke passed', data);
} catch (error) {
  const page = app.windows()[0];
  await page?.screenshot({path: path.join(data, 'failure.png'), fullPage: true}).catch(() => {});
  console.error('Screenshot:', path.join(data, 'failure.png'));
  throw error;
} finally {
  await app.close();
}
