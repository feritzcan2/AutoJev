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
      globalThis.inputs = [];
      Engine.prototype.request = function (op, args = {}) {
        if (op === 'start') {
          globalThis.starts.push(args);
          return Promise.resolve({});
        }
        if (op === 'input') globalThis.inputs.push(args.text);
        if (['message', 'resize', 'stop', 'input'].includes(op)) return Promise.resolve({});
        return original.call(this, op, args);
      };
      const {BrowserTools} = await load(browser);
      BrowserTools.prototype.status = () => ({ready: true, state: 'ready'});
      const ready = (id, label) => ({id, label, state: 'ready', detail: 'Ready.'});
      ipcMain.removeHandler('readiness');
      ipcMain.handle('readiness', (_, input) => ({
        ready: input.provider !== 'opencode',
        provider: input.provider,
        checks: [
          input.provider === 'opencode'
            ? {id: 'agent', label: 'OpenCode', state: 'error', detail: 'OpenCode is not installed.'}
            : ready('agent', input.provider),
          ready('login', 'Agent session'),
          ready('chrome', 'Google Chrome'),
          globalThis.chromeOff
            ? {
                id: 'chrome-debug',
                label: 'Chrome connection',
                state: 'error',
                detail: 'Turn on remote debugging in Chrome.',
                action: {
                  command: 'chrome://inspect/#remote-debugging',
                  label: 'Copy the Chrome address',
                },
              }
            : ready('chrome-debug', 'Chrome connection'),
          globalThis.jevMissing && input.decisions === 'jev'
            ? {id: 'jev', label: 'Jev key', state: 'error', detail: 'Save the key.'}
            : ready('jev', 'Jev key'),
        ],
      }));
      ipcMain.removeHandler('jev-settings-status');
      ipcMain.handle('jev-settings-status', () => ({configured: !globalThis.jevMissing}));
      globalThis.jevMissing = true;
      globalThis.chromeOff = true;
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
  assert.equal(await screen.getByText('Cancel').count(), 0, 'First run cannot be cancelled');
  assert.equal(
    await screen.locator('.onboarding-badge').textContent(),
    'Recommended',
    'Claude is marked as recommended',
  );
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
      instructions: '',
      facts: '',
    });
    await tool('reply_to_user', {message: reply});
    await tool('finish_automation_run', {
      status: 'completed',
      summary: 'Profile filled from the CV.',
    });
    await page.waitForFunction(
      () => document.querySelector('#onboarding').dataset.step === 'review',
    );
  };
  const pickCv = async () => {
    await screen.getByRole('button', {name: 'Choose CV'}).click();
    // Choosing the CV stays on the first step until Start.
    await screen.getByRole('button', {name: 'Choose another CV'}).waitFor();
    assert.equal(await screen.getAttribute('data-step'), 'start');
    assert.notEqual(await screen.locator('.onboarding-cv-file').textContent(), '');
    await screen.getByRole('button', {name: 'Start', exact: true}).click();
    await page.waitForFunction(
      () => document.querySelector('#onboarding').dataset.step === 'reading',
    );
    return page.evaluate(() => localStorage.getItem('selected-workspace'));
  };

  // A first run can start over once the CV is read; declining the confirmation keeps it.
  await pickCv();
  const answer = (accept) =>
    page.once('dialog', (dialog) => (accept ? dialog.accept() : dialog.dismiss()));
  answer(false);
  await screen.getByRole('button', {name: 'Start over'}).click();
  assert.equal(await screen.getAttribute('data-step'), 'reading');
  answer(true);
  await screen.getByRole('button', {name: 'Start over'}).click();
  await page.waitForFunction(() => document.querySelector('#onboarding').dataset.step === 'start');
  assert.equal((await page.evaluate(() => window.jobloop.workspaces())).length, 0);

  // Notes typed next to the CV reach the setup agent with the CV task and stay in the chat.
  await screen.locator('.choice[data-state=ready]').first().waitFor();
  await screen.locator('[name=notes]').fill('Remote or Berlin only, at least 80k EUR');
  const id = await pickCv();
  assert.ok(await page.getByRole('heading', {name: 'Reading your CV'}).isVisible());
  const cvTurn = await app.evaluate(() =>
    globalThis.starts.filter((s) => /Profile from the CV/.test(s.prompt)).at(-1),
  );
  assert.match(cvTurn.prompt, /userNotes.*Remote or Berlin only, at least 80k EUR/s);
  assert.ok(
    (await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), id)).messages.some(
      (m) => m.role === 'user' && m.text === 'Remote or Berlin only, at least 80k EUR',
    ),
  );
  // The setup agent's terminal is on the reading step: Claude's folder trust
  // question fires no agent state, so the screen itself raises the notice.
  const surface = screen.locator('.onboarding-terminal .xterm'),
    terminalShown = () => screen.locator('.onboarding-terminal-wrap').getAttribute('data-shown');
  await surface.waitFor({state: 'attached'});
  await app.evaluate(({BrowserWindow}, id) => {
    const prompt =
      '\x1b[2J\x1b[HAccessing workspace:\r\n\r\nQuick safety check: Is this a project you created or one you trust?\r\n\r\n' +
      '❯ No, exit\r\n  Yes, I trust this folder\r\n\r\nEnter to confirm · Esc to cancel\r\n';
    BrowserWindow.getAllWindows()[0].webContents.send('agent-event', {
      event: 'output',
      candidateId: id,
      workerId: 'conversation',
      sequence: 1e9,
      bytes: [...Buffer.from(prompt)],
    });
  }, id);
  // The trust question gets its own button; the terminal stays folded away.
  await screen.getByText(/asks whether it may work in this profile’s folder/).waitFor();
  assert.equal(await terminalShown(), 'true', 'The terminal is shown by default');
  await screen.getByRole('button', {name: 'Trust this folder'}).click();
  // "No, exit" is selected first: the button moves down to "Yes" before Enter.
  assert.deepEqual(
    await app.evaluate(async () => {
      for (let i = 0; i < 50 && !globalThis.inputs.includes('\r'); i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      return globalThis.inputs;
    }),
    ['\x1b[B', '\r'],
    'The trust button answers yes to the setup agent',
  );
  // Chrome is connected while the CV is read, and the screen notices it by itself.
  await screen.getByRole('heading', {name: 'Connect Chrome'}).waitFor();
  assert.ok(await screen.getByText('chrome://inspect/#remote-debugging').isVisible());
  await page.screenshot({path: path.join(data, '2-reading-chrome.png')});
  await app.evaluate(() => {
    globalThis.chromeOff = false;
  });
  await screen.getByText('Chrome is ready').waitFor({timeout: 15000});
  await screen.getByRole('button', {name: 'Hide the agent terminal'}).click();
  assert.equal(await terminalShown(), 'false');
  await screen.getByRole('button', {name: 'Show the agent terminal'}).click();
  assert.equal(await terminalShown(), 'true');
  await page.waitForFunction(
    () => document.querySelector('.onboarding-elapsed')?.textContent !== '0:00',
  );
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
    reply: 'I filled your role and location from your CV. Add your salary and work permit.',
  });
  const form = screen.locator('form');
  await page.getByText('Add your salary and work permit.').waitFor();
  assert.equal(await form.locator('[name=title]').inputValue(), 'Deniz Yilmaz');
  assert.equal(await form.locator('[name=country]').inputValue(), 'DE');
  assert.equal(
    await form.locator('[name=preferences]').inputValue(),
    'Senior Backend Engineer, .NET',
  );
  assert.ok(
    await form.locator('.onboarding-checks').getByText('StepStone', {exact: true}).isVisible(),
    'Boards for the CV country are suggested',
  );
  // Boards the profile country already added stay listed; the new country's boards join.
  await form.locator('[name=country]').fill('DK');
  assert.ok(
    await form.locator('.onboarding-checks').getByText('Jobindex', {exact: true}).isVisible(),
  );
  await form.locator('[name=country]').fill('DE');
  await form
    .locator('[name=application_facts]')
    .fill('Salary expectation 80,000 EUR, EU work permit');
  // The agent makes the listing decisions by default: no Jev key is asked for.
  assert.equal(await form.getByText('Jev key').count(), 0);
  await page.screenshot({path: path.join(data, '3-review.png')});
  await screen.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await page.screenshot({path: path.join(data, '3-review-bottom.png')});

  await form.getByRole('button', {name: 'Save and start the search'}).click();
  await screen.waitFor({state: 'hidden'});
  await page.waitForFunction((id) => document.querySelector('#candidates').value === id, id);
  const a = (await page.evaluate((id) => window.jobloop.workspaceSnapshot(id), id)).automation;
  assert.equal(a.title, 'Deniz Yilmaz');
  assert.equal(a.criteria.application_facts, 'Salary expectation 80,000 EUR, EU work permit');
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
  await screen.getByRole('button', {name: 'Cancel'}).waitFor();
  const second = await pickCv();
  assert.notEqual(second, id);
  await agentFillsProfile(second, {
    title: 'Ayse Kaya',
    goal: 'Product designer roles in Copenhagen',
    criteria: {preferences: 'Product Designer', country: 'DK', location: 'Copenhagen, Denmark'},
    reply: 'I filled your role and city from your CV.',
  });
  assert.equal(await form.locator('[name=title]').inputValue(), 'Ayse Kaya');
  assert.equal(
    await form.locator('[name=application_facts]').inputValue(),
    '',
    'No values leak in',
  );
  assert.ok(
    await form.locator('.onboarding-checks').getByText('Jobindex', {exact: true}).isVisible(),
  );
  await form.getByRole('button', {name: 'Save and start the search'}).click();
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
  await screen.getByRole('button', {name: 'Cancel'}).click();
  await screen.waitFor({state: 'hidden'});
  await page.waitForFunction(async (id) => {
    const items = await window.jobloop.workspaces();
    return items.length === 2 && document.querySelector('#candidates').value === id;
  }, second);
  // Cancelling while the CV is read deletes the unfinished profile.
  await page.locator('#new').click();
  await screen.waitFor();
  const third = await pickCv();
  answer(true);
  await screen.getByRole('button', {name: 'Cancel'}).click();
  await screen.waitFor({state: 'hidden'});
  await page.waitForFunction(
    async ([third, second]) => {
      const items = await window.jobloop.workspaces();
      return (
        !items.some((item) => item.id === third) &&
        document.querySelector('#candidates').value === second
      );
    },
    [third, second],
  );
  const setups = await app.evaluate(() => globalThis.starts.length);
  await page.locator('#new').click();
  await screen.waitFor();
  // Notes written before choosing the chat become its first message.
  await screen.locator('[name=notes]').fill('Only part-time roles');
  await screen.getByRole('button', {name: 'I want to set it up in a chat'}).click();
  await screen.waitFor({state: 'hidden'});
  await page.locator('aside nav [data-view=setup-agent].selected').waitFor();
  const chatTurn = await app.evaluate(async (_, count) => {
    for (let i = 0; i < 100 && globalThis.starts.length === count; i++)
      await new Promise((r) => setTimeout(r, 50));
    return globalThis.starts.at(-1);
  }, setups);
  assert.match(chatTurn.prompt, /Only part-time roles/, 'The chat starts with the notes');
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
