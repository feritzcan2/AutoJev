import test from 'node:test';
import assert from 'node:assert/strict';
import simplyhired, {
  simplyHiredRequest,
  parseSimplyHiredSearch,
  simplyHiredSearchPage,
  simplyHiredDetailPage,
  readSimplyHired,
} from '../app/site-extensions/simplyhired.mjs';
import {withSearchFilters, searchFilterLabels} from '../app/site-extensions/search.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';

const search = 'https://www.simplyhired.com/search?q=backend+engineer&l=new+york';
const key = (n) => `gpuca69Jw7SbrJzCO-0YMNvB9xzKLs5x-JwzeB_A0no0VruS${n}`;
const job = (n, overrides = {}) => ({
  jobKey: key(n),
  title: `Backend Engineer ${n}`,
  company: 'Bayview Asset Management',
  location: 'New York, NY',
  salaryInfo: '$110,000 - $140,000 a year',
  dateOnIndeed: '1780388715757',
  sponsored: 'False',
  botUrl: `/job/${key(n)}`,
  ...overrides,
});
// The Next.js data the page embeds: the result list in order, the count, the
// page number and cursors for the pages ahead.
const data = (jobs, {page = 1, total = 897, cursors = {2: 'ABQ/2+x=', 3: 'ABQ3'}} = {}) => ({
  props: {
    pageProps: {
      jobs,
      resultCount: total,
      currentPageNumber: page,
      pageCursors: cursors,
      appliedFilters: {sortBy: '', dateAdded: ''},
    },
  },
  page: '/search',
});
// Card title links carry per-view tracking only in data attributes.
const card = (j) =>
  `<div><h2><a class="chakra-button" data-mdref="/job/${j.jobKey}?jobCardTrackingKey=5-yul1&amp;xkcb=So" href="/job/${j.jobKey}" tabindex="0">${j.title.replace('&', '&amp;')}</a></h2><a href="/search?q=backend+engineer&amp;l=boise+id">Boise</a></div>`;
const page = (jobs, options, {withData = true} = {}) =>
  `<html><body>${jobs.map(card).join('')}${
    withData
      ? `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data(jobs, options))}</script>`
      : ''
  }</body></html>`;
const posting = JSON.stringify({
  '@context': 'https://schema.org/',
  '@type': 'JobPosting',
  title: 'Backend Engineer',
  description:
    '<p>Bayview Asset Management is an investment management firm focused on mortgage and consumer credit.</p><ul><li>Build and operate backend services in Python and Go</li><li>Own data pipelines and APIs end to end</li></ul><p>Hybrid in New York with competitive benefits.</p>',
  hiringOrganization: {'@type': 'Organization', name: 'Bayview Asset Management'},
  jobLocation: {
    '@type': 'Place',
    address: {addressLocality: 'New York', addressRegion: 'NY', addressCountry: 'US'},
  },
  employmentType: 'FULL_TIME',
  datePosted: '2026-06-01T05:00:00.000Z',
  validThrough: '2099-01-01T00:00:00.000Z',
});
const detail = () =>
  `<html><head><title>Backend Engineer - Bayview Asset Management - New York, NY | SimplyHired</title><script type="application/ld+json">${posting}</script></head><body><h1>Backend Engineer</h1><p>Similar jobs</p><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props: {pageProps: {jobFound: true, expired: false}}})}</script></body></html>`;

test('only SimplyHired searches and postings use the reader', () => {
  assert.equal(simplyHiredRequest(search).kind, 'search');
  assert.deepEqual(
    simplyHiredRequest(`https://simplyhired.com/job/${key(1)}?jobCardTrackingKey=x`),
    {
      kind: 'detail',
      key: key(1),
      url: `https://www.simplyhired.com/job/${key(1)}`,
    },
  );
  for (const other of [
    'https://www.simplyhired.com/',
    'https://www.simplyhired.com/salaries',
    'https://www.simplyhired.com/job/short',
    'http://www.simplyhired.com/search?q=x',
    'https://www.simplyhired.com.evil.test/search?q=x',
    'https://www.simplyhired.ca/search?q=x',
  ])
    assert.equal(simplyHiredRequest(other), null, other);
  assert.equal(simplyhired.matches('https://www.simplyhired.com/'), true);
  assert.equal(simplyhired.matches('https://simplyhired.com.evil.test/'), false);
  assert.equal(simplyhired.http.handles(search), true);
});

test('the result list comes from the page data in order, with stable addresses and the cursor', () => {
  const parsed = parseSimplyHiredSearch(
    page([job(1), job(2, {sponsored: 'True', salaryInfo: ''})]),
  );
  assert.deepEqual(
    parsed.jobs.map((j) => j.url),
    [key(1), key(2)].map((k) => `https://www.simplyhired.com/job/${k}`),
    'the tracking parameters of the card links are not part of the address',
  );
  assert.deepEqual([parsed.total, parsed.page, parsed.nextCursor], [897, 1, 'ABQ/2+x=']);
  const result = simplyHiredSearchPage(search, parsed);
  assert.deepEqual(
    result.links.map((l) => [l.text, l.listing]),
    [
      ['Backend Engineer 1', true],
      ['Backend Engineer 2', true],
    ],
  );
  assert.match(
    result.text,
    /page 1 of 45\nLink: Backend Engineer 1 — https:\/\/www\.simplyhired\.com\/job\/\S+\nBayview Asset Management · New York, NY · \$110,000 - \$140,000 a year · posted 2026-06-02/,
  );
  assert.match(result.text, /New York, NY · posted 2026-06-02 · sponsored/);
  assert.equal(result.pagination[0].text, '1 of 45');
  assert.equal(result.pagination[1].url, `${search}&cursor=ABQ%2F2%2Bx%3D`);
  assert.equal(result.status, 'ready');
});

test('a later page keeps its own number; the last page and a stale page link no next page', () => {
  const second = simplyHiredSearchPage(
    `${search}&cursor=ABQ2`,
    parseSimplyHiredSearch(page([job(3)], {page: 2, cursors: {1: 'a', 3: 'ABQ3'}})),
  );
  assert.equal(second.pagination[0].text, '2 of 45');
  assert.equal(second.pagination[1].url, `${search}&cursor=ABQ3`, 'the cursor is replaced');

  const last = simplyHiredSearchPage(
    search,
    parseSimplyHiredSearch(page([job(4)], {page: 3, total: 41, cursors: {1: 'a', 2: 'b'}})),
  );
  assert.equal(last.pagination.length, 1);

  const cards = parseSimplyHiredSearch(
    page([job(5, {title: 'R&D Engineer'})], {}, {withData: false}),
  );
  assert.deepEqual(
    cards.jobs.map((j) => [j.title, j.url]),
    [['R&D Engineer', `https://www.simplyhired.com/job/${key(5)}`]],
  );
  const fallback = simplyHiredSearchPage(search, cards);
  assert.equal(fallback.pagination.length, 1, 'without page data there is no next address');
  assert.equal(fallback.links.length, 1);

  const empty = simplyHiredSearchPage(
    search,
    parseSimplyHiredSearch(page([], {total: 0, cursors: {}})),
  );
  assert.match(empty.text, /no job cards/);
  assert.equal(empty.pagination.length, 1);
});

test('a posting reads through its JobPosting; a removed posting says so', () => {
  const url = `https://www.simplyhired.com/job/${key(1)}`;
  const read = simplyHiredDetailPage(url, detail());
  assert.equal(read.listing.fields.company, 'Bayview Asset Management');
  assert.match(read.text, /Build and operate backend services/);
  assert.doesNotMatch(read.text, /Similar jobs/);

  const gone = `<html><title>Job posting is not available</title><body>This job posting is temporarily unavailable<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props: {pageProps: {jobFound: false, expired: false}}})}</script></body></html>`;
  const removed = simplyHiredDetailPage(url, gone);
  assert.equal(removed.listing, undefined);
  assert.match(removed.text, /not found/);

  const plain = simplyHiredDetailPage(
    url,
    '<html><title>Backend Engineer</title><body><p>Some text</p></body></html>',
  );
  assert.equal(plain.listing, undefined);
  assert.match(plain.text, /Some text/);
});

test('reads use the shared site access rules', async () => {
  const requested = [],
    events = [];
  const siteAccess = {
    begin: (url) => {
      events.push(['begin', url]);
      return 'token';
    },
    pace: () => 0,
    complete: (url, token, info) => {
      events.push(['complete', url, token, info]);
      return info.reason
        ? {site: 'simplyhired.com', reason: info.reason, retryAt: 1, waiting: true}
        : null;
    },
  };
  const fetch = async (url, options) => {
    requested.push(url);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(url.includes('/search') ? page([job(1)]) : detail());
  };
  const results = await readSimplyHired(search, {fetch, siteAccess});
  assert.equal(results.links.length, 1);
  assert.equal(requested[0], search);
  const read = await readSimplyHired(
    `https://www.simplyhired.com/job/${key(1)}?jobCardTrackingKey=x`,
    {
      fetch,
      siteAccess,
    },
  );
  assert.equal(requested[1], `https://www.simplyhired.com/job/${key(1)}`, 'tracking is not sent');
  assert.ok(read.listing);
  for (const status of [403, 429]) {
    const error = await readSimplyHired(search, {
      fetch: async () => new Response('', {status}),
      siteAccess,
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError);
    assert.equal(error.url, search);
  }
  const gone = await readSimplyHired(`https://www.simplyhired.com/job/${key(1)}`, {
    fetch: async () => new Response('', {status: 404}),
  });
  assert.match(gone.text, /not found/);
  await assert.rejects(
    readSimplyHired(search, {fetch: async () => new Response('', {status: 500})}),
    /HTTP 500/,
  );
  await assert.rejects(readSimplyHired('https://www.simplyhired.com/salaries'), /does not handle/);
});

test('search filters are labelled and keep the placeholders', () => {
  const template = withSearchFilters(simplyhired.search.template, {
    t: '7',
    wl: 'remote',
    jt: 'CF3CP',
  });
  assert.equal(
    template,
    'https://www.simplyhired.com/search?q={query}&l={location}&t=7&wl=remote&jt=CF3CP',
  );
  assert.deepEqual(searchFilterLabels(simplyhired.search, template), [
    'Posted: Last 7 days',
    'Work location: Remote',
    'Job type: Full-time',
  ]);
  assert.equal(simplyhired.search.ordering, undefined);
});
