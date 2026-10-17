import test from 'node:test';
import assert from 'node:assert/strict';
import reed, {
  reedRequest,
  reedState,
  parseReedSearch,
  reedSearchPage,
  reedDetailPage,
  readReed,
  REED_PAGE_SIZE,
} from '../app/site-extensions/reed.mjs';
import {withSearchFilters, searchFilterLabels} from '../app/site-extensions/search.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev/results.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';

const search = 'https://www.reed.co.uk/jobs?keywords=software%20engineer&location=London';
const seo =
  'https://www.reed.co.uk/jobs/software-engineer-jobs-in-london?q=software+engineer&keywords=software+engineer&locationName=London';
const sid = 'sid=CxuAeyJrIjoiTFFEWC1zRld5dDAiLCJmIjoiZmVxejRvYkZlRE0iLCJxIjoiTmJGX0dod2M5MFEifQM';
const job = (id, title, extra = {}) => ({
  id,
  title,
  slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  company: 'Acme & Co',
  salary: '£55,000 - £65,000 per annum',
  location: 'East London, London',
  workingOption: 'hybrid',
  ...extra,
});
// One entry of searchResults.jobs as the page embeds it.
const stateJob = (j) => ({
  jobDetail: {
    jobId: j.id,
    jobTitle: j.title,
    ouName: j.company,
    displayLocationName: 'London',
    salaryFrom: 28000,
    salaryTo: 35000,
    workingOption: j.workingOption,
    dateCreated: '2026-10-13T09:23:08.09',
    displayDate: '2026-10-16T13:12:26.287',
    isTrainingJob: false,
    jobDescriptionSnippet: 'About the role...',
  },
  url: `/jobs/${j.slug}/${j.id}`,
  ouUrl: '/jobs/acme/p4784',
});
// A rendered result card: title link with the search tracking, the posted-by
// line with the recruiter's profile link, metadata items and a logo link.
const svg = (label) =>
  `<svg viewBox="0 0 16 16" role="img" aria-label="${label}"><use xlink:href="#svg-x"></use></svg>`;
const card = (j) =>
  `<div><article class="card index-module_jobCard__DaYuk" data-qa="job-card" data-id="job${j.id}"><span>Job hidden.<a href="/jobs/software-engineer-jobs-in-london?q=software+engineer&amp;${sid}&amp;hideTrainingJobs=true">hide all</a></span><div class="card-body"><header><h2><a href="/jobs/${j.slug}/${j.id}?source=searchResults&amp;q=software+engineer&amp;${sid}&amp;filter=%2Fjobs%2Fsoftware-engineer-jobs-in-london" class="index-module_jobTitle__702ZU" data-id="${j.id}" title="${j.title}" data-qa="job-card-title" data-element="job_title">${j.title}</a></h2><div data-qa="job-posted-by" class="postedBy">11 September<!-- --> by <a href="/jobs/acme/p4784?${sid}" data-element="recruiter">${j.company}</a></div><ul data-qa="job-metadata">${
    j.salary
      ? `<li data-qa="job-metadata-salary" class="item" role="listitem ">${svg('Salary')}${j.salary}</li>`
      : ''
  }<li data-qa="job-metadata-location" class="item" role="listitem ">${svg('Location')}${j.location}</li><li class="item">${svg('Clock')}Permanent, full-time</li></ul></header></div><a href="/jobs/acme/p4784?${sid}" data-qa="company-logo-link" title="Jobs from ${j.company}"><img alt=""/></a></article></div>`;
const results = (
  jobs,
  {promoted = [], count = 1112, pageno = 1, withState = true, next = true, cards} = {},
) => {
  const data = {
    props: {
      pageProps: {
        criteria: {keywords: 'software engineer', pageno, take: 25, dateCreatedOffSet: 'anytime'},
        searchResults: {count, jobs: jobs.map(stateJob), promotedJobs: promoted.map(stateJob)},
      },
    },
    page: '/jobs/[[...criteria]]',
  };
  const shown = cards ?? [...promoted, ...jobs];
  return `<html><head><title>Software Engineer Jobs in London - Reed.co.uk</title>${
    next
      ? `<link rel="next" data-qa="rel-page-next" href="${seo.replace(/&/g, '&amp;')}&amp;pageno=${pageno + 1}"/>`
      : ''
  }</head><body><nav>Jobs Courses Career advice</nav><a href="/jobs/python-jobs-in-london?${sid}">Python jobs</a>${shown
    .map(card)
    .join('')}${
    withState
      ? `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`
      : ''
  }</body></html>`;
};
const posting = (overrides = {}) =>
  JSON.stringify({
    '@context': 'https://schema.org/',
    '@type': 'JobPosting',
    title: 'Lead Software Engineer',
    description:
      '<strong>Lead Software Engineer</strong><p><br></p><p><strong>Location:</strong> London, E14 5RE / Canary Wharf – Hybrid</p><ul><li>Lead technical direction across the platform</li><li>Mentor a growing engineering team</li></ul><p>We help millions of people each year make better broadband decisions because fast, reliable internet improves everyday life.</p>',
    identifier: {
      '@type': 'PropertyValue',
      name: 'BroadbandUK',
      propertyID: 'JobId',
      value: 57337433,
    },
    datePosted: '2026-09-11T15:04:01.313Z',
    validThrough: '2099-10-23T23:59:59.000Z',
    employmentType: 'FULL_TIME',
    hiringOrganization: {'@type': 'Organization', name: 'BroadbandUK', sameAs: ''},
    jobLocation: {
      '@type': 'Place',
      address: {
        addressLocality: 'East London',
        addressRegion: 'South East England',
        addressCountry: 'GB',
      },
    },
    ...overrides,
  });
const jobDetails = (overrides = {}) => ({
  id: 57337433,
  title: 'Lead Software Engineer',
  isTrainingJob: false,
  jobLocation: {
    locationName: 'East London',
    inferredJobLocationType: 'hybrid',
    workingOption: 'hybrid',
  },
  jobSalary: {displaySalary: 'Salary negotiable', from: 40000, to: 90000},
  jobContractType: {id: 1, name: 'Permanent'},
  ...overrides,
});
const detail = ({jobPosting = {}, state = {}} = {}) =>
  `<html><head><title>Lead Software Engineer East London - Reed.co.uk</title><script type="application/ld+json" data-next-head="">${posting(jobPosting)}</script></head><body><nav>Session expired Jobs Courses</nav><h1 data-qa="job-title">Lead Software Engineer</h1><ul data-qa="job-metadata"><li data-qa="job-metadata-salary">Salary negotiable</li></ul><div data-qa="job-description">Body text</div><h2>Similar Jobs</h2><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    {
      props: {
        pageProps: {consolidatedJobDetails: {jobDetails: jobDetails(state), similarJobs: []}},
      },
    },
  )}</script></body></html>`;
const listing = 'https://www.reed.co.uk/jobs/lead-software-engineer/57337433';

test('only Reed result pages and listings use the reader', () => {
  assert.deepEqual(reedRequest(search), {kind: 'search', number: 1, url: search});
  assert.equal(reedRequest(`${seo}&pageno=3`).number, 3, 'the SEO address the search redirects to');
  assert.equal(reedRequest('https://www.reed.co.uk/jobs').kind, 'search');
  assert.equal(
    reedRequest('https://reed.co.uk/jobs/fdm-group/p4784').kind,
    'search',
    'a recruiter',
  );
  assert.deepEqual(reedRequest(`${listing}?source=searchResults&q=software+engineer&${sid}`), {
    kind: 'detail',
    id: '57337433',
    url: listing,
  });
  for (const other of [
    `${seo}&sortBy=displayDate`,
    'https://www.reed.co.uk/jobs/software-jobs?sourceInternal=1',
    'https://www.reed.co.uk/jobs/software-jobs?directjob=1',
    'https://www.reed.co.uk/api/1.0/search?keywords=x',
    'https://www.reed.co.uk/courses/software',
    `${search}&pageno=0`,
    `${search}&pageno=abc`,
    'https://www.reed.co.uk/jobs/a/b/c',
    'http://www.reed.co.uk/jobs/lead-software-engineer/57337433',
    'https://www.reed.co.uk:8443/jobs',
    'https://reed.co.uk.evil.test/jobs/lead-software-engineer/57337433',
    'https://www.notreed.co.uk/jobs',
    'not a url',
  ])
    assert.equal(reedRequest(other), null, other);
  assert.equal(reed.matches('https://www.reed.co.uk/'), true);
  assert.equal(reed.matches('https://reed.co.uk.evil.test/'), false);
  assert.equal(reed.matches('https://evilreed.co.uk/'), false);
  assert.equal(reed.http.handles(search), true);
  assert.equal(reed.http.handles('https://www.reed.co.uk/career-advice/'), false);
});

test('the result list comes from the state in order, with the promoted listing and card facts', () => {
  const jobs = [
    job(57337433, 'Lead "Software" & Engineer'),
    job(57425945, 'Software Developer Trainee', {
      salary: 'Training Course',
      workingOption: 'remote',
    }),
    job(57227370, 'Senior Engineer', {salary: 'Competitive salary', workingOption: 'onSite'}),
  ];
  const promoted = job(57452596, 'Software Engineer- London', {salary: 'Salary negotiable'});
  // Page 1 shows the promoted listing twice: above the results and among them.
  const html = results([promoted, ...jobs], {promoted: [promoted]});
  const parsed = parseReedSearch(html, 1);
  assert.equal(parsed.total, 1112);
  const read = reedSearchPage(search, 1, parsed);
  assert.deepEqual(
    read.links.map((l) => [l.text, l.url, l.listing]),
    [promoted, ...jobs].map((j) => [
      j.title,
      `https://www.reed.co.uk/jobs/${j.slug}/${j.id}`,
      true,
    ]),
  );
  assert.ok(
    read.links.every((l) => !/[?#]/.test(l.url)),
    'tracking stripped',
  );
  assert.match(read.text, /page 1 of 45 \(1112 results\)/);
  assert.match(
    read.text,
    /Acme & Co · East London, London · £55,000 - £65,000 per annum · hybrid · posted 2026-10-16/,
  );
  assert.match(read.text, /Training Course · remote/);
  assert.match(read.text, /Competitive salary · on-site/);
  assert.doesNotMatch(read.text, /28000/, 'the state has bare numbers the card does not show');
  const position = resultPageSummary(read, {id: 'e1'}, []).position,
    next = observedNextPage(read, position);
  assert.equal(position.currentPage, 1);
  assert.equal(new URL(next.url).searchParams.get('pageno'), '2');
  assert.equal(new URL(next.url).searchParams.get('keywords'), 'software engineer', 'filters stay');
  assert.equal(new URL(next.url).searchParams.get('location'), 'London');
  // Later pages repeat the promoted listing above results it is not part of.
  const page2 = results([job(57342292, 'Backend Engineer')], {promoted: [promoted], pageno: 2});
  const read2 = reedSearchPage(`${seo}&pageno=2`, 2, parseReedSearch(page2, 2));
  assert.equal(read2.links.length, 2);
  assert.deepEqual(
    read2.pagination.map((p) => p.text),
    ['2 of 45', '3'],
  );
});

test('the last page links no next page; an empty search is a real empty result', () => {
  const last = reedSearchPage(
    `${seo}&pageno=45`,
    45,
    parseReedSearch(results([job(1, 'A'), job(2, 'B')], {pageno: 45, next: false}), 45),
  );
  assert.deepEqual(
    last.pagination.map((p) => p.text),
    ['45 of 45'],
  );
  const one = reedSearchPage(search, 1, parseReedSearch(results([job(1, 'A')], {count: 25}), 1));
  assert.deepEqual(
    one.pagination.map((p) => p.text),
    ['1 of 1'],
    'exactly one full page',
  );
  const empty = reedSearchPage(search, 1, parseReedSearch(results([], {count: 0, next: false}), 1));
  assert.deepEqual(empty.links, []);
  assert.match(empty.text, /no further results/);
  assert.equal(empty.pagination.length, 1);
});

test('stale or missing state falls back to the cards and the page next link', () => {
  const jobs = [job(1, 'A'), job(2, 'B')];
  for (const html of [
    results(jobs, {withState: false}),
    results(jobs, {pageno: 3}),
    results([job(3, 'C'), job(4, 'D')], {cards: jobs}),
    results([job(1, 'A')], {cards: jobs}),
  ]) {
    const parsed = parseReedSearch(html, 1);
    assert.equal(parsed.total, null);
    const read = reedSearchPage(search, 1, parsed);
    assert.deepEqual(
      read.links.map((l) => l.url),
      jobs.map((j) => `https://www.reed.co.uk/jobs/${j.slug}/${j.id}`),
    );
    assert.match(read.text, /Acme & Co · East London, London · £55,000/);
    assert.deepEqual(
      read.pagination.map((p) => p.text),
      ['1', '2'],
    );
  }
  const end = reedSearchPage(
    search,
    1,
    parseReedSearch(results(jobs, {withState: false, next: false}), 1),
  );
  assert.deepEqual(
    end.pagination.map((p) => p.text),
    ['1'],
  );
});

test('a page without a result list or cards, or a card without a link, is an error', () => {
  for (const html of [
    '<html><body>Access denied</body></html>',
    '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"notFoundReason":"PAGE_NOT_FOUND"}}}</script></body></html>',
    '<html><body><script id="__NEXT_DATA__" type="application/json">{broken</script></body></html>',
    results([job(1, 'A')], {cards: []}),
  ])
    assert.throws(() => parseReedSearch(html, 1), /could not be read/);
  assert.equal(reedState('<html></html>'), null);
  const unlinked = results([job(1, 'A')]).replace('data-qa="job-card-title"', 'data-qa="other"');
  assert.throws(() => parseReedSearch(unlinked, 1), /without a listing link/);
});

test('a listing reads through its JobPosting with the pay and working option Reed states', () => {
  const read = reedDetailPage(listing, detail(), '57337433');
  assert.equal(read.url, listing);
  assert.equal(read.browser, 'Reed reader');
  assert.equal(read.title, 'Lead Software Engineer @ BroadbandUK');
  assert.deepEqual(read.listing.fields, {
    company: 'BroadbandUK',
    location: 'East London, South East England, GB',
    workMode: 'hybrid',
    employmentType: 'FULL_TIME',
    salary: 'Salary negotiable',
    postedAt: '2026-09-11T15:04:01.313Z',
    validThrough: '2099-10-23T23:59:59.000Z',
    contractType: 'Permanent',
  });
  assert.match(read.text, /• Mentor a growing engineering team/);
  assert.doesNotMatch(read.text, /Session expired|Similar Jobs|Body text/, 'no site chrome');
  // Another listing's state adds nothing; the posting alone still reads.
  const foreign = reedDetailPage(listing, detail({state: {id: 1}}), '57337433');
  assert.deepEqual(Object.keys(foreign.listing.fields), [
    'company',
    'location',
    'employmentType',
    'postedAt',
    'validThrough',
  ]);
  const training = reedDetailPage(
    listing,
    detail({
      state: {isTrainingJob: true, jobSalary: {displaySalary: '£ 28,000 - £ 35,000 per annum'}},
    }),
    '57337433',
  );
  assert.equal(training.listing.fields.salary, undefined, 'a course shows no pay');
  assert.match(training.text, /training course/);
});

test('an expired, removed or unreadable listing has no listing', () => {
  const expired = reedDetailPage(
    listing,
    detail({jobPosting: {validThrough: '2020-01-01'}}),
    '57337433',
  );
  assert.equal(expired.listing, undefined);
  assert.match(expired.text, /Body text/, 'the visible page text remains');
  assert.doesNotMatch(expired.text, /JobPosting|__NEXT_DATA__/);
  const short = reedDetailPage(listing, detail({jobPosting: {description: 'Short.'}}), '57337433');
  assert.equal(short.listing, undefined);
  const removed = reedDetailPage(listing, '', '57337433');
  assert.equal(removed.listing, undefined);
  assert.match(removed.text, /not found/);
});

test('reads use the shared site access rules and pass the signal through', async () => {
  const requested = [],
    events = [];
  let controller = new AbortController();
  const siteAccess = {
    begin: (url) => {
      events.push(['begin', url]);
      return 'token';
    },
    pace: () => 0,
    complete: (url, token, info) => {
      events.push(['complete', url, token, info]);
      return info.reason
        ? {site: 'reed.co.uk', reason: info.reason, retryAt: 1, waiting: true}
        : null;
    },
  };
  const fetch = async (url, options) => {
    requested.push(url);
    assert.match(options.headers['User-Agent'], /AutoJev/);
    assert.equal(options.redirect, 'follow');
    assert.equal(options.signal.aborted, false);
    controller.abort('stop');
    assert.equal(options.signal.aborted, true, 'the caller signal reaches the request');
    return new Response(/\/\d+$/.test(url) ? detail() : results([job(1, 'A')]), {status: 200});
  };
  const page = await readReed(search, {fetch, siteAccess, signal: controller.signal});
  assert.equal(page.links.length, 1);
  controller = new AbortController();
  const read = await readReed(`${listing}?source=searchResults&${sid}`, {
    fetch,
    siteAccess,
    signal: controller.signal,
  });
  assert.ok(read.listing);
  assert.equal(requested.at(-1), listing, 'the listing is fetched without tracking');
  assert.deepEqual(events.at(-1), ['complete', listing, 'token', {status: 200}]);
  for (const status of [403, 429]) {
    const error = await readReed(search, {
      fetch: async () => new Response('', {status}),
      siteAccess,
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError);
    assert.equal(error.wait.reason, 'rate_limit');
    assert.equal(error.url, search);
  }
  let sent = false;
  await assert.rejects(
    readReed(search, {
      fetch: async () => {
        sent = true;
        return new Response('');
      },
      siteAccess: {
        begin: () => {
          throw new SiteWaitError({site: 'reed.co.uk', message: 'wait'});
        },
        pace: () => 0,
        complete: () => null,
      },
    }),
    (e) => e.code === 'SITE_WAIT',
  );
  assert.equal(sent, false, 'an active site wait stops the request before it is sent');
  for (const status of [404, 410]) {
    const gone = await readReed(listing, {fetch: async () => new Response('', {status})});
    assert.equal(gone.listing, undefined);
    assert.match(gone.text, /not found/);
  }
  await assert.rejects(
    readReed(search, {fetch: async () => new Response('', {status: 500})}),
    /HTTP 500/,
  );
  await assert.rejects(
    readReed(search, {fetch: async () => new Response('<html>Just a moment</html>')}),
    /could not be read/,
    'a 200 page without results is not an empty result',
  );
  await assert.rejects(readReed('https://www.reed.co.uk/career-advice/'), /does not handle/);
});

test('a 404 results page is the end only past the stated total', async () => {
  const requested = [];
  const fetchWith = (count) => async (url) => {
    requested.push(url);
    return new URL(url).searchParams.has('pageno')
      ? new Response('<html>Oops, page not found</html>', {status: 404})
      : new Response(results([job(1, 'A')], {count}), {status: 200});
  };
  const past = await readReed(`${seo}&pageno=46`, {fetch: fetchWith(1112)});
  assert.deepEqual(past.links, []);
  assert.match(past.text, /past the last page \(1112 results on 45 pages\)/);
  assert.deepEqual(
    past.pagination.map((p) => p.text),
    ['46'],
  );
  assert.equal(
    new URL(requested.at(-1)).searchParams.has('pageno'),
    false,
    'the total comes from page 1',
  );
  assert.equal(new URL(requested.at(-1)).searchParams.get('keywords'), 'software engineer');
  await assert.rejects(
    readReed(`${seo}&pageno=40`, {fetch: fetchWith(1112)}),
    /no results page 40.*HTTP 404/,
  );
  requested.length = 0;
  await assert.rejects(
    readReed(search, {
      fetch: async (url) => {
        requested.push(url);
        return new Response('', {status: 404});
      },
    }),
    /no results page 1 .*HTTP 404/,
  );
  assert.equal(requested.length, 1, 'a missing first page is an error at once');
  await assert.rejects(
    readReed(`${seo}&pageno=46`, {fetch: async () => new Response('', {status: 404})}),
    /HTTP 404/,
    'without a stated total the 404 stays an error',
  );
});

test('the search template keeps both placeholders and the filters carry labels', () => {
  const {search: site} = reed;
  assert.equal(site.ordering, undefined, 'relevance order is not newest first');
  assert.equal(site.pagination, 'url_param');
  assert.equal(REED_PAGE_SIZE, 25);
  const template = withSearchFilters(site.template, {
    dateCreatedOffSet: 'lastweek',
    workingOption: 'remote',
    hideTrainingJobs: 'true',
  });
  assert.equal(
    template,
    'https://www.reed.co.uk/jobs?keywords={query}&location={location}&dateCreatedOffSet=lastweek&workingOption=remote&hideTrainingJobs=true',
  );
  assert.deepEqual(searchFilterLabels(site, template), [
    'Posted: Last week',
    'Remote/On-site: Remote',
    'Training courses: Hide training courses',
  ]);
  const filled = template.replace('{query}', 'data analyst').replace('{location}', 'Leeds');
  assert.equal(reedRequest(filled).kind, 'search');
  assert.ok(
    site.filters.every((f) => f.param !== 'sortBy'),
    'robots.txt disallows sortBy',
  );
});
