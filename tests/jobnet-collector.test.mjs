import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import jobnet, {
  jobnetApiUrl,
  parseJobnetPage,
  readJobnetPage,
  readJobnetDetail,
} from '../app/site-extensions/jobnet.mjs';
import {siteSearchRecipe, withSearchFilters} from '../app/site-extensions/search.mjs';
import {recipeReplay} from '../app/sources/recipe.mjs';

// Two real hits of a 2026-10-16 search for "udvikler" (one hosted by Jobnet,
// one external), descriptions trimmed.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/jobnet/search-page.json', import.meta.url), 'utf8'),
);
const api = 'https://jobnet.dk/bff/FindJob/Search';
const search = `${api}?searchString=udvikler&orderType=PublicationDate&resultsPerPage=20&pageNumber=1`;
const internal = 'https://jobnet.dk/find-job/92a3c0e3-0182-4ee8-ac64-9b563e65aa83';
// Jobnet's 404 page for the external hit, the address older records keep.
const external = 'https://jobnet.dk/find-job/7a5563f8-6cea-4a36-b975-723fa19807a9';
const posting = 'https://www.it-jobbank.dk/c?t=e6304797&ctx=w';
const ad = (overrides = {}) => ({...fixture.jobAds[0], ...overrides});
const response = (jobAds, overrides = {}) => ({...fixture, jobAds, ...overrides});

test('Jobnet search addresses become one API page with the site filters only', () => {
  assert.equal(jobnet.matches('https://www.jobnet.dk/find-job'), true);
  assert.equal(jobnetApiUrl('https://jobnet.dk/find-job?searchString=udvikler'), search);
  assert.equal(
    jobnetApiUrl('https://jobnet.dk/?q=udvikler'),
    search,
    'the collector fallback names the query q',
  );
  assert.equal(
    jobnetApiUrl('https://jobnet.dk/find-job'),
    `${api}?orderType=PublicationDate&resultsPerPage=20&pageNumber=1`,
  );
  assert.equal(
    jobnetApiUrl(
      `${api}?pageNumber=3&searchString=senior+udvikler&regions=Midtjylland&regions=Nordjylland&workplaceFilter=NonFixed&countries=dk&utm_source=x&kmRadius=20&orderType=BestMatch&resultsPerPage=50`,
    ),
    `${api}?searchString=senior+udvikler&regions=Midtjylland&regions=Nordjylland&countries=DK&workplaceFilter=NonFixed&orderType=BestMatch&resultsPerPage=50&pageNumber=3`,
    'filters keep their values in a fixed order; a radius without a postal code and unknown parameters drop',
  );
  assert.equal(
    jobnetApiUrl(
      'https://jobnet.dk/find-job?searchString=udvikler&postalCode=8000&workHoursType=PartTime&employmentDurationType=Temporary&regions=',
    ),
    `${api}?searchString=udvikler&postalCode=8000&kmRadius=50&workHoursType=PartTime&employmentDurationType=Temporary&orderType=PublicationDate&resultsPerPage=20&pageNumber=1`,
    "a postal code gets the find-job page's 50 km radius; an empty filter drops",
  );
  for (const bad of [
    'https://jobnet.dk/find-job?orderType=Newest',
    'https://jobnet.dk/find-job?regions=Jylland',
    'https://jobnet.dk/find-job?workHoursType=FullTime&workHoursType=PartTime',
    'https://jobnet.dk/find-job?postalCode=800',
    `${api}?pageNumber=0`,
    `${api}?pageNumber=501`,
    `${api}?resultsPerPage=500`,
    internal,
    'https://jobnet.dk/jobnet/forside',
    'http://jobnet.dk/find-job',
    'https://jobnet.dk.evil.test/find-job',
    'https://evil-jobnet.dk/find-job',
    'not a url',
  ])
    assert.throws(() => jobnetApiUrl(bad), undefined, bad);
  for (const bad of [
    'https://jobnet.dk.evil.test/',
    'https://jobnet.dk:8443/',
    'http://jobnet.dk/',
  ])
    assert.equal(jobnet.matches(bad), false, bad);
  assert.equal(jobnet.collector.acceptsQuery('https://jobnet.dk/'), true);
});

test('a page maps hits to stable Jobnet addresses with the stated facts only', () => {
  const page = parseJobnetPage(search, fixture);
  assert.deepEqual(
    [page.page, page.totalPages, page.complete, page.nextUrl],
    [1, 24, false, search.replace('pageNumber=1', 'pageNumber=2')],
  );
  assert.deepEqual(
    page.jobs.map((j) => j.url),
    [internal, posting],
    "an external hit is its own posting, as Jobnet's result card links it",
  );
  const own = jobnet.collector.detail(page.jobs[0]);
  assert.equal(own.url, internal);
  assert.deepEqual(own.listing.fields, {
    company: 'Region Midtjylland',
    location: '8200 Aarhus N',
    occupation: 'IT-ingeniør',
    employmentType: 'Full time',
    postedAt: '2026-10-16',
    deadline: '2026-11-08',
  });
  assert.match(own.text, /^AI-udvikler søges til Dansk Center for Partikelterapi, AUH\n/);
  assert.match(own.text, /protonterapi\. DCPT er/);
  assert.match(own.text, /Det er afgørende, at du har følgende kompetencer$/);
  assert.doesNotMatch(own.text, /<|&nbsp;/);
  assert.deepEqual(own.cells, {company: 'Region Midtjylland', location: '8200 Aarhus N'});

  const relayed = jobnet.collector.detail(page.jobs[1]);
  assert.equal(relayed.url, posting);
  assert.deepEqual(relayed.listing.fields, {
    company: 'Forsvarsministeriets Materiel- og Indkøbsstyrelse',
    location: 'Danmark',
    occupation: 'IT-arkitekt',
    employmentType: 'Full time',
    postedAt: '2026-10-16',
    deadline: '2026-11-02',
    applyUrl: posting,
  });
  assert.match(relayed.text, /Hvis ja, så er det dig vi mangler!/);

  const facts = (overrides) =>
    jobnet.collector.detail(parseJobnetPage(search, response([ad(overrides)])).jobs[0]).listing
      .fields;
  assert.equal(
    facts({applicationDeadlineStatus: 'AsSoonAsPossible'}).deadline,
    'As soon as possible',
  );
  assert.equal(facts({applicationDeadline: '1900-01-01T00:00:00+01:00'}).deadline, undefined);
  assert.equal(facts({applicationDeadlineStatus: 'NotDisclosed'}).deadline, undefined);
  assert.equal(facts({workHourPartTime: true}).employmentType, 'Part time');
  assert.equal(facts({workHourPartTime: undefined}).employmentType, undefined);
  assert.equal(facts({jobAdUrl: 'javascript:alert(1)', isExternal: true}).applyUrl, undefined);
  assert.equal(
    parseJobnetPage(search, response([ad({jobAdUrl: 'javascript:alert(1)', isExternal: true})]))
      .jobs[0].url,
    internal,
    'an external hit without a usable address keeps its Jobnet address',
  );
  assert.deepEqual(
    Object.keys(
      facts({
        hiringOrgName: '',
        occupation: null,
        country: undefined,
        postalCode: undefined,
        publicationDate: null,
      }),
    ),
    ['employmentType', 'deadline'],
    'facts the posting does not state are left out',
  );
});

test('the last page and the 10000-row limit end the search', () => {
  const last = parseJobnetPage(
    search.replace('pageNumber=1', 'pageNumber=24'),
    response(fixture.jobAds.slice(0, 1)),
  );
  assert.deepEqual([last.page, last.totalPages, last.complete, last.nextUrl], [24, 24, true, null]);
  const deep = parseJobnetPage(
    search.replace('pageNumber=1', 'pageNumber=500'),
    response(fixture.jobAds, {totalJobAdCount: 25070}),
  );
  assert.deepEqual([deep.totalPages, deep.complete, deep.nextUrl], [500, true, null]);
  const none = parseJobnetPage(
    search.replace('udvikler', 'zzzzqqqxx'),
    response([], {totalJobAdCount: 0, searchString: 'zzzzqqqxx'}),
  );
  assert.deepEqual([none.jobs, none.complete, none.totalPages], [[], true, 1]);
});

test('malformed, partial or reinterpreted pages are errors, not empty results', () => {
  assert.throws(() => parseJobnetPage(search, {totalJobAdCount: 3}), /malformed/);
  assert.throws(() => parseJobnetPage(search, {jobAds: []}), /malformed/);
  assert.throws(() => parseJobnetPage(search, {errorInformation: {errorCode: 1014}}), /malformed/);
  assert.throws(() => parseJobnetPage(search, response([])), /incomplete/);
  assert.throws(
    () => parseJobnetPage(search.replace('pageNumber=1', 'pageNumber=24'), response([])),
    /incomplete/,
    'the last page inside the total must hold listings',
  );
  assert.throws(
    () => parseJobnetPage(search, response(fixture.jobAds, {searchString: 'pædagog'})),
    /different search/,
  );
  assert.throws(() => parseJobnetPage(search, response([ad({description: ''})])), /description/);
  assert.throws(() => parseJobnetPage(search, response([ad({jobAdId: '42'})])), /id/);
  assert.equal(
    parseJobnetPage(
      `${api}?searchString=%22senior+udvikler%22&orderType=PublicationDate`,
      response(fixture.jobAds, {searchString: ' "senior udvikler" '}),
    ).jobs.length,
    2,
    'the echoed search may pad quotes with spaces',
  );
});

test('reads send the csrf header and the caller signal and report failures', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({url, options});
    return Response.json(
      new URL(url).searchParams.get('searchString') === '7a5563f8-6cea-4a36-b975-723fa19807a9'
        ? response(fixture.jobAds.slice(1), {totalJobAdCount: 1})
        : fixture,
    );
  };
  const controller = new AbortController();
  const page = await readJobnetPage('https://jobnet.dk/find-job?searchString=udvikler', {
    fetch,
    signal: controller.signal,
  });
  assert.equal(page.jobs.length, 2);
  assert.equal(calls[0].url, search);
  assert.equal(calls[0].options.headers['x-csrf'], '1');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  controller.abort();
  assert.equal(calls[0].options.signal.aborted, true, "the caller's signal reaches the request");

  const read = await readJobnetDetail(external, {fetch});
  assert.equal(
    calls[1].url,
    `${api}?searchString=7a5563f8-6cea-4a36-b975-723fa19807a9&orderType=BestMatch&resultsPerPage=20&pageNumber=1`,
  );
  assert.equal(read.url, external, 'an older record keeps its Jobnet address');
  assert.equal(jobnet.collector.detail(read).listing.fields.applyUrl, fixture.jobAds[1].jobAdUrl);

  const failure = await readJobnetPage(search, {
    fetch: async () => new Response('', {status: 401}),
  }).catch((e) => e);
  assert.match(failure.message, /HTTP 401/);
  assert.equal(failure.status, 401);
  await assert.rejects(
    readJobnetPage(search, {
      fetch: async () => new Response('<html>', {headers: {'content-type': 'text/html'}}),
    }),
    /other than JSON/,
  );
  await assert.rejects(readJobnetDetail('https://jobnet.dk/find-job', {fetch}), /single Jobnet/);
  await assert.rejects(readJobnetDetail(posting, {fetch}), /only its own postings/);
  assert.equal(calls.length, 2, 'an external posting is not searched for');
});

test('a removed listing is unavailable and has no listing text', async () => {
  const gone = 'https://jobnet.dk/find-job/00000000-0000-0000-0000-000000000000';
  await assert.rejects(
    readJobnetDetail(gone, {fetch: async () => Response.json(response([], {totalJobAdCount: 0}))}),
    /no longer lists this posting; the address stays pending/,
  );
  await assert.rejects(
    readJobnetDetail(internal, {
      // A search that matches the id's text in another posting is not this listing.
      fetch: async () => Response.json(response(fixture.jobAds.slice(1), {totalJobAdCount: 1})),
    }),
    /no longer lists/,
  );
  await assert.rejects(
    readJobnetDetail(internal, {fetch: async () => new Response('', {status: 503})}),
    /HTTP 503; the address stays pending/,
  );
  const job = parseJobnetPage(search, fixture).jobs[0];
  assert.equal(jobnet.collector.detail({...job, description: ''}).listing, undefined);
});

test('the find-job template gives one API search per term, newest first', () => {
  const template = jobnet.search.template;
  const replay = recipeReplay(
    {
      entry: {kind: 'url_template', template},
      pagination: 'url_param',
      terms: ['udvikler', 'it-arkitekt'],
    },
    {query: 'x'},
  );
  assert.deepEqual(
    replay.searches.map((s) => jobnetApiUrl(s.url)),
    [search, search.replace('udvikler', 'it-arkitekt')],
  );
  const agent = siteSearchRecipe(jobnet.search, {
    entry: {
      kind: 'url_template',
      template: withSearchFilters(
        'https://jobnet.dk/find-job?searchString={query}&orderType=BestMatch',
        {
          regions: 'Syddanmark',
        },
      ),
    },
    pagination: 'none',
  });
  assert.deepEqual(agent.changed, ['template', 'pagination', 'ordering']);
  assert.equal(agent.recipe.ordering, 'newest_first');
  assert.equal(
    jobnetApiUrl(agent.recipe.entry.template.replace('{query}', 'udvikler')),
    `${api}?searchString=udvikler&regions=Syddanmark&orderType=PublicationDate&resultsPerPage=20&pageNumber=1`,
    'the extension restores its date sort and keeps the agent filter',
  );
});
