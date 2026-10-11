import test from 'node:test';
import assert from 'node:assert/strict';
import {
  xingRequest,
  xingState,
  parseXingSearch,
  xingSearchPage,
  xingDetailPage,
  readXing,
  XING_PAGE_SIZE,
} from '../app/site-extensions/xing.mjs';
import {siteReaderFor, siteExtensionKind} from '../app/site-extensions/index.mjs';
import {withSearchFilters, searchFilterLabels} from '../app/site-extensions/search.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev/results.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';

const search = 'https://www.xing.com/jobs/search?keywords=compliance&location=Berlin';
const job = (id, title, company = 'Acme & Co') => ({
  id,
  title,
  company,
  url: `https://www.xing.com/jobs/berlin-role-${id}`,
});
// The Apollo cache the page embeds: the result list in order, the visible
// jobs by reference, the bounded total and the page arguments in the key.
const state = (jobs, {total = 113, limit = XING_PAGE_SIZE, offset = 0} = {}) => {
  const key = `jobSearchByQuery({"consumer":"loggedout.web.jobs.conv_search_results.center","limit":${limit},"offset":${offset},"query":{"keywords":"compliance"}})`;
  const cache = {
    ROOT_QUERY: {
      __typename: 'Query',
      [key]: {
        __typename: 'JobSearchResult',
        total: -1,
        collection: jobs.map((j, position) => ({
          __typename: 'JobItemResult',
          position,
          jobDetail: {__ref: `VisibleJob:${j.id}.ab`},
        })),
        boundedTotal: {__typename: 'BoundedTotal', total, bound: 1000},
      },
    },
  };
  for (const j of jobs)
    cache[`VisibleJob:${j.id}.ab`] = {
      __typename: 'VisibleJob',
      id: `${j.id}.ab`,
      url: j.url,
      title: j.title,
      refreshedAt: '2026-09-25T16:30:26Z',
      location: {city: 'Berlin'},
      locations: [{city: 'Berlin'}, {city: 'Aschaffenburg'}, {city: 'Berlin'}],
      employmentType: {localizationValue: 'Vollzeit'},
      companyInfo: {companyNameOverride: j.company, company: null},
      salary: {currency: 'EUR', minimum: 60000, maximum: 90000},
    };
  return cache;
};
const card = (j) =>
  `<li><article data-testid="job-search-result" aria-label="${j.title}. Klicke zum Öffnen"><a href="${new URL(j.url).pathname}" tabindex="0" aria-label="${j.title}" target="_blank" class="card-link"></a><h2 data-testid="job-teaser-list-title">${j.title}</h2></article></li>`;
// window.crate is not JSON (undefined values), only APOLLO_STATE inside it is.
const page = (jobs, options, {withState = true} = {}) =>
  `<html><head><script id="runtime-config">window.crate={"assetsBaseUrl":"https:\\u002F\\u002Fstatic.xingcdn.com","activeThemeCookie":undefined,"serverData":{${
    withState
      ? `"APOLLO_STATE":${JSON.stringify(state(jobs, options)).replace(/\//g, '\\u002F')},`
      : ''
  }"other":{"brace":"}"}},"isWebview":false}</script></head><body><ul>${jobs
    .map(card)
    .join('')}</ul><a href="/jobs/directory/a">Directory</a></body></html>`;
const posting = (overrides = {}) =>
  JSON.stringify({
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: 'Security Specialist – Compliance (m/w/d)',
    description:
      '\n null\n <p>Der Konzern entwickelt Softwareprodukte zur Optimierung des Energieflusses.</p><ul><li>Schwachstellenanalysen durchführen und bewerten</li><li>Regulatorische Anforderungen umsetzen und dokumentieren</li></ul><p>Wir bieten flexible Arbeitszeiten, Weiterbildung und ein hybrides Modell.</p>',
    hiringOrganization: {'@type': 'Organization', name: 'PSI Software SE'},
    jobLocation: [{'@type': 'Place', address: {addressLocality: 'Berlin', addressCountry: 'DE'}}],
    employmentType: 'FULL_TIME',
    datePosted: '2026-09-10T16:30:26Z',
    validThrough: '2099-11-09T16:31:26Z',
    ...overrides,
  });
const detail = (overrides) =>
  `<html><head><title>Security Specialist – Compliance (m/w/d) - Berlin | XING Jobs</title><script data-ch type="application/ld+json">${posting(overrides)}</script></head><body><nav>Jobs Netzwerk</nav><h1 class="hero">Security Specialist – Compliance (m/w/d)</h1><div>Body text</div></body></html>`;

test('only Xing job searches and postings use the reader', () => {
  assert.equal(xingRequest(search).kind, 'search');
  assert.equal(
    xingRequest('https://www.xing.com/jobs/search/ki?keywords=compliance&page=2').kind,
    'search',
    'the address Xing redirects a search to',
  );
  assert.deepEqual(
    xingRequest('https://www.xing.com/jobs/berlin-legal-compliance-manager-156429599'),
    {
      kind: 'detail',
      id: '156429599',
      url: 'https://www.xing.com/jobs/berlin-legal-compliance-manager-156429599',
    },
  );
  for (const other of [
    'https://www.xing.com/jobs/directory/a',
    'https://www.xing.com/jobs/',
    'https://www.xing.com/recruiting/jobs/create',
    'http://www.xing.com/jobs/berlin-legal-compliance-manager-156429599',
    'https://xing.com.evil.test/jobs/berlin-role-156429599',
    'not a url',
  ])
    assert.equal(xingRequest(other), null, other);
  assert.equal(typeof siteReaderFor(search).read, 'function');
  assert.equal(siteReaderFor('https://www.xing.com/jobs/directory/a'), null);
});

test('the result list comes from the embedded state in order, with the page facts', () => {
  const jobs = [job('156429599', 'Legal "&" Compliance {Manager}'), job('157674525', 'Risk Lead')];
  const parsed = parseXingSearch(page(jobs));
  assert.equal(parsed.total, 113);
  assert.deepEqual(
    parsed.jobs.map((j) => [j.url, j.title, j.company, j.locations, j.salary, j.refreshedAt]),
    jobs.map((j) => [
      j.url,
      j.title,
      'Acme & Co',
      ['Berlin', 'Aschaffenburg'],
      '60000–90000 EUR',
      '2026-09-25',
    ]),
  );
  assert.equal(xingState('<html>no state</html>'), null);
  const read = xingSearchPage(search, parsed);
  assert.deepEqual(
    read.links,
    jobs.map((j) => ({text: j.title, url: j.url, listing: true})),
  );
  assert.match(read.text, /page 1 of 6/);
  assert.match(
    read.text,
    /Acme & Co · Berlin, Aschaffenburg · Vollzeit · 60000–90000 EUR · refreshed 2026-09-25/,
  );
  const position = resultPageSummary(read, {id: 'e1'}, []).position,
    next = observedNextPage(read, position);
  assert.equal(position.currentPage, 1);
  assert.equal(new URL(next.url).searchParams.get('page'), '2');
  assert.equal(new URL(next.url).searchParams.get('keywords'), 'compliance', 'filters stay');
});

test('the last page links no next page; without a total a full page does, a short one does not', () => {
  const last = xingSearchPage(
    `${search}&page=6`,
    parseXingSearch(page([job('1', 'A')], {total: 113, offset: 100})),
  );
  assert.deepEqual(
    last.pagination.map((p) => p.text),
    ['6 of 6'],
  );
  const many = Array.from({length: XING_PAGE_SIZE}, (_, i) =>
    job(String(1000000 + i), `Role ${i}`),
  );
  const full = xingSearchPage(search, parseXingSearch(page(many, {}, {withState: false})));
  assert.equal(full.links.length, XING_PAGE_SIZE, 'rendered cards stand in for a missing state');
  assert.deepEqual(
    full.pagination.map((p) => p.text),
    ['1', '2'],
  );
  const short = xingSearchPage(
    `${search}&page=2`,
    parseXingSearch(page(many.slice(0, 3), {}, {withState: false})),
  );
  assert.deepEqual(
    short.pagination.map((p) => p.text),
    ['2'],
  );
  const duplicate = xingSearchPage(search, parseXingSearch(page([job('1', 'A'), job('1', 'A')])));
  assert.equal(duplicate.links.length, 1, 'a posting listed twice is one listing');
  const empty = xingSearchPage(`${search}&page=6`, parseXingSearch(page([], {offset: 100})));
  assert.deepEqual(empty.links, []);
  assert.match(empty.text, /no further results/);
  assert.equal(empty.pagination.length, 1, 'the page still reports its position');
});

test('a posting reads through its JobPosting; an expired or missing posting does not', () => {
  const url = 'https://www.xing.com/jobs/berlin-security-specialist-157803733';
  const read = xingDetailPage(url, detail());
  assert.equal(read.url, url);
  assert.equal(read.browser, 'Xing reader');
  assert.equal(read.title, 'Security Specialist – Compliance (m/w/d) @ PSI Software SE');
  assert.deepEqual(read.listing.fields, {
    company: 'PSI Software SE',
    location: 'Berlin, DE',
    employmentType: 'FULL_TIME',
    postedAt: '2026-09-10T16:30:26Z',
    validThrough: '2099-11-09T16:31:26Z',
  });
  assert.match(read.text, /• Schwachstellenanalysen durchführen/);
  assert.doesNotMatch(read.text, /Jobs Netzwerk/, 'no site chrome');
  const expired = xingDetailPage(url, detail({validThrough: '2020-01-01'}));
  assert.equal(expired.listing, undefined);
  assert.match(expired.text, /Body text/, 'the visible page text remains');
  assert.doesNotMatch(expired.text, /JobPosting/, 'scripts are not text');
  const removed = xingDetailPage(url, '');
  assert.match(removed.text, /not found/);
  assert.equal(removed.listing, undefined);
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
        ? {site: 'xing.com', reason: info.reason, retryAt: 1, waiting: true}
        : null;
    },
  };
  const fetch = async (url, options) => {
    requested.push(url);
    assert.match(options.headers['User-Agent'], /AutoJev/);
    return new Response(url.includes('/jobs/search') ? page([job('1', 'A')]) : detail(), {
      status: 200,
    });
  };
  const results = await readXing(search, {fetch, siteAccess});
  assert.equal(results.links.length, 1);
  assert.equal(requested[0], search);
  const postingUrl = 'https://www.xing.com/jobs/berlin-security-specialist-157803733';
  const read = await readXing(postingUrl, {fetch, siteAccess});
  assert.ok(read.listing);
  assert.deepEqual(events.at(-1), ['complete', postingUrl, 'token', {status: 200}]);
  for (const status of [403, 429]) {
    const error = await readXing(search, {
      fetch: async () => new Response('', {status}),
      siteAccess,
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError);
    assert.equal(error.wait.reason, 'rate_limit');
    assert.equal(error.url, search);
  }
  let sent = false;
  await assert.rejects(
    readXing(search, {
      fetch: async () => {
        sent = true;
        return new Response('');
      },
      siteAccess: {
        begin: () => {
          throw new SiteWaitError({site: 'xing.com', message: 'wait'});
        },
        pace: () => 0,
        complete: () => null,
      },
    }),
    (e) => e.code === 'SITE_WAIT',
  );
  assert.equal(sent, false, 'an active site wait stops the request before it is sent');
  const gone = await readXing(postingUrl, {fetch: async () => new Response('', {status: 404})});
  assert.match(gone.text, /not found/);
  await assert.rejects(
    readXing(search, {fetch: async () => new Response('', {status: 500})}),
    /HTTP 500/,
  );
  await assert.rejects(readXing('https://www.xing.com/jobs/directory/a'), /does not handle/);
});

test('the publication date filter is the only search filter and keeps the placeholders', () => {
  const search = siteExtensionKind('https://www.xing.com/jobs/', 'job-search').search;
  assert.equal(search.ordering, undefined, 'relevance order is not newest first');
  const template = withSearchFilters(search.template, {sincePeriod: 'LAST_WEEK'});
  assert.equal(
    template,
    'https://www.xing.com/jobs/search?keywords={query}&location={location}&sincePeriod=LAST_WEEK',
  );
  assert.deepEqual(searchFilterLabels(search, template), ['Posted: Last week']);
  assert.equal(
    xingRequest(template.replace('{query}', 'x').replace('{location}', 'y')).kind,
    'search',
  );
});
