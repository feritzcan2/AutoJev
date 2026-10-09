import test from 'node:test';
import assert from 'node:assert/strict';
import {
  linkedInGuestRequest,
  parseJobCards,
  linkedInSearchPage,
  linkedInDetailPage,
  readLinkedInGuest,
  LINKEDIN_PAGE_SIZE,
} from '../app/site-extensions/linkedin.mjs';
import {resultPageSummary, observedNextPage} from '../app/jev-results.mjs';
import {SiteWaitError} from '../app/site-access.mjs';

const search =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=senior+backend+engineer&location=Germany&sortBy=DD';
const card = (
  id,
  title,
  {company = 'Acme', location = 'Berlin, Germany', date = '2026-10-04'} = {},
) =>
  `<li><div class="base-card job-search-card" data-entity-urn="urn:li:jobPosting:${id}"><a class="base-card__full-link absolute" href="https://de.linkedin.com/jobs/view/${title.toLowerCase().replace(/\W+/g, '-')}-at-acme-${id}?position=1&amp;pageNum=0&amp;trackingId=abc"><span class="sr-only">${title}</span></a><div class="base-search-card__info"><h3 class="base-search-card__title">${title}</h3><h4 class="base-search-card__subtitle"><a href="https://de.linkedin.com/company/acme?trk=x">${company}</a></h4><div class="base-search-card__metadata"><span class="job-search-card__location">${location}</span><time class="job-search-card__listdate" datetime="${date}">1 day ago</time></div></div></div></li>`;
const cards = (n) =>
  Array.from({length: n}, (_, i) => card(String(4000000000 + i), `Backend Engineer ${i}`)).join('');
const detail = `<section class="top-card-layout"><h2 class="top-card-layout__title">Senior Backend Engineer</h2><a class="topcard__org-name-link topcard__flavor--black-link" href="https://de.linkedin.com/company/acme">Acme &amp; Co</a><span class="topcard__flavor topcard__flavor--bullet">Berlin, Germany</span></section><div class="description__text"><div class="show-more-less-html__markup"><p>Build APIs in <strong>Go</strong>.</p><ul><li>5+ years backend</li><li>English required</li></ul></div></div><ul><li><h3 class="description__job-criteria-subheader">Seniority level</h3><span class="description__job-criteria-text description__job-criteria-text--criteria">Mid-Senior level</span></li></ul>`;

test('only LinkedIn guest searches and job postings use the reader', () => {
  assert.equal(linkedInGuestRequest(search).kind, 'search');
  assert.deepEqual(
    linkedInGuestRequest(
      'https://de.linkedin.com/jobs/view/senior-backend-engineer-at-acme-4012345678?trk=x',
    ),
    {
      kind: 'detail',
      id: '4012345678',
      url: 'https://de.linkedin.com/jobs/view/senior-backend-engineer-at-acme-4012345678?trk=x',
    },
  );
  assert.equal(
    linkedInGuestRequest('https://www.linkedin.com/jobs/view/4012345678/').id,
    '4012345678',
  );
  assert.equal(
    linkedInGuestRequest('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4012345678').id,
    '4012345678',
  );
  for (const other of [
    'https://www.linkedin.com/jobs/search/?keywords=x',
    'https://www.linkedin.com/feed/',
    'https://linkedin.example.com/jobs/view/4012345678',
    'http://www.linkedin.com/jobs/view/4012345678',
    'https://evil.test/jobs/view/4012345678',
    'not a url',
  ])
    assert.equal(linkedInGuestRequest(other), null, other);
});

test('search cards become marked listing links with their card text and stable addresses', () => {
  const parsed = parseJobCards(
    card('4012345678', 'Staff Engineer &amp; Lead', {company: 'Acme &amp; Co'}) +
      '<li>broken card without urn</li>',
  );
  assert.deepEqual(
    parsed,
    [
      {
        id: '4012345678',
        title: 'Staff Engineer & Lead',
        company: 'Acme & Co',
        location: 'Berlin, Germany',
        date: '2026-10-04',
        url: 'https://de.linkedin.com/jobs/view/staff-engineer-amp-lead-at-acme-4012345678',
      },
    ],
    'tracking parameters are dropped, entities decoded',
  );
  const page = linkedInSearchPage(search, parsed);
  assert.deepEqual(page.links, [
    {text: 'Staff Engineer & Lead', url: parsed[0].url, listing: true},
  ]);
  assert.match(
    page.text,
    /Link: Staff Engineer & Lead — https:\/\/de\.linkedin\.com\/jobs\/view\/staff-engineer-amp-lead-at-acme-4012345678\nAcme & Co · Berlin, Germany · posted 2026-10-04/,
  );
  assert.equal(page.reading.readiness.loading, false);
  assert.equal(page.status, 'ready');
});

test('a full results page links the next offset; a short or empty page ends the search', () => {
  const full = linkedInSearchPage(search, parseJobCards(cards(LINKEDIN_PAGE_SIZE)));
  const position = resultPageSummary(full, {id: 'e1'}, []).position,
    next = observedNextPage(full, position);
  assert.equal(position.currentPage, 1);
  assert.equal(new URL(next.url).searchParams.get('start'), '10');
  assert.equal(
    new URL(next.url).searchParams.get('keywords'),
    'senior backend engineer',
    'filters stay on the next page',
  );
  const second = linkedInSearchPage(next.url, parseJobCards(cards(3)));
  const secondPosition = resultPageSummary(second, {id: 'e2'}, []).position;
  assert.equal(secondPosition.currentPage, 2);
  assert.equal(observedNextPage(second, secondPosition), null);
  const empty = linkedInSearchPage(next.url, []);
  assert.deepEqual(empty.links, []);
  assert.match(empty.text, /no further results/);
  assert.equal(
    empty.pagination.length,
    1,
    'the page still reports its position, so it is not mistaken for a shell without links',
  );
});

test('a posting reads as text with its criteria; a removed posting says so', () => {
  const page = linkedInDetailPage('https://de.linkedin.com/jobs/view/x-4012345678', detail);
  assert.equal(
    page.url,
    'https://de.linkedin.com/jobs/view/x-4012345678',
    'the posting keeps the address it was queued under',
  );
  assert.equal(page.title, 'Senior Backend Engineer @ Acme & Co');
  assert.match(
    page.text,
    /^Senior Backend Engineer\nAcme & Co · Berlin, Germany\nSeniority level: Mid-Senior level\n\nBuild APIs in Go \.?\n?• 5\+ years backend\n• English required$/,
  );
  assert.match(
    linkedInDetailPage(
      'https://www.linkedin.com/jobs/view/1234567',
      detail.replace(
        '<section',
        '<span class="closed-job__flavor">No longer accepting applications</span><section',
      ),
    ).text,
    /No longer accepting applications/,
  );
  assert.match(
    linkedInDetailPage('https://www.linkedin.com/jobs/view/1234567', '').text,
    /not found/,
  );
});

test('guest reads use the shared site access rules and the guest endpoints', async () => {
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
        ? {site: 'linkedin.com', reason: info.reason, retryAt: 1, waiting: true}
        : null;
    },
  };
  const fetch = async (url, options) => {
    requested.push(url);
    assert.match(options.headers['User-Agent'], /AutoJev/);
    return url.includes('jobPosting')
      ? new Response(detail, {status: 200})
      : new Response(cards(2), {status: 200});
  };
  const results = await readLinkedInGuest(search, {fetch, siteAccess});
  assert.equal(results.links.length, 2);
  assert.equal(requested[0], search);
  const posting = await readLinkedInGuest('https://de.linkedin.com/jobs/view/x-4012345678?trk=a', {
    fetch,
    siteAccess,
  });
  assert.equal(
    requested[1],
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4012345678',
    'postings come from the light guest endpoint',
  );
  assert.equal(posting.url, 'https://de.linkedin.com/jobs/view/x-4012345678?trk=a');
  assert.deepEqual(events.at(-1), [
    'complete',
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4012345678',
    'token',
    {status: 200},
  ]);
  for (const status of [429, 999]) {
    const error = await readLinkedInGuest(search, {
      fetch: async () => ({status, ok: false, text: async () => ''}),
      siteAccess,
    }).catch((e) => e);
    assert.ok(error instanceof SiteWaitError);
    assert.equal(error.code, 'SITE_WAIT');
    assert.equal(error.wait.reason, 'rate_limit');
    assert.equal(error.url, search);
  }
  const waiting = {
    begin: () => {
      throw new SiteWaitError({site: 'linkedin.com', message: 'wait'});
    },
    pace: () => 0,
    complete: () => null,
  };
  let sent = false;
  await assert.rejects(
    readLinkedInGuest(search, {
      fetch: async () => {
        sent = true;
        return new Response('');
      },
      siteAccess: waiting,
    }),
    (e) => e.code === 'SITE_WAIT',
  );
  assert.equal(sent, false, 'an active site wait stops the request before it is sent');
  assert.match(
    (
      await readLinkedInGuest('https://www.linkedin.com/jobs/view/4012345678', {
        fetch: async () => new Response('', {status: 404}),
        siteAccess,
      })
    ).text,
    /not found/,
  );
  await assert.rejects(
    readLinkedInGuest(search, {fetch: async () => new Response('', {status: 500}), siteAccess}),
    /HTTP 500/,
  );
  let waited = 0;
  await readLinkedInGuest(search, {
    fetch,
    siteAccess: {...siteAccess, pace: () => 4000},
    wait: async (ms) => {
      waited = ms;
    },
  });
  assert.equal(waited, 4000, 'pacing after an incident spaces the request');
  await assert.rejects(readLinkedInGuest('https://example.test/jobs', {fetch}), /does not handle/);
});
