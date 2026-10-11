import test from 'node:test';
import assert from 'node:assert/strict';
import themuse, {
  theMuseApiUrl,
  parseTheMusePage,
  readTheMusePage,
  readTheMuseDetail,
} from '../app/site-extensions/themuse.mjs';
import {siteSearchRecipe} from '../app/site-extensions/search.mjs';
import {recipeReplay} from '../app/sources/recipe.mjs';

const api = 'https://www.themuse.com/api/public/jobs';
const search = `${api}?category=Software+Engineering&location=New+York%2C+NY&page=0`;
const listing = 'https://www.themuse.com/jobs/gitlab/intermediate-support-engineer-shift-476781';
const job = (id, overrides = {}) => ({
  id,
  name: 'Intermediate Support Engineer (SHIFT) ',
  type: 'external',
  publication_date: '2026-08-05T23:40:33Z',
  short_name: 'intermediate-support-engineer-shift-476781',
  model_type: 'jobs',
  contents: '<p>Help &amp; support customers.</p><ul><li>Git</li><li>Linux</li></ul>',
  locations: [{name: 'Flexible / Remote'}, {name: 'New York, NY'}],
  categories: [{name: 'Software Engineering'}],
  levels: [{name: 'Mid Level', short_name: 'mid'}],
  tags: [],
  refs: {landing_page: `${listing}?utm_source=api`},
  company: {id: 15000088, short_name: 'gitlab', name: 'GitLab'},
  ...overrides,
});
const response = (results, {page = 0, page_count = 3} = {}) => ({
  page,
  page_count,
  items_per_page: 20,
  total: 50,
  results,
});

test('The Muse addresses become one API page with only documented filters', () => {
  assert.equal(theMuseApiUrl('https://www.themuse.com/'), `${api}?page=0`);
  assert.equal(
    theMuseApiUrl(
      `${api}?category=Software%20Engineering&category=Data%20and%20Analytics&level=Senior%20Level&page=4&utm_source=x&company=`,
    ),
    `${api}?category=Software+Engineering&category=Data+and+Analytics&level=Senior+Level&page=4`,
    'facets repeat, empty placeholders drop their filter, pages count from 0',
  );
  for (const bad of [
    `${api}?query=backend`,
    `${api}?descending=true`,
    `${api}?page=-1`,
    'https://www.themuse.com/jobs/gitlab/some-job',
    'http://www.themuse.com/api/public/jobs',
    'https://themuse.com.evil.test/api/public/jobs',
    'not a url',
  ])
    assert.throws(() => theMuseApiUrl(bad), undefined, bad);
});

test('a page maps postings to their listing address with the stated facts only', () => {
  const page = parseTheMusePage(
    search,
    response([job(1), job(2, {levels: [], categories: [], locations: []})]),
  );
  assert.deepEqual(
    [page.page, page.totalPages, page.complete, page.nextUrl],
    [1, 3, false, search.replace('page=0', 'page=1')],
  );
  assert.equal(page.jobs[0].url, listing);
  const detail = themuse.collector.detail(page.jobs[0]);
  assert.equal(detail.url, listing);
  assert.deepEqual(detail.listing.fields, {
    company: 'GitLab',
    location: 'Flexible / Remote, New York, NY',
    level: 'Mid Level',
    category: 'Software Engineering',
    postedAt: '2026-08-05T23:40:33Z',
  });
  assert.match(detail.text, /Help & support customers\.\n+• Git\n+• Linux/);
  assert.deepEqual(detail.cells, {company: 'GitLab', location: 'Flexible / Remote, New York, NY'});
  assert.deepEqual(
    Object.keys(themuse.collector.detail(page.jobs[1]).listing.fields),
    ['company', 'postedAt'],
    'facts the posting does not state are left out',
  );
  const last = parseTheMusePage(search.replace('page=0', 'page=2'), response([job(3)], {page: 2}));
  assert.deepEqual([last.page, last.complete, last.nextUrl], [3, true, null]);
  assert.deepEqual(parseTheMusePage(search, response([], {page_count: 0})).jobs, []);
});

test('malformed or partial pages are errors, not empty results', () => {
  assert.throws(() => parseTheMusePage(search, {results: []}), /malformed/);
  assert.throws(() => parseTheMusePage(search, response([job(1)], {page: 1})), /malformed/);
  assert.throws(() => parseTheMusePage(search, response([])), /incomplete/);
  assert.throws(() => parseTheMusePage(search, response([job(1, {contents: ''})])), /description/);
  assert.throws(
    () =>
      parseTheMusePage(search, response([job(1, {refs: {landing_page: 'https://evil.test/x'}})])),
    /address/,
  );
});

test('reads go to the API with the caller signal and report failures', async () => {
  const calls = [];
  const page = 'x&quot;sp_page_entity_id&quot;:&quot;22034737&quot;y';
  const fetch = async (url, options) => {
    calls.push({url, options});
    if (url === listing) return new Response(page, {headers: {'content-type': 'text/html'}});
    if (url.endsWith('/22034737')) return Response.json(job(22034737));
    return Response.json(response([job(1)], {page_count: 1}));
  };
  const read = await readTheMusePage(search, {fetch});
  assert.equal(read.jobs.length, 1);
  assert.equal(calls[0].url, search);
  assert.ok(calls[0].options.signal instanceof AbortSignal);

  const detail = await readTheMuseDetail(listing, {fetch});
  assert.deepEqual(
    calls.slice(1).map((c) => c.url),
    [listing, `${api}/22034737`],
  );
  assert.equal(detail.url, listing);
  await assert.rejects(
    readTheMuseDetail(listing, {
      fetch: async (url) =>
        url === listing
          ? new Response(page)
          : Response.json(job(22034737, {refs: {landing_page: `${listing}-other`}})),
    }),
    /does not match/,
  );
  await assert.rejects(
    readTheMuseDetail(listing, {fetch: async () => new Response('<html></html>')}),
    /names no posting id/,
  );
  await assert.rejects(
    readTheMuseDetail(listing, {fetch: async () => new Response('', {status: 404})}),
    /HTTP 404/,
  );
  await assert.rejects(readTheMuseDetail(`${listing}?x=1`, {fetch}), /single The Muse/);

  const failure = await readTheMusePage(search, {
    fetch: async () => new Response('', {status: 429}),
  }).catch((e) => e);
  assert.equal(failure.status, 429);
  await assert.rejects(
    readTheMusePage(search, {
      fetch: async () => new Response('<html>', {headers: {'content-type': 'text/html'}}),
    }),
    /other than JSON/,
  );
});

test('recipe terms are categories and the extension claims no order', () => {
  const recipe = siteSearchRecipe(themuse.search, {
    entry: {kind: 'url_template', template: `${api}?category={query}&level=Senior%20Level`},
    pagination: 'none',
    ordering: 'newest_first',
  });
  assert.deepEqual(recipe.changed, ['pagination', 'ordering']);
  assert.equal(recipe.recipe.ordering, undefined);
  const replay = recipeReplay(
    {...recipe.recipe, terms: ['Software Engineering', 'Data and Analytics']},
    {query: 'x'},
  );
  assert.deepEqual(
    replay.searches.map((s) => theMuseApiUrl(s.url)),
    [
      `${api}?category=Software+Engineering&level=Senior+Level&page=0`,
      `${api}?category=Data+and+Analytics&level=Senior+Level&page=0`,
    ],
  );
  assert.equal(themuse.collector.acceptsQuery(api), false);
});
