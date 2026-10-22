import test from 'node:test';
import assert from 'node:assert/strict';
import builtIn, {
  isBuiltInUrl,
  builtInRequest,
  parseBuiltInSearch,
  builtInSearchPage,
  builtInDetailPage,
  readBuiltIn,
} from '../app/site-extensions/builtin.mjs';
import {siteSearchRecipe, withSearchFilters} from '../app/site-extensions/search.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';
import {recordUrlKey} from '../app/records/identity.mjs';

const search = 'https://builtin.com/jobs?search=backend+engineer&country=USA&allLocations=true';
const listing = (id) => `https://builtin.com/job/backend-engineer-${id}/${id}`;
// One result card shaped like the site's markup (2026-10-11): company link,
// title link, age, work mode, location (a tooltip for several), pay, level
// and the collapsed teaser.
const card = ({id, title = 'Senior Backend Engineer', company = 'Hex & Co', places = null}) => `
<div id="job-card-${id}" data-id="job-card" x-data="jobTracking" class="job-bounded-responsive"><div id="main" class="row">
<div class="left-side-tile-item-1"><a href="/company/hex" target="_blank"><picture><img alt="Hex Logo"></picture></a></div>
<div class="left-side-tile-item-2"><a href="/company/hex" target="_blank" data-id="company-title" data-builtin-track-job-id="${id}" class="font-barlow"><span>${company.replace('&', '&amp;')}</span></a></div>
<div class="left-side-tile-item-3"><h2><a href="/job/backend-engineer-${id}/${id}" target="_blank" data-id="job-card-title" data-alias="/job/backend-engineer-${id}/${id}" class="card-alias-after-overlay text-break">${title}</a></h2></div></div>
<div class="bounded-attribute-section"><span x-show="!showSavedTag" class="fs-xs"><i class="fa-regular fa-clock fs-xs text-gray-03 d-inline-block"></i>5 Days Ago</span>
<div class="d-flex align-items-start gap-sm"><div class="d-flex"><i class="fa-regular fa-house-building fs-xs text-pretty-blue"></i></div>
<span class="font-barlow text-gray-04">Remote or Hybrid</span></div>
<div class="d-flex align-items-start gap-sm"><div class="d-flex"><i class="fa-regular fa-location-dot fs-xs text-pretty-blue"></i></div>
<div>${
  places
    ? `<span class="font-barlow text-gray-04 text-decoration-underline" data-bs-toggle="tooltip" role="tooltip" aria-label="Job locations" data-bs-title="${places.map((p) => `&lt;div class=&#x27;text-truncate&#x27;&gt;${p}&lt;/div&gt;`).join('')}">${places.length} Locations
      </span>`
    : '<span class="font-barlow text-gray-04">New York, NY, USA</span>'
}</div></div>
<div class="d-flex align-items-start gap-sm"><div class="d-flex"><i class="fa-regular fa-sack-dollar fs-xs text-pretty-blue"></i></div>
<span class="font-barlow text-gray-04">199K-295K Annually</span></div>
<div class="d-flex align-items-start gap-sm"><div class="d-flex"><i class="fa-regular fa-trophy fs-xs text-pretty-blue"></i></div>
<span class="font-barlow text-gray-04">Senior level</span></div></div>
<div id="drop-data-${id}" class="collapse"><div class="fs-sm fw-regular mb-md text-gray-04">Build event-driven services in Go.</div></div></div>`;
const pager = (current, last) =>
  `<div id="pagination"><nav><ul class="pagination">${[...Array(Math.min(last, 5)).keys()]
    .map(
      (i) =>
        `<li><a href="/jobs?search=backend%20engineer&amp;page=${i + 1}" aria-label="Go to ${i ? 'Page' : 'page'} ${i + 1}">${i + 1}</a></li>`,
    )
    .join(
      '',
    )}<li><a href="/jobs?search=backend%20engineer&amp;page=${last}" aria-label="Go to page ${last}">${last}</a></li>${
    current < last
      ? `<li><a href="/jobs?search=backend%20engineer&amp;country=USA&amp;allLocations=true&amp;page=${current + 1}" aria-label="Go to Next Page"></a></li>`
      : ''
  }</ul></nav></div>`;
const resultsHtml = (cards, current = 1, last = 57) =>
  `<html><head><title>Best Tech Jobs | Built In</title></head><body><header><a href="/auth/login?destination=%2fjobs">Log In</a></header><main><div id="jobs-list"><h1>Top Tech Jobs</h1>${cards.join('')}${cards.length ? pager(current, last) : 'No job results. To see more jobs, try: Expanding your search area'}</div></main></body></html>`;

test('Built In addresses: searches with filter paths, listings by id, nothing else', () => {
  assert.equal(isBuiltInUrl('https://www.builtin.com/jobs'), true);
  assert.equal(isBuiltInUrl('https://builtin.com.evil.test/jobs'), false);
  assert.equal(isBuiltInUrl('http://builtin.com/jobs'), false);
  assert.deepEqual(builtInRequest(`${search}&page=3`), {
    kind: 'search',
    number: 3,
    url: `${search}&page=3`,
  });
  assert.equal(
    builtInRequest('https://builtin.com/jobs/remote/engineering/senior?search=go').kind,
    'search',
  );
  assert.equal(builtInRequest(listing(11386683)).kind, 'detail');
  for (const other of [
    'https://builtin.com/',
    'https://builtin.com/company/hex',
    'https://builtin.com/auth/login',
    `${search}&page=0`,
    'https://builtin.com/job/no-id',
  ])
    assert.equal(builtInRequest(other), null, other);
  assert.equal(builtIn.http.handles(search), true);
  // A retitled listing keeps its ID; both slugs are one record.
  assert.equal(
    recordUrlKey('https://builtin.com/job/staff-software-engineer-mobile/11739970'),
    recordUrlKey('https://www.builtin.com/job/senior-staff-software-engineer-mobile/11739970/'),
  );
  assert.notEqual(recordUrlKey(listing(11739970)), recordUrlKey(listing(11739971)));
  assert.equal(builtIn.listingKey(search), null);
});

test('a results page lists its cards as listings with the stated facts and the site pagination', () => {
  const html = resultsHtml([
    card({id: 11, places: ['New York, NY, USA', 'San Francisco, CA, USA']}),
    card({id: 12, title: 'Staff Engineer, Platform'}),
    card({id: 11}),
  ]);
  const list = parseBuiltInSearch(html);
  assert.equal(list.totalPages, 57);
  assert.equal(list.jobs[0].company, 'Hex & Co');
  assert.equal(list.jobs[0].location, 'New York, NY, USA; San Francisco, CA, USA');
  assert.equal(list.jobs[1].location, 'New York, NY, USA');
  const page = builtInSearchPage(search, 1, html);
  assert.deepEqual(page.links, [
    {text: 'Senior Backend Engineer', url: listing(11), listing: true},
    {text: 'Staff Engineer, Platform', url: listing(12), listing: true},
  ]);
  assert.match(
    page.text,
    /page 1 of 57\nLink: Senior Backend Engineer — https:\/\/builtin\.com\/job\/backend-engineer-11\/11\nHex & Co · New York, NY, USA; San Francisco, CA, USA · Remote or Hybrid · 199K-295K Annually · Senior level · posted 5 Days Ago · Build event-driven services in Go\./,
  );
  assert.doesNotMatch(page.text, /company\/hex|Log In/, 'company and site links are not listings');
  assert.deepEqual(
    page.pagination.map((p) => [p.text, p.url, p.current]),
    [
      ['1 of 57', search, true],
      [
        '2',
        'https://builtin.com/jobs?search=backend%20engineer&country=USA&allLocations=true&page=2',
        false,
      ],
    ],
  );

  const last = builtInSearchPage(`${search}&page=57`, 57, resultsHtml([card({id: 13})], 57, 57));
  assert.deepEqual(
    last.pagination.map((p) => p.text),
    ['57 of 57'],
  );
  const empty = builtInSearchPage(search, 1, resultsHtml([]));
  assert.deepEqual([empty.links, empty.pagination.length], [[], 1]);
  assert.match(empty.text, /no further results/);
  const other = builtInSearchPage(
    search,
    1,
    '<html><title>Built In</title><body><p>Maintenance</p></body></html>',
  );
  assert.deepEqual([other.links, other.pagination], [[], []]);
  assert.match(other.text, /Maintenance/);
});

const posting = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Senior Backend Engineer',
  description: '<p>Build and run event-driven services in Go for a payments platform. </p>'.repeat(
    4,
  ),
  datePosted: '2026-10-10',
  validThrough: '2099-01-01T00:00:00+00:00',
  employmentType: 'FULL_TIME',
  hiringOrganization: {
    '@type': 'Organization',
    name: 'Hex',
    sameAs: 'https://builtin.com/company/hex',
  },
  jobLocation: {
    '@type': 'Place',
    address: {addressLocality: 'New York', addressRegion: 'NY', addressCountry: 'USA'},
  },
};
// The site encodes the "+" of the script type as an HTML entity.
const detailHtml = (data = posting) =>
  `<html><head><title>Senior Backend Engineer - Hex | Built In</title><script type="application/ld&#x2B;json">${JSON.stringify(
    {'@context': 'https://schema.org', '@graph': [data]},
  )}</script></head><body><nav>Jobs Companies</nav><h1>Senior Backend Engineer</h1><div>Similar jobs</div></body></html>`;

test('a listing is read through its JobPosting; other pages keep their text', () => {
  const page = builtInDetailPage(listing(11), detailHtml());
  assert.ok(page.listing);
  assert.equal(page.url, listing(11));
  assert.deepEqual(
    [page.listing.fields.company, page.listing.fields.location, page.listing.fields.postedAt],
    ['Hex', 'New York, NY, USA', '2026-10-10'],
  );
  assert.match(page.text, /event-driven services in Go/);
  assert.doesNotMatch(page.text, /Similar jobs/);
  const expired = builtInDetailPage(
    listing(11),
    detailHtml({...posting, validThrough: '2020-01-01'}),
  );
  assert.equal(expired.listing, undefined);
  assert.match(expired.text, /Similar jobs/);
  assert.match(builtInDetailPage(listing(11), '').text, /not found/);
});

test('reads go through the shared site access with the caller signal', async () => {
  const events = [],
    requested = [];
  const siteAccess = {
    begin: (url) => {
      events.push(['begin', url]);
      return 'token';
    },
    pace: () => 0,
    complete: (url, token, info) => {
      events.push(['complete', url, token, info]);
      return info.reason
        ? {site: 'builtin.com', reason: info.reason, retryAt: 1, waiting: true}
        : null;
    },
  };
  const controller = new AbortController();
  const fetch = async (url, options) => {
    requested.push([url, options.signal]);
    return new Response(url.includes('/job/') ? detailHtml() : resultsHtml([card({id: 11})]));
  };
  const results = await readBuiltIn(search, {fetch, siteAccess, signal: controller.signal});
  assert.equal(results.links.length, 1);
  assert.equal(requested[0][0], search);
  assert.ok(requested[0][1] instanceof AbortSignal);
  const read = await readBuiltIn(listing(11), {fetch, siteAccess});
  assert.ok(read.listing);
  assert.deepEqual(events.at(-1), ['complete', listing(11), 'token', {status: 200}]);
  for (const status of [403, 429]) {
    const error = await readBuiltIn(search, {
      fetch: async () => new Response('', {status}),
      siteAccess,
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError);
    assert.equal(error.url, search);
  }
  const gone = await readBuiltIn(listing(11), {fetch: async () => new Response('', {status: 404})});
  assert.match(gone.text, /not found/);
  assert.equal(gone.listing, undefined);
  await assert.rejects(
    readBuiltIn(search, {fetch: async () => new Response('', {status: 500})}),
    /HTTP 500/,
  );
  await assert.rejects(readBuiltIn('https://builtin.com/company/hex'), /does not handle/);
});

test('the site search keeps the location fixed and claims no order', () => {
  const template = withSearchFilters(builtIn.search.template, {daysSinceUpdated: '7'});
  assert.equal(
    template,
    'https://builtin.com/jobs?search={query}&country=USA&allLocations=true&daysSinceUpdated=7',
  );
  const {recipe, changed} = siteSearchRecipe(builtIn.search, {
    entry: {
      kind: 'url_template',
      template: 'https://builtin.com/jobs/remote?search={query}&country=USA',
    },
    pagination: 'none',
    ordering: 'newest_first',
  });
  assert.deepEqual(changed, ['template', 'pagination', 'ordering']);
  assert.equal(
    recipe.entry.template,
    'https://builtin.com/jobs/remote?search={query}&country=USA&allLocations=true',
  );
  assert.equal(recipe.ordering, undefined);
});
