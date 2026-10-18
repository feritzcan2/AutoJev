import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import jobBank, {
  jobBankRequest,
  parseJobBankSearch,
  jobBankSearchPage,
  jobBankDetailPage,
  parseJobBankPosting,
  rdfaElements,
  readJobBank,
} from '../app/site-extensions/jobbank-ca.mjs';
import {
  withSearchFilters,
  searchFilterLabels,
  siteSearchRecipe,
} from '../app/site-extensions/search.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev/results.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';

// Trimmed from captures of 2026-10-16 (session ids replaced).
const fixture = (name) =>
  readFileSync(new URL(`./fixtures/jobbank-ca/${name}`, import.meta.url), 'utf8');
const results = fixture('results.html');
const ownPosting = fixture('posting-jobbank.html');
const partnerPosting = fixture('posting-partner.html');
const bareP = fixture('posting-no-description.html');
const search = (query = '') =>
  `https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=developer&sort=D${query}`;
const posting = (id) => `https://www.jobbank.gc.ca/jobsearch/jobposting/${id}`;
const withCount = (html, count) => html.replace(/(id="results-count">)\d[\d,]*/, `$1${count}`);
const read = (url, html) => jobBankSearchPage(url, jobBankRequest(url), html);

test('search and posting addresses use the reader without session ids; look-alike hosts do not', () => {
  assert.deepEqual(jobBankRequest(search()), {kind: 'search', number: 1, url: search()});
  assert.deepEqual(
    jobBankRequest(
      'https://www.jobbank.gc.ca/jobsearch/jobsearch;jsessionid=ABC.jobsearch76?searchstring=developer&sort=D&page=3',
    ),
    {kind: 'search', number: 3, url: search('&page=3')},
  );
  assert.deepEqual(
    jobBankRequest(
      'https://www.jobbank.gc.ca/jobsearch/jobposting/50512507;jsessionid=9D80C55F.jobsearch76?source=searchresults#top',
    ),
    {kind: 'detail', id: '50512507', url: posting(50512507)},
  );
  assert.equal(jobBankRequest('https://jobbank.gc.ca/jobsearch/jobposting/1').url, posting(1));
  for (const other of [
    'https://www.jobbank.gc.ca.evil.test/jobsearch/jobsearch?searchstring=x',
    'https://evil-jobbank.gc.ca/jobsearch/jobsearch?searchstring=x',
    'https://jobbank.gc.ca.example.com/jobsearch/jobposting/1',
    'http://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=x',
    'https://www.jobbank.gc.ca:8443/jobsearch/jobsearch?searchstring=x',
    'https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring=x&page=0',
    'https://www.jobbank.gc.ca/jobsearch/jobpostingexpired',
    'https://www.jobbank.gc.ca/login',
    'not a url',
  ])
    assert.equal(jobBankRequest(other), null, other);
  assert.equal(jobBank.matches('https://www.jobbank.gc.ca.evil.test/'), false);
  assert.equal(jobBank.matches('https://www.jobbank.gc.ca/'), true);
  assert.equal(jobBank.http.handles(search()), true);
  assert.equal(jobBank.http.handles('https://www.jobbank.gc.ca/login'), false);
});

test('a results page lists its cards as stable listing links with the computed page count', () => {
  const parsed = parseJobBankSearch(results);
  assert.equal(parsed.total, 261);
  assert.deepEqual(parsed.jobs[1], {
    url: posting(50506564),
    title: 'senior software developer',
    company: 'Vector Institute',
    location: 'Toronto (ON)',
    salary: '$125,800.00 to $157,300.00 annually (to be negotiated)',
    postedAt: '2026-10-15',
    workplace: 'Hybrid',
    source: 'Job Bank',
  });
  const url = search('&fprov=ON');
  const page = read(url, results);
  assert.deepEqual(
    page.links.map((l) => [l.url, l.listing]),
    [
      [posting(50512507), true],
      [posting(50506564), true],
      [posting(50512537), true],
    ],
    'favourite, sign-in and sign-up links are not listings',
  );
  assert.match(
    page.links[0].siteCard,
    /^Web developer · YO AI Labs · Calgary \(AB\) · \$80\.00 to \$120\.00 hourly · posted 2026-10-16 · via Talent\.com$/,
  );
  assert.match(page.text, /page 1 of 11 \(261 results\)/);
  assert.deepEqual(
    page.pagination.map((p) => [p.text, p.url, p.current]),
    [
      ['1 of 11', url, true],
      ['2', search('&fprov=ON&page=2'), false],
    ],
  );
  const position = resultPageSummary(page, {id: 'e1'}, []).position;
  assert.equal(position.currentPage, 1);
  assert.equal(observedNextPage(page, position).url, search('&fprov=ON&page=2'));
  const thousands = read(search('&page=2'), withCount(results, '73,604'));
  assert.equal(thousands.pagination[0].text, '2 of 2945');
  assert.equal(thousands.pagination[1].url, search('&page=3'));
});

test('the last page has no next page; past the end and a search without results are empty', () => {
  const last = read(search('&page=11'), results);
  assert.deepEqual(
    last.pagination.map((p) => p.text),
    ['11 of 11'],
  );
  assert.equal(last.links.length, 3);
  const noCards = results.replace(/<article\b[\s\S]*<\/article>/, '');
  const past = read(search('&page=12'), noCards);
  assert.deepEqual(past.links, []);
  assert.match(past.text, /no further results/);
  assert.deepEqual(
    past.pagination.map((p) => p.text),
    ['12 of 11'],
  );
  const none = read(search(), withCount(noCards, 0));
  assert.match(none.text, /This search has no results/);
  assert.deepEqual(
    none.pagination.map((p) => p.text),
    ['1 of 1'],
  );
});

test('a page without the result count or with broken cards is an error, not an empty result', () => {
  assert.throws(
    () => read(search(), '<html><body><p>Service unavailable</p></body></html>'),
    /could not be read/,
  );
  assert.throws(
    () => read(search(), results.replace(/id="results-count"/, 'id="other"')),
    /could not be read/,
    'the result-count template in the page script is not the count',
  );
  assert.throws(
    () => read(search('&page=4'), results.replace(/<article\b[\s\S]*<\/article>/, '')),
    /page 4 of 11 came without result cards/,
  );
  assert.throws(
    () => read(search(), results.replace(/href="\/jobsearch\/jobposting\/50512537/, 'href="/x')),
    /could not be read/,
  );
});

test('the RDFa reader finds properties by token, nested elements whole', () => {
  const html =
    '<div><span property="baseSalary"><span property="value"><b>1</b></span> a</span><p property="experienceRequirements qualification">5 years</p><meta property="og:title" content="x"/><span property=\'workHours\' content="36">36 h</span></div>';
  assert.equal(
    rdfaElements(html, 'baseSalary')[0].inner,
    '<span property="value"><b>1</b></span> a',
  );
  assert.deepEqual(rdfaElements(html, 'qualification')[0].properties, [
    'experienceRequirements',
    'qualification',
  ]);
  assert.equal(rdfaElements(html, 'title').length, 0);
  assert.equal(rdfaElements(html, 'workHours')[0].content, '36');
});

test("Job Bank's own posting reads its RDFa description and only the stated facts", () => {
  const url = posting(50501195);
  const page = jobBankDetailPage(url, ownPosting);
  assert.equal(page.url, url);
  assert.equal(page.title, 'software developer @ Techy Logs Software Inc');
  assert.deepEqual(page.listing.fields, {
    company: 'Techy Logs Software Inc',
    location: 'Markham, ON',
    salary: '$48.50 hourly / 30 hours per week',
    employmentType: 'Permanent employment, Full time',
    languages: 'English',
    postedAt: '2026-10-15',
    validThrough: '2026-11-05',
  });
  assert.match(page.text, /Tasks: Write, modify, integrate and test software code\./);
  assert.doesNotMatch(
    page.text,
    /Sign up for a Plus account|Report a problem|Government of Canada/,
  );
});

test('a partner posting reads its escaped HTML description and the partner apply address', () => {
  const page = jobBankDetailPage(posting(50512507), partnerPosting);
  assert.equal(page.title, 'Web developer @ YO AI Labs');
  const {applyUrl, ...fields} = page.listing.fields;
  assert.deepEqual(fields, {
    company: 'YO AI Labs',
    location: 'Calgary, AB',
    salary: '$80.00 to $120.00 hourly',
    employmentType: 'Full time',
    postedAt: '2026-10-16',
    validThrough: '2026-10-23',
    originalTitle: 'Backend Developer - Remote',
  });
  assert.match(
    applyUrl,
    /^https:\/\/ca\.talent\.com\/redirect\?id=634407437217957680&source=&utm_medium=xml/,
  );
  assert.match(page.text, /\n\nSenior Software Engineer\nJob Type: Contract/);
  assert.doesNotMatch(page.text, /&lt;|<h1>|&amp;/);
  // Some partners escape the description more than once.
  const triple = partnerPosting.replace(
    /(property="description">)[^<]*/,
    '$1&amp;amp;nbsp;Why FCC?At FCC, we&amp;amp;rsquo;re proud&amp;amp;nbsp;to be invested.',
  );
  assert.match(
    jobBankDetailPage(posting(1), triple).text,
    /\n\nWhy FCC\?At FCC, we’re proud to be invested\.$/,
  );
});

test('a posting without description or markup has no listing', () => {
  const bare = jobBankDetailPage(posting(50495527), bareP);
  assert.equal(bare.listing, undefined);
  assert.match(bare.text, /company: Meubles RD - Candiac/);
  assert.match(bare.text, /applyUrl: https:\/\/www\.jobillico\.com\//);
  assert.match(
    bare.text,
    /Job Bank shows no description for this posting; the full posting is at applyUrl\./,
  );
  const plain = jobBankDetailPage(
    posting(1),
    '<html><head><title>Maintenance - Job Bank</title></head><body><p>Back soon</p></body></html>',
  );
  assert.equal(plain.listing, undefined);
  assert.equal(plain.text, 'Back soon');
  assert.equal(parseJobBankPosting('<p>none</p>'), null);
});

test('reads use the shared site access rules, pass the signal and report removed postings', async () => {
  const requested = [];
  let controller = new AbortController();
  const siteAccess = {
    begin: () => 'token',
    pace: () => 0,
    complete: (_url, _token, info) =>
      info.reason
        ? {site: 'www.jobbank.gc.ca', reason: info.reason, retryAt: 1, waiting: true}
        : null,
  };
  const fetch = async (url, options) => {
    requested.push(url);
    assert.match(options.headers['User-Agent'], /AutoJev/);
    controller.abort();
    assert.equal(options.signal.aborted, true, "the caller's signal reaches the request");
    return new Response(url.includes('/jobsearch/jobsearch') ? results : ownPosting);
  };
  const page = await readJobBank(search(), {fetch, siteAccess, signal: controller.signal});
  assert.equal(page.links.length, 3);
  const listing = await readJobBank(
    'https://www.jobbank.gc.ca/jobsearch/jobposting/50501195;jsessionid=X.jobsearch76?source=searchresults',
    {fetch, siteAccess, signal: (controller = new AbortController()).signal},
  );
  assert.ok(listing.listing);
  assert.deepEqual(requested, [search(), posting(50501195)]);
  for (const status of [403, 429]) {
    const error = await readJobBank(search(), {
      fetch: async () => new Response('', {status}),
      siteAccess,
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError, `HTTP ${status} starts the site wait`);
  }
  await assert.rejects(
    readJobBank(search(), {fetch: async () => new Response('<html>Checking your browser</html>')}),
    /could not be read/,
  );
  await assert.rejects(
    readJobBank(search(), {fetch: async () => new Response('', {status: 404})}),
    /not found \(HTTP 404\)/,
  );
  await assert.rejects(
    readJobBank(search(), {fetch: async () => new Response('', {status: 500})}),
    /HTTP 500/,
  );
  // An expired posting redirects to /jobsearch/jobpostingexpired, which answers 410.
  const gone = await readJobBank(posting(40000000), {
    fetch: async () => new Response('<h1>Job posting expired</h1>', {status: 410}),
  });
  assert.match(gone.text, /no longer advertised/);
  assert.equal(gone.listing, undefined);
  const redirected = await readJobBank(posting(40000000), {
    fetch: async () => ({
      status: 200,
      ok: true,
      url: 'https://www.jobbank.gc.ca/jobsearch/jobpostingexpired;jsessionid=X.jobsearch74',
      text: async () => '<h1>Job posting expired</h1>',
    }),
  });
  assert.equal(redirected.listing, undefined);
  assert.match(redirected.text, /no longer advertised/);
  await assert.rejects(readJobBank('https://www.jobbank.gc.ca/login'), /does not handle/);
});

test('the search description builds newest-first url_param recipes with the site filters', () => {
  const {search: s} = jobBank;
  assert.equal(s.ordering, 'newest_first');
  assert.equal(s.pagination, 'url_param');
  const template = withSearchFilters(s.template, {fprov: 'QC', fskl: '15141', fage: '30'});
  assert.equal(
    template,
    'https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring={query}&sort=D&fprov=QC&fskl=15141&fage=30',
  );
  assert.deepEqual(searchFilterLabels(s, template), [
    'Date posted: Last 30 days',
    'Province or territory: Québec',
    'Work location: Remote',
  ]);
  const {recipe, changed} = siteSearchRecipe(s, {
    entry: {
      kind: 'url_template',
      template:
        'https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring={query}&sort=M&fprov=ON',
    },
    pagination: 'auto',
  });
  assert.equal(
    recipe.entry.template,
    'https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring={query}&sort=D&fprov=ON',
  );
  assert.equal(recipe.ordering, 'newest_first');
  assert.deepEqual(changed, ['template', 'pagination', 'ordering']);
});
