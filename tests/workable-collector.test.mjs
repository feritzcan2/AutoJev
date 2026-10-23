import test from 'node:test';
import assert from 'node:assert/strict';
import workable, {
  workableApiUrl,
  parseWorkablePage,
  readWorkablePage,
  readWorkableDetail,
} from '../app/site-extensions/workable.mjs';
import {siteSearchRecipe, withSearchFilters} from '../app/site-extensions/search.mjs';
import {recipeReplay} from '../app/sources/recipe.mjs';

const api = 'https://jobs.workable.com/api/v1/jobs';
const search = `${api}?query=backend+engineer&location=United+States`;
const token = 'eyJzZWFyY2hBdCI6IjIwMjYifQ==';
const job = (id, overrides = {}) => ({
  id: `uuid-${id}`,
  title: 'Staff Backend Engineer',
  state: 'published',
  description: '<p>Build &amp; run our platform.</p>',
  requirementsSection: '<ul><li>Go</li><li>AWS</li></ul>',
  benefitsSection: '',
  employmentType: 'Full-time',
  url: `https://jobs.workable.com/view/${id}/staff-backend-engineer-in-miami-at-acme`,
  location: {city: 'Miami', subregion: 'Florida', countryName: 'United States'},
  created: '2026-10-09T21:08:39.200Z',
  company: {title: 'Acme Inc'},
  workplace: 'on_site',
  ...overrides,
});
const response = (jobs, {totalSize = 50, nextPageToken = token} = {}) => ({
  title: 'Workable',
  totalSize,
  nextPageToken,
  jobs,
  autoAppliedFilters: {},
});

test('Workable search addresses become one API page with checked filters', () => {
  assert.equal(workable.matches('https://jobs.workable.com/search'), true);
  assert.equal(workable.matches('https://apply.workable.com/acme/'), false);
  assert.equal(workableApiUrl('https://jobs.workable.com/'), api);
  assert.equal(
    workableApiUrl(
      'https://jobs.workable.com/search?location=Berlin&query=go&workplace=remote&day_range=0&utm_source=x',
    ),
    `${api}?query=go&location=Berlin&workplace=remote`,
    'filters keep a fixed order; "any time" and tracking drop out',
  );
  assert.equal(
    workableApiUrl(`${search}&pageToken=${token}&page=3`),
    `${search}&page=3&pageToken=${encodeURIComponent(token)}`,
  );
  assert.equal(workableApiUrl(`${api}?query=go&location=`), `${api}?query=go`);
  for (const bad of [
    `${api}?query=go&foo=bar`,
    `${api}?workplace=zzz`,
    `${api}?day_range=14`,
    `${api}?query=a&query=b`,
    `${api}?page=2`,
    `${api}?pageToken=${token}`,
    `${api}?page=2&pageToken=a%20b`,
    'https://jobs.workable.com/view/2jHLrD3RmHM8PcjPKR2g47',
    'http://jobs.workable.com/search',
    'https://jobs.workable.com.evil.test/search',
    'not a url',
  ])
    assert.throws(() => workableApiUrl(bad), undefined, bad);
});

test('a page maps listings to their stable view address with the stated facts only', () => {
  const page = parseWorkablePage(
    search,
    response([
      job('2jHLrD3RmHM8PcjPKR2g47'),
      job('XoXMgg9K9du3Xa', {
        employmentType: '',
        workplace: '',
        requirementsSection: '',
        benefitsSection: '<p>Equity</p>',
        location: {city: '', subregion: null, countryName: 'United States'},
        linkoutUrl: 'https://acme.example/careers/1',
      }),
    ]),
  );
  assert.deepEqual(
    [page.page, page.totalPages, page.complete, page.nextUrl],
    [1, 3, false, `${search}&page=2&pageToken=${encodeURIComponent(token)}`],
  );
  assert.equal(page.jobs[0].url, 'https://jobs.workable.com/view/2jHLrD3RmHM8PcjPKR2g47');
  const detail = workable.collector.detail(page.jobs[0]);
  assert.deepEqual(detail.listing.fields, {
    company: 'Acme Inc',
    location: 'Miami, Florida, United States',
    workMode: 'onsite',
    employmentType: 'Full-time',
    postedAt: '2026-10-09T21:08:39.200Z',
  });
  assert.match(detail.text, /Build & run our platform\.\n+Requirements\n• Go\n+• AWS/);
  assert.deepEqual(detail.cells, {company: 'Acme Inc', location: 'Miami, Florida, United States'});
  const second = workable.collector.detail(page.jobs[1]);
  assert.deepEqual(second.listing.fields, {
    company: 'Acme Inc',
    location: 'United States',
    postedAt: '2026-10-09T21:08:39.200Z',
    applyUrl: 'https://acme.example/careers/1',
  });
  assert.match(second.text, /Benefits\nEquity/);

  const last = parseWorkablePage(
    page.nextUrl.replace('page=2', 'page=3'),
    response([job('c1234567')]),
  );
  assert.deepEqual([last.page, last.complete, last.nextUrl], [3, true, null], 'page 3 of 50 ends');
  const noToken = parseWorkablePage(search, response([job('d1234567')], {nextPageToken: null}));
  assert.equal(noToken.complete, true);
});

test('malformed or partial pages are errors, not empty results', () => {
  assert.throws(() => parseWorkablePage(search, {jobs: []}), /malformed/);
  assert.throws(() => parseWorkablePage(search, response([])), /incomplete/);
  assert.throws(
    () => parseWorkablePage(search, response([job('a1234567', {title: ' '})])),
    /title/,
  );
  assert.throws(
    () => parseWorkablePage(search, response([job('a1234567', {url: 'https://evil.test/view/x'})])),
    /address/,
  );
  assert.throws(
    () => parseWorkablePage(search, response([job('a1234567')], {nextPageToken: 5})),
    /token/,
  );
  assert.deepEqual(
    parseWorkablePage(search, response([], {totalSize: 0, nextPageToken: null})).jobs,
    [],
  );
});

test('a listing whose text is only in the requirements is read, and one without any text is skipped', () => {
  const page = parseWorkablePage(
    search,
    response([
      job('a1234567', {description: ''}),
      job('b1234567', {description: '', requirementsSection: '', benefitsSection: ''}),
      job('c1234567'),
    ]),
  );
  assert.deepEqual(
    page.jobs.map((j) => j.url.split('/').pop()),
    ['a1234567', 'c1234567'],
  );
  assert.match(page.jobs[0].description, /^Requirements\n• Go/);
});

test('reads send the cursor without the page count, with the caller signal, and report failures', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({url, options});
    return Response.json(
      url.includes('/jobs/a1234567')
        ? job('a1234567', {state: 'closed'})
        : response([job('a1234567')], {totalSize: 40}),
    );
  };
  const page = await readWorkablePage(`${search}&page=2&pageToken=${token}`, {fetch});
  assert.equal(page.page, 2);
  assert.equal(calls[0].url, `${search}&pageToken=${encodeURIComponent(token)}`);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(page.complete, true, '2 × 20 covers 40 results');

  const read = await readWorkableDetail('https://jobs.workable.com/view/a1234567/some-slug', {
    fetch,
  });
  assert.equal(calls[1].url, 'https://jobs.workable.com/api/v1/jobs/a1234567');
  assert.equal(read.url, 'https://jobs.workable.com/view/a1234567/some-slug');
  assert.match(workable.collector.detail(read).text, /No longer accepting applications/);

  const failure = await readWorkablePage(search, {
    fetch: async () => new Response('', {status: 429}),
  }).catch((e) => e);
  assert.match(failure.message, /HTTP 429/);
  assert.equal(failure.status, 429);
  await assert.rejects(
    readWorkablePage(search, {
      fetch: async () => new Response('<html>', {headers: {'content-type': 'text/html'}}),
    }),
    /other than JSON/,
  );
  await assert.rejects(
    readWorkableDetail('https://jobs.workable.com/view/gone12345', {
      fetch: async () => new Response('Job not found', {status: 404}),
    }),
    /HTTP 404/,
  );
  await assert.rejects(
    readWorkableDetail('https://jobs.workable.com/search', {fetch}),
    /single Workable/,
  );
});

test('the site search gives one API search per term and claims no order', () => {
  const replay = recipeReplay(
    {
      entry: {kind: 'url_template', template: workable.search.template},
      pagination: 'url_param',
      terms: ['backend engineer', 'platform engineer'],
    },
    {query: 'x', location: 'United States'},
  );
  assert.deepEqual(
    replay.searches.map((s) => workableApiUrl(s.url)),
    [search, search.replace('backend', 'platform')],
  );
  const worldwide = recipeReplay(
    {entry: {kind: 'url_template', template: workable.search.template}, pagination: 'url_param'},
    {query: 'go developer', location: ''},
  );
  assert.equal(workableApiUrl(worldwide.searches[0].url), `${api}?query=go+developer`);
  const agent = siteSearchRecipe(workable.search, {
    entry: {
      kind: 'url_template',
      template: withSearchFilters(workable.search.template, {workplace: 'remote', day_range: '7'}),
    },
    pagination: 'none',
    ordering: 'newest_first',
  });
  assert.deepEqual(agent.changed, ['pagination', 'ordering']);
  assert.equal(agent.recipe.ordering, undefined);
  assert.match(agent.recipe.entry.template, /workplace=remote&day_range=7$/);
});
