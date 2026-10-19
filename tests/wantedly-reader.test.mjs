import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import wantedly, {
  wantedlyRequest,
  parseWantedlyState,
  parseWantedlyCards,
  wantedlySearchPage,
  parseWantedlyListing,
  wantedlyDetailPage,
  readWantedly,
} from '../app/site-extensions/wantedly.mjs';
import {withSearchFilters, searchFilterLabels} from '../app/site-extensions/search.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev/results.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';

// Trimmed from real captures of 2026-10-16: page 2 of an "engineer" search
// (state with the page's offset search and the small-screen list that starts
// at page 1, two rendered cards) and one open listing.
const fixture = (name) =>
  readFileSync(new URL(`./fixtures/wantedly/${name}`, import.meta.url), 'utf8');
const SEARCH = fixture('search-page2.html');
const LISTING = fixture('listing.html');
const search = (page = 2, keywords = 'engineer') =>
  `https://www.wantedly.com/projects?new=true&keywords=${keywords}&order=recent&page=${page}`;
const listingUrl = 'https://www.wantedly.com/projects/2599350';
const NEXT = /(<script id="__NEXT_DATA__" type="application\/json">)([\s\S]*?)(<\/script>)/;
// The fixture with its embedded state changed by edit(cache).
const editState = (html, edit) =>
  html.replace(NEXT, (_, open, json, close) => {
    const data = JSON.parse(json);
    edit(data.props.pageProps.__apollo.graphqlGatewayInitialState);
    return open + JSON.stringify(data) + close;
  });
const offset = (cache) => {
  const index = cache.ROOT_QUERY.projectIndexPageJobPostIndex;
  const key = Object.keys(index).find((k) => k.startsWith('searchedJobPostsUsingOffset('));
  return {index, key, result: index[key]};
};
// Moves the offset search to another page number and total.
const atPage = (html, page, total, posts) =>
  editState(html, (cache) => {
    const {index, key, result} = offset(cache);
    delete index[key];
    index[key.replace('"pageNumber":2', `"pageNumber":${page}`)] = {
      ...result,
      totalCount: total,
      jobPosts: posts ?? result.jobPosts,
    };
  });

test('only Wantedly searches and listings use the reader', () => {
  assert.deepEqual(wantedlyRequest(search()), {kind: 'search', number: 2, url: search()});
  assert.equal(wantedlyRequest('https://www.wantedly.com/projects').number, 1);
  assert.deepEqual(wantedlyRequest('https://wantedly.com/projects/2599350?featured=0'), {
    kind: 'detail',
    id: '2599350',
    url: listingUrl,
  });
  for (const other of [
    'https://www.wantedly.com/companies/everforth',
    'https://www.wantedly.com/en/projects/2599350',
    'https://www.wantedly.com/projects/2599350/staffings',
    'https://www.wantedly.com/projects?page=0',
    'http://www.wantedly.com/projects/2599350',
    'https://www.wantedly.com.evil.test/projects/2599350',
    'https://evilwantedly.com/projects/2599350',
    'not a url',
  ])
    assert.equal(wantedlyRequest(other), null, other);
  assert.equal(wantedly.matches('https://www.wantedly.com/'), true);
  assert.equal(wantedly.matches('https://wantedly.com.evil.test/'), false);
  assert.equal(wantedly.http.handles(listingUrl), true);
  assert.equal(wantedly.http.handles('https://www.wantedly.com/companies/everforth'), false);
});

test('a results page lists the state offset search in order, with the page position and next page', () => {
  const parsed = parseWantedlyState(SEARCH, search());
  assert.equal(parsed.total, 3989);
  assert.equal(parsed.pageSize, 10);
  assert.deepEqual(
    parsed.jobs.map((j) => [j.id, j.company, j.hiringTypes, j.postedAt]),
    [
      ['2599350', '株式会社 Panta Rhei', ['Internship'], '2026-10-15'],
      ['2600218', '株式会社G-gen', ['Mid-career'], '2026-10-15'],
      ['2596952', '株式会社ブリリオ', ['Mid-career'], '2026-10-15'],
    ],
  );
  const read = wantedlySearchPage(search(), 2, SEARCH);
  assert.equal(read.browser, 'Wantedly reader');
  assert.deepEqual(
    read.links.map((l) => [l.url, l.listing]),
    parsed.jobs.map((j) => [`https://www.wantedly.com/projects/${j.id}`, true]),
    'only the listings of this page: no page-1 list, featured or company links',
  );
  assert.equal(read.links[0].text, 'プロダクトの核をつくるバックエンドインターン募集！');
  assert.match(read.text, /page 2 of 100 \(3989 results stated\)/, 'the site serves 100 pages');
  assert.match(read.text, /株式会社 Panta Rhei · Web Engineer · Internship · posted 2026-10-15/);
  const position = resultPageSummary(read, {id: 'e1'}, []).position,
    next = new URL(observedNextPage(read, position).url);
  assert.equal(position.currentPage, 2);
  assert.equal(next.searchParams.get('page'), '3');
  assert.equal(next.searchParams.get('keywords'), 'engineer', 'the search stays');
  assert.equal(next.searchParams.get('order'), 'recent');
});

test('the last page, an empty page and the 100-page limit link no next page', () => {
  const last = wantedlySearchPage(search(), 2, atPage(SEARCH, 2, 13));
  assert.deepEqual(
    last.pagination.map((p) => [p.text, p.current]),
    [['2 of 2', true]],
  );
  const cap = wantedlySearchPage(search(100), 100, atPage(SEARCH, 100, 3989));
  assert.deepEqual(
    cap.pagination.map((p) => p.text),
    ['100 of 100'],
  );
  const empty = wantedlySearchPage(search(6), 6, atPage(SEARCH, 6, 49, []));
  assert.deepEqual(empty.links, []);
  assert.match(empty.text, /no further results/);
  assert.deepEqual(
    empty.pagination.map((p) => p.text),
    ['6 of 6'],
    'the page still reports its position',
  );
  const none = wantedlySearchPage(search(1), 1, atPage(SEARCH, 1, 0, []));
  assert.match(none.text, /page 1 of 1 \(0 results stated\)/, 'a genuinely empty search');
});

test('state for another page, other terms or no state falls back to the cards without pagination', () => {
  const stale = [
    [search(3), SEARCH],
    [search(2, 'designer'), SEARCH],
    [search(2).replace('&order=recent', '&order=popular'), SEARCH],
    [search(), SEARCH.replace(NEXT, '')],
    [search(), SEARCH.replace(NEXT, '$1{not json$3')],
  ];
  for (const [url, html] of stale) {
    assert.equal(parseWantedlyState(html, url), null, url);
    const read = wantedlySearchPage(url, Number(new URL(url).searchParams.get('page')), html);
    assert.deepEqual(
      read.links.map((l) => l.url),
      ['https://www.wantedly.com/projects/2599350', 'https://www.wantedly.com/projects/2600218'],
    );
    assert.deepEqual(read.pagination, [], 'the position is unknown');
    assert.match(read.text, /page position and the next page are unknown/);
  }
  assert.equal(
    parseWantedlyCards(SEARCH)[1].title,
    'Google CloudをベースにしたSI開発組織のマネジメントポジション',
  );
  // Without an order the site drops the terms and the page loads client-side.
  assert.throws(
    () =>
      wantedlySearchPage(
        'https://www.wantedly.com/projects?keywords=engineer',
        1,
        SEARCH.replace(/<ul>[\s\S]*<\/ul>/, '<div data-testid="project-list-loading"></div>'),
      ),
    /no result cards/,
  );
  assert.throws(
    () => wantedlySearchPage(search(), 2, '<html><body>Access denied</body></html>'),
    (e) => /no result cards/.test(e.message) && e.url === search(),
    'a block or error page is not an empty result',
  );
});

test('a listing reads its own text and stated facts from the state', () => {
  const read = wantedlyDetailPage(listingUrl, '2599350', LISTING);
  assert.equal(read.url, listingUrl);
  assert.equal(
    read.title,
    'プロダクトの核をつくるバックエンドインターン募集！ @ 株式会社 Panta Rhei',
  );
  assert.deepEqual(read.listing.fields, {
    company: '株式会社 Panta Rhei',
    location: 'Tokyo, 東京都港区六本木2-2-6 福吉町ビル6F',
    workLocation: '六本木オフィス/リモート',
    employmentType: 'Internship',
    occupation: 'Web Engineer',
    salary: 'from 1240 per hour; 試用期間は1240円。本契約からは応能力で昇給。',
    postedAt: '2026-10-15T08:54:15.083Z',
  });
  assert.match(read.text, /What you will do\n自社プロダクトのバックエンド領域全般/);
  assert.match(
    read.text,
    /・Pythonを用いたWeb開発の基礎知識・経験/,
    'the full role text, not the teaser',
  );
  assert.match(read.text, /Duties\noarthの開発/);
  assert.match(read.text, /How we work\n[\s\S]*その後は応能力でリモート可能です/);
  for (const outside of [
    /Everything Analysable/, // the company's business and mission sections
    /会社広報から技術広報/, // another listing of the company
    /recruit@example\.com|0300000000/, // the recruiter's contact details
    /話を聞きに行きたい|ビジネスSNS/, // site chrome
  ])
    assert.doesNotMatch(read.text, outside);
  assert.equal(read.text.includes('PAUSED'), false);
  const closed = wantedlyDetailPage(
    listingUrl,
    '2599350',
    editState(LISTING, (cache) => {
      cache['JobPost:{"id":"2599350"}'].lifecycleState = 'PAUSED';
    }),
  );
  assert.ok(closed.listing);
  assert.match(closed.text, /marks this listing as PAUSED: recruitment has ended/);
});

test('a removed listing or one without its state has no listing', () => {
  const removed = wantedlyDetailPage(listingUrl, '2599350', '');
  assert.match(removed.text, /not found/);
  assert.equal(removed.listing, undefined);
  const plain = wantedlyDetailPage(listingUrl, '2599350', LISTING.replace(NEXT, ''));
  assert.equal(plain.listing, undefined, 'the JobPosting holds only a teaser');
  assert.match(plain.text, /話を聞きに行きたい/, 'the visible page text remains');
  assert.equal(parseWantedlyListing(LISTING, '2556330'), null, 'state of another listing');
  const empty = editState(LISTING, (cache) => {
    const post = cache['JobPost:{"id":"2599350"}'];
    post.detailDescription = post.howDescription = null;
    cache['JobDescription:2042'].workDuties = '';
  });
  assert.equal(wantedlyDetailPage(listingUrl, '2599350', empty).listing, undefined);
});

test('reads use the shared site access rules and pass the caller signal', async () => {
  const requested = [],
    events = [],
    caller = new AbortController();
  const siteAccess = {
    begin: (url) => {
      events.push(['begin', url]);
      return 'token';
    },
    pace: () => 0,
    complete: (url, token, info) => {
      events.push(['complete', url, token, info]);
      return info.reason
        ? {site: 'wantedly.com', reason: info.reason, retryAt: 1, waiting: true}
        : null;
    },
  };
  const fetch = async (url, options) => {
    requested.push(url);
    assert.match(options.headers['User-Agent'], /AutoJev/);
    assert.equal(options.signal.aborted, false);
    return new Response(url.includes('/projects?') ? SEARCH : LISTING, {status: 200});
  };
  let passed = null;
  const results = await readWantedly(search(), {
    fetch: async (url, options) => {
      passed = options.signal;
      return fetch(url, options);
    },
    siteAccess,
    signal: caller.signal,
  });
  assert.equal(results.links.length, 3);
  caller.abort();
  assert.equal(passed.aborted, true, 'the caller signal reaches the fetch');
  const read = await readWantedly(`${listingUrl}?featured=0`, {fetch, siteAccess});
  assert.ok(read.listing);
  assert.equal(requested.at(-1), listingUrl, 'the listing address without tracking');
  assert.equal(read.url, `${listingUrl}?featured=0`, 'the queued address');
  assert.deepEqual(events.at(-1), ['complete', listingUrl, 'token', {status: 200}]);
  for (const status of [403, 429]) {
    const error = await readWantedly(search(), {
      fetch: async () => new Response('', {status}),
      siteAccess,
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError);
    assert.equal(error.wait.reason, 'rate_limit');
    assert.equal(error.url, search());
  }
  const gone = await readWantedly(listingUrl, {fetch: async () => new Response('', {status: 404})});
  assert.match(gone.text, /not found/);
  assert.equal(gone.listing, undefined);
  await assert.rejects(
    readWantedly(search(), {fetch: async () => new Response('', {status: 404})}),
    /search page not found/,
  );
  await assert.rejects(
    readWantedly(search(), {fetch: async () => new Response('', {status: 500})}),
    /HTTP 500/,
  );
  await assert.rejects(readWantedly('https://www.wantedly.com/companies/x'), /does not handle/);
});

test('the search template sorts by the site order and its filters keep the placeholders', () => {
  const {search: site} = wantedly;
  assert.equal(site.ordering, undefined, 'the order restarts after a block of results');
  assert.equal(new URL(site.template.replace('{query}', 'x')).searchParams.get('order'), 'recent');
  const template = withSearchFilters(site.template, {hiringTypes: 'mid_career', areas: 'tokyo'});
  assert.equal(
    template,
    'https://www.wantedly.com/projects?new=true&keywords={query}&order=recent&hiringTypes=mid_career&areas=tokyo',
  );
  assert.deepEqual(searchFilterLabels(site, template), ['Hiring type: Mid-career', 'Area: Tokyo']);
  assert.equal(wantedlyRequest(template.replace('{query}', 'backend')).kind, 'search');
});
