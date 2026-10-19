import test from 'node:test';
import assert from 'node:assert/strict';
import {isIndeedUrl, indeedResults, collectIndeedPage} from '../app/site-extensions/indeed.mjs';
import {siteExtensionKind, applySiteExtension} from '../app/site-extensions/index.mjs';
import {siteSearchRecipe} from '../app/site-extensions/search.mjs';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';

const results =
  'https://de.indeed.com/jobs?q=software+architect&l=Berlin&fromage=7&vjk=e1ea8cdff329f252';
const ad = 'https://de.indeed.com/pagead/clk?mo=r&ad=-6NYlbfk&xkcb=SoC36&p=11&vjs=3';
const raw = (overrides = {}) => ({
  url: results,
  cards: [
    {id: 'e1ea8cdff329f252', title: 'Senior Solution Architect', hidden: false},
    {id: 'e848845f2c3ca5ac', title: 'Payments Architect', hidden: false},
    {id: '0f1e2d3c4b5a6978', title: 'Senior IT System Architect', hidden: true},
  ],
  items: [
    {
      id: 'e1ea8cdff329f252',
      title: 'Senior Solution Architect',
      company: 'Xecuro GmbH',
      location: 'Berlin',
      posted: '2026-10-01',
    },
    {
      id: 'e848845f2c3ca5ac',
      title: 'Payments Architect',
      company: 'Accenture',
      location: '',
      posted: '',
    },
  ],
  next: 'https://de.indeed.com/jobs?q=software+architect&l=Berlin&radius=35&start=10',
  ...overrides,
});

test('indeed cards become stable viewjob listings and the hidden card is not one', () => {
  const read = indeedResults(raw());
  assert.deepEqual(read.listings, [
    {
      url: 'https://de.indeed.com/viewjob?jk=e1ea8cdff329f252',
      text: 'Senior Solution Architect',
      siteCard: 'Senior Solution Architect · Xecuro GmbH · Berlin · 2026-10-01',
    },
    {
      url: 'https://de.indeed.com/viewjob?jk=e848845f2c3ca5ac',
      text: 'Payments Architect',
      siteCard: 'Payments Architect · Accenture',
    },
  ]);
  assert.deepEqual(
    read.pagination.map((p) => [p.text, p.url, p.current]),
    [
      ['1', results, true],
      [
        '2',
        'https://de.indeed.com/jobs?q=software+architect&l=Berlin&radius=35&start=10&fromage=7',
        false,
      ],
    ],
    'the next page keeps the filters of the address',
  );
  assert.equal(indeedResults(raw({next: null})).pagination.length, 1);
});

test('an indeed page without a matching result list is left to the generic reader', () => {
  assert.equal(indeedResults(raw({items: null})), null, 'detail or sign-in page');
  assert.equal(indeedResults(raw({cards: []})), null);
  assert.equal(
    indeedResults(raw({items: raw().items.slice(0, 1)})),
    null,
    'a stale list that misses a shown card',
  );
});

test('extension listings replace the ad-click links as the queued listings', () => {
  const document = {
    url: results,
    links: [
      {url: ad, text: 'Senior Solution Architect'},
      {url: 'https://de.indeed.com/jobs?q=software+architect&l=Berlin&start=10', text: '2'},
    ],
  };
  const applied = applySiteExtension(document, indeedResults(raw()), 'indeed');
  assert.deepEqual(
    applied.links.filter((l) => l.listing).map((l) => l.url),
    [
      'https://de.indeed.com/viewjob?jk=e1ea8cdff329f252',
      'https://de.indeed.com/viewjob?jk=e848845f2c3ca5ac',
    ],
  );
  assert.equal(applied.links.find((l) => l.url === ad).listing, false);
});

test('the in-page collector reads card ids, hidden cards, the result list and the next page', (t) => {
  const card = (jk, text, hidden) => ({
    dataset: {jk},
    innerText: ` ${text}\n`,
    closest: (selector) => (hidden && selector === '[aria-hidden="true"]' ? {} : null),
  });
  globalThis.window = {
    mosaic: {
      providerData: {
        'mosaic-provider-jobcards': {
          metaData: {
            mosaicProviderJobCardsModel: {
              results: [
                {
                  jobkey: 'e1ea8cdff329f252',
                  displayTitle: 'Role',
                  company: 'Co',
                  formattedLocation: 'Berlin',
                  pubDate: Date.UTC(2026, 9, 1),
                },
              ],
            },
          },
        },
      },
    },
  };
  globalThis.document = {
    querySelectorAll: (selector) =>
      selector === 'a[data-jk]'
        ? [card('e1ea8cdff329f252', 'Role', false), card('0f1e2d3c4b5a6978', 'Decoy', true)]
        : [],
    querySelector: (selector) =>
      selector === 'a[data-testid="pagination-page-next"]'
        ? {href: 'https://de.indeed.com/n'}
        : null,
  };
  globalThis.location = {href: results};
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.location;
  });
  assert.deepEqual(collectIndeedPage(), {
    url: results,
    cards: [
      {id: 'e1ea8cdff329f252', title: 'Role', hidden: false},
      {id: '0f1e2d3c4b5a6978', title: 'Decoy', hidden: true},
    ],
    items: [
      {
        id: 'e1ea8cdff329f252',
        title: 'Role',
        company: 'Co',
        location: 'Berlin',
        posted: '2026-10-01',
      },
    ],
    next: 'https://de.indeed.com/n',
  });
});

test('every indeed country site gets its own search address, in relevance order', () => {
  assert.equal(isIndeedUrl('https://uk.indeed.com/'), true);
  assert.equal(isIndeedUrl('https://indeed.com/jobs'), true);
  for (const url of [
    'https://secure.indeed.com/auth',
    'https://smartapply.indeed.com/beta',
    'http://de.indeed.com/',
    'https://de.indeed.com.evil.test/',
  ])
    assert.equal(isIndeedUrl(url), false, url);
  const uk = siteExtensionKind('https://uk.indeed.com/', 'job-search');
  assert.equal(uk.kind, 'browser');
  assert.equal(uk.search.template, 'https://uk.indeed.com/jobs?q={query}&l={location}');
  assert.equal(uk.search.ordering, undefined, 'relevance mixes dates');
  // A recipe saved with the date sort loses it, and keeps its filters.
  const {recipe, changed} = siteSearchRecipe(
    siteExtensionKind('https://de.indeed.com/', 'job-search').search,
    {
      entry: {
        kind: 'url_template',
        template: 'https://de.indeed.com/jobs?q={query}&l=Berlin&fromage=7&sort=date',
      },
      pagination: 'url_param',
    },
  );
  assert.equal(recipe.ordering, undefined);
  assert.deepEqual(changed, ['template']);
  assert.equal(recipe.entry.template, 'https://de.indeed.com/jobs?q={query}&l=Berlin&fromage=7');
  // A recipe without a sort is left as saved.
  const plain = 'https://de.indeed.com/jobs?q={query}&l=Berlin&fromage=7';
  assert.deepEqual(
    siteSearchRecipe(siteExtensionKind('https://de.indeed.com/', 'job-search').search, {
      entry: {kind: 'url_template', template: plain},
      pagination: 'url_param',
    }).changed,
    [],
  );
});

test('a saved Indeed recipe with the date sort replays without it and keeps its filters', (t) => {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core),
    source = 'https://uk.indeed.com/';
  t.after(() => core.close());
  const a = db.create('job-search', {
    goal: 'backend',
    criteria: {preferences: 'England', location: 'London'},
    sources: [source],
  });
  const template = 'https://uk.indeed.com/jobs?q={query}&l={location}&fromage=7&sort=date';
  db.saveSource(a.id, source, {
    recipe: {
      entry: {kind: 'url_template', template},
      pagination: 'url_param',
      terms: ['Staff Software Engineer'],
    },
  });
  const {replay} = db.sourceRecipe(a.id, source);
  assert.match(replay.searches[0].url, /[?&]fromage=7$/);
  assert.doesNotMatch(replay.searches[0].url, /sort=/);
  assert.equal(
    db.get(a.id).sourceSettings[source].recipe.entry.template,
    template,
    'the saved recipe itself is unchanged',
  );
});
