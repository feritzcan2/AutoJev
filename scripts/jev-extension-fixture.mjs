// Test Chrome with the AutoJob extension loaded from the repository. Branded
// Chrome ignores --load-extension since 137, so smoke tests run Playwright's
// Chrome for Testing; the app connects to it exactly as to the user's Chrome.
import {spawn} from 'node:child_process';
import {lstat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {activateChrome} from '../app/jev/chrome.mjs';
const require = createRequire(import.meta.url),
  {chromium} = createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
export const extensionPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../extension',
);

export async function launchExtensionChrome(directory, {headless = true} = {}) {
  const context = await chromium.launchPersistentContext(directory, {
    channel: 'chromium',
    headless,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1120,780',
    ],
  });
  let opened = 0;
  // Stands in for app/jev/chrome.mjs openChromeUrl: Chrome opens the connect
  // page, the extension connects and then closes that page itself.
  const openUrl = async (url) => {
    opened++;
    const page = await context.newPage();
    await page.goto(url).catch(() => {});
  };
  return {
    context,
    openUrl,
    extensionInstalled: async () => true,
    get opened() {
      return opened;
    },
  };
}

// Chrome for Testing as a plain process with only the extension loaded: no
// Playwright launch flags, no remote debugging and no focus emulation on the
// user's tabs, as in the user's own Chrome. Opening a URL starts the same
// binary with that URL, which hands it to the running browser.
export async function launchPlainExtensionChrome(directory, {url = 'about:blank'} = {}) {
  const args = [
    `--user-data-dir=${directory}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1120,780',
  ];
  const executable = chromium.executablePath(),
    child = spawn(executable, [...args, url], {stdio: 'ignore'}),
    exited = new Promise((resolve) => child.once('exit', resolve));
  // A second process hands its URL to the running browser only once that
  // browser holds the profile lock; before that it would start a browser of
  // its own.
  for (let i = 0; i < 100; i++) {
    if (await lstat(path.join(directory, 'SingletonLock')).catch(() => null)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let opened = 0;
  // Like app/jev/chrome.mjs openChromeUrl: never wait for the process to exit.
  const openUrl = async (target) => {
    opened++;
    spawn(executable, [...args, target], {stdio: 'ignore', detached: true}).unref();
  };
  return {
    openUrl,
    extensionInstalled: async () => true,
    // app/jev/chrome.mjs activateChrome, for this test browser.
    activateChrome: () => activateChrome({findChromeImpl: async () => executable}),
    get opened() {
      return opened;
    },
    async close() {
      child.kill();
      await exited;
    },
  };
}
