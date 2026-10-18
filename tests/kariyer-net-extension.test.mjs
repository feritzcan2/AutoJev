import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'node-html-parser';
import kariyerNet, {
  isKariyerNetUrl,
  collectKariyerNetPage,
  kariyerNetResults,
} from '../app/site-extensions/kariyer-net.mjs';
import {applySiteExtension} from '../app/site-extensions/index.mjs';

// Result pages saved from Chrome on 2026-10-16, trimmed to four cards each.
const fixture = (name) =>
  readFileSync(new URL(`./fixtures/kariyer-net/${name}`, import.meta.url), 'utf8');
const pages = {
  1: {html: fixture('page-1.html'), state: JSON.parse(fixture('page-1.state.json'))},
  2: {html: fixture('page-2.html'), state: JSON.parse(fixture('page-2.state.json'))},
};
const first = 'https://www.kariyer.net/is-ilanlari/yazilim';
const second = 'https://www.kariyer.net/is-ilanlari/yazilim-2';
const listing = (slug) => `https://www.kariyer.net/is-ilani/${slug}`;

function collect(t, {html, state}, href) {
  globalThis.document = parse(html);
  globalThis.location = {href};
  globalThis.window = state === undefined ? {} : {__NUXT__: state};
  t.after(() => {
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.window;
  });
  return collectKariyerNetPage();
}

test('page 1: cards become listings with the Nuxt facts, and the next page is the -2 path', (t) => {
  const raw = collect(t, pages[1], first);
  assert.equal(raw.cards.length, 4);
  assert.equal(raw.total, 269);
  assert.deepEqual(raw.paging, {
    current: '/is-ilanlari/yazilim',
    page: '1',
    next: '/is-ilanlari/yazilim-2',
  });
  assert.equal(raw.summary, 'Şu an 6 sayfa içerisinden 1. sayfadasınız');
  const read = kariyerNetResults(raw);
  assert.deepEqual(read.listings, [
    {
      url: listing('b-bilisim-bilgisayar-muhendisi-4580270'),
      text: 'Bilgisayar Mühendisi',
      // The card says "Adana +1 il daha"; the payload names every city.
      siteCard:
        'Bilgisayar Mühendisi · B.Bilişim · Adana, Adıyaman · İş Yerinde · Tam zamanlı · 1 gün · Sponsored',
    },
    {
      url: listing('negmar-denizcilik-yatirim-a-s-temizlik-gorevlisi-4541967'),
      text: 'Temizlik Görevlisi',
      siteCard:
        'Temizlik Görevlisi · Negmar Denizcilik Yatırım A.Ş. · İstanbul(Asya) · İş Yerinde · Tam zamanlı · 2 gün',
    },
    {
      url: listing('logo-yazilim-san-ve-tic-a-s-operasyon-destek-uzmani-4577826'),
      text: 'Operasyon Destek Uzmanı',
      siteCard:
        'Operasyon Destek Uzmanı · Logo Yazılım San Ve Tic A.Ş. · İstanbul(Asya) · Hibrit · Tam zamanlı · 2 gün',
    },
    {
      url: listing('basak-yazilim-a-s-full-stack-php-developer-startup-marketplace-4574071'),
      text: 'Full Stack PHP Developer – Startup / Marketplace',
      siteCard:
        'Full Stack PHP Developer – Startup / Marketplace · BAŞAK YAZILIM A.Ş. · İstanbul(Avr.), Kocaeli, İstanbul(Asya) · Hibrit · Yarı zamanlı · 4 gün',
    },
  ]);
  assert.deepEqual(read.pagination, [
    {text: '1 of 6', url: first, current: true, disabled: false, kind: 'link'},
    {text: '2', url: second, current: false, disabled: false, kind: 'link'},
  ]);
});

test('page 2: the sponsored cards repeat and the next page is -3', (t) => {
  const read = kariyerNetResults(collect(t, pages[2], second));
  assert.deepEqual(
    read.listings.map((l) => [l.url.split('-').pop(), l.siteCard.endsWith('Sponsored')]),
    [
      ['4580270', true],
      ['4579428', true],
      ['4357633', false],
      ['4564033', false],
    ],
  );
  assert.deepEqual(read.pagination, [
    {text: '2 of 6', url: second, current: true, disabled: false, kind: 'link'},
    {
      text: '3',
      url: 'https://www.kariyer.net/is-ilanlari/yazilim-3',
      current: false,
      disabled: false,
      kind: 'link',
    },
  ]);
});

test('the last page has only its current entry; contradicting pagination gives none', (t) => {
  const raw = collect(t, pages[2], second);
  const last = 'https://www.kariyer.net/is-ilanlari/yazilim-6';
  const lastPage = {
    ...raw,
    url: last,
    searchUrl: '/is-ilanlari/yazilim-6',
    statePage: 6,
    paging: {current: '/is-ilanlari/yazilim-6', page: '6', next: null},
    summary: 'Şu an 6 sayfa içerisinden 6. sayfadasınız',
  };
  assert.deepEqual(kariyerNetResults(lastPage).pagination, [
    {text: '6 of 6', url: last, current: true, disabled: false, kind: 'link'},
  ]);
  // A next link past the stated last page, or none before it.
  assert.equal(
    kariyerNetResults({...lastPage, paging: {...lastPage.paging, next: '/is-ilanlari/yazilim-7'}})
      .pagination,
    null,
  );
  assert.equal(kariyerNetResults({...raw, paging: {...raw.paging, next: null}}).pagination, null);
  // The pagination of another address (in-page navigation in between).
  assert.equal(kariyerNetResults({...raw, url: first}).pagination, null);
  // A next link to another site or back to this page.
  assert.equal(
    kariyerNetResults({...raw, paging: {...raw.paging, next: 'https://evil.test/is-ilanlari/x-3'}})
      .pagination,
    null,
  );
  assert.equal(
    kariyerNetResults({...raw, paging: {...raw.paging, next: raw.paging.current}}).pagination,
    null,
  );
  // Without the page summary the page is numbered without a count.
  assert.deepEqual(
    kariyerNetResults({...raw, summary: null}).pagination.map((p) => p.text),
    ['2', '3'],
  );
});

test('the next page keeps query parameters of the address the site link leaves out', (t) => {
  const address = `${first}?kw=java`;
  const raw = collect(t, pages[1], address);
  const read = kariyerNetResults({...raw, searchUrl: '/is-ilanlari/yazilim'});
  assert.equal(read.pagination[1].url, `${second}?kw=java`);
});

test('a stale or missing Nuxt payload leaves the card facts', (t) => {
  const raw = collect(t, pages[1], first);
  const cardFacts =
    'Bilgisayar Mühendisi · B.Bilişim · Adana +1 il daha · İş Yerinde · Tam zamanlı · 1 gün · Sponsored';
  const stale = [
    {...raw, items: null},
    {...raw, items: raw.items.slice(1)},
    {...raw, items: [...raw.items, {...raw.items[0], id: '1'}]},
    {...raw, searchUrl: '/is-ilanlari/yazilim-2'},
    {...raw, statePage: 2},
  ];
  for (const page of stale) {
    const read = kariyerNetResults(page);
    assert.equal(read.listings.length, 4);
    assert.equal(read.listings[0].siteCard, cardFacts);
    // The updated-listing icon's name is not part of the age.
    assert.equal(read.listings[1].siteCard.endsWith(' · Tam zamanlı · 2 gün'), true);
    // The rendered pagination still describes this address.
    assert.equal(read.pagination[0].text, '1 of 6');
  }
  const noState = collect(t, {html: pages[1].html}, first);
  assert.equal(noState.items, null);
  assert.equal(kariyerNetResults(noState).listings[0].siteCard, cardFacts);
});

test('listing addresses drop query and fragment; a repeated card is one listing', (t) => {
  const raw = collect(t, pages[1], first);
  const [card] = raw.cards;
  const read = kariyerNetResults({
    ...raw,
    items: null,
    cards: [{...card, href: `${card.href}?from=list#apply`}, card],
  });
  assert.deepEqual(
    read.listings.map((l) => l.url),
    [listing('b-bilisim-bilgisayar-muhendisi-4580270')],
  );
});

test('no cards, a card without a listing link, or another site leave the generic reader', (t) => {
  assert.equal(kariyerNetResults(null), null);
  assert.equal(kariyerNetResults({url: first, cards: []}), null);
  const raw = collect(t, pages[1], first);
  for (const href of [
    null,
    '/is-ilanlari/yazilim',
    '/firma/b-bilisim',
    'https://evil.test/is-ilani/x-y-1',
  ])
    assert.equal(kariyerNetResults({...raw, cards: [{...raw.cards[0], href}]}), null, String(href));
  assert.equal(
    kariyerNetResults({...raw, url: 'https://kariyer.net.evil.test/is-ilanlari/yazilim'}),
    null,
  );
  // A page without result cards (a bot check, a listing page).
  assert.equal(
    kariyerNetResults(
      collect(
        t,
        {html: '<html><body><h1>Bilgisayar Mühendisi</h1></body></html>'},
        listing('b-bilisim-bilgisayar-muhendisi-4580270'),
      ),
    ),
    null,
  );
});

test('only kariyer.net over https is matched; the extension reads in the browser with its search', () => {
  assert.equal(isKariyerNetUrl(first), true);
  assert.equal(isKariyerNetUrl('https://kariyer.net/'), true);
  for (const url of [
    'http://www.kariyer.net/',
    'https://www.kariyer.net.evil.test/',
    'https://evilkariyer.net/',
    'https://m.kariyer.net/',
    'not a url',
  ])
    assert.equal(isKariyerNetUrl(url), false, url);
  assert.equal(kariyerNet.id, 'kariyer-net');
  assert.equal(kariyerNet.matches, isKariyerNetUrl);
  assert.equal(typeof kariyerNet.dom.collect, 'function');
  assert.equal(kariyerNet.http, undefined);
  assert.equal(kariyerNet.search.template, 'https://www.kariyer.net/is-ilanlari/{query}');
  assert.equal(kariyerNet.search.pagination, 'next_link');
  assert.equal(kariyerNet.search.ordering, undefined);
});

test('applySiteExtension marks the cards as listings and search, city and nav links as not', (t) => {
  const read = kariyerNetResults(collect(t, pages[1], first));
  const document = {
    url: first,
    links: [
      {url: 'https://www.kariyer.net/is-ilanlari', text: 'İş İlanları'},
      {
        url: listing('b-bilisim-bilgisayar-muhendisi-4580270'),
        text: 'Sponsorlu İlan Bilgisayar Mühendisi B.Bilişim Adana +1 il daha',
      },
      {url: 'https://www.kariyer.net/is-ilanlari/yazilim+muhendisi', text: 'Yazılım Mühendisi'},
      {url: second, text: '2'},
      {
        url: 'https://www.kariyer.net/isveren/reklam-verin?utm_source=kariyer.net',
        text: 'İlan Paketi Al',
      },
    ],
    pagination: [],
  };
  const marked = applySiteExtension(document, read, 'kariyer-net');
  assert.deepEqual(
    marked.links.filter((l) => l.listing).map((l) => l.url.split('-').pop()),
    ['4580270', '4541967', '4577826', '4574071'],
  );
  assert.equal(marked.links.filter((l) => !l.listing).length, 4);
  assert.equal(marked.pagination[1].url, second);
  assert.equal(marked.siteExtension, 'kariyer-net');
});
