import test from 'node:test';
import assert from 'node:assert/strict';
import {
  berlinStartupJobsRequest,
  parseBerlinStartupJobsList,
  berlinStartupJobsListPage,
  berlinStartupJobsDetailPage,
  readBerlinStartupJobs,
} from '../app/site-extensions/berlin-startup-jobs.mjs';
import {siteReaderFor, siteExtensionKind} from '../app/site-extensions/index.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev/results.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';

const category = 'https://berlinstartupjobs.com/engineering/';
const listing = (slug) => `https://berlinstartupjobs.com/engineering/${slug}/`;
const card = (slug, title, {featured = false, company = 'Solarize'} = {}) =>
  `<li class="bjs-jlid${featured ? ' bjs-jlid__is-featured' : ''}"><div class="bjs-jlid__wrapper"><div class="bjs-jlid__header"><div class="bjs-jlid__meta"><h4 class="bjs-jlid__h"><a href="${listing(slug)}">${title}</a></h4><a class="bjs-jlid__b" href="https://berlinstartupjobs.com/companies/${company.toLowerCase()}/">${company}</a></div></div><div class="links-box"></div><div class="bjs-jlid__description">\n\t\t\tBuild the <b>backend</b> of our solar platform &amp; more...\t\t</div></div></li>`;
const list = (
  cards,
  {
    next = null,
    pages = [],
    title = 'Jobs in IT &amp; Software Development | Berlin Startup Jobs',
  } = {},
) =>
  `<html><head><title>${title}</title></head><body><nav><a href="https://berlinstartupjobs.com/marketing/">Marketing</a></nav><ul class="jobs-list-items">${cards.join('')}</ul><div class="pagination">${pages
    .map((p) =>
      p.current
        ? `<span aria-current="page" class="page-numbers current">${p.number}</span>`
        : `<a class="page-numbers" href="${p.url}">${p.number}</a>`,
    )
    .join(
      '',
    )}${next ? `<a class="next page-numbers" href="${next}">Next</a>` : ''}</div></body></html>`;
const body =
  'Mein Grundeinkommen sucht eine Backend Developer*in in Berlin mit 32 Wochenstunden. '.repeat(3);
const detail = (overrides = {}) =>
  `<html><head><title>Job Vacancy: Backend Developer*in (Ruby on Rails) // Mein Grundeinkommen e.V. | Berlin Startup Jobs</title></head><body><script type="application/ld+json">${JSON.stringify(
    {
      '@context': 'http://schema.org',
      '@type': 'JobPosting',
      datePosted: '2026-09-02',
      validThrough: '2099-11-16',
      description: `${body}\n\nDeine Aufgaben:\n- Rails APIs\n- Reviews`,
      title: 'Backend Developer*in (Ruby on Rails)',
      hiringOrganization: {'@type': 'Organization', name: 'Mein Grundeinkommen e.V.'},
      jobLocation: {'@type': 'Place', address: {addressLocality: 'Berlin', addressCountry: 'DE'}},
      employmentType: 'FULL_TIME',
      ...overrides,
    },
  )}</script><h1 class="title">Backend Developer*in (Ruby on Rails)</h1><p>Rendered</p></body></html>`;

test('category lists and listings use the reader; company pages and the site search do not', () => {
  assert.deepEqual(berlinStartupJobsRequest(category), {kind: 'list', number: 1, url: category});
  assert.deepEqual(berlinStartupJobsRequest(`${category}page/2/`), {
    kind: 'list',
    number: 2,
    url: `${category}page/2/`,
  });
  assert.equal(berlinStartupJobsRequest(listing('role')).kind, 'detail');
  for (const other of [
    'https://berlinstartupjobs.com/companies/solarize/',
    'https://berlinstartupjobs.com/?s=compliance',
    'https://berlinstartupjobs.com/page/2/?s=compliance',
    'https://berlinstartupjobs.com/',
    'http://berlinstartupjobs.com/engineering/',
    'https://berlinstartupjobs.com.evil.test/engineering/',
    'not a url',
  ])
    assert.equal(berlinStartupJobsRequest(other), null, other);
  assert.equal(typeof siteReaderFor(category).read, 'function');
  assert.equal(siteReaderFor('https://berlinstartupjobs.com/?s=compliance'), null);
  assert.equal(
    siteExtensionKind(category, 'job-search').search.ordering,
    'newest_first',
    'category pages list the newest posting first',
  );
});

test('a category page lists its job cards as listings with the site paging', () => {
  const html = list(
    [
      card('senior-node', 'Senior Software Engineer &#8211; Node.js (m/f/d)', {featured: true}),
      card('lead', 'Lead Engineer'),
    ],
    {
      next: `${category}page/2/`,
      pages: [
        {number: 1, current: true},
        {number: 2, url: `${category}page/2/`},
      ],
    },
  );
  const parsed = parseBerlinStartupJobsList(html);
  assert.deepEqual(parsed.jobs[0], {
    url: listing('senior-node'),
    title: 'Senior Software Engineer – Node.js (m/f/d)',
    company: 'Solarize',
    teaser: 'Build the backend of our solar platform & more...',
  });
  assert.equal(parsed.totalPages, 2);
  const read = berlinStartupJobsListPage(category, 1, html);
  assert.deepEqual(
    read.links.map((l) => [l.url, l.listing]),
    [
      [listing('senior-node'), true],
      [listing('lead'), true],
    ],
    'company and category links are not listings',
  );
  assert.match(read.text, /Jobs in IT & Software Development \| Berlin Startup Jobs, page 1 of 2/);
  assert.match(read.text, /Solarize · Build the backend/);
  const position = resultPageSummary(read, {id: 'e1'}, []).position;
  assert.equal(position.currentPage, 1);
  assert.equal(observedNextPage(read, position).url, `${category}page/2/`);
  const last = berlinStartupJobsListPage(
    `${category}page/2/`,
    2,
    list([card('x', 'X')], {
      pages: [
        {number: 1, url: category},
        {number: 2, current: true},
      ],
    }),
  );
  assert.deepEqual(
    last.pagination.map((p) => p.text),
    ['2 of 2'],
  );
  const empty = berlinStartupJobsListPage(category, 1, list([]));
  assert.deepEqual(empty.links, []);
  assert.match(empty.text, /no further results/);
  assert.equal(empty.pagination.length, 1);
  const other = berlinStartupJobsListPage(
    'https://berlinstartupjobs.com/about/',
    1,
    '<html><head><title>About</title></head><body><script>x()</script><p>About the board</p></body></html>',
  );
  assert.deepEqual(other.pagination, [], 'a page without a job list is not a results page');
  assert.equal(other.text, 'About the board');
});

test('a listing reads through its JobPosting; a removed or plain page does not', () => {
  const url = listing('backend-developer-mein-grundeinkommen');
  const read = berlinStartupJobsDetailPage(url, detail());
  assert.equal(read.title, 'Backend Developer*in (Ruby on Rails) @ Mein Grundeinkommen e.V.');
  assert.deepEqual(read.listing.fields, {
    company: 'Mein Grundeinkommen e.V.',
    location: 'Berlin, DE',
    employmentType: 'FULL_TIME',
    postedAt: '2026-09-02',
    validThrough: '2099-11-16',
  });
  assert.match(read.text, /Deine Aufgaben:\n- Rails APIs/);
  assert.equal(
    berlinStartupJobsDetailPage(url, detail({description: 'Short.'})).listing,
    undefined,
  );
  const removed = berlinStartupJobsDetailPage(url, '');
  assert.match(removed.text, /not found/);
  assert.equal(removed.listing, undefined);
});

test('reads use the shared site access rules and never fetch the site search', async () => {
  const requested = [];
  const siteAccess = {
    begin: () => 'token',
    pace: () => 0,
    complete: (_url, _token, info) =>
      info.reason
        ? {site: 'berlinstartupjobs.com', reason: info.reason, retryAt: 1, waiting: true}
        : null,
  };
  const fetch = async (url, options) => {
    requested.push(url);
    assert.match(options.headers['User-Agent'], /AutoJev/);
    return new Response(url.endsWith('/engineering/') ? list([card('a', 'A')]) : detail());
  };
  const read = await readBerlinStartupJobs(category, {fetch, siteAccess});
  assert.equal(read.links.length, 1);
  assert.ok((await readBerlinStartupJobs(listing('a'), {fetch, siteAccess})).listing);
  assert.deepEqual(requested, [category, listing('a')]);
  const error = await readBerlinStartupJobs(category, {
    fetch: async () => new Response('', {status: 429}),
    siteAccess,
  }).catch((e) => e);
  assert.ok(error instanceof SiteWaitError);
  const gone = await readBerlinStartupJobs(listing('gone'), {
    fetch: async () => new Response('', {status: 404}),
  });
  assert.match(gone.text, /not found/);
  await assert.rejects(
    readBerlinStartupJobs('https://berlinstartupjobs.com/?s=compliance'),
    /does not handle/,
  );
});
