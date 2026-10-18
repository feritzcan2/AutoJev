import test from 'node:test';
import assert from 'node:assert/strict';
import {SITE_EXTENSIONS} from '../app/site-extensions/index.mjs';
import {listingPage} from '../app/site-extensions/listing.mjs';
import {readerPage} from '../app/site-extensions/http.mjs';
import {extensionBench} from '../app/sources/extension-bench.mjs';

const host = (name) => (url) => {
  try {
    return new URL(url).hostname === name;
  } catch {
    return false;
  }
};
// Synthetic extensions on reserved .test hosts, registered for one test.
function withExtension(extension, fn) {
  return async () => {
    SITE_EXTENSIONS.unshift(extension);
    try {
      await fn();
    } finally {
      SITE_EXTENSIONS.splice(SITE_EXTENSIONS.indexOf(extension), 1);
    }
  };
}
const db = (templateId = 'job-search') => ({get: () => ({templateId}), siteAccess: null});
const job = (n) => ({
  url: `https://api.bench.test/jobs/${n}`,
  title: `Role ${n}`,
  company: `Company ${n}`,
  description: `Own text of role ${n}.`,
});
const apiExtension = (calls) => ({
  id: 'bench-api',
  matches: host('api.bench.test'),
  collector: {
    templateId: 'job-search',
    searchUrl: (url) => url,
    acceptsQuery: () => true,
    readPage: async (url) => {
      calls.push(['page', url]);
      return {
        url,
        jobs: [job(1), job(2)],
        page: 1,
        totalPages: 3,
        nextUrl: url + '&page=2',
        complete: false,
      };
    },
    readDetail: async (url) => {
      calls.push(['detail', url]);
      return job(9);
    },
    detail: (j) => ({
      ...listingPage({
        url: j.url,
        title: j.title,
        description: j.description,
        fields: {company: j.company},
      }),
      cells: {company: j.company},
    }),
  },
});

const apiCalls = [];
test(
  'an API collector page lists its jobs and pagination; a listing comes from that page',
  withExtension(apiExtension(apiCalls), async () => {
    const calls = apiCalls;
    const bench = extensionBench({browser: null, db: db()});
    const read = await bench.read('w', 'https://api.bench.test/search?q=x');
    assert.equal(read.transport, 'api');
    assert.deepEqual(read.extension, {id: 'bench-api', kind: 'api'});
    assert.deepEqual(
      read.listings.map((l) => [l.url, l.title]),
      [
        [job(1).url, 'Role 1'],
        [job(2).url, 'Role 2'],
      ],
    );
    assert.match(read.listings[0].card, /company: Company 1/);
    // Results cross Electron IPC: nothing in them may be a function.
    assert.doesNotThrow(() => structuredClone(read));
    assert.equal(read.instance, undefined);
    assert.equal(
      read.pagination.find((p) => !p.current).url,
      'https://api.bench.test/search?q=x&page=2',
    );
    const listing = await bench.listing('w', job(2).url);
    assert.equal(listing.fromCache, true);
    assert.deepEqual(listing.listing.fields, {company: 'Company 2'});
    assert.equal(listing.listing.description.text, 'Own text of role 2.');
    assert.deepEqual(listing.cells, {company: 'Company 2'});
    // A listing not on a read page goes through the collector's own detail read.
    const other = await bench.listing('w', 'https://api.bench.test/jobs/9');
    assert.equal(other.fromCache, false);
    assert.deepEqual(
      calls.map(([kind]) => kind),
      ['page', 'detail'],
    );
  }),
);

test(
  'a collector of another template is read in the browser, as that workspace scans it',
  withExtension(apiExtension([]), async () => {
    const calls = [];
    const browser = fakeBrowser({pages: [page({url: 'https://api.bench.test/x'})], calls});
    const read = await extensionBench({browser, db: db('car-search')}).read(
      'w',
      'https://api.bench.test/x',
    );
    assert.equal(read.transport, 'browser');
    assert.match(read.notes[0], /serves job-search workspaces only/);
    assert.equal(calls[0][0], 'browser_jev_open');
  }),
);

test(
  'an HTTP reader page separates listings from other links',
  withExtension(
    {
      id: 'bench-http',
      matches: host('http.bench.test'),
      http: {
        handles: () => true,
        read: async (url, options) => {
          assert.ok(options.signal instanceof AbortSignal);
          return readerPage({
            browser: 'Bench reader',
            url,
            title: 'Results',
            text: 'Results',
            links: [
              {url: 'https://http.bench.test/job/1', text: 'Role 1', listing: true},
              {url: 'https://http.bench.test/company/1', text: 'Company', listing: false},
            ],
            pagination: [{text: '1 of 2', url, kind: 'link', current: true, disabled: false}],
          });
        },
      },
    },
    async () => {
      const read = await extensionBench({browser: null, db: db()}).read(
        'w',
        'https://http.bench.test/search',
      );
      assert.equal(read.transport, 'http');
      assert.doesNotThrow(() => structuredClone(read));
      assert.equal(read.applied, true);
      assert.deepEqual(read.listings, [{url: 'https://http.bench.test/job/1', title: 'Role 1'}]);
      assert.equal(read.otherLinks, 1);
      assert.equal(read.listing, null);
    },
  ),
);

test(
  'an address the HTTP reader leaves to the browser (null) is read in the tab',
  withExtension(
    {
      id: 'bench-http-moved',
      matches: host('moved.bench.test'),
      http: {handles: () => true, read: async () => null},
    },
    async () => {
      const calls = [];
      const url = 'https://moved.bench.test/job/1';
      const browser = fakeBrowser({pages: [page({url})], calls});
      const read = await extensionBench({browser, db: db()}).read('w', url);
      assert.equal(read.transport, 'browser');
      assert.equal(calls[0][0], 'browser_jev_open');
    },
  ),
);

const page = ({url, loading = false, siteExtension, links = []}) => ({
  tabId: 'tab-1',
  url,
  title: 'Page',
  text: 'Page text',
  links,
  pagination: [],
  ...(siteExtension ? {siteExtension} : {}),
  reading: {readiness: {loading, reason: loading ? 'network' : null}},
});
// Answers browser calls in order; the last page repeats.
function fakeBrowser({pages, calls, raw = null}) {
  let index = 0;
  const reply = (value) => ({content: [{type: 'text', text: JSON.stringify(value)}]});
  return {
    forWorker: () => ({
      call: async (id, name, args, owner, state) => {
        calls.push([name, args, owner, state]);
        return reply(pages[Math.min(index++, pages.length - 1)]);
      },
    }),
    enqueue: (id, fn) => fn(),
    connectedClient: async () => ({
      tabs: new Map([['tab-1', {page: {evaluate: async () => raw}}]]),
    }),
  };
}
const domExtension = {
  id: 'bench-dom',
  matches: host('dom.bench.test'),
  dom: {
    collect: () => ({}),
    results: (raw) => (raw?.cards?.length ? {listings: [], pagination: null} : null),
  },
};

test(
  'a browser read waits a bounded time for loading and reports a page that never loads',
  withExtension(domExtension, async () => {
    const calls = [],
      waits = [],
      url = 'https://dom.bench.test/results';
    const browser = fakeBrowser({pages: [page({url, loading: true})], calls});
    const read = await extensionBench({browser, db: db(), wait: async (ms) => waits.push(ms)}).read(
      'w',
      url,
    );
    assert.equal(read.readiness.loading, true);
    assert.deepEqual(read.listings, []);
    // One open, then a bounded number of document reads; never a second open.
    assert.equal(calls.filter(([name]) => name === 'browser_jev_open').length, 1);
    assert.equal(calls.filter(([name]) => name === 'browser_jev_observe').length, 4);
    assert.equal(waits.length, 3);
    assert.deepEqual(calls[0][3], {
      automationWorkspaceId: 'w',
      automationTabKey: 'extension-bench',
    });
  }),
);

test(
  'a DOM reader the page used marks its listings; one it did not use says why',
  withExtension(domExtension, async () => {
    const url = 'https://dom.bench.test/results',
      links = [
        {url: 'https://dom.bench.test/job/1', text: 'Role 1', listing: true},
        {url: 'https://dom.bench.test/company', text: 'Company', listing: false},
      ];
    const applied = await extensionBench({
      browser: fakeBrowser({
        pages: [page({url, loading: true}), page({url, siteExtension: 'bench-dom', links})],
        calls: [],
      }),
      db: db(),
      wait: async () => {},
    }).read('w', url);
    assert.equal(applied.applied, true);
    assert.doesNotThrow(() => structuredClone(applied));
    assert.equal(applied.listings.length, 1);
    assert.deepEqual(applied.diagnostics, []);

    const generic = await extensionBench({
      browser: fakeBrowser({
        pages: [page({url, links: links.map(({listing, ...l}) => l)})],
        calls: [],
        raw: {url, cards: [], items: null},
      }),
      db: db(),
    }).read('w', url);
    assert.equal(generic.applied, false);
    assert.deepEqual(generic.listings, []);
    assert.equal(generic.otherLinks, 2);
    assert.match(generic.diagnostics[0], /"cards":"0 items"/);
    assert.match(generic.diagnostics[1], /dom.results returned null/);
  }),
);

test('the bench refuses addresses that are not http(s)', async () => {
  await assert.rejects(
    extensionBench({browser: null, db: db()}).read('w', 'file:///etc/hosts'),
    /http\(s\) address/,
  );
});

test('a source bench opens the recipe searches a scan opens, not the source address', () => {
  const source = 'https://jobs.bench.test/',
    automation = (recipe) => ({
      get: () => ({
        templateId: 'job-search',
        goal: 'backend',
        sourceSettings: {[source]: {recipe}},
      }),
    });
  const recipe = {
    entry: {
      kind: 'url_template',
      template: 'https://jobs.bench.test/api/search?keywords={query}&location=United+States',
    },
    terms: ['staff backend engineer', 'senior .NET engineer'],
  };
  assert.deepEqual(extensionBench({browser: null, db: automation(recipe)}).searches('w', source), [
    {
      term: 'staff backend engineer',
      url: 'https://jobs.bench.test/api/search?keywords=staff+backend+engineer&location=United+States',
    },
    {
      term: 'senior .NET engineer',
      url: 'https://jobs.bench.test/api/search?keywords=senior+.NET+engineer&location=United+States',
    },
  ]);
  // Without a URL recipe the bench reads the source address itself.
  assert.deepEqual(
    extensionBench({browser: null, db: automation(undefined)}).searches('w', source),
    [],
  );
});
