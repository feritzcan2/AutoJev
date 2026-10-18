import test from 'node:test';
import assert from 'node:assert/strict';
import werkNl, {
  werkNlRequest,
  werkNlSearchBody,
  parseWerkNlSearch,
  werkNlSearchPage,
  werkNlDetailPage,
  readWerkNl,
  isWerkNlUrl,
} from '../app/site-extensions/werk-nl.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev/results.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';
import {withSearchFilters} from '../app/site-extensions/search.mjs';

const API = 'https://www.werk.nl/werkzoekenden/mijn-werkmap/kia/publiek/zoekenvacatures/api';
const search = `${API}/search?keywords=developer&sort=newest`;
const vacancy = (ref) => `https://www.werk.nl/nl/vacatures/${ref}`;
// Trimmed from a real search response (2026-10-16).
const item = (ref, title, extra = {}) => ({
  key: `2001:L:${ref}`,
  referenceNumber: ref,
  score: 100,
  resultDepth: 0,
  profession: 'Developer',
  vacatureTitle: title,
  modified: '2026-10-16 00:00:00',
  organisation: 'MKG Nederland',
  workLocationCity: 'HENGELO OV',
  workLocationType: 'Vaste werklocatie',
  workLocationForeignCountry: null,
  workLocationForeignCity: null,
  minHours: 32,
  maxHours: 40,
  contractType: 'Tijdelijk',
  studyLevel: 'HBO/bachelor',
  ...extra,
});
const results = (items, totalResults = 672) => ({
  items,
  facets: [],
  totalResults,
  sortOptions: {standard: [1], special: [2]},
  template: 'DescriptionMatchInCategory',
});
const body =
  'As a Cross Model Analytics Model Developer, you will coordinate the model development environment. ';
// Trimmed from GET .../api/vacature/71804751 (2026-10-16).
const detail = (overrides = {}) => ({
  referenceNumber: 71804751,
  title: 'Cross Model Analytics Model Developer',
  expirationDate: '2099-11-15T00:00:00',
  modifiedDate: '2026-10-16T00:00:00',
  createdDate: '2026-10-16T00:00:00',
  proposition: {
    termsOfEmploymentDescription: 'A pension scheme and 27 days of leave.',
    workLocation: {type: 1, countryCode: null, postcode: '1102CT', city: 'AMSTERDAM'},
    function: {name: 'Data scientist', description: `${body.repeat(3)}\nHow to succ...`},
    salary: {type: 1, amountIndication: '6131'},
    contract: {type: 3, startDate: '2026-10-05T00:00:00', endDate: null},
    soortTypes: [],
    workhours: {minimumHours: 32, maximumHours: 40, werktijden: 1},
  },
  description: 'Continued: what you bring.',
  cvOffer: {educationLevel: {name: 'Hbo/bachelor'}},
  applicationMethods: [
    {
      sollicitatieWijze: 4,
      urlApplicationForm: 'https://careers.ing.com/post/3121?utm_source=careerguide',
    },
    {sollicitatieWijze: 2, urlApplicationForm: ''},
  ],
  employer: {organizationName: 'ING'},
  ...overrides,
});

// The site's sign-on and API as observed: three redirects that set the
// session cookies, then the API; the search needs the XSRF-TOKEN echoed.
function site({
  search: answer = () => ok(results([item(1, 'One')])),
  vacature = () => ok(detail()),
} = {}) {
  const requests = [];
  const reply = (status, data, headers = []) =>
    new Response(data === undefined ? null : JSON.stringify(data), {
      status,
      headers: [['content-type', 'application/json; charset=utf-8'], ...headers],
    });
  const redirect = (location, cookies) =>
    new Response(null, {
      status: 302,
      headers: [['location', location], ...cookies.map((c) => ['set-cookie', c])],
    });
  const fetch = async (target, init) => {
    const url = new URL(target),
      cookie = init.headers?.Cookie ?? '';
    requests.push({
      url: target,
      method: init.method,
      cookie,
      redirect: init.redirect,
      signal: init.signal,
      headers: init.headers,
    });
    if (url.hostname === 'login.werk.nl')
      return redirect(
        `https://www.werk.nl/obrar.cgi?encreply=${encodeURIComponent(url.searchParams.get('back'))}`,
        ['OAM_ID=abc; httponly; secure; path=/'],
      );
    if (url.pathname === '/obrar.cgi') {
      assert.match(
        cookie,
        /OAMRequestContext=ctx/,
        'the sign-on needs the cookie of its first hop',
      );
      return redirect(url.searchParams.get('encreply'), [
        'OAMRequestContext=;expires=thursday, 01-jan-1970 01:00:00 gmt; httponly; secure; path=/',
        'OAMAuthnCookie=session; httponly; secure; path=/',
      ]);
    }
    if (!/OAMAuthnCookie=session/.test(cookie))
      return redirect(
        `https://login.werk.nl:443/oam/server/obrareq.cgi?back=${encodeURIComponent(url.pathname)}`,
        [
          'OAMAuthnHintCookie=0@1; httponly; secure; path=/; domain=.www.werk.nl',
          'OAMRequestContext=ctx;max-age=300; httponly; secure; path=/',
        ],
      );
    assert.doesNotMatch(cookie, /OAMRequestContext/, 'an expired cookie is not sent again');
    if (url.pathname.endsWith('/search/totals'))
      return reply(200, {anonymous: 261000}, [
        ['set-cookie', 'XSRF-TOKEN=tok123; path=/; secure; samesite=strict'],
      ]);
    if (url.pathname.endsWith('/search')) {
      if (init.method !== 'POST') return reply(405);
      if (init.headers['X-XSRF-TOKEN'] !== 'tok123' || !/XSRF-TOKEN=tok123/.test(cookie))
        return reply(400);
      return answer(JSON.parse(init.body));
    }
    const ref = url.pathname.match(/\/vacature\/(\d+)$/)?.[1];
    if (ref) return vacature(ref);
    return reply(404);
  };
  return {fetch, requests};
}
const ok = (data) =>
  new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});

test('the reader handles the search address and vacancy pages, not look-alike hosts', () => {
  assert.equal(werkNlRequest(search).kind, 'search');
  assert.deepEqual(werkNlRequest('https://werk.nl/nl/vacatures/71804751/'), {
    kind: 'detail',
    ref: '71804751',
    url: vacancy(71804751),
  });
  for (const other of [
    'https://www.werk.nl/',
    'https://www.werk.nl/nl/vacatures',
    'https://www.werk.nl/nl/vacatures/71804751/reageer-per-email',
    `${API}/vacature/71804751`,
    'http://www.werk.nl/nl/vacatures/71804751',
    'https://www.werk.nl.evil.test/nl/vacatures/71804751',
    'https://evilwerk.nl/nl/vacatures/71804751',
    'https://login.werk.nl/nl/vacatures/71804751',
    'not a url',
  ])
    assert.equal(werkNlRequest(other), null, other);
  assert.equal(isWerkNlUrl('https://www.werk.nl.evil.test/'), false);
  assert.equal(werkNl.matches('https://www.werk.nl/'), true);
  assert.equal(werkNl.http.handles(search), true);
  assert.equal(werkNl.search.ordering, 'newest_first');
});

test('the address becomes the body the site search posts; bad parameters are refused', () => {
  const address = withSearchFilters(
    `${API}/search?keywords=java%20developer&location=Utrecht&distance=25&sort=newest&page=3`,
    {JOB_CONTRACT_TYPE: '1'},
  );
  assert.deepEqual(werkNlSearchBody(address), {
    facets: [{propertyCode: 'JOB_CONTRACT_TYPE', value: '1'}],
    keywords: 'java developer',
    location: 'Utrecht',
    distanceFilter: {distance: 25, alternatingLocation: false},
    currentPage: 3,
    sort: {by: 1, direction: 1},
    includeFirstExpansion: false,
    includeSecondExpansion: false,
  });
  assert.equal(
    werkNlSearchBody(`${API}/search?keywords=x&location=&distance=25`).distanceFilter,
    undefined,
  );
  for (const [address, message] of [
    [`${API}/search?q=x`, /does not know the parameter "q"/],
    [`${API}/search?keywords=x&page=0`, /page number/],
    [`${API}/search?keywords=x&sort=relevance`, /newest first only/],
    [`${API}/search?keywords=x&location=Utrecht&distance=7`, /distance must be one of/],
    [`${API}/search?keywords=x&location=Utrecht`, /needs a distance/],
  ])
    assert.throws(() => werkNlSearchBody(address), message);
});

test('a results page lists its vacancies with the paging the stated total gives', () => {
  const read = werkNlSearchPage(
    search,
    parseWerkNlSearch(
      results(
        [
          item(71803384, 'Stack Web Developer'),
          item(71804751, 'Model Developer', {organisation: 'ING', minHours: 0, maxHours: 0}),
        ],
        672,
      ),
      1,
    ),
  );
  assert.deepEqual(
    read.links.map((l) => [l.url, l.listing]),
    [
      [vacancy(71803384), true],
      [vacancy(71804751), true],
    ],
  );
  assert.match(read.text, /page 1 of 34 \(672 results\)/);
  assert.match(
    read.text,
    /Link: Stack Web Developer — https:\/\/www\.werk\.nl\/nl\/vacatures\/71803384/,
  );
  assert.match(
    read.text,
    /MKG Nederland · HENGELO OV · Tijdelijk · 32–40 hours per week · updated 2026-10-16/,
  );
  assert.match(read.text, /ING · HENGELO OV · Tijdelijk · updated/, 'hours of 0 are not stated');
  const position = resultPageSummary(read, {id: 'e1'}, []).position;
  assert.equal(position.currentPage, 1);
  assert.equal(observedNextPage(read, position).url, `${search}&page=2`);

  const last = werkNlSearchPage(
    `${search}&page=34`,
    parseWerkNlSearch(results([item(1, 'A')], 672), 34),
  );
  assert.deepEqual(
    last.pagination.map((p) => p.text),
    ['34 of 34'],
  );
  const past = werkNlSearchPage(`${search}&page=35`, parseWerkNlSearch(results([], 672), 35));
  assert.deepEqual(past.links, []);
  assert.match(past.text, /no further results/);
  assert.equal(past.pagination.length, 1);
  const none = werkNlSearchPage(search, parseWerkNlSearch(results([], 0), 1));
  assert.match(none.text, /no further results/);
});

test('a malformed or incomplete search response is an error, not an empty result', () => {
  for (const data of [
    null,
    {},
    {items: []},
    {items: {}, totalResults: 3},
    {items: [], totalResults: -1},
  ])
    assert.throws(() => parseWerkNlSearch(data, 1), /malformed/);
  assert.throws(
    () => parseWerkNlSearch(results([{vacatureTitle: 'No ref'}]), 1),
    /reference number/,
  );
  assert.throws(
    () => werkNlSearchPage(search, parseWerkNlSearch(results([], 672), 2)),
    /no vacancies on page 2 of 34; the results are incomplete/,
  );
});

test('a vacancy reads its description sections and only the stated facts', () => {
  const read = werkNlDetailPage(vacancy(71804751), detail(), '71804751');
  assert.equal(read.title, 'Cross Model Analytics Model Developer');
  assert.deepEqual(read.listing.fields, {
    company: 'ING',
    location: 'AMSTERDAM',
    employmentType: 'Temporary',
    hours: '32–40 hours per week',
    workingTime: 'Office hours',
    salary: '€6,131 gross per month (indication)',
    education: 'Hbo/bachelor',
    deadline: '2099-11-15',
    postedAt: '2026-10-16',
    applyUrl: 'https://careers.ing.com/post/3121?utm_source=careerguide',
    applyBy: 'online, by phone',
  });
  assert.match(read.text, /How to succ\.\.\.\n\nContinued: what you bring\.\n\nA pension scheme/);
  assert.match(read.text, /shows this description shortened/);
  const sparse = werkNlDetailPage(
    vacancy(71804751),
    detail({
      proposition: {
        function: {description: body},
        workLocation: {type: 3, city: null},
        workhours: {minimumHours: 0, maximumHours: 0},
        salary: {type: 1, amountIndication: null},
        contract: {type: 9},
      },
      description: null,
      cvOffer: null,
      applicationMethods: [],
      employer: null,
      expirationDate: '2020-01-01T00:00:00',
      modifiedDate: '2026-10-17T00:00:00',
    }),
    '71804751',
  );
  assert.deepEqual(sparse.listing.fields, {
    location: 'Varying locations across the Netherlands',
    deadline: '2020-01-01',
    postedAt: '2026-10-16',
    updatedAt: '2026-10-17',
  });
  assert.match(sparse.text, /deadline \(2020-01-01\) has passed/);
  assert.doesNotMatch(sparse.text, /shortened/);
  const empty = werkNlDetailPage(
    vacancy(1),
    detail({referenceNumber: 1, proposition: {}, description: null}),
    '1',
  );
  assert.equal(empty.listing, undefined, 'without a description it is an ordinary page');
  const removed = werkNlDetailPage(vacancy(1), null, '1');
  assert.match(removed.text, /not found/);
  assert.equal(removed.listing, undefined);
  assert.throws(() => werkNlDetailPage(vacancy(2), detail(), '2'), /another vacancy/);
});

test('a search read signs on with its own cookie jar, then posts the search with the token', async () => {
  const {fetch, requests} = site({
    search: (sent) => {
      assert.equal(sent.keywords, 'developer');
      assert.equal(sent.currentPage, 2);
      return ok(results([item(71803384, 'Stack Web Developer')], 672));
    },
  });
  const controller = new AbortController();
  const read = await readWerkNl(`${search}&page=2`, {fetch, signal: controller.signal});
  assert.equal(read.links[0].url, vacancy(71803384));
  assert.equal(read.pagination[1].url, `${search}&page=3`);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${new URL(r.url).hostname}${new URL(r.url).pathname}`),
    [
      `GET www.werk.nl${new URL(API).pathname}/search/totals`,
      'GET login.werk.nl/oam/server/obrareq.cgi',
      'GET www.werk.nl/obrar.cgi',
      `GET www.werk.nl${new URL(API).pathname}/search/totals`,
      `POST www.werk.nl${new URL(API).pathname}/search`,
    ],
    'five requests: three sign-on redirects, the totals call and the search',
  );
  assert.ok(requests.every((r) => r.redirect === 'manual'));
  assert.ok(requests.every((r) => r.signal instanceof AbortSignal));
  controller.abort();
  assert.ok(
    requests.every((r) => r.signal.aborted),
    'every request carries the caller signal',
  );
  assert.match(requests[2].cookie, /OAMRequestContext=ctx/);
  assert.doesNotMatch(requests[2].cookie, /OAM_ID/, 'a login.werk.nl cookie stays on that host');

  // A second read starts a new session: no state is kept between reads.
  const again = site();
  await readWerkNl(search, {fetch: again.fetch});
  assert.equal(again.requests[0].cookie, '');
});

test('a vacancy read signs on and reads the vacancy in four requests; a removed one has no listing', async () => {
  const {fetch, requests} = site();
  const read = await readWerkNl(vacancy(71804751), {fetch});
  assert.ok(read.listing);
  assert.equal(read.url, vacancy(71804751));
  assert.equal(requests.length, 4);
  assert.match(requests.at(-1).url, /\/api\/vacature\/71804751$/);
  const gone = site({
    vacature: () =>
      new Response('{"status":404}', {status: 404, headers: {'content-type': 'application/json'}}),
  });
  const missing = await readWerkNl(vacancy(1), {fetch: gone.fetch});
  assert.match(missing.text, /not found/);
  assert.equal(missing.listing, undefined);
  const html = site({
    vacature: () => new Response('<html></html>', {headers: {'content-type': 'text/html'}}),
  });
  await assert.rejects(readWerkNl(vacancy(71804751), {fetch: html.fetch}), /other than JSON/);
});

test('failures are explicit: blocks start the site wait, a refused or endless sign-on is an error', async () => {
  const siteAccess = {
    begin: () => 'token',
    pace: () => 0,
    complete: (_url, _token, info) =>
      info.reason ? {site: 'www.werk.nl', reason: info.reason, retryAt: 1, waiting: true} : null,
  };
  const blocked = await readWerkNl(search, {
    fetch: async () => new Response('', {status: 429}),
    siteAccess,
  }).catch((e) => e);
  assert.ok(blocked instanceof SiteWaitError);
  const blockedDetail = await readWerkNl(vacancy(1), {
    fetch: async () => new Response('', {status: 403}),
    siteAccess,
  }).catch((e) => e);
  assert.ok(blockedDetail instanceof SiteWaitError);

  const loop = async (target) =>
    new Response(null, {
      status: 302,
      headers: {
        location:
          new URL(target).hostname === 'login.werk.nl'
            ? `${API}/search/totals`
            : 'https://login.werk.nl/oam',
      },
    });
  await assert.rejects(readWerkNl(search, {fetch: loop}), /did not finish within 6 redirects/);
  const away = async () =>
    new Response(null, {status: 302, headers: {location: 'https://evil.test/'}});
  await assert.rejects(readWerkNl(vacancy(1), {fetch: away}), /outside werk\.nl/);
  const noToken = async () => ok({anonymous: 1});
  await assert.rejects(readWerkNl(search, {fetch: noToken}), /no XSRF token/);

  const unknownPlace = site({
    search: () =>
      new Response('{"InvalidLocation":["Location does not match any known location."]}', {
        status: 400,
        headers: {'content-type': 'application/json'},
      }),
  });
  await assert.rejects(
    readWerkNl(`${API}/search?keywords=x&location=Atlantis&distance=10`, {
      fetch: unknownPlace.fetch,
    }),
    /refused this search: .*does not match any known location/,
  );
  const garbled = site({
    search: () => new Response('{"items":', {headers: {'content-type': 'application/json'}}),
  });
  await assert.rejects(readWerkNl(search, {fetch: garbled.fetch}), /not valid JSON/);
  await assert.rejects(readWerkNl('https://www.werk.nl/'), /does not handle/);
  await assert.rejects(readWerkNl(`${API}/search?q=x`), /does not know the parameter/);
});
