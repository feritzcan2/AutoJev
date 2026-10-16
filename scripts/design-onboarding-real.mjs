// Real first-run onboarding: real CV, real AI assistant, real engine. Only the
// native file dialog (and the OS keychain on CI) are stubbed. Screenshots the
// reading screen as it changes and answers any AI prompt through the app card.
// Usage: xvfb-run -a node scripts/design-onboarding-real.mjs <cv> [outDir] [--dark]
import {createRequire} from 'node:module';
import {mkdtemp, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  args = process.argv.slice(2).filter((a) => !a.startsWith('--')),
  cv = path.resolve(args[0]),
  out = path.resolve(args[1] ?? 'design-onboarding-real'),
  data = await mkdtemp(path.join(os.tmpdir(), 'jobloop-real-'));
await mkdir(out, {recursive: true});
const log = [],
  started = Date.now(),
  t = () => ((Date.now() - started) / 1000).toFixed(0) + 's';
const application = await electron.launch({
  executablePath: process.env.JOBLOOP_ELECTRON_BINARY || require('electron'),
  args: [root],
  env: {...process.env, JOBLOOP_DATA_DIR: data},
});
let n = 0;
const shot = async (page, name) => {
  const file = path.join(out, String(++n).padStart(2, '0') + '-' + name + '.png');
  await page.screenshot({path: file});
  log.push(`${t()} ${path.basename(file)}`);
};
try {
  const page = await application.firstWindow({timeout: 30000});
  page.on('pageerror', (e) => log.push('UI_ERROR ' + e.message));
  if (process.argv.includes('--dark')) await page.emulateMedia({colorScheme: 'dark'});
  await page.setViewportSize({width: 1280, height: 860});
  await application.evaluate(({dialog, safeStorage}, cvPath) => {
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
    safeStorage.encryptString = (text) => Buffer.from('x' + text);
    safeStorage.decryptString = (buffer) => buffer.toString().slice(1);
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [cvPath]});
  }, cv);
  await page.locator('#onboarding').waitFor({state: 'visible', timeout: 15000});
  await page.waitForFunction(
    () => !document.querySelector('[data-action=pick-cv]')?.disabled,
    null,
    {timeout: 60000},
  );
  await shot(page, 'welcome');
  await page.locator('[data-action=pick-cv]').click();
  await page.waitForFunction(
    () => document.querySelector('#onboarding')?.dataset.step === 'reading',
  );
  await page.waitForTimeout(1500);
  await shot(page, 'reading');
  let asked = 0,
    lastStage = '';
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      step: document.querySelector('#onboarding')?.dataset.step,
      ask: !document.querySelector('.onboarding-ask')?.hidden,
      askText: document.querySelector('.onboarding-ask')?.innerText,
      stage: [...document.querySelectorAll('.onboarding-stages li')]
        .map((li) => li.dataset.state?.[0] ?? '-')
        .join(''),
    }));
    if (state.step !== 'reading') break;
    if (state.stage !== lastStage) {
      lastStage = state.stage;
      await shot(page, 'stage-' + state.stage);
    }
    if (state.ask && asked < 6) {
      asked++;
      log.push(`${t()} ASK ${JSON.stringify(state.askText)}`);
      await page.waitForTimeout(400);
      await shot(page, 'ask-' + asked);
      const primary = page.locator('.onboarding-ask button.primary');
      if (await primary.count()) await primary.first().click();
      await page.waitForTimeout(2500);
    }
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1500);
  if (process.argv.includes('--dump')) {
    const text = await page.evaluate(async () => {
      const [w] = await window.jobloop.workspaces(),
        output = await window.jobloop.terminalOutput(w.id, 'conversation');
      return new TextDecoder()
        .decode(new Uint8Array(output.bytes))
        .replace(/\x1b\[\d*C/g, ' ')
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .slice(-4000);
    });
    log.push('TERMINAL ' + text);
  }
  await shot(page, 'review-top');
  const values = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('#onboarding form [name]')]
        .filter((i) => i.type !== 'radio' || i.checked)
        .map((i) => [i.name, i.value]),
    ),
  );
  log.push('FORM ' + JSON.stringify(values, null, 1));
  for (const at of [0.35, 0.65, 1]) {
    await page
      .locator('#onboarding')
      .evaluate((node, f) => (node.scrollTop = node.scrollHeight * f), at);
    await page.waitForTimeout(300);
    await shot(page, 'review-' + Math.round(at * 100));
  }
  await page.locator('.onboarding-sources > summary').click();
  await page.waitForTimeout(300);
  await shot(page, 'sources-open');
} catch (error) {
  log.push('FAILED ' + error.message);
} finally {
  await application.close();
}
console.log(log.join('\n'));
