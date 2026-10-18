import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import duckduckgo, {
  duckDuckGoRequest,
  resultTarget,
  parseDuckDuckGoResults,
  duckDuckGoSearchPage,
  readDuckDuckGo,
} from '../app/site-extensions/duckduckgo.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev/results.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';
import {replayUrl} from '../app/sources/recipe.mjs';

const results = readFileSync(
  new URL('./fixtures/duckduckgo/results.html', import.meta.url),
  'utf8',
);
const search = 'https://html.duckduckgo.com/html/?q=python+developer+careers+copenhagen';
const nordic = 'https://nordictechjobs.com/jobs/python/copenhagen';
const glassdoor =
  'https://www.glassdoor.com/Job/copenhagen-python-developer-jobs-SRCH_IL.0,10_IC2218704_KO11,27.htm';
const block = (href, title, extra = '') =>
  `<div class="result results_links results_links_deep web-result ${extra}"><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${title}</a></h2><a class="result__snippet" href="${href}">Snippet</a></div></div>`;
const page = (blocks) =>
  `<html><body><div class="serp__results"><div id="links" class="results">${blocks.join('')}</div></div></body></html>`;
const siteAccess = () => ({
  begin: () => 'token',
  pace: () => 0,
  complete: (_url, _token, info) =>
    info.reason ? {site: 'duckduckgo.com', reason: info.reason, retryAt: 1, waiting: true} : null,
  block: (_url, reason) => ({site: 'duckduckgo.com', reason, retryAt: 1, waiting: true}),
});

test('GET searches with q and the honoured filters are read; paging and look-alikes are not', () => {
  assert.deepEqual(duckDuckGoRequest(search), {url: search});
  assert.ok(duckDuckGoRequest('https://html.duckduckgo.com/html?q=jobs&kl=dk-da&df=w'));
  assert.equal(
    replayUrl(duckduckgo.search.template, {query: 'python developer careers'}),
    'https://html.duckduckgo.com/html/?q=python+developer+careers',
  );
  for (const other of [
    'https://html.duckduckgo.com/html/',
    'https://html.duckduckgo.com/html/?q=',
    'https://html.duckduckgo.com/html/?q=jobs&s=10&dc=11',
    'https://html.duckduckgo.com/html/?q=jobs&vqd=4-1',
    'https://html.duckduckgo.com/lite/?q=jobs',
    'https://duckduckgo.com/html/?q=jobs',
    'https://duckduckgo.com/?q=jobs',
    'http://html.duckduckgo.com/html/?q=jobs',
    'https://html.duckduckgo.com.evil.test/html/?q=jobs',
    'not a url',
  ]) {
    assert.equal(duckDuckGoRequest(other), null, other);
    assert.equal(duckduckgo.http.handles(other), false, other);
  }
  assert.equal(duckduckgo.matches('https://html.duckduckgo.com.evil.test/html/?q=jobs'), false);
  assert.equal(duckduckgo.search.ordering, undefined, 'relevance order');
});

test('result links decode the uddg redirect; direct links stay as they are', () => {
  assert.equal(
    resultTarget(
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fjobs%2Fpython%2Dudvikler%2Djobs%2Dk%25C3%25B8benhavn&amp;rut=1b',
    ),
    'https://www.linkedin.com/jobs/python-udvikler-jobs-k%C3%B8benhavn',
  );
  assert.equal(
    resultTarget('https://englishjobs.dk/jobs/python'),
    'https://englishjobs.dk/jobs/python',
  );
  assert.equal(resultTarget('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'), null);
});

test('a results page lists organic targets as listings, ads not, with a single page', () => {
  const read = duckDuckGoSearchPage(search, results);
  assert.deepEqual(
    read.links.map((l) => [l.url, l.listing]),
    [
      [nordic, true],
      [glassdoor, true],
    ],
  );
  assert.equal(read.links[0].text, 'Python Developer Jobs in Copenhagen - Nordic Tech Jobs');
  assert.match(read.links[0].siteCard, /nordictechjobs\.com\/jobs\/python\/copenhagen · Browse 32/);
  assert.doesNotMatch(read.text, /feedback/i);
  assert.match(read.text, /only page of this search/);
  assert.deepEqual(
    read.pagination.map((p) => [p.text, p.current]),
    [['1 of 1', true]],
    'the next page is a POST form, not an address',
  );
  const position = resultPageSummary(read, {id: 'e1'}, []).position;
  assert.equal(observedNextPage(read, position), null);

  const mixed = duckDuckGoSearchPage(
    search,
    page([
      block(
        'https://duckduckgo.com/y.js?ad_domain=example.com&amp;u3=x',
        'Sponsored jobs',
        'result--ad',
      ),
      block('https://ads.example.com/jobs', 'Advertised board', 'result--ad'),
      block('//duckduckgo.com/l/?uddg=https%3A%2F%2Fcareers.example.com%2Fjobs%2F42', 'Engineer'),
      block(
        '//duckduckgo.com/l/?uddg=https%3A%2F%2Fcareers.example.com%2Fjobs%2F42',
        'Engineer again',
      ),
    ]),
  );
  assert.deepEqual(
    mixed.links.map((l) => [l.url, l.listing]),
    [
      ['https://careers.example.com/jobs/42', true],
      ['https://duckduckgo.com/y.js?ad_domain=example.com&u3=x', false],
      ['https://ads.example.com/jobs', false],
    ],
  );
  const none = duckDuckGoSearchPage(
    search,
    page([
      '<div class="result results_links results_links_deep result--no-result"><div class="no-results">No results.</div></div>',
    ]),
  );
  assert.deepEqual(none.links, []);
  assert.match(none.text, /no results/);
  assert.equal(parseDuckDuckGoResults('<html><body>Something else</body></html>'), null);
});

test('a bot check or an unknown page is an error, never an empty result', async () => {
  const challenge =
    '<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form></body></html>';
  const wait = await readDuckDuckGo(search, {
    fetch: async () => new Response(challenge, {status: 202}),
    siteAccess: siteAccess(),
  }).catch((e) => e);
  assert.ok(wait instanceof SiteWaitError, 'a bot check starts the shared site wait');
  await assert.rejects(
    readDuckDuckGo(search, {fetch: async () => new Response(challenge, {status: 202})}),
    /bot check/,
  );
  await assert.rejects(
    readDuckDuckGo(search, {fetch: async () => new Response('<html><body>Oops</body></html>')}),
    /no results list/,
  );
  for (const status of [403, 429]) {
    const error = await readDuckDuckGo(search, {
      fetch: async () => new Response('', {status}),
      siteAccess: siteAccess(),
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError, String(status));
  }
  await assert.rejects(
    readDuckDuckGo(search, {fetch: async () => new Response('', {status: 404})}),
    /not found/,
  );
});

test('reads use the shared site access rules and pass the caller signal', async () => {
  const requested = [];
  const controller = new AbortController();
  let signal;
  const read = await readDuckDuckGo(search, {
    signal: controller.signal,
    siteAccess: siteAccess(),
    fetch: async (url, options) => {
      requested.push(url);
      signal = options.signal;
      assert.match(options.headers['User-Agent'], /AutoJev/);
      return new Response(results);
    },
  });
  assert.equal(read.url, search);
  assert.equal(read.links.length, 2);
  assert.deepEqual(requested, [search]);
  controller.abort();
  assert.equal(signal.aborted, true);
  await assert.rejects(readDuckDuckGo('https://html.duckduckgo.com/html/'), /does not handle/);
});
