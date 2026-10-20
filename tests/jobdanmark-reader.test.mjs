import test from 'node:test';
import assert from 'node:assert/strict';
import jobdanmark, {
  jobdanmarkRequest,
  parseJobdanmarkSearch,
  jobdanmarkListingPage,
  readJobdanmark,
} from '../app/site-extensions/jobdanmark.mjs';
import {withSearchFilters, searchFilterLabels} from '../app/site-extensions/search.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev/results.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';

const search = 'https://jobdanmark.dk/jobsoeger/find-job?freetext=udvikler';
const API = 'https://jobdanmark.dk/api/jobsearch/search/';
const listing = (slug) => `https://jobdanmark.dk/job/${slug}`;
// One result as the JSON search returns it (logo and cover fields trimmed).
const item = (slug, title, {boostJob = false, publishedDate = '15-10-2026'} = {}) => ({
  title,
  companyName: 'VIA University College',
  companyLogo: {key: 'k', url: '/media/via-logo.png', focalPoint: null},
  companyAddress: 'Banegårdsgade 2, 8700 Horsens',
  jobTypes: ['fuldtid'],
  boostJob,
  publishedDate,
  applicationDeadline: '15-11-2026',
  url: `/job/${slug}`,
  silhouetteLogo: false,
});
const result = (items, {currentPage = 1, totalItems = 89, totalPages = 3} = {}) => ({
  items,
  currentPage,
  totalItems,
  itemsPrPage: 30,
  totalPages,
});
const json = (data, init) =>
  new Response(JSON.stringify(data), {
    headers: {'Content-Type': 'application/json; charset=utf-8'},
    ...init,
  });
// A listing page shaped like the live one: details block (head with logo,
// badge, title and meta; body), the sidebar with apply link and overview
// (with the site's malformed "</ li >"), a login dialog and the footer.
const description =
  '<b><strong>Mosetoft - Et sted for dig</strong></b><br><p>Når du starter på Mosetoft, træder du ind i en hverdag med borgere, der har komplekse behov. Det stiller krav til dig som medarbejder.</p><ul><li>Faglighed</li><li>Humor</li></ul><div class="note"><p><i>Region Midtjylland oplyser startløn.</i></p></div>';
const detail = ({body = description, apply = true} = {}) =>
  `<!DOCTYPE html><html><head><title>P&#xE6;dagogisk personale s&#xF8;ges til Mosetoft, Viborg | Jobdanmark</title></head><body><header><nav><a href="/jobsoeger">Jobsøger</a></nav></header><div class="content-wrapper"><div class="page-heading-section section"><h3 class="title">P&#xE6;dagogisk personale s&#xF8;ges til Mosetoft, Viborg</h3></div><div class="section section-padding"><div class="container"><div class="row mb-4"><div class="col-lg-8 col-12 mb-5 pe-lg-5"><div class="job-list-details"><div class="job-details-head row mx-0"><div class="company-logo col-auto"><svg viewBox="0 0 1000 945"><path d="m492"/></svg></div><div class="salary-type col-auto order-sm-3"><span class="badge">fuldtid</span></div><div class="content col"><h5 class="title">P&#xE6;dagogisk personale s&#xF8;ges til Mosetoft, Viborg</h5><ul class="meta"><li><strong class="text-primary">Region Midtjylland</strong></li><li><svg viewBox="0 0 384 512"><path d="M168"/></svg> Liseborgvej 61, 8800 Viborg</li></ul></div></div><div class="job-details-body">${body}</div></div></div><!-- Job List Details End --><div class="col-lg-4 col-12 mb-5"><div class="sidebar-wrap sidebar-job"><div class="sidebar-widget primary"><div class="inner"><div class="job-apply"><div class="actions"><a data-jobid="687202" class="savejob" title="Log ind">Save</a></div>${apply ? '<a href="https://midtjob.dk/ad/paedagogisk-personale/6zfxqk/da?x=1&amp;y=2" class="action primary count-click" target="_blank" data-nodeid="687202">Ansøg nu</a>' : ''}</div></div></div><div class="sidebar-widget"><div class="inner"><h6 class="title">Jobdetaljer</h6><ul class="job-overview list-unstyled"><li><strong>Udgivet:</strong> 15-10-2026</li><li>\n<strong>Jobtype:</strong> Fuldtid </ li ><li><strong>Arbejdssted:</strong> Liseborgvej 61, 8800 Viborg</li><li><strong>Ansøgningsfrist:</strong> 29-10-2026 21.59</li><li><strong>Kontaktperson:</strong> Thomas Nielsen</li><li><strong>Kontakttelefon:</strong> &#x2B;4524440531</li></ul></div></div></div></div></div></div></div></div><dialog id="login"><form><button class="primary">Log ind</button></form></dialog><div class="footer-top-section section"><p>Banegårdspladsen 1, 5000 Odense C CVR: 40131507</p></div></body></html>`;
const searchPage =
  '<!DOCTYPE html><html><head><title>Find job | Jobdanmark</title></head><body><nav><a href="/jobsoeger/find-job">Find dit næste job her</a></nav><div id="jobapp"></div><script type="module" src="/dist/jobsearch/jobsearch.mjs"></script></body></html>';
const redirected = (response, url) =>
  Object.defineProperties(response, {redirected: {value: true}, url: {value: url}});

test('the search page address and listings use the reader; other addresses do not', () => {
  assert.deepEqual(
    jobdanmarkRequest(
      'https://jobdanmark.dk/jobsoeger/find-job?freetext=python+udvikler&municipality=Aarhus&municipality=Odense&jobtype=fuldtid&category=227978&utm_source=x&p=2#top',
    ),
    {
      kind: 'search',
      url: 'https://jobdanmark.dk/jobsoeger/find-job?freetext=python+udvikler&municipality=Aarhus&municipality=Odense&jobtype=fuldtid&category=227978&utm_source=x&p=2',
      page: 2,
      body: {
        jobTypes: ['fuldtid'],
        filters: [
          {type: 'freetext', value: 'python udvikler', displayText: 'python udvikler'},
          {type: 'category', value: '227978', displayText: '227978'},
          {type: 'municipality', value: 'Aarhus', displayText: 'Aarhus'},
          {type: 'municipality', value: 'Odense', displayText: 'Odense'},
        ],
        locationMode: 'Text',
        distance: 50,
      },
    },
  );
  const empty = jobdanmarkRequest('https://www.jobdanmark.dk/jobsoeger/find-job/?freetext=');
  assert.equal(empty.page, 1);
  assert.deepEqual(empty.body.filters, [], 'an empty term is no filter');
  assert.deepEqual(jobdanmarkRequest(listing('lead-engineer')), {
    kind: 'listing',
    url: listing('lead-engineer'),
  });
  assert.match(
    jobdanmarkRequest(`${search}&jobtype=weekend`).problem,
    /no job type weekend; it knows fuldtid/,
  );
  assert.match(jobdanmarkRequest(`${search}&category=IT`).problem, /numeric id/);
  for (const other of [
    'https://jobdanmark.dk/jobsoeger/find-job/fuldtid/aarhus',
    `${search}&location=aarhus`,
    `${search}&locationMode=Distance&distance=20&addressId=abc`,
    `${search}&p=0`,
    `${search}&p=two`,
    'https://jobdanmark.dk/job',
    'https://jobdanmark.dk/job/a/b',
    'https://jobdanmark.dk/',
    'https://jobdanmark.dk/api/jobsearch/search/1',
    'http://jobdanmark.dk/jobsoeger/find-job?freetext=x',
    'https://jobdanmark.dk.evil.test/jobsoeger/find-job?freetext=x',
    'https://evil-jobdanmark.dk/job/x',
    'https://jobdanmark.com/job/x',
    'not a url',
  ])
    assert.equal(jobdanmarkRequest(other), null, other);
  assert.equal(jobdanmark.matches('https://jobdanmark.dk.evil.test/job/x'), false);
  assert.equal(jobdanmark.matches('https://www.jobdanmark.dk/job/x'), true);
  assert.equal(jobdanmark.http.handles(search), true);
  assert.equal(jobdanmark.http.handles('https://jobdanmark.dk/'), false);
});

test('a results address becomes one JSON search and lists its results as listings', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({url, ...options, body: JSON.parse(options.body)});
    return json(
      result([
        item('uddannelsesleder-skive', 'Uddannelsesleder &amp; underviser', {
          boostJob: true,
          publishedDate: '12-10-2026',
        }),
        item('backend-udvikler', 'Backend udvikler'),
        item('backend-udvikler', 'Backend udvikler'),
      ]),
    );
  };
  const read = await readJobdanmark(search, {fetch});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API}1`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.match(calls[0].headers['User-Agent'], /AutoJob/);
  assert.deepEqual(calls[0].body, {
    jobTypes: [],
    filters: [{type: 'freetext', value: 'udvikler', displayText: 'udvikler'}],
    locationMode: 'Text',
    distance: 50,
  });
  assert.deepEqual(
    read.links.map((l) => [l.url, l.text, l.listing]),
    [
      [listing('uddannelsesleder-skive'), 'Uddannelsesleder & underviser', true],
      [listing('backend-udvikler'), 'Backend udvikler', true],
    ],
  );
  assert.match(read.text, /page 1 of 3 \(89 listings\)/);
  assert.match(
    read.text,
    /VIA University College · Banegårdsgade 2, 8700 Horsens · fuldtid · published 2026-10-12 · deadline 2026-11-15 · promoted/,
  );
  assert.match(read.links[1].siteCard, /^Backend udvikler · VIA University College/);
  assert.equal(read.status, 'ready');
  const position = resultPageSummary(read, {id: 'e1'}, []).position;
  assert.equal(position.currentPage, 1);
  assert.equal(observedNextPage(read, position).url, `${search}&p=2`);

  const second = await readJobdanmark(`${search}&p=2`, {
    fetch: async (url) => (calls.push({url}), json(result([item('a', 'A')], {currentPage: 2}))),
  });
  assert.equal(calls.at(-1).url, `${API}2`);
  assert.deepEqual(
    second.pagination.map((p) => [p.text, p.url]),
    [
      ['2 of 3', `${search}&p=2`],
      ['3', `${search}&p=3`],
    ],
  );
});

test('the last page, a page past the end and an empty search have no next page', async () => {
  const read = (url, data) => readJobdanmark(url, {fetch: async () => json(data)});
  const last = await read(`${search}&p=3`, result([item('a', 'A')], {currentPage: 3}));
  assert.deepEqual(
    last.pagination.map((p) => p.text),
    ['3 of 3'],
  );
  const past = await read(`${search}&p=4`, result([], {currentPage: 4}));
  assert.deepEqual(past.links, []);
  assert.match(past.text, /no further results/);
  assert.equal(past.pagination.length, 1);
  const none = await read(search, result([], {totalItems: 0, totalPages: 0}));
  assert.match(none.text, /This search has no results/);
  assert.deepEqual(
    none.pagination.map((p) => p.text),
    ['1'],
  );
});

test('a malformed, failed or blocked search is an error, never an empty result', async () => {
  const fails = async (response, pattern, url = search) =>
    assert.rejects(
      readJobdanmark(url, {fetch: async () => response}),
      (error) => pattern.test(error.message) && error.url === url,
    );
  await fails(new Response(searchPage), /no JSON/);
  await fails(json({items: null, currentPage: 1}), /unexpected response/);
  await fails(json({...result([]), totalPages: '3'}), /unexpected response/);
  await fails(
    json(result([{...item('a', 'A'), url: 'https://other.test/job/a'}])),
    /listing address/,
  );
  await fails(json(result([{...item('a', 'A'), title: ''}])), /listing address or title/);
  await fails(json(result([], {currentPage: 1})), /answered page 1 for page 2/, `${search}&p=2`);
  await fails(json({status: 400}, {status: 400}), /request failed \(HTTP 400\)/);
  await fails(new Response('', {status: 500}), /request failed \(HTTP 500\)/);
  await fails(new Response('', {status: 404}), /search failed \(HTTP 404\)/);
  await fails(new Response('', {status: 403}), /denied access \(HTTP 403\)/);
  let fetched = false;
  await assert.rejects(
    readJobdanmark(`${search}&jobtype=weekend`, {fetch: async () => ((fetched = true), json({}))}),
    /no job type weekend/,
  );
  assert.equal(fetched, false, 'an unknown job type is not sent');
  assert.throws(() => parseJobdanmarkSearch(null), /unexpected response/);
  await assert.rejects(readJobdanmark('https://jobdanmark.dk/'), /does not handle/);
});

test('a listing reads its details block with only the facts the page states', async () => {
  const url = listing('paedagogisk-personale-soeges-til-mosetoft-viborg');
  const read = await readJobdanmark(url, {fetch: async () => new Response(detail())});
  assert.equal(read.url, url);
  assert.equal(read.title, 'Pædagogisk personale søges til Mosetoft, Viborg');
  assert.deepEqual(read.listing.fields, {
    company: 'Region Midtjylland',
    postedAt: '2026-10-15',
    employmentType: 'Fuldtid',
    location: 'Liseborgvej 61, 8800 Viborg',
    deadline: '2026-10-29 21:59',
    applyUrl: 'https://midtjob.dk/ad/paedagogisk-personale/6zfxqk/da?x=1&y=2',
  });
  const body = read.text.split('\n\n').slice(1).join('\n\n');
  assert.match(body, /^Mosetoft - Et sted for dig\nNår du starter/);
  assert.match(body, /• Faglighed\n• Humor/);
  assert.match(body, /Region Midtjylland oplyser startløn\.$/, 'nested blocks stay in the body');
  for (const chrome of [/Ansøg nu/, /Log ind/, /Jobdetaljer/, /CVR/, /Thomas Nielsen/, /Jobsøger/])
    assert.doesNotMatch(read.text, chrome);
  const noApply = jobdanmarkListingPage(url, detail({apply: false}));
  assert.equal(noApply.listing.fields.applyUrl, undefined, 'no apply link, no applyUrl');
});

test('a removed listing or a page without details has no listing', async () => {
  const url = listing('gone');
  const moved = await readJobdanmark(url, {
    fetch: async () =>
      redirected(new Response(searchPage), 'https://jobdanmark.dk/jobsoeger/find-job'),
  });
  assert.match(moved.text, /not found; it has been removed/);
  assert.equal(moved.listing, undefined);
  const missing = await readJobdanmark(url, {
    fetch: async () => new Response('', {status: 404}),
  });
  assert.match(missing.text, /not found/);
  assert.equal(missing.listing, undefined);
  const moved2 = await readJobdanmark(url, {
    fetch: async () => redirected(new Response(detail()), listing('new-slug')),
  });
  assert.ok(moved2.listing, 'a redirect to another listing is still a listing');
  const plain = jobdanmarkListingPage(url, searchPage);
  assert.equal(plain.listing, undefined);
  assert.equal(plain.title, 'Find job | Jobdanmark');
  assert.match(plain.text, /Find dit næste job her/);
  assert.equal(jobdanmarkListingPage(url, detail({body: ''})).listing, undefined);
});

test('reads use the shared site access rules and pass the caller signal', async () => {
  const events = [];
  const siteAccess = {
    begin: (url) => (events.push(['begin', url]), 'token'),
    pace: (url) => (events.push(['pace', url]), 5),
    complete: (url, token, info) => {
      events.push(['complete', url, token, info.status]);
      return info.reason
        ? {site: 'jobdanmark.dk', reason: info.reason, retryAt: 1, waiting: true, message: 'wait'}
        : null;
    },
  };
  const waits = [];
  const wait = async (ms) => waits.push(ms);
  const controller = new AbortController();
  const signals = [];
  const fetch = async (url, options) => {
    signals.push(options.signal);
    return url.startsWith(API) ? json(result([item('a', 'A')])) : new Response(detail());
  };
  await readJobdanmark(search, {fetch, siteAccess, wait, signal: controller.signal});
  await readJobdanmark(listing('a'), {fetch, siteAccess, wait, signal: controller.signal});
  assert.deepEqual(events, [
    ['begin', `${API}1`],
    ['pace', `${API}1`],
    ['complete', `${API}1`, 'token', 200],
    ['begin', listing('a')],
    ['pace', listing('a')],
    ['complete', listing('a'), 'token', 200],
  ]);
  assert.deepEqual(waits, [5, 5]);
  assert.ok(signals.every((s) => s instanceof AbortSignal));
  controller.abort();
  assert.ok(
    signals.every((s) => s.aborted),
    'the caller signal reaches both requests',
  );
  for (const url of [search, listing('a')]) {
    const error = await readJobdanmark(url, {
      fetch: async () => new Response('', {status: 429}),
      siteAccess,
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError, url);
    assert.equal(error.url, url);
  }
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(readJobdanmark(search, {fetch, siteAccess, wait, signal: stopped.signal}), {
    name: 'AbortError',
  });
});

test('the search description builds addresses the reader handles', () => {
  const {search: site} = jobdanmark;
  // Promoted listings lead page 1 only; the rest of the board is newest first.
  assert.equal(site.ordering, 'newest_first');
  assert.equal(site.pagination, 'url_param');
  const template = withSearchFilters(site.template, {
    administrativeRegion: 'Region Hovedstaden',
    jobtype: 'fuldtid',
    category: '227978',
  });
  assert.deepEqual(searchFilterLabels(site, template), [
    'Region: Region Hovedstaden',
    'Category: IT, engineering and energy',
    'Job type: Full time',
  ]);
  const request = jobdanmarkRequest(template.replace('{query}', 'udvikler'));
  assert.deepEqual(request.body.jobTypes, ['fuldtid']);
  assert.deepEqual(
    request.body.filters.map((f) => [f.type, f.value]),
    [
      ['freetext', 'udvikler'],
      ['category', '227978'],
      ['administrativeRegion', 'Region Hovedstaden'],
    ],
  );
});
