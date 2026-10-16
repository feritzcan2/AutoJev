import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'node-html-parser';
import {
  isWeWorkRemotelyUrl,
  collectWeWorkRemotelyPage,
  weWorkRemotelyResults,
} from '../app/site-extensions/weworkremotely.mjs';
import {
  siteExtensionFor,
  siteExtensionKind,
  applySiteExtension,
} from '../app/site-extensions/index.mjs';
import {searchFilterLabels, withSearchFilters} from '../app/site-extensions/search.mjs';

const results = 'https://weworkremotely.com/remote-jobs/search?term=backend+engineer';
const listing = (slug) => `https://weworkremotely.com/remote-jobs/${slug}`;
// A result card shaped like the site's (2026-10-16), with synthetic content.
const card = (slug, title, {company = 'Acme', hq = 'Berlin', tags = ['Full-Time']} = {}) =>
  `<li class=" new-listing-container feature "><div class="tooltip--flag-logo"><a href="/company/${company.toLowerCase()}"><span class="tooltip--flag-logo__tooltiptext">View Company Profile</span></a></div><a class="listing-link--unlocked" href="/remote-jobs/${slug}"><div class=" new-listing "><div class="new-listing__header"><h3 class="new-listing__header__title"><span class="new-listing__header__title__text">${title}</span></h3><div class="new-listing__header__icons"><p class="new-listing__header__icons__date"> 5d </p></div></div><p class="new-listing__company-name"> ${company} <img alt="" src="/i.svg"/></p><p class="new-listing__company-headquarters"><span class="new-listing__company-headquarters__label"><i></i> HQ:</span> ${hq} </p><div class="new-listing__categories">${tags.map((t) => `<p class="new-listing__categories__category"> ${t} </p>`).join('')}</div></div></a></li>`;
// The site's ad card: the same card class, links through ad-click redirects.
const ad = `<li id="listing-ad-13" class="feature feature--ad new-listing-container listing-ad listing-ad--listing-card"><a class="listing-ad-url" href="/listing_ads/13/click?pk=x&target=profile">Ad</a><a href="/listing_ads/13/click?pk=x&target=main"><span class="new-listing__header__title__text">Hire talent</span></a></li>`;
const page = ({
  count = '2',
  active = 'all',
  cards = [
    card('acme-backend-engineer', 'Backend Engineer'),
    card('beta-api-engineer', 'API Engineer', {
      company: 'Beta',
      hq: 'Remote',
      tags: ['Contract', 'Anywhere in the World'],
    }),
  ],
} = {}) =>
  `<html><body><nav><a href="/">Home</a><a href="/categories/remote-back-end-programming-jobs">Back-End</a></nav><form><div class="topForm__job-filter">${[
    'all',
    'hot',
    'boosted',
  ]
    .map(
      (option) =>
        `<button class="topForm__job-filter__option ${option === active ? 'is-active' : ''}" data-job-filter-option="${option}"><span>${option}</span><span class="topForm__job-filter__count" data-job-filter-count${option === active ? '' : ' hidden'}>${option === active ? count : ''}</span></button>`,
    )
    .join(
      '',
    )}</div></form><section class="jobs"><a href="/categories/remote-back-end-programming-jobs.rss">RSS</a><ul>${cards.join('')}${ad}</ul></section><a href="/remote-europe-jobs">Europe ↗</a></body></html>`;

function collect(t, html, href = results) {
  globalThis.document = parse(html);
  globalThis.location = {href};
  t.after(() => {
    delete globalThis.document;
    delete globalThis.location;
  });
  return collectWeWorkRemotelyPage();
}

test('search cards become their listing links, with the card facts and one complete page', (t) => {
  const raw = collect(t, page());
  assert.equal(raw.total, '2');
  // The ad card is counted apart and is not a result.
  assert.equal(raw.ads, 1);
  assert.equal(raw.cards.length, 2);
  const read = weWorkRemotelyResults(raw);
  assert.deepEqual(read.listings, [
    {
      url: listing('acme-backend-engineer'),
      text: 'Backend Engineer',
      siteCard: 'Backend Engineer · Acme · Berlin · Full-Time · 5d',
    },
    {
      url: listing('beta-api-engineer'),
      text: 'API Engineer',
      siteCard: 'API Engineer · Beta · Remote · Contract · Anywhere in the World · 5d',
    },
  ]);
  assert.deepEqual(read.pagination, [
    {text: '1 of 1', url: results, current: true, disabled: false, kind: 'link'},
  ]);
});

test('company, category, RSS and region links are not listings', (t) => {
  const read = weWorkRemotelyResults(collect(t, page()));
  const document = {
    url: results,
    links: [
      {url: listing('acme-backend-engineer'), text: 'Backend Engineer 5d Acme'},
      {url: 'https://weworkremotely.com/company/acme', text: ''},
      {
        url: 'https://weworkremotely.com/categories/remote-back-end-programming-jobs',
        text: 'Back-End',
      },
      {url: 'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss', text: ''},
      {url: 'https://weworkremotely.com/remote-europe-jobs', text: 'Europe ↗'},
    ],
    pagination: [],
  };
  const marked = applySiteExtension(document, read, 'weworkremotely');
  assert.deepEqual(
    marked.links.filter((l) => l.listing).map((l) => l.url),
    [listing('acme-backend-engineer'), listing('beta-api-engineer')],
  );
  assert.equal(marked.links.filter((l) => !l.listing).length, 4);
  assert.equal(marked.siteExtension, 'weworkremotely');
});

test('a boosted listing shown twice is one listing; the page counts both cards', (t) => {
  const twice = card('acme-backend-engineer', 'Backend Engineer');
  const read = weWorkRemotelyResults(collect(t, page({count: '2', cards: [twice, twice]})));
  assert.deepEqual(
    read.listings.map((l) => l.url),
    [listing('acme-backend-engineer')],
  );
  assert.equal(read.pagination[0].text, '1 of 1');
});

test('without a matching result count the page is not declared complete', (t) => {
  assert.equal(weWorkRemotelyResults(collect(t, page({count: '75'}))).pagination, null);
  // The hot tab states its own count; the hidden "All jobs" count is not read.
  const hot = collect(t, page({active: 'hot', count: '2'}));
  assert.equal(hot.total, '2');
  assert.equal(weWorkRemotelyResults({...hot, total: null}).pagination, null);
});

test('no cards, a card without one listing link, or a listing page leave the generic reader', (t) => {
  assert.equal(weWorkRemotelyResults(null), null);
  assert.equal(weWorkRemotelyResults(collect(t, page({cards: []}))), null);
  const broken = card('acme-backend-engineer', 'Backend Engineer').replace(
    'href="/remote-jobs/acme-backend-engineer"',
    'href="/company/acme/jobs"',
  );
  assert.equal(weWorkRemotelyResults(collect(t, page({cards: [broken]}))), null);
  // A listing page shows similar listings in the same cards, without the results toolbar.
  const similar = collect(
    t,
    `<html><body><h1>Backend Engineer</h1><ul>${card('beta-api-engineer', 'API Engineer')}</ul></body></html>`,
    listing('acme-backend-engineer'),
  );
  assert.equal(similar.cards.length, 1);
  assert.equal(weWorkRemotelyResults(similar), null);
});

test('only weworkremotely.com is matched and it reads in the browser with its search', () => {
  assert.equal(isWeWorkRemotelyUrl(results), true);
  assert.equal(isWeWorkRemotelyUrl('https://www.weworkremotely.com/'), true);
  for (const url of [
    'http://weworkremotely.com/',
    'https://weworkremotely.com.evil.test/',
    'https://evilweworkremotely.com/',
    'not a url',
  ])
    assert.equal(isWeWorkRemotelyUrl(url), false, url);
  assert.equal(siteExtensionFor(results).id, 'weworkremotely');
  const kind = siteExtensionKind(results, 'job-search');
  assert.equal(kind.kind, 'browser');
  assert.equal(kind.search.pagination, 'none');
  assert.equal(kind.search.ordering, undefined);
  const recent = withSearchFilters(kind.search.template, {sort: 'Past Week'});
  assert.equal(recent, 'https://weworkremotely.com/remote-jobs/search?term={query}&sort=Past+Week');
  assert.deepEqual(searchFilterLabels(kind.search, recent), ['Posted: Past week']);
});
