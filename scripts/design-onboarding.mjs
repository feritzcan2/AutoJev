// Walks the real first-run onboarding end to end with a stubbed agent:
// welcome → pick CV (native dialog stubbed) → reading → agent fills profile
// through the real tool server → review → start. Saves a screenshot per step.
// Usage: xvfb-run -a node scripts/design-onboarding.mjs [outDir] [--dark]
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  args = process.argv.slice(2),
  cvArg = args.indexOf('--cv'),
  out = path.resolve(
    args.find((a, i) => !a.startsWith('--') && !['--cv', '--profile'].includes(args[i - 1])) ??
      'design-onboarding',
  ),
  data = await mkdtemp(path.join(os.tmpdir(), 'jobloop-onboarding-')),
  realCv = cvArg >= 0 ? path.resolve(args[cvArg + 1]) : null,
  cv = realCv ?? path.join(data, 'Sara_Kaya_CV.txt');
await mkdir(out, {recursive: true});
if (!realCv)
  await writeFile(
    cv,
    'Sara Kaya\nSenior Backend Engineer · Berlin, Germany · sara@example.com · +49 151 000000\n\n' +
      'Experience\nPlatform Engineer, Larkspur (2021–now): Go, Kubernetes, Postgres.\n' +
      'Backend Engineer, Quayside (2018–2021): Python, payments.\n\nLanguages: English C2, German B1\n',
  );
const log = [];
const application = await electron.launch({
  executablePath: process.env.JOBLOOP_ELECTRON_BINARY || require('electron'),
  args: [root],
  env: {...process.env, JOBLOOP_DATA_DIR: data},
});
const step = async (page, name, note) => {
  await page.waitForTimeout(600);
  await page.screenshot({path: path.join(out, name + '.png')});
  log.push(`${name}: ${note}`);
};
try {
  const page = await application.firstWindow({timeout: 30000});
  page.on('pageerror', (e) => log.push('UI_ERROR ' + e.message));
  if (args.includes('--dark')) await page.emulateMedia({colorScheme: 'dark'});
  await page.setViewportSize({width: 1440, height: 900});
  // Stub the provider and the native file dialog; everything else is real.
  await application.evaluate(
    async ({dialog, safeStorage}, {engineUrl, cvPath}) => {
      // CI has no OS keychain; a reversible stand-in keeps the real save path.
      safeStorage.isEncryptionAvailable = () => true;
      safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
      safeStorage.encryptString = (text) => Buffer.from('x' + text);
      safeStorage.decryptString = (buffer) => buffer.toString().slice(1);
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [cvPath]});
      const vm = process.getBuiltinModule('node:vm'),
        load = vm.runInThisContext('(url)=>import(url)', {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        }),
        {Engine} = await load(engineUrl),
        request = Engine.prototype.request;
      globalThis.setupStarts = [];
      globalThis.inputs = [];
      Engine.prototype.request = function (op, args = {}) {
        if (op === 'input') {
          globalThis.inputs.push(args.text);
          return Promise.resolve({});
        }
        if (op === 'start') {
          globalThis.setupStarts.push(args);
          return Promise.resolve({});
        }
        if (['resize', 'message', 'stop'].includes(op)) return Promise.resolve({});
        return request.call(this, op, args);
      };
    },
    {engineUrl: pathToFileURL(path.join(root, 'app/agents/engine.mjs')).href, cvPath: cv},
  );
  await page.locator('#onboarding').waitFor({state: 'visible', timeout: 15000});
  await page.waitForTimeout(2500); // provider readiness checks
  await step(page, '01-welcome', 'first screen a new user sees');
  const pick = page.locator('[data-action=pick-cv]');
  log.push('pick-cv enabled: ' + (await pick.isEnabled()));
  await pick.click();
  await page.waitForFunction(
    () => document.querySelector('#onboarding')?.dataset.step === 'reading',
    null,
    {timeout: 20000},
  );
  await step(page, '02-reading', 'agent reading the CV');
  // Simulated Claude Code screens in the hidden terminal: folder trust, then a tool approval.
  const workspace = await page.evaluate(async () => (await window.jobloop.workspaces())[0].id);
  let sequence = 1000;
  const screen = (text) =>
    application.evaluate(
      ({BrowserWindow}, event) =>
        BrowserWindow.getAllWindows()[0].webContents.send('agent-event', event),
      {
        candidateId: workspace,
        workerId: 'conversation',
        event: 'output',
        sequence: ++sequence,
        bytes: [...Buffer.from('\x1b[2J\x1b[H' + text.replaceAll('\n', '\r\n'))],
      },
    );
  const answer = async (name, note) => {
    await page.locator('.onboarding-ask:not([hidden])').waitFor({timeout: 10000});
    await step(
      page,
      name,
      note + ': ' + (await page.locator('.onboarding-ask').innerText()).replace(/\n+/g, ' | '),
    );
    await page.locator('.onboarding-ask button.primary').click();
    await page.waitForTimeout(300);
    log.push(
      'keys sent: ' + JSON.stringify(await application.evaluate(() => globalThis.inputs.splice(0))),
    );
  };
  await screen(
    ' Accessing workspace:\n\n /Users/you/Library/Application Support/JobLoop/profiles/a1\n\n' +
      " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.\n\n" +
      " Claude Code'll be able to read, edit, and execute files here.\n\n Security guide\n\n" +
      ' ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel\n',
  );
  await answer('02a-trust', 'trust card');
  await screen(' ✻ Reading the CV…\n');
  await page.waitForTimeout(800);
  await screen(
    '╭──────────────────────────────────────────────────────────────╮\n' +
      '│ Bash command                                                 │\n' +
      '│                                                              │\n' +
      '│   pdftotext -layout documents/' +
      path.basename(cv) +
      ' -    │\n' +
      '│   Extract the text of the uploaded CV                        │\n' +
      '│                                                              │\n' +
      '│ Do you want to proceed?                                      │\n' +
      '│ ❯ 1. Yes                                                     │\n' +
      "│   2. Yes, and don't ask again for pdftotext commands         │\n" +
      '│   3. No, and tell Claude what to do differently (esc)        │\n' +
      '╰──────────────────────────────────────────────────────────────╯\n',
  );
  await answer('02b-permission', 'permission card');
  await screen(' ✻ Reading the CV…\n');
  await page.waitForTimeout(6000);
  await step(page, '02c-reading-later', 'stages after a few seconds');
  // The stubbed agent fills the profile through the real tool server.
  const run = await application.evaluate(() => globalThis.setupStarts.at(-1));
  let id = 0;
  const tool = async (name, args = {}) => {
    const response = await fetch(run.endpoint, {
        method: 'POST',
        headers: {Authorization: 'Bearer ' + run.token, 'Content-Type': 'application/json'},
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: {name, arguments: args},
        }),
      }),
      body = await response.json();
    if (body.error || body.result?.isError) throw Error(name + ': ' + JSON.stringify(body));
    return body.result.content[0].text;
  };
  // --profile <json> replays what the AI filled for a real CV: {plan, reply}.
  const profileArg = args.indexOf('--profile'),
    replay =
      profileArg >= 0
        ? JSON.parse(await readFile(path.resolve(args[profileArg + 1]), 'utf8'))
        : {
            plan: {
              title: 'Sara Kaya',
              goal: 'Senior backend and platform engineering roles in Berlin or remote in the EU',
              criteria: [
                {
                  key: 'preferences',
                  value: 'Senior Backend Engineer, Platform Engineer · Berlin or remote (EU)',
                },
                {key: 'country', value: 'DE'},
                {key: 'location', value: 'Berlin, Germany'},
                {
                  key: 'experience',
                  value: '7 years · Go, Python, Postgres, Kubernetes · English C2, German B1',
                },
                {key: 'application_facts', value: 'Phone +49 151 000000 · sara@example.com'},
              ],
            },
            reply:
              'I filled your profile from the CV. Please add your salary floor and notice period.',
          };
  await screen(' ⏺ jobloop - save_automation_plan (MCP)\n');
  await page.waitForTimeout(1200);
  await step(page, '02d-saving', 'stage after the save call shows');
  await tool('save_automation_plan', {instructions: '', facts: '', ...replay.plan});
  await tool('reply_to_user', {message: replay.reply});
  await tool('finish_automation_run', {status: 'completed', summary: 'Profile filled from the CV'});
  await page.waitForFunction(
    () => document.querySelector('#onboarding')?.dataset.step === 'review',
    null,
    {timeout: 20000},
  );
  await step(page, '03-review-top', 'agent filled the profile');
  await page.locator('#onboarding').evaluate((n) => (n.scrollTop = n.scrollHeight / 2));
  await step(page, '04-review-middle', 'autopilot level and sources');
  await page.locator('#onboarding').evaluate((n) => (n.scrollTop = n.scrollHeight));
  await step(page, '05-review-bottom', 'readiness checks and start button');
  await page.setViewportSize({width: 1440, height: 3000});
  await page.locator('#onboarding').evaluate((n) => (n.scrollTop = 0));
  await step(page, '05b-review-full', 'whole review form');
  await page.locator('.onboarding-pill', {hasText: 'I need a visa'}).click();
  await page.locator('.onboarding-pill', {hasText: 'Maybe'}).click();
  await page.locator('[name=once_notice]').fill('1 month');
  await page.locator('[name=once_salary]').fill('Open to discuss');
  await page.locator('[name=never]').fill('gambling, casino');
  await page.locator('.onboarding-sources > summary').click();
  await step(page, '05c-review-answered', 'answers given, sources open');
  await page.setViewportSize({width: 1440, height: 900});
  await page.locator('#onboarding button.primary[type=submit]').click();
  await page.waitForTimeout(1500);
  const error =
    (await page
      .locator('.onboarding-error')
      .textContent()
      .catch(() => '')) || '';
  await step(page, '06-after-start', 'error shown: ' + (error || 'none'));
  // A test key passes the format check; no network call is made.
  const key = page.locator('#onboarding input[name=jevKey]');
  if (await key.count()) {
    await key.fill('test-key-0000000000');
    await page.locator('#onboarding .onboarding-key button').click();
    await page.waitForTimeout(1200);
    await step(page, '07-key-saved', 'after saving a test TypeSafe key');
  }
  await page.locator('#onboarding button.primary[type=submit]').click();
  await page.waitForTimeout(3000);
  const error2 =
    (await page
      .locator('.onboarding-error')
      .textContent()
      .catch(() => '')) || '';
  const open = await page.locator('#onboarding').isVisible();
  log.push('second start error: ' + (error2 || 'none') + ' · onboarding open: ' + open);
  await step(page, '08-after-second-start', open ? 'still in onboarding' : 'home after onboarding');
  if (!open)
    log.push(
      'saved criteria: ' +
        JSON.stringify(
          await page.evaluate(async () => {
            const [w] = await window.jobloop.workspaces(),
              c = (await window.jobloop.workspaceSnapshot(w.id)).automation.criteria;
            return {application_facts: c.application_facts, hard_rules: c.hard_rules};
          }),
        ),
    );
  if (!open) {
    await page.waitForTimeout(2000);
    await step(page, '09-home-settled', 'home a moment later');
  }
} catch (error) {
  log.push('FAILED ' + error.message);
} finally {
  await application.close();
}
console.log(log.join('\n'));
