import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'node-html-parser';
import jobbankDk, {
  isJobbankDkUrl,
  collectJobbankDkPage,
  jobbankDkResults,
} from '../app/site-extensions/jobbank-dk.mjs';
import {
  siteExtensionFor,
  siteExtensionKind,
  applySiteExtension,
} from '../app/site-extensions/index.mjs';
import {searchFilterLabels, withSearchFilters} from '../app/site-extensions/search.mjs';

// Results pages 1 and 2 of key=udvikler, saved from Chrome 2026-10-16 and
// trimmed to a few cards (page 1 opens with promoted cards).
const fixture = (name) =>
  readFileSync(new URL(`fixtures/jobbank-dk/${name}`, import.meta.url), 'utf8');
const page1 = 'https://jobbank.dk/job/?key=udvikler';
const page2 = 'https://jobbank.dk/job/?key=udvikler&page=2';
const listing = (path) => `https://jobbank.dk/job/${path}/`;

function collect(t, html, href) {
  globalThis.document = parse(html);
  globalThis.location = {href};
  t.after(() => {
    delete globalThis.document;
    delete globalThis.location;
  });
  return collectJobbankDkPage();
}

test('result cards become their listing links with the card facts and the next page', (t) => {
  const raw = collect(t, fixture('search-1.html'), page1);
  assert.equal(raw.url, page1);
  assert.match(raw.heading, /^1\.956 job/);
  assert.equal(raw.cards.length, 5);
  const read = jobbankDkResults(raw);
  assert.deepEqual(
    read.listings.map((l) => l.url),
    [
      listing('3121464/jobadvice-management-aps/country-regulatory-specialist-til-nordisk-alkali'),
      listing('3140389/ankestyrelsen/souschef-til-ledelse-og-okonomi-i-ankestyrelsen'),
      listing(
        '3127694/danske-rederier/praktikant-til-ledelsessekretariatet-i-danske-rederier-foraret-2027',
      ),
      listing('3121463/carelink-gruppen/praktikanter-til-workwiser-forar-2027'),
      listing(
        '3135797/teknologisk-institut/erfaren-softwareudvikler-til-digitalisering-og-gron-omstilling',
      ),
    ],
  );
  assert.deepEqual(read.listings[0], {
    url: listing(
      '3121464/jobadvice-management-aps/country-regulatory-specialist-til-nordisk-alkali',
    ),
    text: 'Country Regulatory Specialist til Nordisk Alkali',
    siteCard:
      'Country Regulatory Specialist til Nordisk Alkali · Fuldtidsjob via JobAdvice Management ApS, Storkøbenhavn, Nordsjælland, Østsjælland +12 andre (Fjernarbejde) · Rekrutteringsfirma · Opdateret: 28.09.2026 · Frist: snarest muligt',
  });
  assert.equal(
    read.listings[4].siteCard,
    'Erfaren softwareudvikler til digitalisering og grøn omstilling · Fuldtidsjob hos Teknologisk Institut, Østjylland (Aarhus) · Opdateret: 08.10.2026 · Frist: 05.11.2026',
  );
  // The site links /job?…&page=2 and redirects it to /job/?…&page=2.
  assert.deepEqual(read.pagination, [
    {text: '1 of 98', url: page1, current: true, disabled: false, kind: 'link'},
    {text: '2', url: page2, current: false, disabled: false, kind: 'link'},
  ]);
});

test('page 2 states its page and links page 3', (t) => {
  const read = jobbankDkResults(collect(t, fixture('search-2.html'), page2));
  assert.equal(read.listings.length, 3);
  assert.equal(
    read.listings[0].url,
    listing(
      '3140503/region-syddanmark/introduktionslaege-soges-til-borne-og-ungdomspsykiatri-syddanmark-odense',
    ),
  );
  assert.deepEqual(read.pagination, [
    {text: '2 of 98', url: page2, current: true, disabled: false, kind: 'link'},
    {
      text: '3',
      url: 'https://jobbank.dk/job/?key=udvikler&page=3',
      current: false,
      disabled: false,
      kind: 'link',
    },
  ]);
});

test('the last page has only the current entry; one page without links needs the stated count', (t) => {
  const raw = collect(t, fixture('search-2.html'), page2);
  const last = 'https://jobbank.dk/job/?key=udvikler&page=98';
  const lastPages = [
    {
      text: '«',
      href: 'https://jobbank.dk/job?key=udvikler&page=97',
      active: false,
      unavailable: false,
    },
    {
      text: '97',
      href: 'https://jobbank.dk/job?key=udvikler&page=97',
      active: false,
      unavailable: false,
    },
    {
      text: '98',
      href: 'https://jobbank.dk/job?key=udvikler&page=98',
      active: true,
      unavailable: false,
    },
    {text: '»', href: '#', active: false, unavailable: true},
  ];
  assert.deepEqual(jobbankDkResults({...raw, url: last, pages: lastPages}).pagination, [
    {text: '98 of 98', url: last, current: true, disabled: false, kind: 'link'},
  ]);
  const one = {...raw, url: page1, pages: null, heading: '3 job og karriereopslag i dag'};
  assert.deepEqual(jobbankDkResults(one).pagination, [
    {text: '1 of 1', url: page1, current: true, disabled: false, kind: 'link'},
  ]);
  assert.equal(
    jobbankDkResults({...one, heading: '40 job og karriereopslag i dag'}).pagination,
    null,
  );
});

test('page links that disagree with the address leave pagination to the generic reader', (t) => {
  const raw = collect(t, fixture('search-2.html'), page2);
  // The address says page 3 but the page marks page 2 active (in-page navigation).
  assert.equal(jobbankDkResults({...raw, url: page2.replace('page=2', 'page=3')}).pagination, null);
  // A next link that skips a page, leaves the site or is missing is not used.
  const next = (href) => raw.pages.map((i) => (i.text === '»' ? {...i, href} : i));
  for (const href of [
    'https://jobbank.dk/job?key=udvikler&page=5',
    'https://jobbank.dk.evil.test/job?key=udvikler&page=3',
    '#',
  ])
    assert.equal(jobbankDkResults({...raw, pages: next(href)}).pagination, null, href);
  assert.equal(
    jobbankDkResults({...raw, pages: raw.pages.filter((i) => i.text !== '»')}).pagination,
    null,
  );
  // The listings are still read.
  assert.equal(jobbankDkResults({...raw, pages: []}).listings.length, 3);
});

test('no cards, a card without its listing link, a listing page or an unknown page give null', (t) => {
  const raw = collect(t, fixture('search-1.html'), page1);
  assert.equal(jobbankDkResults(null), null);
  assert.equal(jobbankDkResults({...raw, cards: []}), null);
  assert.equal(jobbankDkResults({...raw, cards: [{...raw.cards[0], href: null}]}), null);
  // The link must be the card's own listing.
  assert.equal(jobbankDkResults({...raw, cards: [{...raw.cards[0], id: '1'}]}), null);
  assert.equal(
    jobbankDkResults({...raw, cards: [{...raw.cards[0], href: '/virksomheder/128387/info/x'}]}),
    null,
  );
  assert.equal(jobbankDkResults({...raw, url: listing('3125211/teknologisk-institut/x')}), null);
  assert.equal(jobbankDkResults({...raw, heading: null}), null);
  assert.equal(jobbankDkResults({...raw, url: 'https://jobbank.gc.ca/job/?key=udvikler'}), null);
});

test('company, job agent, RSS and navigation links are not listings', (t) => {
  const read = jobbankDkResults(collect(t, fixture('search-1.html'), page1));
  const first = read.listings[0].url;
  const document = {
    url: page1,
    links: [
      {url: first, text: 'Country Regulatory Specialist til Nordisk Alkali'},
      {
        url: 'https://jobbank.dk/virksomheder/128387/info/jobadvice-management-aps',
        text: 'Talentefterspørgsel',
      },
      {
        url: 'https://jobbank.dk/virksomheder/13990/profil/teknologisk-institut',
        text: 'Virksomhedsprofil',
      },
      {url: 'https://jobbank.dk/profil/agent/new/', text: 'Opret jobagent'},
      {url: 'https://jobbank.dk/job/rss?key=udvikler', text: 'RSS'},
      {url: 'https://jobbank.dk/job/', text: 'Job'},
    ],
    pagination: [],
  };
  const marked = applySiteExtension(document, read, 'jobbank-dk');
  assert.deepEqual(
    marked.links.filter((l) => l.listing).map((l) => l.url),
    read.listings.map((l) => l.url),
  );
  assert.equal(marked.links.filter((l) => !l.listing).length, 5);
  assert.equal(marked.links[0].siteCard, read.listings[0].siteCard);
  assert.equal(marked.pagination, read.pagination);
  assert.equal(marked.siteExtension, 'jobbank-dk');
});

test('only jobbank.dk is matched; it reads in the browser with its search form parameters', () => {
  assert.equal(jobbankDk.id, 'jobbank-dk');
  assert.equal(isJobbankDkUrl(page1), true);
  assert.equal(isJobbankDkUrl('https://www.jobbank.dk/'), true);
  for (const url of [
    'http://jobbank.dk/',
    'https://jobbank.dk.evil.test/',
    'https://evil-jobbank.dk/',
    'https://www.jobbank.gc.ca/jobsearch/jobsearch',
    'not a url',
  ])
    assert.equal(isJobbankDkUrl(url), false, url);
  const {search} = jobbankDk;
  assert.equal(search.pagination, 'url_param');
  assert.equal(search.ordering, undefined);
  const it = withSearchFilters(search.template, {cvtype: '3', udd: '24'});
  assert.equal(it, 'https://jobbank.dk/job/?key={query}&cvtype=3&udd=24');
  assert.deepEqual(searchFilterLabels(search, it), ['Job type: Full time', 'Education: IT']);
});

// Registration in index.mjs is a separate step; this runs once it is done.
const registered = siteExtensionFor(page1)?.id === 'jobbank-dk';
test(
  'the registry finds jobbank-dk as a browser extension',
  {skip: !registered && 'not registered in index.mjs yet'},
  () => {
    assert.equal(siteExtensionFor('https://www.jobbank.gc.ca/')?.id, 'jobbank-ca');
    const kind = siteExtensionKind(page1, 'job-search');
    assert.equal(kind.kind, 'browser');
    assert.equal(kind.search, jobbankDk.search);
  },
);
