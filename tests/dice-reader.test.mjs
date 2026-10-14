import test from 'node:test';
import assert from 'node:assert/strict';
import dice, {
  diceRequest,
  diceState,
  diceCards,
  parseDiceSearch,
  diceSearchPage,
  diceDetailPage,
  readDice,
} from '../app/site-extensions/dice.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';

const search = 'https://www.dice.com/jobs?q=backend%20engineer&location=New%20York';
const guid = (n) => `${String(n).padStart(8, '0')}-7be5-4568-a660-4ebad5e8aa64`;
const listing = (n) => `https://www.dice.com/job-detail/${guid(n)}`;
const job = (n, overrides = {}) => ({
  id: `aa${n}`,
  guid: guid(n),
  detailsPageUrl: listing(n),
  companyName: 'Motion Recruitment Partners, LLC',
  employmentType: 'Full-time',
  jobLocation: {city: 'New York', displayName: 'New York, New York, USA'},
  postedDate: '2026-08-12T00:04:16Z',
  salary: '$$120000 - $160000',
  title: `Back End Engineer ${n}`,
  workplaceTypes: ['On-Site'],
  ...overrides,
});
const card = (n, title = `Back End Engineer ${n}`) =>
  `<div role="listitem"><div data-id="x" data-job-guid="${guid(n)}" data-testid="job-card" role="article"><a tabindex="-1" aria-label="View Details for ${title} (x)" data-testid="job-search-job-card-link" href="/job-detail/${guid(n)}"> </a><a href="/company-profile/c?companyname=Motion"><img alt="Motion"/></a><a data-testid="job-search-job-detail-link" aria-label="${title}" href="/job-detail/${guid(n)}">${title}</a><a href="/company-profile/c"><p class="mb-0" data-testid="job-card-company-name" title="Motion">Motion Recruitment Partners, LLC</p></a></div></div>`;
// The RSC payload is pushed as JSON string chunks; split it to mirror the page.
const push = (value) => {
  const text = `10:["$","$L44",null,${JSON.stringify(value)}]\n`,
    middle = Math.floor(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)]
    .map((part) => `<script>self.__next_f.push([1,${JSON.stringify(part)}])</script>`)
    .join('');
};
const page = ({
  jobs = [1, 2],
  cards = jobs,
  currentPage = 1,
  pageCount = 14,
  totalResults = 416,
  similar = [9],
} = {}) =>
  `<html><head><title>Search Jobs | Dice.com</title></head><body><p>${totalResults} results</p><div role="list" aria-label="Job search results">${cards.map((n) => card(n)).join('')}</div><h2>Similar Jobs</h2>${similar.map((n) => card(n, 'Senior Full Stack Engineer')).join('')}${push(
    {
      jobList: {
        data: jobs.map((n) => job(n)),
        meta: {currentPage, pageSize: 30, pageCount, totalResults, sortBy: 'relevance'},
      },
      totalPages: pageCount,
    },
  )}</body></html>`;
const detail = (posting = true) =>
  `<html><head><title>Back End Engineer - Motion Recruitment Partners, LLC - New York, NY, US | Dice.com</title>${
    posting
      ? `<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'JobPosting',
          title: 'Back End Engineer',
          description: '<p>An investment platform is looking for a Back End Engineer. </p>'.repeat(
            4,
          ),
          hiringOrganization: {'@type': 'Organization', name: 'Motion Recruitment Partners, LLC'},
          jobLocation: {
            '@type': 'Place',
            address: {addressLocality: 'New York', addressRegion: 'NY', addressCountry: 'US'},
          },
          employmentType: 'FULL_TIME',
          datePosted: '2026-08-12T00:04:16Z',
          validThrough: '2099-01-01',
        })}</script>`
      : ''
  }</head><body><h1>Back End Engineer</h1><p>Motion Recruitment Partners, LLC</p></body></html>`;

test('searches and postings use the reader; other Dice pages and look-alike hosts do not', () => {
  assert.deepEqual(diceRequest(search), {kind: 'search', number: 1, url: search});
  assert.equal(diceRequest(`${search}&page=3`).number, 3);
  assert.deepEqual(diceRequest(`${listing(1)}?searchlink=x`), {kind: 'detail', url: listing(1)});
  for (const other of [
    'https://www.dice.com/',
    'https://www.dice.com/company-profile/5b6108e0',
    'https://www.dice.com/job-detail/not-a-guid',
    `${search}&page=0`,
    'http://www.dice.com/jobs?q=x',
    'https://www.dice.com.evil.test/jobs?q=x',
  ])
    assert.equal(diceRequest(other), null, other);
  assert.ok(dice.matches('https://dice.com/jobs'));
  assert.ok(!dice.matches('https://notdice.com/jobs'));
  assert.ok(dice.http.handles(search));
});

test('a results page lists the state results with the site paging, not the similar jobs', () => {
  const html = page();
  assert.equal(diceState(html).total, 416);
  assert.deepEqual(
    diceCards(html).map((c) => c.guid),
    [guid(1), guid(2)],
  );
  const read = diceSearchPage(search, 1, html);
  assert.deepEqual(
    read.links.map((l) => [l.url, l.listing]),
    [
      [listing(1), true],
      [listing(2), true],
    ],
  );
  assert.ok(!read.text.includes(guid(9)), 'similar jobs are not results');
  assert.match(read.text, /page 1 of 14 \(416 results\)/);
  assert.match(
    read.text,
    /Motion Recruitment Partners, LLC · New York, New York, USA · On-Site · Full-time · \$120000 - \$160000 · posted 2026-08-12/,
  );
  assert.deepEqual(
    read.pagination.map((p) => [p.text, p.url, p.current]),
    [
      ['1 of 14', search, true],
      ['2', 'https://www.dice.com/jobs?q=backend+engineer&location=New+York&page=2', false],
    ],
  );
  const last = diceSearchPage(`${search}&page=14`, 14, page({currentPage: 14}));
  assert.deepEqual(
    last.pagination.map((p) => p.text),
    ['14 of 14'],
  );
  const empty = diceSearchPage(search, 1, page({jobs: [], pageCount: 0, totalResults: 0}));
  assert.equal(empty.links.length, 0);
  assert.match(empty.text, /no further results/);
});

test('a stale or missing state gives the cards alone without page numbers', () => {
  for (const html of [
    page({currentPage: 2}),
    page({jobs: [1, 3], cards: [1, 2]}),
    page().replace(/<script>self\.__next_f[\s\S]*?<\/script>/g, ''),
  ]) {
    const parsed = parseDiceSearch(html, 1);
    assert.equal(parsed.pages, null);
    assert.deepEqual(
      parsed.jobs.map((j) => j.url),
      [listing(1), listing(2)],
    );
    assert.deepEqual(
      diceSearchPage(search, 1, html).pagination.map((p) => p.text),
      ['1'],
    );
  }
  assert.deepEqual(diceCards('<html><body>Loading</body></html>'), []);
});

test('a posting reads through its JobPosting; a removed or plain page does not', () => {
  const read = diceDetailPage(listing(1), detail());
  assert.equal(read.url, listing(1));
  assert.equal(read.listing.fields.company, 'Motion Recruitment Partners, LLC');
  assert.match(read.text, /investment platform/);
  assert.equal(diceDetailPage(listing(1), detail(false)).listing, undefined);
  const gone = diceDetailPage(
    listing(1),
    '<html><head><title>Job Not Found | Dice.com</title></head><body></body></html>',
  );
  assert.equal(gone.listing, undefined);
  assert.match(gone.text, /not found/);
});

test('reads use the shared site access rules and the caller signal', async () => {
  const requested = [];
  const siteAccess = {
    begin: () => 'token',
    pace: () => 0,
    complete: (_url, _token, info) =>
      info.reason ? {site: 'dice.com', reason: info.reason, retryAt: 1, waiting: true} : null,
  };
  const controller = new AbortController();
  const fetch = async (url, options) => {
    requested.push(url);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(url.includes('/jobs?') ? page() : detail());
  };
  assert.equal(
    (await readDice(search, {fetch, siteAccess, signal: controller.signal})).links.length,
    2,
  );
  assert.ok((await readDice(`${listing(1)}?searchlink=x`, {fetch, siteAccess})).listing);
  assert.deepEqual(requested, [search, listing(1)]);
  const error = await readDice(search, {
    fetch: async () => new Response('', {status: 403}),
    siteAccess,
  }).catch((e) => e);
  assert.ok(error instanceof SiteWaitError);
  const gone = await readDice(listing(2), {fetch: async () => new Response('', {status: 404})});
  assert.match(gone.text, /not found/);
  await assert.rejects(readDice('https://www.dice.com/'), /does not handle/);
});
