// Test Chrome with the AutoJob extension loaded from the repository. Branded
// Chrome ignores --load-extension since 137, so smoke tests run Playwright's
// Chrome for Testing; the app connects to it exactly as to the user's Chrome.
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
