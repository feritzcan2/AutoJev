import test from 'node:test';
import assert from 'node:assert/strict';
import arbeitnow, {
  arbeitnowApiUrl,
  parseArbeitnowPage,
  readArbeitnowPage,
  readArbeitnowDetail,
} from '../app/site-extensions/arbeitnow.mjs';
import {siteExtensionKind} from '../app/site-extensions/index.mjs';
import {collectorSearches} from '../app/sources/collectors.mjs';
import {prepareCollection, collectSourcePage} from '../app/sources/collector-worker.mjs';
import {recipePageCap} from '../app/sources/recipe.mjs';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';

const source = 'https://www.arbeitnow.com/';
const feed = 'https://www.arbeitnow.com/api/job-board-api?page=1';
const job = (slug, overrides = {}) => ({
  slug,
  company_name: 'teamative',
  title: 'Senior SAP SD Consultant',
  description:
    '<strong>Über uns</strong><p>Beratung &amp; Entwicklung.</p><ul><li>SAP SD</li><li>Deutsch</li></ul>',
  remote: true,
  url: `https://www.arbeitnow.com/jobs/companies/teamative/${slug}?utm_source=api`,
  tags: ['SAP', 'SD'],
  job_types: ['Experienced', 'Full time'],
  location: 'DE - Stuttgart',
  created_at: 1791565797,
  ...overrides,
});
const response = (
  jobs,
  page = 1,
  next = `https://www.arbeitnow.com/api/job-board-api?page=${page + 1}`,
) => ({
  data: jobs,
  links: {first: feed, last: null, prev: null, next},
  meta: {current_page: page, per_page: 100, terms: 'please do not abuse'},
});

test('every Arbeitnow address means that site feed with only its page and visa filter', () => {
  assert.equal(arbeitnowApiUrl(source), feed);
  assert.equal(
    arbeitnowApiUrl('https://arbeitnow.com/api/job-board-api?search=engineer&page=3&utm_x=1'),
    'https://www.arbeitnow.com/api/job-board-api?page=3',
    'the feed ignores search, so the search does not split it',
  );
  assert.equal(
    arbeitnowApiUrl('https://www.arbeitnow.ch/jobs?visa_sponsorship=true'),
    'https://www.arbeitnow.ch/api/job-board-api?visa_sponsorship=true&page=1',
    'country sites keep their own feed',
  );
  for (const bad of [
    'https://www.arbeitnow.com/?page=0',
    'https://www.arbeitnow.com/?visa_sponsorship=maybe',
    'http://www.arbeitnow.com/',
    'https://arbeitnow.com.evil.test/',
    'not a url',
  ])
    assert.throws(() => arbeitnowApiUrl(bad), undefined, bad);
  assert.equal(arbeitnow.collector.acceptsQuery(feed), false);
  assert.equal(siteExtensionKind(source, 'job-search').kind, 'api');
  assert.equal(siteExtensionKind(source, 'housing'), null);
  assert.equal(siteExtensionKind(source, 'job-search').search.filters[0].param, 'visa_sponsorship');
});

test('a feed page maps its postings to listings with the stated facts', () => {
  const page = parseArbeitnowPage(
    source,
    response([
      job('a-1'),
      job('b-2', {
        url: 'https://www.arbeitnow.co.uk/jobs/companies/x/b-2',
        remote: false,
        created_at: null,
      }),
    ]),
  );
  assert.equal(page.url, feed);
  assert.deepEqual(page.jobs[0], {
    url: 'https://www.arbeitnow.com/jobs/companies/teamative/a-1',
    title: 'Senior SAP SD Consultant',
    company: 'teamative',
    location: 'DE - Stuttgart',
    remote: true,
    tags: ['SAP', 'SD'],
    jobTypes: ['Experienced', 'Full time'],
    description: 'Über uns Beratung & Entwicklung.\n• SAP SD\n• Deutsch',
    publishedAt: '2026-10-09T17:09:57.000Z',
  });
  assert.equal(
    page.jobs[1].url,
    'https://www.arbeitnow.co.uk/jobs/companies/x/b-2',
    'the .com feed mixes country sites',
  );
  assert.equal(page.jobs[1].publishedAt, null);
  assert.deepEqual(
    [page.page, page.totalPages, page.nextUrl, page.complete],
    [1, null, 'https://www.arbeitnow.com/api/job-board-api?page=2', false],
  );
  const filtered = parseArbeitnowPage(
    'https://www.arbeitnow.com/api/job-board-api?visa_sponsorship=true&page=2',
    response([job('c')], 2),
  );
  assert.equal(
    filtered.nextUrl,
    'https://www.arbeitnow.com/api/job-board-api?visa_sponsorship=true&page=3',
    'the next page keeps the request filter',
  );
  const last = parseArbeitnowPage(source, response([job('a')], 1, null));
  assert.equal(last.complete, true);
  assert.equal(last.nextUrl, null);
  assert.throws(() => parseArbeitnowPage(source, response([job('a')], 2)), /farklı bir sayfa/);
  assert.throws(
    () => parseArbeitnowPage(source, response([job('a', {description: ' '})])),
    /eksik/,
  );
  assert.throws(
    () =>
      parseArbeitnowPage(
        source,
        response([job('a', {url: 'https://evil.test/jobs/companies/x/y'})]),
      ),
    /doğrulanamadı/,
  );
  assert.throws(() => parseArbeitnowPage(source, response([])), /boş sayfaya rağmen/);
  assert.throws(() => parseArbeitnowPage(source, {data: 'x'}), /biçimi geçersiz/);
  const detail = arbeitnow.collector.detail(page.jobs[0]);
  assert.equal(detail.title, 'Senior SAP SD Consultant');
  assert.deepEqual(detail.listing.fields, {
    company: 'teamative',
    location: 'DE - Stuttgart',
    workMode: 'remote',
    employmentType: 'Experienced, Full time',
    tags: 'SAP, SD',
    postedAt: '2026-10-09T17:09:57.000Z',
  });
  assert.match(detail.text, /• SAP SD/);
  assert.deepEqual(detail.cells, {company: 'teamative', location: 'DE - Stuttgart'});
  assert.equal(
    arbeitnow.collector.detail(page.jobs[1]).listing.fields.workMode,
    undefined,
    'not remote is not stated',
  );
});

test('feed and listing reads report failures instead of empty results', async () => {
  const signals = [];
  const fetch = async (url, {signal}) => {
    signals.push(signal);
    assert.equal(url, feed);
    return Response.json(response([job('a')]));
  };
  const page = await readArbeitnowPage(source, {fetch});
  assert.equal(page.jobs.length, 1);
  assert.ok(signals[0] instanceof AbortSignal);
  await assert.rejects(
    readArbeitnowPage(source, {
      fetch: async () =>
        new Response('<html>', {status: 200, headers: {'content-type': 'text/html'}}),
    }),
    /JSON yerine/,
  );
  const failure = await readArbeitnowPage(source, {
    fetch: async () => new Response('', {status: 503}),
  }).catch((e) => e);
  assert.match(failure.message, /HTTP 503/);
  assert.equal(failure.status, 503);
  const listing = 'https://www.arbeitnow.com/jobs/companies/teamative/a-1';
  const html = `<html><head><title>Senior SAP SD Consultant – teamative – Stuttgart | Arbeitnow</title><script type="application/ld+json">${JSON.stringify(
    {
      '@context': 'https://schema.org/',
      '@graph': [
        {
          '@type': 'JobPosting',
          title: 'Senior SAP SD Consultant',
          description:
            '<p>Beratung, Entwicklung und Umsetzung von IT-Projekten in Europa und den USA. </p>'.repeat(
              3,
            ),
          hiringOrganization: {'@type': 'Organization', name: 'teamative'},
          jobLocation: {
            '@type': 'Place',
            address: {addressLocality: 'Stuttgart', addressCountry: 'DE'},
          },
          jobLocationType: 'TELECOMMUTE',
          employmentType: 'FULL_TIME',
          datePosted: '2026-10-09',
          validThrough: '2099-01-01',
        },
      ],
    },
  )}</script></head><body><svg><title>hospital-building</title></svg><a href="${listing}">Senior SAP SD Consultant</a></body></html>`;
  const read = await readArbeitnowDetail(listing, {fetch: async () => new Response(html)});
  assert.equal(read.url, listing);
  assert.equal(read.company, 'teamative');
  assert.equal(read.location, 'Stuttgart, DE');
  assert.equal(read.remote, true);
  assert.deepEqual(read.jobTypes, ['FULL_TIME']);
  assert.match(read.description, /Beratung, Entwicklung/);
  await assert.rejects(
    readArbeitnowDetail(listing, {
      fetch: async () => new Response('<html><body>Gone</body></html>'),
    }),
    /güncel ilan verisi yok/,
  );
  await assert.rejects(
    readArbeitnowDetail(listing, {fetch: async () => new Response('', {status: 404})}),
    /HTTP 404/,
  );
  await assert.rejects(readArbeitnowDetail('https://www.arbeitnow.com/jobs', {fetch}), /Tekil/);
});

function workspace(t, recipe) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('job-search', {
    goal: 'backend',
    criteria: {preferences: 'Germany'},
    sources: [source],
  });
  if (recipe) db.saveSource(a.id, source, {recipe});
  db.review(a.id);
  const task = core.workspaces.tasks.enqueue(a.id, {
      sourceUrl: source,
      operation: 'scan',
      sources: [source],
      lockKey: 'source:' + source,
    }),
    run = db.begin(a.id, {kind: 'run', taskId: task.id});
  prepareCollection(db, run, db.get(a.id));
  return {db, a, run};
}
// An endless feed of empty pages: nothing to review, so each call consumes
// the previous page and fetches the next.
const endless = (reads) => async (url) => {
  reads.push(url);
  const page = Number(new URL(url).searchParams.get('page'));
  return {
    url,
    jobs: [],
    page,
    totalPages: null,
    nextUrl: url.replace(/page=\d+$/, `page=${page + 1}`),
    complete: false,
  };
};

test('one feed is one search, and without a newest-first recipe it reads only its page budget', async (t) => {
  const {db, a, run} = workspace(t);
  assert.deepEqual(
    collectorSearches(db.get(a.id), source).map((s) => s.url),
    [feed],
    'the saved query does not reach a feed that ignores it',
  );
  const reads = [];
  let result;
  for (let i = 0; i < 40 && !result?.complete; i++)
    result = await collectSourcePage(db, run.id, {readPage: endless(reads)});
  assert.equal(result.complete, true);
  assert.equal(reads.length, recipePageCap(undefined));
  assert.equal(db.run(run.id).scan.work.searches[0].completion, 'end');
});

test('a newest-first recipe reads a collector feed to its end', async (t) => {
  const {db, run} = workspace(t, {
    entry: {kind: 'url_template', template: 'https://www.arbeitnow.com/api/job-board-api'},
    pagination: 'url_param',
    ordering: 'newest_first',
  });
  const reads = [];
  const limit = recipePageCap(undefined) + 5;
  const readPage = async (url) => {
    const page = await endless(reads)(url);
    return page.page >= limit ? {...page, nextUrl: null, complete: true} : page;
  };
  let result;
  for (let i = 0; i < 60 && !result?.complete; i++)
    result = await collectSourcePage(db, run.id, {readPage});
  assert.equal(result.complete, true);
  assert.equal(reads.length, limit);
});
