import test from 'node:test';
import assert from 'node:assert/strict';
import freehire, {
  freehireApiUrl,
  parseFreehirePage,
  readFreehirePage,
  readFreehireDetail,
} from '../app/site-extensions/freehire.mjs';
import {siteExtensionFor, siteExtensionKind} from '../app/site-extensions/index.mjs';
import {siteSearchRecipe, withSearchFilters} from '../app/site-extensions/search.mjs';
import {recipeReplay} from '../app/sources/recipe.mjs';
import {jobSearchSources} from '../app/templates/job-search/sources.mjs';

const api = 'https://freehire.me/api/v1/agent/jobs/search';
const search = `${api}?q=%22backend+engineer%22&q_fields=title&countries=de&sort=created_at&limit=25&offset=0`;
const job = (slug, overrides = {}) => ({
  public_slug: slug,
  title: 'Senior Backend Engineer (m/w/d)',
  company: 'finanzen.net GmbH',
  location: 'Germany',
  url: `https://jobs.ashbyhq.com/acme/${slug}?utm_source=freehire.me&gh_src=x`,
  description: '<p>Build &amp; run our broker.</p><ul><li>Java</li><li>AWS</li></ul>',
  work_mode: 'remote',
  posted_at: '2026-10-11T06:31:04Z',
  closed_at: null,
  enrichment: {
    employment_type: 'full_time',
    salary_min: 70000,
    salary_max: 90000,
    salary_currency: 'EUR',
    salary_period: 'year',
  },
  ...overrides,
});
const response = (jobs, {offset = 0, total = 60, ...meta} = {}) => ({
  data: jobs,
  meta: {limit: 25, offset, total, ...meta},
});

test('FreeHire search addresses become one API page of the agent search', () => {
  assert.equal(siteExtensionFor('https://freehire.me/'), freehire);
  assert.equal(siteExtensionKind('https://freehire.me/jobs', 'job-search').kind, 'api');
  assert.equal(siteExtensionKind('https://freehire.me/jobs', 'housing'), null);
  assert.equal(freehireApiUrl('https://freehire.me/'), `${api}?sort=created_at&limit=25&offset=0`);
  assert.equal(
    freehireApiUrl(
      'https://www.freehire.me/jobs?countries=gb&countries=ie&work_mode=remote&page=3&utm_source=x&limit=100',
    ),
    `${api}?countries=gb&countries=ie&work_mode=remote&sort=created_at&limit=25&offset=50`,
    "repeated facets stay, the page becomes an offset and the page size is the reader's",
  );
  assert.equal(
    freehireApiUrl(`${api}?q=go&sort=posted_at&countries=&offset=25`),
    `${api}?q=go&sort=posted_at&limit=25&offset=25`,
    'an empty placeholder value drops its filter; a stated sort is kept',
  );
  for (const bad of [
    'https://freehire.me/jobs/some-listing-abc123',
    'https://freehire.me/companies',
    `${api}?offset=13`,
    `${api}?offset=10000`,
    'http://freehire.me/jobs',
    'https://freehire.me.evil.test/jobs',
    'not a url',
  ])
    assert.throws(() => freehireApiUrl(bad), undefined, bad);
});

test('a page maps listings to their FreeHire address with the stated facts only', () => {
  const page = parseFreehirePage(
    search,
    response([job('a-1'), job('b-2', {enrichment: {}, work_mode: undefined})]),
  );
  assert.deepEqual(
    [page.page, page.totalPages, page.complete, page.nextUrl],
    [1, 3, false, search.replace('offset=0', 'offset=25')],
  );
  assert.equal(page.jobs[0].url, 'https://freehire.me/jobs/a-1');
  assert.equal(page.jobs[0].applyUrl, 'https://jobs.ashbyhq.com/acme/a-1?gh_src=x');
  const detail = freehire.collector.detail(page.jobs[0]);
  assert.equal(detail.url, 'https://freehire.me/jobs/a-1');
  assert.deepEqual(detail.listing.fields, {
    company: 'finanzen.net GmbH',
    location: 'Germany',
    workMode: 'remote',
    employmentType: 'full_time',
    salary: '70000–90000 EUR per year',
    postedAt: '2026-10-11T06:31:04Z',
    applyUrl: 'https://jobs.ashbyhq.com/acme/a-1?gh_src=x',
  });
  assert.match(detail.text, /Build & run our broker\.\n+• Java\n+• AWS/);
  assert.deepEqual(detail.cells, {company: 'finanzen.net GmbH', location: 'Germany'});
  assert.deepEqual(
    Object.keys(freehire.collector.detail(page.jobs[1]).listing.fields),
    ['company', 'location', 'postedAt', 'applyUrl'],
    'facts the posting does not state are left out',
  );

  const last = parseFreehirePage(
    search.replace('offset=0', 'offset=50'),
    response([job('c')], {offset: 50}),
  );
  assert.deepEqual([last.page, last.complete, last.nextUrl], [3, true, null]);
  const deep = parseFreehirePage(
    search.replace('offset=0', 'offset=9975'),
    response([job('d')], {offset: 9975, total: 50000}),
  );
  assert.equal(deep.nextUrl, null, 'the API refuses offset+limit above 10000');
  assert.equal(deep.totalPages, 400);
});

test('malformed, partial or reinterpreted pages are errors, not empty results', () => {
  assert.throws(() => parseFreehirePage(search, {data: []}), /malformed/);
  assert.throws(() => parseFreehirePage(search, response([job('a')], {offset: 25})), /malformed/);
  assert.throws(() => parseFreehirePage(search, response([])), /incomplete/);
  assert.throws(
    () => parseFreehirePage(search, response([job('a', {description: ''})])),
    /description/,
  );
  assert.throws(
    () =>
      parseFreehirePage(
        search,
        response([job('a')], {ignored_params: [{param: 'country', did_you_mean: 'countries'}]}),
      ),
    /country \(did you mean countries\?\)/,
  );
  assert.deepEqual(parseFreehirePage(search, response([], {total: 0})).jobs, []);
});

test('reads go to the API with the caller signal and report failures', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({url, options});
    return Response.json(
      url.includes('/api/v1/jobs/')
        ? {data: job('a-1', {closed_at: '2026-10-10T00:00:00Z'})}
        : response([job('a-1')], {total: 1}),
    );
  };
  const page = await readFreehirePage(search, {fetch});
  assert.equal(page.jobs.length, 1);
  assert.equal(calls[0].url, search);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.match(calls[0].options.headers['User-Agent'], /^jobloop\//);

  const read = await readFreehireDetail('https://freehire.me/jobs/a-1', {fetch});
  assert.equal(calls[1].url, 'https://freehire.me/api/v1/jobs/a-1');
  assert.equal(read.url, 'https://freehire.me/jobs/a-1');
  assert.match(freehire.collector.detail(read).text, /No longer accepting applications/);

  const failure = await readFreehirePage(search, {
    fetch: async () => new Response('', {status: 429}),
  }).catch((e) => e);
  assert.match(failure.message, /HTTP 429/);
  assert.equal(failure.status, 429);
  await assert.rejects(
    readFreehirePage(search, {
      fetch: async () => new Response('<html>', {headers: {'content-type': 'text/html'}}),
    }),
    /other than JSON/,
  );
  await assert.rejects(
    readFreehireDetail('https://freehire.me/jobs/gone', {
      fetch: async () => new Response('', {status: 404}),
    }),
    /HTTP 404/,
  );
  await assert.rejects(readFreehireDetail('https://freehire.me/jobs', {fetch}), /single FreeHire/);
});

test('the template recipe and the site search give one API search per term', () => {
  const source = jobSearchSources.find((s) => s.url === 'https://freehire.me/');
  assert.equal(siteExtensionFor(source.url).id, 'freehire');
  const replay = recipeReplay(
    {...source.recipe, terms: ['backend engineer', 'platform engineer']},
    {query: 'x', country: 'de'},
  );
  assert.deepEqual(
    replay.searches.map((s) => freehireApiUrl(s.url)),
    [search, search.replace('backend', 'platform')],
  );
  const worldwide = recipeReplay(source.recipe, {query: 'go developer', country: ''});
  assert.ok(!new URL(freehireApiUrl(worldwide.searches[0].url)).searchParams.has('countries'));

  const agent = siteSearchRecipe(freehire.search, {
    entry: {
      kind: 'url_template',
      template: withSearchFilters(`${api}?q={query}&sort=posted_at`, {work_mode: 'remote'}),
    },
    pagination: 'none',
    ordering: 'newest_first',
  });
  assert.deepEqual(agent.changed, ['template', 'pagination', 'ordering']);
  const params = new URL(agent.recipe.entry.template.replace('{query}', 'x')).searchParams;
  assert.deepEqual(
    [params.get('sort'), params.get('q_fields'), params.get('work_mode'), agent.recipe.ordering],
    ['created_at', 'title', 'remote', undefined],
    'the extension restores its sort and title matching and claims no order',
  );
});
