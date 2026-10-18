import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import jobindex, {
  jobindexRequest,
  robotsAllows,
  parseJobindexFeed,
  jobindexSearchPage,
  jobindexDetailPage,
  readJobindex,
} from '../app/site-extensions/jobindex.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev/results.mjs';
import {SiteWaitError} from '../app/browser/site-access.mjs';

const fixture = (name, encoding = 'utf8') =>
  readFileSync(new URL(`./fixtures/jobindex/${name}`, import.meta.url), encoding);
// The live feed is ISO-8859-1 with every non-ASCII character as an entity;
// one raw byte checks that the declared charset is used.
const feedBytes = () =>
  Buffer.from(fixture('feed.xml', 'latin1').replace('FE s&#xF8;ger', 'FE søger'), 'latin1');
const feedResponse = (init = {}) =>
  new Response(feedBytes(), {headers: {'content-type': 'application/rss+xml'}, ...init});
const search = 'https://www.jobindex.dk/jobsoegning?q=python';
const ad = 'https://www.jobindex.dk/jobannonce/h1708450';
const siteAccess = () => ({
  begin: () => 'token',
  pace: () => 0,
  complete: (_url, _token, info) =>
    info.reason ? {site: 'jobindex.dk', reason: info.reason, retryAt: 1, waiting: true} : null,
});

test('searches read the RSS feed of q only; robots-disallowed searches are refused', () => {
  assert.deepEqual(jobindexRequest(search), {
    kind: 'search',
    url: search,
    feed: 'https://www.jobindex.dk/jobsoegning.rss?q=python',
    refused: null,
  });
  assert.equal(jobindexRequest('https://jobindex.dk/jobsoegning.rss?q=python').refused, null);
  assert.equal(jobindexRequest('https://www.jobindex.dk/jobsoegning?q=data+analyst').refused, null);
  assert.equal(
    jobindexRequest('https://www.jobindex.dk/jobsoegning?q=data%20analyst').feed,
    'https://www.jobindex.dk/jobsoegning.rss?q=data+analyst',
    'the feed address uses form encoding, like recipes',
  );
  assert.equal(
    jobindexRequest('https://www.jobindex.dk/jobsoegning').feed,
    'https://www.jobindex.dk/jobsoegning.rss',
  );
  for (const [address, reason] of [
    ['https://www.jobindex.dk/jobsoegning?q=python&page=2', /"page" parameter/],
    ['https://www.jobindex.dk/jobsoegning?q=python&sort=date', /"sort" parameter/],
    ['https://www.jobindex.dk/jobsoegning?jobage=7&q=python', /"jobage" parameter/],
    ['https://www.jobindex.dk/jobsoegning.rss?q=python&geoareaid=15', /"geoareaid" parameter/],
    ['https://www.jobindex.dk/jobsoegning?q=senior+data+analyst', /three or more words/],
    ['https://www.jobindex.dk/jobsoegning?q=senior%20data%20analyst', /three or more words/],
    ['https://www.jobindex.dk/jobsoegning?q=ofir', /search term "ofir"/],
    ['https://www.jobindex.dk/jobsoegning?q=www.example.dk', /search term/],
  ])
    assert.match(jobindexRequest(address).refused, reason, address);
  assert.equal(robotsAllows('https://www.jobindex.dk/jobsoegning.rss?q=c%2B%2B+developer'), true);
  assert.equal(robotsAllows('https://www.jobindex.dk/jobsoegning?q=a&b=1&c=2'), false);
  assert.equal(robotsAllows('https://www.jobindex.dk/jobsoegning?q=a@b'), false);
});

test('listings use /jobannonce/<tid>; other Jobindex addresses and look-alike hosts are not read', () => {
  for (const address of [
    ad,
    'https://www.jobindex.dk/jobannonce/h1708450/senioranalytiker-til-taenketanken',
    'https://www.jobindex.dk/vis-job/h1708450',
    'https://jobindex.dk/vis-job/h1708450/',
  ])
    assert.deepEqual(
      jobindexRequest(address),
      {kind: 'detail', tid: 'h1708450', fetch: ad},
      address,
    );
  for (const other of [
    'https://www.jobindex.dk/jobannonce/korrektur/123',
    'https://www.jobindex.dk/jobannonce/embed/h1708450',
    'https://www.jobindex.dk/jobsoegning/it?q=python',
    'https://www.jobindex.dk/virksomhed/71975/mandag-morgen-aps',
    'https://www.jobindex.dk/',
    'http://www.jobindex.dk/jobsoegning?q=python',
    'https://www.jobindex.dk.evil.test/jobsoegning?q=python',
    'https://evil-jobindex.dk/jobsoegning?q=python',
    'not a url',
  ]) {
    assert.equal(jobindexRequest(other), null, other);
    assert.equal(jobindex.http.handles(other), false, other);
  }
  assert.equal(jobindex.matches('https://www.jobindex.dk.evil.test/'), false);
  assert.equal(jobindex.http.handles(search), true);
  assert.equal(jobindex.search.ordering, 'newest_first');
  assert.equal(jobindex.search.pagination, 'none');
});

test('the feed lists its items as listings, newest first, on a single page', () => {
  const xml = new TextDecoder('latin1').decode(feedBytes());
  const feed = parseJobindexFeed(xml);
  assert.equal(feed.title, 'Jobindex - Ledige job indeholdende ordet python');
  assert.deepEqual(feed.jobs[1], {
    url: 'https://www.jobindex.dk/jobannonce/h1699736',
    title: 'Software Engineer, Vision and Robotics',
    company: 'BEUMER Group A/S',
    location: 'Aarhus N',
    teaser:
      'Develop software solutions for vision and robotics in a multidisciplinary Robot Product Team. Work with C#, Python, 3D vision, point cloud processing and robotic systems while taking responsibility for the full software development process. Contribute to product development, code quality, testing, i',
    postedAt: '2026-10-16',
  });
  assert.equal(feed.jobs[2].company, 'Forsvarets Efterretningstjeneste');
  assert.match(feed.jobs[2].title, /^FE søger DevOps-profiler/);
  assert.equal(feed.jobs[2].location, '', 'an item without an area states no location');
  const read = jobindexSearchPage(search, xml);
  assert.deepEqual(
    read.links.map((l) => [l.url, l.listing]),
    [
      ['https://www.jobindex.dk/jobannonce/h1708450', true],
      ['https://www.jobindex.dk/jobannonce/h1699736', true],
      ['https://www.jobindex.dk/jobannonce/h1708262', true],
    ],
  );
  assert.match(read.links[0].siteCard, /Mandag Morgen ApS · København K · published 2026-10-16/);
  assert.match(read.text, /robots\.txt disallows paging/);
  assert.equal(read.url, search);
  assert.deepEqual(
    read.pagination.map((p) => [p.text, p.current]),
    [['1 of 1', true]],
  );
  const position = resultPageSummary(read, {id: 'e1'}, []).position;
  assert.equal(observedNextPage(read, position), null, 'robots.txt forbids a next page');
  const empty = jobindexSearchPage(search, xml.replace(/<item>[\s\S]*<\/item>/, ''));
  assert.deepEqual(empty.links, []);
  assert.match(empty.text, /no results/);
  assert.throws(
    () => jobindexSearchPage(search, '<html><body>Fejl</body></html>'),
    /did not return its RSS feed/,
  );
});

test('a hosted ad reads its body and only the facts it states', () => {
  const read = jobindexDetailPage(ad, fixture('hosted-ad.html'));
  assert.equal(read.url, ad);
  assert.equal(
    read.title,
    'Senioranalytiker til Tænketanken Mandag Morgen – kvantitativ analyse og projektledelse @ Mandag Morgen ApS',
  );
  assert.deepEqual(read.listing.fields, {
    company: 'Mandag Morgen ApS',
    location: 'København K',
    postedAt: '2026-10-16',
    deadline: '2026-11-03',
    employmentType: 'Fastansættelse',
    workingHours: 'Fuldtid',
  });
  assert.doesNotMatch(read.text, /Ikke oplyst|Gem job|Find job|Jobindex A\/S/);
  assert.match(read.text, /Tænketanken Mandag Morgen søger en senioranalytiker/);
  // An employer-designed ad page without Jobindex's layout stays an ordinary page.
  const designed = jobindexDetailPage(
    ad,
    '<html><head><title>Quantitative Developer</title></head><body><h1>Quantitative Developer</h1><p>Our own layout.</p></body></html>',
  );
  assert.equal(designed.listing, undefined);
  assert.match(designed.text, /Our own layout/);
  const removed = jobindexDetailPage(ad, '');
  assert.match(removed.text, /not found/);
  assert.equal(removed.listing, undefined);
  const expired = jobindexDetailPage(ad, '', {archived: true});
  assert.match(expired.text, /expired/);
  assert.equal(expired.listing, undefined);
});

test('reads go through the shared site access rules and keep the queued address', async () => {
  const requested = [];
  const fetch = async (url, options) => {
    requested.push([url, options.redirect]);
    assert.match(options.headers['User-Agent'], /AutoJev/);
    assert.ok(options.signal instanceof AbortSignal);
    return url.includes('.rss') ? feedResponse() : new Response(fixture('hosted-ad.html'));
  };
  const read = await readJobindex(search, {fetch, siteAccess: siteAccess()});
  assert.equal(read.links.length, 3);
  assert.match(read.text, /FE søger DevOps/, 'the feed is decoded as ISO-8859-1');
  assert.ok((await readJobindex('https://www.jobindex.dk/vis-job/h1708450', {fetch})).listing);
  assert.deepEqual(requested, [
    ['https://www.jobindex.dk/jobsoegning.rss?q=python', 'follow'],
    [ad, 'manual'],
  ]);

  const controller = new AbortController();
  let signal;
  await readJobindex(search, {
    signal: controller.signal,
    fetch: async (_url, options) => {
      signal = options.signal;
      return feedResponse();
    },
  });
  controller.abort();
  assert.equal(signal.aborted, true, 'the fetch receives the caller signal');

  for (const status of [403, 429]) {
    const error = await readJobindex(search, {
      fetch: async () => new Response('', {status}),
      siteAccess: siteAccess(),
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError, String(status));
  }
  await assert.rejects(
    readJobindex(search, {fetch: async () => new Response('<html>Fejl</html>', {status: 200})}),
    /did not return its RSS feed/,
  );
  await assert.rejects(
    readJobindex(search, {fetch: async () => new Response('', {status: 500})}),
    /HTTP 500/,
  );
  let fetched = 0;
  await assert.rejects(
    readJobindex(`${search}&page=2`, {fetch: async () => (fetched++, feedResponse())}),
    /robots\.txt disallows this search address/,
  );
  assert.equal(fetched, 0, 'a refused search sends no request');
  await assert.rejects(readJobindex('https://www.jobindex.dk/'), /does not handle/);
});

test('redirects: the archive is not fetched, an employer page is read only for its JobPosting', async () => {
  const requested = [];
  const redirecting = (location, final) => async (url) => {
    requested.push(url);
    return url === ad
      ? new Response(null, {status: 302, headers: {location}})
      : new Response(final);
  };
  const expired = await readJobindex(ad, {
    fetch: redirecting('https://www.jobindex.dk/arkiv/vis/h1708450'),
  });
  assert.match(expired.text, /expired/);
  assert.equal(expired.listing, undefined);
  assert.deepEqual(requested, [ad], 'the archive is not requested');

  requested.length = 0;
  const employer = 'https://jobs.example.com/job/42';
  const external = await readJobindex(ad, {
    fetch: redirecting(
      employer,
      '<html><head><title>Release Manager</title></head><body><h1>Release Manager</h1><p>Ship it.</p></body></html>',
    ),
  });
  assert.deepEqual(requested, [ad, employer]);
  assert.equal(
    external,
    null,
    'a page that may render its ad with scripts is left to the browser tab',
  );

  const body = 'Build release pipelines for our robots and own the release calendar. '.repeat(4);
  const posting = await readJobindex(ad, {
    fetch: redirecting(
      employer,
      `<html><head><title>Release Manager</title><script type="application/ld+json">${JSON.stringify(
        {
          '@type': 'JobPosting',
          title: 'Release Manager',
          description: body,
          hiringOrganization: {name: 'Universal Robots'},
          jobLocation: {address: {addressLocality: 'Odense', addressCountry: 'DK'}},
        },
      )}</script></head><body><h1>Release Manager</h1></body></html>`,
    ),
  });
  assert.equal(posting.url, ad);
  assert.deepEqual(posting.listing.fields, {company: 'Universal Robots', location: 'Odense, DK'});

  const gone = await readJobindex('https://www.jobindex.dk/jobannonce/h9999999', {
    fetch: async () =>
      new Response('<html><title>Siden kan ikke findes</title></html>', {status: 404}),
  });
  assert.match(gone.text, /not found/);
  assert.equal(gone.listing, undefined);
});
