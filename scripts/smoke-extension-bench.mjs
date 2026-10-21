// Extension test bench UI: the row menu opens a bench for the source, the
// pagination follows to the next page and flags repeats, a listing reads
// inline, and a page still loading is never shown as an empty result.
//   node scripts/smoke-extension-bench.mjs [screenshot.png]
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const data = await mkdtemp(path.join(os.tmpdir(), 'extension-bench-')),
  env = {...process.env, JOBLOOP_DATA_DIR: data, JOBLOOP_DIAGNOSTICS: 'off'},
  screenshot = process.argv[2] ?? null;
delete env.ELECTRON_RUN_AS_NODE;
const fixtureModule = path.join(data, 'source-panel.mjs');
await build({
  entryPoints: ['src/automation-sources.js'],
  bundle: true,
  format: 'esm',
  outfile: fixtureModule,
});
const app = await electron.launch({
  executablePath: require('electron'),
  args: [process.cwd()],
  env,
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({width: 1280, height: 1100});
  await page.evaluate(async (url) => {
    const {automationSourcesPanel} = await import(url),
      main = document.createElement('main'),
      host = document.createElement('section');
    main.style.gridColumn = '1 / -1';
    host.id = 'sources';
    main.append(host);
    document.body.replaceChildren(main);
    const source = 'https://jobs.bench.test/search?q=engineer';
    const sources = [
      {
        url: source,
        name: 'Bench jobs',
        enabled: true,
        mode: 'observe',
        intervalMinutes: 30,
        extension: {id: 'bench', kind: 'browser'},
      },
    ];
    const snapshot = {
      automation: {id: 'owner', mode: 'observe', status: 'enabled', sources: [source]},
      sources,
      progress: {reviewed: true},
    };
    const listing = (n) => ({url: `https://jobs.bench.test/job/${n}`, title: `Role ${n}`});
    const results = (n, listings) => ({
      url: n === 1 ? source : `${source}&page=${n}`,
      at: Date.now(),
      version: 0,
      extension: {id: 'bench', kind: 'browser'},
      transport: 'browser',
      notes: [],
      diagnostics: [],
      applied: true,
      tabId: 'tab-1',
      title: 'Results',
      readiness: {loading: false, reason: null},
      listings: listings.map((l) => ({...l, card: `${l.title} · Company · Berlin`})),
      otherLinks: 2,
      otherLinkSample: [
        {url: 'https://jobs.bench.test/company/1', text: 'Company'},
        {url: 'https://jobs.bench.test/filter', text: 'Remote only'},
      ],
      pagination: [
        {text: `${n} of 3`, url: n === 1 ? source : `${source}&page=${n}`, current: true},
        {text: String(n + 1), url: `${source}&page=${n + 1}`, current: false},
      ],
      listing: null,
      text: {text: 'Results page text', length: 17},
    });
    window.calls = [];
    const api = {
      extensionBenchStatus: async () => ({available: true, version: 0, extensions: []}),
      extensionBenchSearches: async () => [
        {term: 'engineer', url: source},
        {term: 'developer', url: 'https://jobs.bench.test/search?q=developer'},
      ],
      extensionBenchRead: async (id, address) => {
        window.calls.push(['read', id, address]);
        if (address.endsWith('page=3'))
          return {
            ...results(3, []),
            readiness: {loading: true, reason: 'network'},
            pagination: [],
          };
        return address.endsWith('page=2')
          ? results(2, [listing(2), listing(3)])
          : results(1, [listing(1), listing(2)]);
      },
      extensionBenchObserve: async () => results(3, [listing(4)]),
      extensionBenchListing: async (id, address) => ({
        ...results(1, []),
        url: address,
        title: 'Role 1',
        listing: {
          fields: {company: 'Company', location: 'Berlin'},
          description: {text: 'The listing’s own text.', length: 23},
        },
      }),
      extensionBenchReload: async () => ({version: 1, extensions: ['bench'], at: Date.now()}),
      extensionBenchClose: async () => ({closed: 1}),
      openLink: async () => {},
    };
    const panel = automationSourcesPanel(host, api, {
      notice: () => {},
      refresh: async () => panel.update(snapshot, 'owner'),
    });
    panel.update(snapshot, 'owner');
    window.rerender = () => panel.update(snapshot, 'owner');
  }, pathToFileURL(fixtureModule).href);

  // The header offers a free bench; the row menu a bench for the source.
  await page.getByRole('button', {name: 'Test bench'}).waitFor();
  await page.locator('.source-row-menu').click();
  await page.getByRole('button', {name: 'Test extension'}).click();
  const bench = page.locator('.source-row > .extension-bench');
  await bench.getByText('2 listings').waitFor();
  assert.ok(await bench.getByText('bench · browser').isVisible());
  assert.ok(await bench.getByText('DOM reader applied').isVisible());
  assert.ok(await bench.getByText('[1 of 3]', {exact: false}).isVisible());

  // The source's bench offers its recipe searches and read the first one.
  const picker = bench.locator('.extension-bench-picker select');
  assert.deepEqual(await picker.locator('option').allTextContents(), [
    'Recipe search · engineer',
    'Recipe search · developer',
    'Source address · https://jobs.bench.test/search?q=engineer',
  ]);

  // A snapshot render keeps the open bench and its focus.
  await bench.locator('input[type=url]').focus();
  await page.evaluate(() => window.rerender());
  assert.equal(
    await page.evaluate(() => document.activeElement?.matches('.extension-bench input')),
    true,
  );

  // Next page: one listing repeats page 1.
  await bench.getByRole('button', {name: 'Next page →'}).click();
  await bench.getByText('2 listings · 1 already seen on an earlier page').waitFor();

  // A listing reads inline with its facts and own description.
  await bench
    .locator('.extension-bench-listings li')
    .first()
    .getByRole('button', {name: 'Read'})
    .click();
  await bench.locator('.extension-bench-facts').getByText('Berlin').waitFor();

  // Reload keeps the page and reads it again.
  await bench.getByRole('button', {name: 'Reload extensions'}).click();
  await bench.getByText(/Reloaded from disk at .* · 1 extensions · version 1/).waitFor();
  if (screenshot) await page.screenshot({path: screenshot, fullPage: true});

  // Page 3 is still loading: not an empty result, and read again without reopening.
  await bench.getByRole('button', {name: 'Next page →'}).click();
  await bench.getByText('The page is still loading; this is not an empty result.').waitFor();
  await bench.getByRole('button', {name: 'Read again without reloading'}).click();
  await bench.getByText('1 listing', {exact: true}).waitFor();
  assert.deepEqual(
    (await page.evaluate(() => window.calls)).map(([, , address]) => address.split('?')[1]),
    ['q=engineer', 'q=engineer&page=2', 'q=engineer&page=2', 'q=engineer&page=3'],
  );

  // Back returns to page 2 without a read.
  await bench.getByRole('button', {name: '← Back'}).click();
  await bench.getByText('[2 of 3]', {exact: false}).waitFor();
  console.log('Extension bench UI works.');
} finally {
  await app.close();
}
