// @ts-check
// Development only (unpackaged builds): the extension test bench. It reads one
// address the way a scan of this workspace would — a site extension's DOM
// reader on the workspace's managed Chrome, its HTTP reader or its API
// collector, otherwise the generic browser reader — and reports what came
// back. No agent, no Jev model call, no triage, scoring or records. Pages and
// collected listings stay in RAM.
import {siteExtensionFor, siteExtensionKind, SITE_EXTENSIONS} from '../site-extensions/index.mjs';
import {listingCard} from '../site-extensions/listing.mjs';
import {pageEntries} from '../site-extensions/http.mjs';
import {reloadSiteExtensions, siteExtensionsVersion} from '../site-extensions/reload.mjs';
import {recipeReplay, recipeValues} from './recipe.mjs';

// One bench tab per workspace, navigated by every browser read.
const TAB_KEY = 'extension-bench',
  OWNER = 'extension-bench',
  READ_TIMEOUT_MS = 60000,
  SETTLE_TRIES = 4,
  SETTLE_MS = 1500,
  TEXT_LIMIT = 6000,
  LINK_SAMPLE = 60,
  JOB_CACHE = 1000;

const kindOf = (extension) =>
  extension.collector ? 'api' : extension.http ? 'http' : extension.dom ? 'browser' : null;
const excerpt = (text) => {
  const value = String(text ?? '');
  return {text: value.slice(0, TEXT_LIMIT), length: value.length};
};
const parse = (result) => {
  const text = result?.content?.find((part) => part.type === 'text')?.text ?? '';
  if (result?.isError) throw Error(text || 'The browser call failed.');
  const page = JSON.parse(text);
  if (page.status === 'browser_wait')
    throw Error('Chrome is still connecting for this workspace. Try again in a moment.');
  if (page.siteWait) throw Error(page.siteWait.message ?? 'The site asked to wait; try later.');
  if (page.navigationError) throw Error(page.navigationError);
  return page;
};
// The shape of what dom.collect returned, without its content: enough to see
// which part of the page the reader did not find.
const shape = (value, depth = 0) => {
  if (value === null || value === undefined) return value === null ? 'null' : 'missing';
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 80) : value;
  if (depth) return 'object';
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
};
// The listing a page carries: a site reader's own (listingPage) or the page's
// schema.org JobPosting from the browser reader.
function listingSummary(page) {
  if (!page.listing) return null;
  const text = page.listing.text ?? page.text ?? '',
    split = text.indexOf('\n\n');
  return {
    fields: page.listing.fields ?? {},
    description: excerpt(split < 0 ? '' : text.slice(split + 2)),
    card: listingCard({...page, text}),
  };
}
function pageSummary(page, base) {
  const links = page.links ?? [];
  return {
    url: page.url,
    title: page.title ?? '',
    readiness: page.reading?.readiness ?? null,
    // The browser reader marks listings only when the DOM extension read the page.
    applied: Boolean(page.siteExtension) || base.transport !== 'browser',
    listings: links
      .filter((link) => link.listing === true)
      .map((link) => ({
        url: link.url,
        title: link.text ?? '',
        ...(link.siteCard ? {card: link.siteCard} : {}),
      })),
    otherLinks: links.filter((link) => link.listing !== true).length,
    otherLinkSample: links
      .filter((link) => link.listing !== true)
      .slice(0, LINK_SAMPLE)
      .map((link) => ({url: link.url, text: link.text ?? ''})),
    pagination: (page.pagination ?? []).map((entry) => ({
      text: entry.text ?? '',
      url: entry.url ?? null,
      current: Boolean(entry.current),
      disabled: Boolean(entry.disabled),
      kind: entry.kind ?? null,
    })),
    listing: listingSummary(page),
    text: excerpt(page.text),
  };
}

export function extensionBench({
  browser,
  db,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const jobs = new Map();
  const remember = (extensionId, job) => {
    jobs.delete(job.url);
    jobs.set(job.url, {extensionId, job});
    if (jobs.size > JOB_CACHE) jobs.delete(jobs.keys().next().value);
  };
  // What a scan of this workspace reads the address with.
  function route(id, url) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw Error('Enter an http(s) address.');
    const {templateId} = db.get(id),
      extension = siteExtensionFor(target.href),
      kind = siteExtensionKind(target.href, templateId)?.kind ?? null,
      notes = [];
    if (extension?.collector && !kind)
      notes.push(
        `The ${extension.id} collector serves ${extension.collector.templateId} workspaces only; scans here read the address in the browser.`,
      );
    if (kind === 'http' && !extension.http.handles(target.href))
      notes.push(
        `The ${extension.id} HTTP reader does not handle this address; scans read it in the browser.`,
      );
    const transport =
      kind === 'api'
        ? 'api'
        : kind === 'http' && extension.http.handles(target.href)
          ? 'http'
          : 'browser';
    return {
      url: target.href,
      extension: extension ? {id: extension.id, kind: kindOf(extension)} : null,
      instance: extension,
      transport,
      notes,
    };
  }
  const signal = () => AbortSignal.timeout(READ_TIMEOUT_MS);

  async function call(id, name, args) {
    return parse(
      await browser.forWorker(OWNER).call(id, name, args, OWNER, {
        automationWorkspaceId: id,
        automationTabKey: TAB_KEY,
      }),
    );
  }
  // Reads the bench tab's document until it stops loading, a bounded number of
  // times. A page still loading afterwards is reported as not ready, never as empty.
  async function settle(id, tabId) {
    let page = null;
    for (let attempt = 0; attempt < SETTLE_TRIES; attempt++) {
      if (attempt) await wait(SETTLE_MS);
      page = await call(id, 'browser_jev_observe', {
        tabId,
        scope: 'document',
        full: true,
        fullReason: 'context_loss',
      });
      if (!page.reading?.readiness?.loading) break;
    }
    return page;
  }
  // Why a DOM extension left the page to the generic reader, from a second
  // run of its own collect/results on the same tab.
  async function domDiagnostics(id, tabId, extension, page) {
    if (!extension?.dom || page.siteExtension) return [];
    return browser.enqueue(
      id,
      async () => {
        const slot = (await browser.connectedClient(id))?.tabs.get(tabId);
        if (!slot) return ['The bench tab is gone; read the address again.'];
        let raw;
        try {
          raw = await slot.page.evaluate(extension.dom.collect);
        } catch (error) {
          return [`dom.collect threw in the page: ${error.message}`];
        }
        const lines = [`dom.collect returned: ${JSON.stringify(shape(raw))}`];
        if (raw?.url !== page.url)
          lines.push(
            `dom.collect reported url ${raw?.url ?? 'none'}, the page is ${page.url}; a read across a redirect is dropped.`,
          );
        try {
          const read = extension.dom.results(raw);
          lines.push(
            read
              ? `dom.results now returns ${read.listings?.length ?? 0} listings; the page changed between the reads — read again.`
              : 'dom.results returned null: the generic reader kept the page (no cards, a loading page, a detail page or a changed layout).',
          );
        } catch (error) {
          lines.push(`dom.results threw: ${error.message}`);
        }
        return lines;
      },
      {checkActive: false},
    );
  }
  async function readBrowser(id, base, {reopen = true} = {}) {
    const tabId = reopen ? (await call(id, 'browser_jev_open', {url: base.url})).tabId : base.tabId;
    if (!tabId) throw Error('Could not open the bench tab.');
    const page = await settle(id, tabId),
      diagnostics = await domDiagnostics(id, tabId, base.instance, page);
    return {page, tabId, diagnostics};
  }
  const result = (base, summary) => {
    const {instance, ...rest} = base;
    return {...rest, ...summary, at: Date.now(), version: siteExtensionsVersion()};
  };

  return {
    status: () => ({
      available: true,
      version: siteExtensionsVersion(),
      extensions: SITE_EXTENSIONS.map((extension) => ({
        id: extension.id,
        kind: kindOf(extension),
      })),
    }),
    reload: reloadSiteExtensions,

    // The addresses a scan of this source opens: its recipe's searches, one per
    // term, filled like the scan fills them. Without a URL recipe, the source.
    searches(id, sourceUrl) {
      const a = db.get(id),
        replay = recipeReplay(
          a.sourceSettings?.[sourceUrl]?.recipe ?? null,
          recipeValues(a, sourceUrl),
        );
      return replay?.kind === 'url_template'
        ? replay.searches.map((search) => ({term: search.term, url: search.url}))
        : [];
    },

    // A results page (or any page): its listings, other links and pagination.
    async read(id, url) {
      const base = route(id, url);
      if (base.transport === 'api') {
        const adapter = base.instance.collector,
          apiUrl = adapter.searchUrl(base.url),
          page = await adapter.readPage(apiUrl, {signal: signal()});
        for (const job of page.jobs) remember(base.instance.id, job);
        const number = page.page ?? 1;
        return result(base, {
          url: base.url,
          apiUrl: page.url ?? apiUrl,
          title: '',
          readiness: null,
          applied: true,
          listings: page.jobs.map((job) => ({
            url: job.url,
            title: job.title ?? '',
            card: listingCard(adapter.detail(job)),
          })),
          otherLinks: 0,
          otherLinkSample: [],
          pagination: pageEntries(page.url ?? apiUrl, number, page.totalPages, page.nextUrl),
          complete: page.complete ?? !page.nextUrl,
          unavailable: page.unavailable ?? [],
          listing: null,
          text: excerpt(''),
        });
      }
      if (base.transport === 'http') {
        const page = await base.instance.http.read(base.url, {
          signal: signal(),
          siteAccess: db.siteAccess,
          wait,
        });
        return result(base, pageSummary(page, base));
      }
      const {page, tabId, diagnostics} = await readBrowser(id, base);
      return result(base, {...pageSummary(page, base), tabId, diagnostics});
    },

    // Reads the bench tab again without reloading it, for a page that was
    // still loading.
    async observe(id, url, tabId) {
      const base = {...route(id, url), tabId};
      if (base.transport !== 'browser') throw Error('Only browser reads have a tab to read again.');
      const read = await readBrowser(id, base, {reopen: false});
      return result(base, {...pageSummary(read.page, base), tabId, diagnostics: read.diagnostics});
    },

    // One listing as Jev's detail evidence would get it.
    async listing(id, url) {
      const base = route(id, url);
      if (base.transport === 'api') {
        const adapter = base.instance.collector,
          cached = jobs.get(base.url);
        let job = cached?.extensionId === base.instance.id ? cached.job : null;
        if (!job) {
          if (!adapter.readDetail) throw Error('This collector cannot read a single listing.');
          job = {...(await adapter.readDetail(base.url, {signal: signal()})), url: base.url};
          remember(base.instance.id, job);
        }
        const page = adapter.detail(job);
        return result(base, {
          ...pageSummary(page, base),
          fromCache: Boolean(cached),
          cells: page.cells ?? {},
        });
      }
      if (base.transport === 'http') {
        const page = await base.instance.http.read(base.url, {
          signal: signal(),
          siteAccess: db.siteAccess,
          wait,
        });
        return result(base, pageSummary(page, base));
      }
      const {page, tabId, diagnostics} = await readBrowser(id, base);
      return result(base, {...pageSummary(page, base), tabId, diagnostics});
    },

    // Closes this workspace's bench tab.
    close: (id) =>
      browser.enqueue(
        id,
        async () => {
          const client = await browser.connectedClient(id);
          if (!client) return {closed: 0};
          let closed = 0;
          for (const slot of [...client.tabs.values()])
            if (
              client.automationTabs.get(slot.id) === TAB_KEY &&
              client.automationWorkspaces.get(slot.id) === id
            )
              try {
                await slot.page.close({runBeforeUnload: false});
                client.forgetTab(slot.id);
                closed++;
              } catch {}
          await client.persistTabs().catch(() => {});
          return {closed};
        },
        {checkActive: false},
      ),
  };
}

// The bench's IPC handlers; only `extension-bench-status` exists in a packaged build.
export function registerExtensionBench({enabled, handle, browser, db, changed}) {
  if (!enabled) {
    handle('extension-bench-status', () => ({available: false}));
    return null;
  }
  const bench = extensionBench({browser, db});
  handle('extension-bench-status', () => bench.status());
  handle('extension-bench-searches', (id, url) => bench.searches(id, url));
  handle('extension-bench-read', (id, url) => bench.read(id, url));
  handle('extension-bench-observe', (id, url, tabId) => bench.observe(id, url, tabId));
  handle('extension-bench-listing', (id, url) => bench.listing(id, url));
  handle('extension-bench-close', (id) => bench.close(id));
  handle('extension-bench-reload', async () => {
    const reloaded = await bench.reload();
    // Source rows show the reader kind; let open windows read it again.
    for (const automation of db.list()) changed(automation.id);
    return {...bench.status(), ...reloaded};
  });
  return bench;
}
