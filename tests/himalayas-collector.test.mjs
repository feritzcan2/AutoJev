import test from 'node:test';
import assert from 'node:assert/strict';
import {
  himalayasApiUrl,
  parseHimalayasPage,
  readHimalayasPage,
  collectHimalayas,
} from '../app/site-extensions/himalayas/api.mjs';
import {collectorSearches, sourceCollector} from '../app/source-collectors.mjs';
import {collectionArguments} from '../app/site-extensions/himalayas/cli.mjs';

const base = 'https://himalayas.app/jobs/api/search?country=DE&q=backend';
const job = (n) => ({
  guid: `https://himalayas.app/companies/synthetic/jobs/role-${n}`,
  title: `Synthetic role ${n}`,
  companyName: 'Synthetic Co',
  description: '<p>Short but complete.</p>',
  pubDate: 1791165059,
  locationRestrictions: ['Germany'],
});
const payload = (jobs, {offset = 0, totalCount = jobs.length, limit = 20, ...rest} = {}) => ({
  jobs,
  offset,
  totalCount,
  limit,
  ...rest,
});
const json = (data) =>
  new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});

test('legacy and API search addresses preserve query, country and independent terms', () => {
  const url = new URL(
    himalayasApiUrl('https://himalayas.app/jobs/countries/germany/?q=C%23%20%2F%20.NET&page=2'),
  );
  assert.equal(url.pathname, '/jobs/api/search');
  assert.equal(url.searchParams.get('q'), 'C# / .NET');
  assert.equal(url.searchParams.get('country'), 'germany');
  assert.equal(url.searchParams.get('page'), '2');
  const source = 'https://himalayas.app/',
    a = {
      templateId: 'job-search',
      goal: 'backend',
      criteria: {location: 'Germany'},
      sourceSettings: {
        [source]: {
          recipe: {
            entry: {
              kind: 'url_template',
              template: 'https://himalayas.app/jobs/countries/germany?q={query}',
            },
            terms: ['C#', '.NET'],
          },
        },
      },
    };
  assert.deepEqual(
    collectorSearches(a, source).map((s) => new URL(s.url).searchParams.get('q')),
    ['C#', '.NET'],
  );
  assert.equal(
    new URL(collectorSearches({...a, sourceSettings: {}}, source)[0].url).searchParams.get('q'),
    'backend',
  );
  assert.equal(sourceCollector({...a, templateId: 'housing'}, source), null);
  for (const bad of [
    'https://himalayas.app.evil.test/jobs',
    'https://name:secret@himalayas.app/jobs',
    'http://himalayas.app/jobs',
    'https://himalayas.app:123/jobs',
    'https://himalayas.app/docs',
    'https://himalayas.app/jobs?unsupported=1',
  ])
    assert.throws(() => himalayasApiUrl(bad));
});

test('short descriptions and real zero results are valid; missing content is not', () => {
  const page = parseHimalayasPage(base, payload([job(1)]));
  assert.equal(page.jobs[0].description, 'Short but complete.');
  assert.equal(page.jobs[0].publishedAt, '2026-10-05T01:50:59.000Z');
  assert.equal(page.complete, true);
  assert.equal(parseHimalayasPage(base, payload([])).complete, true);
  for (const data of [
    {},
    payload([], {totalCount: 10}),
    payload([{...job(1), description: ''}]),
    payload([{...job(1), guid: 'https://evil.test/jobs/1'}]),
    payload([job(1)], {offset: 20}),
    payload([job(1)], {limit: 0}),
  ])
    assert.throws(() => parseHimalayasPage(base, data));
  const worldwide = parseHimalayasPage(base, payload([{...job(1), locationRestrictions: []}]))
    .jobs[0];
  assert.equal(worldwide.location, 'Worldwide');
  assert.equal(
    parseHimalayasPage(
      base,
      payload([{...job(1), locationRestrictions: [{alpha2: 'DE', name: 'Germany'}]}]),
    ).jobs[0].location,
    'Germany',
  );
});

test('search pagination uses metadata even on a short page and retains filters', () => {
  const first = parseHimalayasPage(base, payload([job(1)], {totalCount: 45}));
  assert.equal(first.complete, false);
  assert.equal(first.totalPages, 3);
  const second = parseHimalayasPage(first.nextUrl, payload([job(2)], {offset: 20, totalCount: 45}));
  assert.equal(new URL(second.nextUrl).searchParams.get('page'), '3');
  assert.equal(new URL(second.nextUrl).searchParams.get('country'), 'DE');
  assert.equal(
    parseHimalayasPage(second.nextUrl, payload([job(3)], {offset: 40, totalCount: 45})).complete,
    true,
  );
});

test('browse echoes opaque cursors and rejects a cursor cycle', () => {
  const first = parseHimalayasPage(
    'https://himalayas.app/jobs/api',
    payload([job(1)], {totalCount: 50, nextCursor: 'opaque+/= value'}),
  );
  assert.equal(new URL(first.nextUrl).searchParams.get('cursor'), 'opaque+/= value');
  assert.throws(
    () =>
      parseHimalayasPage(
        first.nextUrl,
        payload([job(2)], {totalCount: 50, nextCursor: 'opaque+/= value'}),
      ),
    /ilerlemedi/,
  );
  assert.equal(
    parseHimalayasPage(first.nextUrl, payload([job(2)], {totalCount: 50})).complete,
    true,
  );
});

test('HTTP/HTML failures never become an empty success; retries are bounded and cancellable', async () => {
  for (const response of [
    new Response('blocked', {status: 403}),
    new Response('<html>loading</html>', {headers: {'content-type': 'text/html'}}),
    json({}),
  ])
    await assert.rejects(readHimalayasPage(base, {fetch: async () => response}));
  let attempts = 0;
  await assert.rejects(
    readHimalayasPage(base, {
      fetch: async () => {
        attempts++;
        return new Response('', {status: 503});
      },
      wait: async () => {},
    }),
    /503/,
  );
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(
    readHimalayasPage(base, {
      fetch: async () => {
        attempts++;
        return new Response('', {status: 429, headers: {'retry-after': '120'}});
      },
      wait: async () => {
        throw Error('must not wait');
      },
    }),
    /429/,
  );
  assert.equal(attempts, 1);
  const controller = new AbortController();
  let entered;
  const pending = readHimalayasPage(base, {
    signal: controller.signal,
    fetch: async (_url, {signal}) =>
      new Promise((_resolve, reject) => {
        entered = true;
        signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      }),
  });
  assert.ok(entered);
  controller.abort();
  await assert.rejects(pending, /abort/i);
  await assert.rejects(
    readHimalayasPage(base, {
      timeoutMs: 10,
      fetch: async (_url, {signal}) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {once: true});
          const timer = setTimeout(() => {}, 30);
          signal.addEventListener('abort', () => clearTimeout(timer), {once: true});
        }),
      wait: async () => {},
    }),
    /timeout/i,
  );
});

test('collection waits for page acknowledgement, deduplicates across searches and reports budget exhaustion', async () => {
  const received = [],
    read = [];
  let release;
  const input = {searches: [{id: 'one', url: base}], maxPages: 1};
  const collecting = collectHimalayas(input, {
    readPage: async (url) => {
      read.push(url);
      return parseHimalayasPage(url, payload([job(1), job(1)], {totalCount: 30}));
    },
    onPage: (page) => {
      received.push(page);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(read.length, 1);
  assert.equal(received[0].jobs.length, 1);
  release();
  assert.deepEqual(await collecting, {complete: false, pages: 1, count: 1});
  const result = await collectHimalayas(
    {
      searches: [
        {id: 'one', url: base},
        {id: 'two', url: base + '&company=synthetic'},
      ],
    },
    {
      readPage: async (url) => parseHimalayasPage(url, payload([job(1)])),
      onPage: (page) => received.push(page),
    },
  );
  assert.deepEqual(result, {complete: true, pages: 2, count: 1});
});

test('CLI validates options and separates filtered search from full feed', () => {
  const search = collectionArguments([
    '--source',
    'himalayas',
    '--country',
    'DE',
    '--query',
    'backend',
  ]);
  assert.equal(new URL(search.searches[0].url).searchParams.get('q'), 'backend');
  assert.equal(new URL(collectionArguments(['--all']).searches[0].url).pathname, '/jobs/api');
  for (const args of [
    ['--all', '--country', 'DE'],
    ['--source', 'other'],
    ['--query'],
    ['--max-pages', '0'],
    ['--query', 'a', '--query', 'b'],
  ])
    assert.throws(() => collectionArguments(args));
});
