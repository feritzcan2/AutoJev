// Indeed site extension (user asked for one, 2026-10-10). Most result cards
// link through ad-click redirects (/pagead/clk, /rc/clk) whose address changes
// on every page load, so a saved record never matched its queued card and some
// redirects ended in the Indeed Apply flow. Every card carries its listing id
// (data-jk); /viewjob?jk=<id> is the stable listing address. Each page also
// holds one hidden card (aria-hidden, not in the page's own result list) that
// is not a listing. Checked live on de.indeed.com 2026-10-10.
//
// Since 2026-10-21 (user asked) a job-search scan reads Indeed like LinkedIn:
// the app opens each results page in the user's browser, clicks each new card
// there and reads the posting from the pane beside the cards (dom.pane), so a
// posting opens on its own /viewjob page only when the pane does not show it.
import {cardCollector} from '../sources/card-collector.mjs';
import {listingPage} from './listing.mjs';

export const isIndeedUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:[a-z]{2,3}\.)?indeed\.com$/.test(u.hostname);
  } catch {
    return false;
  }
};

// Runs inside the page through page.evaluate, so it must stay self-contained.
// It only reports what the page shows; indeedResults() decides.
export function collectIndeedPage() {
  const results =
    window.mosaic?.providerData?.['mosaic-provider-jobcards']?.metaData?.mosaicProviderJobCardsModel
      ?.results;
  return {
    url: location.href,
    cards: [...document.querySelectorAll('a[data-jk]')].map((a) => ({
      id: String(a.dataset.jk ?? ''),
      title: (a.innerText ?? '').replace(/\s+/g, ' ').trim(),
      hidden: Boolean(a.closest('[aria-hidden="true"]')),
    })),
    items: Array.isArray(results)
      ? results.map((r) => ({
          id: String(r.jobkey ?? ''),
          title: String(r.displayTitle ?? r.title ?? ''),
          company: String(r.company ?? ''),
          location: String(r.formattedLocation ?? ''),
          posted: Number.isFinite(r.pubDate) ? new Date(r.pubDate).toISOString().slice(0, 10) : '',
        }))
      : null,
    next: document.querySelector('a[data-testid="pagination-page-next"]')?.href ?? null,
  };
}

const JOB_ID = /^[0-9a-f]{16}$/;
const pageNumber = (value) =>
  Math.floor(Number(new URL(value).searchParams.get('start') ?? 0) / 10) + 1;

// The next page keeps the search and filters of the current address.
function pagination(raw) {
  const pages = [
    {text: String(pageNumber(raw.url)), url: raw.url, current: true, disabled: false, kind: 'link'},
  ];
  if (raw.next) {
    const next = new URL(raw.next, raw.url);
    if (next.origin !== new URL(raw.url).origin) return null;
    for (const [key, value] of new URL(raw.url).searchParams)
      if (!['start', 'vjk'].includes(key) && !next.searchParams.has(key))
        next.searchParams.append(key, value);
    pages.push({
      text: String(pageNumber(next.href)),
      url: next.href,
      current: false,
      disabled: false,
      kind: 'link',
    });
  }
  return pages;
}

// Returns {listings,pagination} for an Indeed result page, or null when the
// page has no result list (still loading, a detail or sign-in page, or a
// changed layout); the generic reader then handles the page unchanged.
export function indeedResults(raw) {
  if (!raw?.items?.length || !raw.cards?.length) return null;
  const shown = new Map(
    raw.cards.filter((c) => !c.hidden && JOB_ID.test(c.id)).map((c) => [c.id, c]),
  );
  // The result list must describe the rendered cards; otherwise it is stale.
  if (![...shown.keys()].every((id) => raw.items.some((i) => i.id === id))) return null;
  const origin = new URL(raw.url).origin;
  const listings = raw.items
    .filter((item) => shown.has(item.id))
    .map((item) => ({
      url: `${origin}/viewjob?jk=${item.id}`,
      text: item.title || shown.get(item.id).title,
      siteCard: [item.title, item.company, item.location, item.posted].filter(Boolean).join(' · '),
      id: item.id,
      title: item.title || shown.get(item.id).title,
      company: item.company,
      location: item.location,
      posted: item.posted,
    }));
  return listings.length ? {listings, pagination: pagination(raw)} : null;
}

// The results address of the Indeed site the source uses, in Indeed's default
// relevance order (user asked, 2026-10-19). The date sort put listings that
// only loosely matched the words ahead of matching ones; a saved template
// loses its sort=date. Indeed's own "Relevanz" link is the address without a
// sort parameter (checked on de.indeed.com). The order mixes dates, so there
// is no newest_first. fromage keeps only recent listings.
const search = (url) => ({
  template: `${new URL(url).origin}/jobs?q={query}&l={location}`,
  removes: ['sort'],
  pagination: 'url_param',
  filters: [
    {
      param: 'fromage',
      label: 'Posted',
      values: {1: 'Last 24 hours', 3: 'Last 3 days', 7: 'Last 7 days', 14: 'Last 14 days'},
    },
    {
      param: 'radius',
      label: 'Radius (km)',
      values: {0: 'City only', 10: '10', 25: '25', 50: '50'},
    },
  ],
  notes:
    'Pages via &start=10,20,… Listings open as /viewjob?jk=<id>. Without a signed-in Indeed session the second results page may ask to sign in.',
});

// The listing ID of a posting address (/viewjob?jk=<id>), or null.
export function indeedJobKey(value) {
  try {
    const url = new URL(value);
    const jk = url.searchParams.get('jk');
    return isIndeedUrl(url.href) && url.pathname === '/viewjob' && JOB_ID.test(jk ?? '')
      ? jk
      : null;
  } catch {
    return null;
  }
}
const isResultsPage = (value) => {
  try {
    return isIndeedUrl(value) && new URL(value).pathname === '/jobs';
  } catch {
    return false;
  }
};

// The card of a listing ID on the results page, to show it in the pane. Runs
// inside the page, so it is self-contained; the hidden decoy card is not one.
export function indeedCard(key) {
  return (
    [...document.querySelectorAll(`a[data-jk="${key}"]`)].find(
      (card) => !card.closest('[aria-hidden="true"]'),
    ) ?? null
  );
}

// The posting the results page's pane shows. Runs inside the page (its main
// world), so it is self-contained. The pane carries no listing ID in its
// markup, and the address's vjk changes before the pane does; the pane's own
// component state names the listing it renders (jobKey), checked live on
// de.indeed.com 2026-10-21. The summary holds pay, job type and place.
export function collectIndeedPane() {
  const clean = (value) =>
    String(value ?? '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  const pane = document.querySelector('#jobsearch-ViewjobPaneWrapper'),
    main = pane?.querySelector('[data-testid="viewjob-main-content"]'),
    fiber = main ? Object.keys(main).find((name) => name.startsWith('__reactFiber')) : null;
  let key = null;
  for (let node = fiber ? main[fiber] : null, i = 0; node && i < 8 && !key; i++, node = node.return)
    if (typeof node.memoizedProps?.jobKey === 'string') key = node.memoizedProps.jobKey;
  const summary = pane?.querySelector('[data-testid="structured-job-summary"]'),
    headings = new Set(
      [...(summary?.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]') ?? [])].map(
        (heading) => clean(heading.innerText),
      ),
    );
  return {
    url: location.href,
    key,
    title: clean(pane?.querySelector('[data-testid="vj-job-title"]')?.innerText),
    company: clean(
      pane?.querySelector('[data-testid="company-info-metadata"] a[href*="/cmp/"]')?.innerText,
    ),
    summary: clean(summary?.innerText)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !headings.has(line)),
    description: clean(
      pane?.querySelector('[data-testid="viewjob-job-content"] .react-native-html-content')
        ?.innerText,
    ),
  };
}
// A pane is read only with its own description; a short block is still loading.
export function readIndeedPane(raw) {
  const description = String(raw?.description ?? '').trim();
  if (!raw?.title || description.length < 200) return null;
  const summary = Array.isArray(raw.summary) ? raw.summary.map(String).filter(Boolean) : [];
  return {
    title: raw.title,
    company: raw.company || null,
    location: null,
    description,
    fields: summary.length ? {summary: summary.join(' · ').slice(0, 500)} : {},
    closed: false,
  };
}

// A saved search address as the search the collector pages through, from its
// first page: the results path with the same search and filters.
export function indeedSearchUrl(value) {
  const url = new URL(value);
  if (!isIndeedUrl(url.href)) throw Error('An Indeed address is required.');
  url.pathname = '/jobs';
  url.hash = '';
  for (const key of ['start', 'vjk']) url.searchParams.delete(key);
  return url.href;
}
// The cards of a results page read in the browser, in the collector's terms.
export function indeedBrowserCards(page, url) {
  if (page?.siteExtension !== 'indeed') return null;
  const jobs = (page.links ?? [])
    .filter((link) => link.listing && link.id)
    .map((link) => ({
      url: link.url,
      title: link.title || '',
      company: link.company || '',
      location: link.location || '',
      publishedAt: link.posted || '',
    }));
  if (!jobs.length) return null;
  const nextUrl = (page.pagination ?? []).find((entry) => !entry.current && entry.url)?.url ?? null;
  return {
    url,
    jobs,
    page: pageNumber(url),
    totalPages: null,
    nextUrl,
    complete: !nextUrl,
  };
}

// Results pages and postings that open on their own page keep the app's
// default browser pacing. A card click loads no page, only the posting the
// pane shows: 2.5-5 s apart, like a person reading the list, and at most 480
// an hour (LinkedIn's pane pacing).
export const INDEED_PACING = {
  minIntervalMs: 12000,
  jitterMs: 8000,
  budget: {requests: 120, windowMs: 60 * 60000},
  pane: {minIntervalMs: 2500, jitterMs: 2500, budget: {requests: 480, windowMs: 60 * 60000}},
};

// The posting a card read gives, as the listing evidence.
const detail = (job) => ({
  ...listingPage({
    browser: 'Indeed (browser)',
    url: job.url,
    title: job.company ? `${job.title} @ ${job.company}` : job.title,
    description: job.description,
    fields: {
      company: job.company,
      location: job.location,
      postedAt: job.publishedAt,
      ...job.fields,
    },
  }),
  cells: {company: job.company, location: job.location},
});

// Job-search scans use the collector; other reads (records, other templates)
// open the page in the browser, where the same page readers apply.
const collector = cardCollector({
  templateId: 'job-search',
  searchUrl: indeedSearchUrl,
  acceptsQuery: isResultsPage,
  listingIn: 'browser',
  cardsInBrowser: {open: (url) => url, read: indeedBrowserCards},
  detail,
});

export default {
  id: 'indeed',
  matches: isIndeedUrl,
  pacing: INDEED_PACING,
  collector,
  dom: {
    pageWorld: true,
    collect: collectIndeedPage,
    results: indeedResults,
    pane: {
      handles: isResultsPage,
      key: indeedJobKey,
      card: indeedCard,
      collect: collectIndeedPane,
      read: readIndeedPane,
    },
  },
  search,
};
