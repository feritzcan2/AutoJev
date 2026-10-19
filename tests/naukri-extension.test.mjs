import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parse} from 'node-html-parser';
import naukri, {
  isNaukriUrl,
  collectNaukriPage,
  naukriResults,
} from '../app/site-extensions/naukri.mjs';
import {
  SITE_EXTENSIONS,
  siteExtensionFor,
  siteExtensionKind,
  applySiteExtension,
} from '../app/site-extensions/index.mjs';
import {searchFilterLabels, withSearchFilters} from '../app/site-extensions/search.mjs';
import {jobPostingDetail, jobPostingHtml} from '../app/site-extensions/job-posting.mjs';

// Saved from Chrome 2026-10-16 and trimmed: the results header, the first
// cards, the page's ItemList (cut to those cards) and the page links.
const fixture = (name) =>
  fs.readFileSync(new URL(`./fixtures/naukri/${name}`, import.meta.url), 'utf8');
const page1 = 'https://www.naukri.com/software-developer-jobs';
const page2 = 'https://www.naukri.com/software-developer-jobs-2';
const listing = (slug) => `https://www.naukri.com/job-listings-${slug}`;
const autosar = listing(
  'autosar-base-software-developer-hcltech-bengaluru-3-to-5-years-240826029290',
);

function collect(t, html, href) {
  globalThis.document = parse(html);
  globalThis.location = {href};
  t.after(() => {
    delete globalThis.document;
    delete globalThis.location;
  });
  return collectNaukriPage();
}

test('result cards become their listing links with the card facts and the next page', (t) => {
  const raw = collect(t, fixture('search-1.html'), page1);
  assert.equal(raw.url, page1);
  assert.equal(raw.range, '1 - 19 of 42417');
  assert.equal(raw.cards.length, 4);
  const read = naukriResults(raw);
  assert.deepEqual(read.listings[0], {
    url: autosar,
    text: 'Autosar Base Software Developer',
    siteCard: 'Autosar Base Software Developer · HCLTech · 3-5 Yrs · Bengaluru · 1 week ago',
  });
  assert.equal(read.listings.length, 4);
  assert.deepEqual(read.pagination, [
    {text: '1 of 2121', url: page1, current: true, disabled: false, kind: 'link'},
    {text: '2', url: page2, current: false, disabled: false, kind: 'link'},
  ]);
});

test('page 2 states its range, pay and walk-in cards, and links page 3 with the search kept', (t) => {
  const raw = collect(t, fixture('search-2.html'), page2);
  assert.equal(raw.range, '21 - 39 of 42417');
  const read = naukriResults(raw);
  assert.equal(
    read.listings[0].siteCard,
    'Urgent requirements For Software Developer (fresher) - Chennai · Z Tech Solutions · 0-1 Yrs · 1.75-3 Lacs PA · Chennai · 3+ weeks ago',
  );
  assert.equal(
    read.listings[2].siteCard,
    'Walk-in || Software Developer · Arissa India · Walk-in · 21 Oct - 23 Oct · Bengaluru(8th Phase JP Nagar) · Few hours ago',
  );
  assert.deepEqual(
    read.pagination.map((p) => [p.text, p.url]),
    [
      ['2 of 2121', page2],
      ['3', 'https://www.naukri.com/software-developer-jobs-3'],
    ],
  );
  // The page links carry only the path; the query of the address is kept.
  const filtered = `${page2}?k=software+developer&wfhType=2`;
  const next = naukriResults({...raw, url: filtered}).pagination[1].url;
  assert.equal(
    next,
    'https://www.naukri.com/software-developer-jobs-3?k=software+developer&wfhType=2',
  );
});

test('tracking parameters and fragments are dropped from listing addresses', (t) => {
  const raw = collect(t, fixture('search-1.html'), page1);
  raw.cards[0].href = `${autosar}?src=jobsearchDesk&sid=17607&xp=1&px=1#apply`;
  raw.items[0] = `${autosar}?src=seo`;
  const read = naukriResults(raw);
  assert.equal(read.listings[0].url, autosar);
  assert.notEqual(read.pagination, null);
});

test('the last page has no next page, and none past the stated page count', (t) => {
  const raw = collect(t, fixture('search-2.html'), page2);
  const last = {
    ...raw,
    url: 'https://www.naukri.com/software-developer-jobs-2121',
    range: '42401 - 42417 of 42417',
    items: null,
    pages: [
      {text: '2120', href: '/software-developer-jobs-2120', selected: false},
      {text: '2121', href: '/software-developer-jobs-2121', selected: true},
    ],
  };
  assert.deepEqual(naukriResults({...last, next: null}).pagination, [
    {text: '2121 of 2121', url: last.url, current: true, disabled: false, kind: 'link'},
  ]);
  // A Next link on the last page the count allows is not followed.
  assert.equal(
    naukriResults({...last, next: '/software-developer-jobs-2122'}).pagination.length,
    1,
  );
  // A single page of results without page links.
  const one = {
    ...raw,
    url: 'https://www.naukri.com/rare-skill-jobs',
    range: '1 - 3 of 3',
    items: null,
    pages: null,
    next: null,
  };
  assert.deepEqual(naukriResults(one).pagination, [
    {text: '1 of 1', url: one.url, current: true, disabled: false, kind: 'link'},
  ]);
});

test('a redirected or past-the-end address never reads as page N with page-1 results', (t) => {
  // The site answers /software-developer-jobs-2000 with page 1. If the address
  // still said 2000 while page 1 shows, the range and the marked page disagree.
  const raw = collect(
    t,
    fixture('search-1.html'),
    'https://www.naukri.com/software-developer-jobs-2000',
  );
  const read = naukriResults(raw);
  assert.equal(read.listings.length, 4);
  assert.equal(read.pagination, null);
  // After the redirect the document address is page 1 and reads as page 1.
  assert.equal(naukriResults({...raw, url: page1}).pagination[0].text, '1 of 2121');
  // The marked page link must agree with the address and the range too.
  const page2raw = collect(t, fixture('search-2.html'), page2);
  const marked = page2raw.pages.map((p) => ({...p, selected: p.text === '1'}));
  assert.equal(naukriResults({...page2raw, pages: marked}).pagination, null);
  assert.equal(naukriResults({...page2raw, range: '1 - 19 of 42417'}).pagination, null);
  // A Next link that does not lead to the following page is not used.
  assert.equal(naukriResults({...page2raw, next: '/software-developer-jobs-7'}).pagination, null);
});

test('a stale ItemList or a missing range keeps the cards but not the paging', (t) => {
  const raw = collect(t, fixture('search-1.html'), page1);
  assert.equal(naukriResults({...raw, items: [...raw.items].reverse()}).pagination, null);
  assert.equal(naukriResults({...raw, items: raw.items.slice(1)}).pagination, null);
  assert.equal(naukriResults({...raw, range: null}).pagination, null);
  assert.equal(naukriResults({...raw, range: '1 - 19 of 42417'}).listings.length, 4);
  // Without an ItemList the range and the page links still decide.
  assert.equal(naukriResults({...raw, items: null}).pagination.length, 2);
});

test('no cards, a card without its listing link, or a listing page leave the generic reader', (t) => {
  assert.equal(naukriResults(null), null);
  const raw = collect(t, fixture('search-1.html'), page1);
  assert.equal(naukriResults({...raw, cards: []}), null);
  const broken = (patch) =>
    naukriResults({...raw, cards: [{...raw.cards[0], ...patch}, ...raw.cards.slice(1)]});
  assert.equal(broken({href: null}), null);
  assert.equal(broken({href: 'https://www.naukri.com/hcltech-jobs-careers-460'}), null);
  assert.equal(broken({id: '999999999999'}), null);
  assert.equal(broken({href: autosar.replace('www.naukri.com', 'www.naukri.com.evil.test')}), null);
  assert.equal(
    naukriResults({...raw, url: 'https://naukri.com.evil.test/software-developer-jobs'}),
    null,
  );
  const detail = collect(t, fixture('listing.html'), autosar);
  assert.equal(detail.cards.length, 0);
  assert.equal(naukriResults(detail), null);
});

test('company boards, ratings, reviews, filters and page links are not listings', (t) => {
  const read = naukriResults(collect(t, fixture('search-1.html'), page1));
  const document = {
    url: page1,
    links: [
      {url: autosar, text: 'Autosar Base Software Developer'},
      {url: 'https://www.naukri.com/hcltech-jobs-careers-460', text: 'HCLTech'},
      {
        url: 'https://www.ambitionbox.com/reviews/hcl-technologies-reviews?utm_campaign=srp_ratings&utm_medium=desktop&utm_source=naukri',
        text: '50435 Reviews',
      },
      {
        url: 'https://www.naukri.com/software-developer-jobs?wfhType=2&src=discovery_topCategoriesWdgt_SRP_srch',
        text: 'Remote Developer Jobs',
      },
      {url: page2, text: '2'},
    ],
    pagination: [],
  };
  const marked = applySiteExtension(document, read, naukri.id);
  assert.deepEqual(
    marked.links.filter((l) => l.listing).map((l) => l.url),
    read.listings.map((l) => l.url),
  );
  assert.equal(marked.links.filter((l) => !l.listing).length, 4);
  assert.equal(marked.siteExtension, 'naukri');
  assert.equal(marked.pagination, read.pagination);
});

test('only naukri.com is matched; it reads in the browser with its search', () => {
  assert.equal(isNaukriUrl(page1), true);
  assert.equal(isNaukriUrl('https://naukri.com/'), true);
  for (const url of [
    'http://www.naukri.com/',
    'https://www.naukri.com.evil.test/',
    'https://evilnaukri.com/',
    'https://www.naukrigulf.com/',
    'not a url',
  ])
    assert.equal(isNaukriUrl(url), false, url);
  assert.equal(naukri.id, 'naukri');
  assert.equal(naukri.dom.collect, collectNaukriPage);
  assert.equal(naukri.search.ordering, 'newest_first');
  const remote = withSearchFilters(naukri.search.template, {wfhType: '2'});
  assert.equal(remote, 'https://www.naukri.com/{query}-jobs?sort=f&wfhType=2');
  assert.deepEqual(searchFilterLabels(naukri.search, remote), ['Work mode: Remote']);
});

test(
  'the registry finds the extension once it is registered',
  {skip: !SITE_EXTENSIONS.includes(naukri)},
  () => {
    assert.equal(siteExtensionFor(page1)?.id, 'naukri');
    assert.equal(siteExtensionKind(page1)?.kind, 'browser');
  },
);

test('the listing page carries one current JobPosting the generic reader accepts', () => {
  const job = jobPostingDetail(
    jobPostingHtml(fixture('listing.html')),
    Date.parse('2026-10-16T12:00:00Z'),
  );
  assert.equal(job?.title, 'Autosar Base Software Developer');
  assert.equal(job.company, 'HCLTech');
  assert.ok(job.description.length > 2000);
  assert.equal(job.fields.postedAt, '2026-10-06');
  assert.equal(job.fields.employmentType, 'Full Time, Permanent');
});
