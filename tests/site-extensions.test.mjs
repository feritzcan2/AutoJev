import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stepstoneResults,
  collectStepstonePage,
  isStepstoneUrl,
} from '../app/site-extensions/stepstone.mjs';
import {
  applySiteExtension,
  readSiteExtension,
  siteExtensionFor,
  siteReaderFor,
  siteExtensionKind,
} from '../app/site-extensions/index.mjs';
import {
  searchFilterValues,
  withSearchFilters,
  searchFilterLabels,
} from '../app/site-extensions/search.mjs';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {automationTaskContext} from '../app/automation/task-context.mjs';
import {runJevTask} from '../app/jev/tasks.mjs';
import {updateScanQueue, noteExcluded, noteCards, scanStats} from '../app/sources/scan-work.mjs';

const results =
  'https://www.stepstone.de/jobs/staff-software-engineer/in-berlin?radius=30&sort=2&action=sort_publish';
const listing = (id) =>
  `https://www.stepstone.de/stellenangebote--Role-${id}-Berlin-Company--${id}-inline.html`;
const company = (id) => `https://www.stepstone.de/cmp/de/company-${id}/jobs`;
const item = (id) => ({
  id: String(id),
  title: `Role ${id}`,
  url: `/stellenangebote--Role-${id}-Berlin-Company--${id}-inline.html?rltr=${id}_${id}_25_seorl_s_0`,
  company: `Company ${id}`,
  location: 'Berlin',
  posted: '2026-10-01',
});
const raw = (overrides = {}) => ({
  url: results,
  cards: [
    {id: '1', url: listing(1), title: 'Role 1'},
    {id: '2', url: listing(2), title: 'Role 2'},
  ],
  items: [item(1), item(2), item(3)],
  paging: {
    page: 1,
    pageCount: 16,
    template:
      'https://www.stepstone.de/jobs/staff-software-engineer/in-berlin?radius=30&page=%7bpage%7d&sort=2&action=sort_publish',
  },
  ...overrides,
});

test('stepstone results use the page result list, drop tracking and expose the next page', () => {
  const read = stepstoneResults(raw());
  // Card 3 is in the result list but not rendered yet; it is still a listing.
  assert.deepEqual(
    read.listings.map((l) => l.url),
    [listing(1), listing(2), listing(3)],
  );
  assert.equal(read.listings[2].text, 'Role 3');
  assert.equal(read.listings[0].siteCard, 'Role 1 · Company 1 · Berlin · 2026-10-01');
  assert.deepEqual(read.pagination, [
    {text: '1 of 16', url: results, current: true, disabled: false, kind: 'link'},
    {
      text: '2',
      url: 'https://www.stepstone.de/jobs/staff-software-engineer/in-berlin?radius=30&page=2&sort=2&action=sort_publish',
      current: false,
      disabled: false,
      kind: 'link',
    },
  ]);
  assert.deepEqual(
    stepstoneResults(
      raw({paging: {page: 16, pageCount: 16, template: null}, url: results + '&page=16'}),
    ).pagination,
    [{text: '16 of 16', url: results + '&page=16', current: true, disabled: false, kind: 'link'}],
  );
});

test('the next stepstone page keeps the sort and filters its template drops', () => {
  const read = stepstoneResults(
    raw({
      url: results + '&fdl=en&page=2',
      paging: {
        page: 2,
        pageCount: 4,
        template:
          'https://www.stepstone.de/jobs/staff-software-engineer/in-berlin?siteId=250&radius=30&page=%7bpage%7d',
      },
    }),
  );
  assert.equal(
    read.pagination[1].url,
    'https://www.stepstone.de/jobs/staff-software-engineer/in-berlin?siteId=250&radius=30&page=3&sort=2&action=sort_publish&fdl=en',
  );
});

test('a stale stepstone result list falls back to the rendered cards without paging', () => {
  for (const stale of [
    raw({items: [item(7), item(8)]}),
    raw({url: results + '&page=3'}),
    raw({items: null}),
  ]) {
    const read = stepstoneResults(stale);
    assert.deepEqual(
      read.listings.map((l) => l.url),
      [listing(1), listing(2)],
    );
    assert.equal(read.pagination, null);
  }
});

test('a stepstone page without result cards is left to the generic reader', () => {
  assert.equal(stepstoneResults(raw({cards: []})), null);
  assert.equal(stepstoneResults(null), null);
  assert.equal(
    stepstoneResults(raw({cards: [{id: '1', url: null, title: ''}], items: null})),
    null,
  );
  assert.equal(isStepstoneUrl('https://www.stepstone.de/jobs/x'), true);
  assert.equal(isStepstoneUrl('https://stepstone.de.evil.test/'), false);
  assert.equal(siteExtensionFor('https://www.glassdoor.com/Job/index.htm'), null);
  assert.equal(siteExtensionFor('https://himalayas.app/jobs/api/search?q=backend').id, 'himalayas');
  assert.equal(typeof siteExtensionFor('https://himalayas.app/').collector.readPage, 'function');
});

test('the in-page collector reads cards, title links and the preloaded state', (t) => {
  const card = (id, href, text) => ({
    id: `job-item-${id}`,
    querySelector: (selector) =>
      selector === 'a[data-at="job-item-title"]' ? {href, innerText: ` ${text}\n`} : null,
  });
  globalThis.window = {
    __PRELOADED_STATE__: {
      'app-unifiedResultlist': {
        searchResults: {
          items: [
            {
              id: 1,
              title: 'Role 1',
              url: '/x?rltr=1',
              companyName: 'Company 1',
              location: 'Berlin',
              datePosted: '2026-10-01T06:28:30+02:00',
            },
          ],
          unifiedPagination: {page: 1, pageCount: 2, template: 't'},
        },
      },
    },
  };
  globalThis.document = {
    querySelectorAll: (selector) =>
      selector === 'article[data-at="job-item"]' ? [card(1, listing(1), 'Role  1')] : [],
  };
  globalThis.location = {href: results};
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.location;
  });
  assert.deepEqual(collectStepstonePage(), {
    url: results,
    cards: [{id: '1', url: listing(1), title: 'Role 1'}],
    items: [
      {
        id: '1',
        title: 'Role 1',
        url: '/x?rltr=1',
        company: 'Company 1',
        location: 'Berlin',
        posted: '2026-10-01',
      },
    ],
    paging: {page: 1, pageCount: 2, template: 't'},
  });
});

test('extension links mark listings and keep every other link visible as not a listing', async () => {
  const document = {
    url: results,
    links: [
      {text: '', url: company(1)},
      {text: 'Role 1', url: listing(1), contextRange: {offset: 0, length: 5}},
      {text: 'Homeoffice', url: results + '&wfh=1'},
    ],
    pagination: [],
  };
  const marked = applySiteExtension(document, stepstoneResults(raw()), 'stepstone');
  assert.deepEqual(
    marked.links.map((l) => [l.url, l.listing]),
    [
      [company(1), false],
      [listing(1), true],
      [results + '&wfh=1', false],
      [listing(2), true],
      [listing(3), true],
    ],
  );
  assert.deepEqual(marked.links[1].contextRange, {offset: 0, length: 5});
  assert.equal(marked.siteExtension, 'stepstone');
  const slot = (value) => ({
    page: {
      evaluate: async () => {
        if (value instanceof Error) throw value;
        return value;
      },
    },
  });
  assert.equal((await readSiteExtension(slot(raw()), document)).siteExtension, 'stepstone');
  // Another site, a redirect between reads, or a failed read leave the page unchanged.
  assert.equal(
    await readSiteExtension(slot(raw()), {...document, url: 'https://example.test/jobs'}).then(
      (d) => d.siteExtension,
    ),
    undefined,
  );
  assert.equal(
    await readSiteExtension(
      {
        page: {
          evaluate: () => {
            throw Error('CLI extension must not evaluate DOM');
          },
        },
      },
      {...document, url: 'https://himalayas.app/'},
    ).then((d) => d.siteExtension),
    undefined,
  );
  assert.equal(await readSiteExtension(slot(raw({url: results + '&page=2'})), document), document);
  assert.equal(await readSiteExtension(slot(Error('gone')), document), document);
});

test('a jev scan queues only extension listings and never company boards', async (t) => {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('housing', {
    goal: 'Berlin homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 rooms'},
    sources: [results],
  });
  db.save(a.id, {browserMode: 'jev'});
  db.review(a.id);
  const page = applySiteExtension(
    {
      url: results,
      title: 'Jobs',
      text: 'Role 1 Company 1',
      links: [
        {text: '', url: company(1)},
        {text: 'Role 1', url: listing(1)},
        {
          text: 'Software Engineer Jobs',
          url: 'https://www.stepstone.de/jobs/software-engineer/in-berlin',
        },
      ],
      pagination: [],
    },
    stepstoneResults(
      raw({items: null, cards: [{id: '1', url: listing(1), title: 'Role 1'}], paging: null}),
    ),
    'stepstone',
  );
  page.pagination = [{text: '1 of 1', url: results, current: true, disabled: false, kind: 'link'}];
  let seen = 0;
  const ports = {
    authorize: async () => {},
    assertActive: () => {},
    searchId: 'default',
    browser: async () => page,
    evaluate: async (state, questions) => {
      seen += Object.keys(state.links ?? {}).length;
      return {
        answers: Object.fromEntries(
          Object.entries(questions).map(([key, q]) => [
            key,
            ((c) => ({
              choice: c,
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(q.criteria).map((k) => [k, k === c ? 1 : 0]),
              ),
            }))(key === 'next' ? 'end' : key.startsWith('fit') ? 'keep' : 'listing'),
          ]),
        ),
        usage: {input_tokens: 1, output_tokens: 1},
      };
    },
  };
  const result = await runJevTask({
    store: db.jevTasks,
    owner: a.id,
    taskId: 'assigned',
    input: {operation: 'scan_results', url: results},
    ports,
    criteria: a.criteria,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    result.items.map((i) => i.url),
    [listing(1)],
  );
  assert.equal(result.items[0].discovery.decision, 'listing');
  assert.equal(seen, 1);
});

test('extension listings are asked only about fit, and a clearly unrelated title is eliminated with its reason', async (t) => {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('housing', {
    goal: 'Berlin homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 rooms'},
    sources: [results],
  });
  db.save(a.id, {browserMode: 'jev'});
  db.review(a.id);
  const page = applySiteExtension(
    {
      url: results,
      title: 'Jobs',
      text: 'Role 1 Project Manager',
      links: [
        {text: 'Role 1', url: listing(1)},
        {text: 'Project Manager Medical Devices', url: listing(2)},
      ],
      pagination: [],
    },
    stepstoneResults(
      raw({
        items: null,
        cards: [
          {id: '1', url: listing(1), title: 'Role 1'},
          {id: '2', url: listing(2), title: 'Project Manager Medical Devices'},
        ],
        paging: null,
      }),
    ),
    'stepstone',
  );
  page.pagination = [{text: '1 of 1', url: results, current: true, disabled: false, kind: 'link'}];
  const asked = [];
  let saved = null;
  const ports = {
    authorize: async () => {},
    assertActive: () => {},
    searchId: 'default',
    browser: async () => page,
    checkpoint: async (_, urls, extra) => {
      saved = {urls, ...extra};
      return {saved: true};
    },
    detailExclusions: () => ['SAP Basis Architect'],
    evaluate: async (state, questions) => {
      asked.push(...Object.keys(questions));
      if (state.links)
        assert.deepEqual(
          state.eliminatedAfterDetail,
          ['SAP Basis Architect'],
          'card triage sees what detail reading proved unrelated',
        );
      return {
        answers: Object.fromEntries(
          Object.entries(questions).map(([key, q]) => {
            const link = state.links?.[key.replace(/^fit/, 'link')],
              c =
                key === 'next'
                  ? 'end'
                  : link?.text.startsWith('Project Manager')
                    ? 'unrelated_role'
                    : 'keep';
            assert.ok(Object.hasOwn(q.criteria, c));
            return [
              key,
              {
                choice: c,
                confidence: 0.9,
                probabilities: Object.fromEntries(
                  Object.keys(q.criteria).map((k) => [k, k === c ? 0.9 : 0.1 / 3]),
                ),
              },
            ];
          }),
        ),
        usage: {input_tokens: 1, output_tokens: 1},
      };
    },
  };
  const result = await runJevTask({
    store: db.jevTasks,
    owner: a.id,
    taskId: 'assigned',
    input: {operation: 'scan_results', url: results},
    ports,
    criteria: a.criteria,
    signal: new AbortController().signal,
  });
  assert.ok(
    !asked.some((k) => k.startsWith('link')),
    'a marked listing is not asked what it opens',
  );
  assert.deepEqual(
    result.items.map((i) => i.url),
    [listing(1)],
  );
  assert.deepEqual(
    saved.rejected.map((r) => [r.url, r.title, r.reason]),
    [[listing(2), 'Project Manager Medical Devices', 'unrelated_role']],
  );
});

test('eliminated listings are kept per search with their stage and reason', () => {
  const run = {
    scan: {
      work: {
        activeSearchId: 's',
        searches: [
          {
            id: 's',
            label: 'Search',
            status: 'pending',
            pendingUrls: [listing(1), listing(2)],
            processedUrls: [],
            pageProgress: null,
            plan: null,
          },
        ],
      },
    },
  };
  let work = updateScanQueue(run, {
    pendingUrls: [],
    processedUrls: [listing(2)],
    excluded: [{url: listing(2), title: 'Project Manager', reason: 'unrelated_role'}],
  });
  assert.deepEqual(work.searches[0].excluded, [
    {url: listing(2), title: 'Project Manager', reason: 'unrelated_role', stage: 'card', by: 'jev'},
  ]);
  noteCards(work.searches[0], [
    {
      url: listing(1),
      title: 'Role 1',
      scores: {keep: 0.6, hard_constraint: 0.05, qualification: 0.05, unrelated_role: 0.3},
    },
    {url: listing(3), title: 'Not waiting', scores: {keep: 1}},
  ]);
  assert.deepEqual(
    work.searches[0].cards,
    {[listing(1)]: {title: 'Role 1', keep: 0.6, risk: {reason: 'unrelated_role', p: 0.3}}},
    'only waiting listings keep a card note',
  );
  noteExcluded(work.searches[0], [
    {url: listing(2), title: 'Project Manager', reason: 'Different profession', stage: 'detail'},
  ]);
  assert.deepEqual(
    work.searches[0].excluded.map((e) => [e.stage, e.reason]),
    [['detail', 'Different profession']],
    'one entry per address, latest decision wins',
  );
  noteExcluded(work.searches[0], [
    {url: listing(1), title: 'Role 1', reason: 'Requires relocation', stage: 'detail', by: 'agent'},
  ]);
  assert.deepEqual(
    work.searches[0].counts,
    {jevRejected: 1, reviewRejected: 1},
    'each listing counts once, by who rejected it first',
  );
  assert.deepEqual(work.searches[0].pendingUrls, [listing(1)]);
  assert.equal(scanStats({work: {...work, counted: false}}), null, 'older work has no counts');
  work.counted = true;
  work.searches[0].newListings = {[listing(0)]: 3};
  work.searches[0].counts.saved = 1;
  assert.deepEqual(scanStats({work}), {
    searches: 1,
    listings: 3,
    jevRejected: 1,
    reviewRejected: 1,
    belowThreshold: 0,
    saved: 1,
  });
});

test('an HTTP reader extension serves only the addresses it handles', () => {
  assert.equal(siteExtensionFor('https://www.xing.com/jobs/berlin-role-1234567').id, 'xing');
  assert.equal(
    typeof siteReaderFor('https://www.xing.com/jobs/berlin-role-1234567').read,
    'function',
  );
  assert.ok(siteReaderFor('https://www.xing.com/jobs/search?keywords=go&location=Berlin'));
  for (const other of [
    'https://www.linkedin.com/jobs/view/4012345678',
    'https://www.xing.com/',
    results,
    'not a url',
  ])
    assert.equal(siteReaderFor(other), null, other);
});

test('the source list shows which kind of extension reads a source and its search address', (t) => {
  const kinds = Object.fromEntries(
    [
      ['https://www.stepstone.de/', 'stepstone'],
      ['https://www.linkedin.com/jobs/', 'linkedin'],
      ['https://himalayas.app/', 'himalayas'],
      ['https://www.xing.com/jobs/', 'xing'],
      ['https://berlinstartupjobs.com/engineering/', 'berlin-startup-jobs'],
      ['https://www.arbeitnow.com/', 'arbeitnow'],
    ].map(([url, id]) => [id, siteExtensionKind(url, 'job-search')]),
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(kinds).map(([id, k]) => [id, [k.id, k.kind]])),
    {
      stepstone: ['stepstone', 'browser'],
      linkedin: ['linkedin', 'api'],
      himalayas: ['himalayas', 'api'],
      xing: ['xing', 'http'],
      'berlin-startup-jobs': ['berlin-startup-jobs', 'http'],
      arbeitnow: ['arbeitnow', 'api'],
    },
  );
  for (const [id, {search}] of Object.entries(kinds)) {
    assert.match(search.template, /^https:\/\//, id);
    // A feed without search has no {query}; an order is claimed only when certain.
    if (id !== 'arbeitnow') assert.match(search.template, /\{query\}/, id);
    if (search.ordering) assert.equal(search.ordering, 'newest_first', id);
    assert.ok(
      search.filters.every((f) => f.param && f.label),
      id,
    );
  }
  assert.deepEqual(
    ['stepstone', 'linkedin', 'himalayas'].map((id) => kinds[id].search.ordering),
    ['newest_first', undefined, 'newest_first'],
    'the signed-in LinkedIn search lists by relevance',
  );
  assert.equal(
    siteExtensionKind('https://himalayas.app/', 'housing'),
    null,
    'a collector serves only its own template',
  );
  assert.equal(siteExtensionKind('https://jobs.lever.co/', 'job-search'), null);
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('housing', {
    goal: 'Berlin homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 rooms'},
    sources: [results, 'https://example.test/homes'],
  });
  assert.deepEqual(
    db.sources(a.id).map((s) => s.extension?.kind ?? null),
    ['browser', null],
  );
});

test('site filters are read from and written into a results template without touching placeholders', () => {
  const {search} = siteExtensionKind('https://www.stepstone.de/', 'job-search');
  const template =
    'https://www.stepstone.de/jobs/{query}/in-berlin?radius=30&sort=2&action=sort_publish';
  assert.deepEqual(searchFilterValues(search, template), {radius: '30'});
  const withLanguage = withSearchFilters(template, {fdl: 'en'});
  assert.equal(
    withLanguage,
    'https://www.stepstone.de/jobs/{query}/in-berlin?radius=30&sort=2&action=sort_publish&fdl=en',
  );
  assert.deepEqual(searchFilterLabels(search, withLanguage), [
    'Listing language: English',
    'Radius (km, with a city): 30',
  ]);
  assert.equal(
    withSearchFilters(withLanguage, {radius: '', fdl: 'de'}),
    'https://www.stepstone.de/jobs/{query}/in-berlin?sort=2&action=sort_publish&fdl=de',
  );
  const linkedin = siteExtensionKind('https://www.linkedin.com/jobs/', 'job-search').search;
  assert.equal(
    withSearchFilters(linkedin.template, {f_WT: '2'}),
    linkedin.template + '&f_WT=2',
    'query placeholders survive the rewrite',
  );
  assert.equal(withSearchFilters('https://x.test/jobs', {}), 'https://x.test/jobs');
  assert.deepEqual(searchFilterValues(search, 'not a url'), {});
});

test('an assigned extension source tells the agent its known search address', (t) => {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('housing', {
    goal: 'Berlin homes',
    criteria: {location: 'Berlin'},
    sources: [results, 'https://example.test/homes'],
  });
  const context = (url) =>
    automationTaskContext(db, a.id, {id: 'r1', kind: 'trial', sourceUrl: url, sources: [url]})
      .assignedSource;
  const stepstone = context(results);
  assert.equal(stepstone.siteSearch.template, siteExtensionFor(results).search.template);
  assert.match(stepstone.siteSearchGuidance, /siteSearch\.filters/);
  assert.equal(context('https://example.test/homes').siteSearch, undefined);
});
