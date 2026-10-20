// @ts-check
// LinkedIn site extension: a site exception the user explicitly requested
// (2026-10-05). Since 2026-10-19 a scan reads LinkedIn only in the user's
// signed-in browser, like a person browsing: the results page lists its cards
// (dom.collect/results) and each new posting opens on its own page
// (dom.listing). LinkedIn's logged-out jobs-guest API is no longer read; it
// refused after a few dozen requests an hour. Everything after the read
// (known listings, assessment, evidence, queue) stays generic.
import {listingPage} from './listing.mjs';
import {cardCollector} from '../sources/card-collector.mjs';

// Saved searches keep the address they were made with: the jobs-guest search
// (until 2026-10-19), the classic /jobs/search/ or the 2026 /jobs/search-results/.
const SEARCH_PATHS = new Set([
  '/jobs-guest/jobs/api/seeMoreJobPostings/search',
  '/jobs/search',
  '/jobs/search/',
  '/jobs/search-results',
  '/jobs/search-results/',
]);
// The signed-in results page lists 25 cards.
export const LINKEDIN_PAGE_SIZE = 25;
// Page views of the user's account: 5-7.5 s apart and at most 240 an hour
// (doubled twice at the user's request on 2026-10-19: 20-30 s and 60 an hour
// from 2026-10-12, then 10-15 s and 120 an hour, drew no block). Results pages
// and postings share this budget (the worker's browser budget for the site).
export const LINKEDIN_PACING = {
  minIntervalMs: 5000,
  jitterMs: 2500,
  budget: {requests: 240, windowMs: 60 * 60000},
};

const linkedInHost = (host) => host === 'linkedin.com' || host.endsWith('.linkedin.com');
// What a LinkedIn address is: a job search, a posting (with its job ID), or none.
export function linkedInAddress(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !linkedInHost(url.hostname)) return null;
  if (SEARCH_PATHS.has(url.pathname)) return {kind: 'search', url: url.href};
  const id =
    url.pathname.match(/^\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/)?.[1] ??
    url.pathname.match(/^\/jobs-guest\/jobs\/api\/jobPosting\/(\d{6,})\/?$/)?.[1];
  return id ? {kind: 'detail', id, url: url.href} : null;
}

// A saved search address as the search the collector pages through, from its
// first page.
export function linkedInSearchUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !linkedInHost(url.hostname))
    throw Error('A LinkedIn address is required.');
  if (!SEARCH_PATHS.has(url.pathname))
    throw Error(
      'The LinkedIn collector pages through job search addresses; save a search recipe with the search template.',
    );
  url.searchParams.delete('start');
  return url.href;
}

// The 2026 signed-in search (/jobs/search-results/) drops the location,
// work mode and sort parameters of the older addresses (observed 2026-10-19).
// It keeps keywords, start and f_TPR (posted within), takes the location as a
// geoId, and reads a work mode written into the keywords ("… remote"). Results
// come in relevance order.
const GEO_IDS = {
  germany: 101282230,
  deutschland: 101282230,
  'united states': 103644278,
  usa: 103644278,
  worldwide: 92000000,
};
// A location names its country ("Germany", "Berlin, Germany").
const geoIdOf = (location) => {
  const words = location.toLowerCase();
  return (
    GEO_IDS[words] ??
    Object.entries(GEO_IDS).find(([name]) => new RegExp(`\\b${name}\\b`).test(words))?.[1] ??
    null
  );
};
const WORK_MODES = {1: 'on-site', 2: 'remote', 3: 'hybrid'};
// The signed-in results page for a saved search address, at the same offset.
export function linkedInSignedInSearch(value) {
  const saved = new URL(value).searchParams,
    open = new URL('https://www.linkedin.com/jobs/search-results/');
  const modes = (saved.get('f_WT') ?? '')
    .split(',')
    .map((mode) => WORK_MODES[mode.trim()])
    .filter(Boolean);
  const keywords = [saved.get('keywords') ?? '', ...modes].join(' ').trim();
  if (keywords) open.searchParams.set('keywords', keywords);
  const location = saved.get('location')?.trim(),
    geoId = saved.get('geoId') ?? (location ? geoIdOf(location) : null);
  if (location && !geoId)
    throw Error(
      `LinkedIn takes a search location only as a geoId, and "${location}" has no known one. Search on linkedin.com with that location and add its geoId=… parameter to the source's search address.`,
    );
  if (geoId) open.searchParams.set('geoId', String(geoId));
  for (const key of ['f_TPR', 'start'])
    if (saved.get(key)) open.searchParams.set(key, saved.get(key));
  return open.href;
}

// One posting page open in the browser (logged in or not). Runs inside the
// page, so it is self-contained. The signed-in layout (observed 2026-10-19) has
// generated class names and no h1: its description sits in the "about the job"
// component, and the tab title reads "Title | Company | LinkedIn". The guest
// layout keeps its named classes. Styled Unicode letters become plain (NFKC).
export function collectLinkedInPosting() {
  const clean = (value) =>
    String(value ?? '')
      .normalize('NFKC')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  const text = (selectors) => {
    for (const selector of selectors) {
      const value = clean(document.querySelector(selector)?.innerText);
      if (value) return value;
    }
    return '';
  };
  // The company is the part before "LinkedIn"; a title may hold " | " itself.
  const tab = document.title.split(' | ').map(clean);
  const fromTab =
    tab.length >= 3 && tab.at(-1) === 'LinkedIn' ? [tab.slice(0, -2).join(' | '), tab.at(-2)] : [];
  return {
    url: location.href,
    title:
      text([
        '.job-details-jobs-unified-top-card__job-title h1',
        '.job-details-jobs-unified-top-card__job-title',
        '.top-card-layout__title',
        'main h1',
        'h1',
      ]) ||
      fromTab[0] ||
      '',
    company:
      text([
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
        '.topcard__org-name-link',
      ]) ||
      fromTab[1] ||
      '',
    location: text([
      '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
      '.job-details-jobs-unified-top-card__bullet',
      '.topcard__flavor--bullet',
    ]),
    description: text([
      '[componentkey^="JobDetails_AboutTheJob_"] [data-testid="expandable-text-box"]',
      '[componentkey^="JobDetails_AboutTheJob_"]',
      '#job-details',
      '.jobs-description__content .jobs-box__html-content',
      '.jobs-description-content__text',
      '.show-more-less-html__markup',
      '.description__text',
    ]),
    closed: /No longer accepting applications/i.test(document.body?.innerText ?? ''),
  };
}
// A posting is read only with its own description; a short block is a
// placeholder or a login prompt, not the listing.
export function readLinkedInPosting(raw) {
  const description = String(raw?.description ?? '').trim();
  if (!raw?.title || description.length < 200) return null;
  return {
    title: raw.title,
    company: raw.company || null,
    location: raw.location || null,
    description,
    fields: {},
    closed: Boolean(raw.closed),
  };
}

// The signed-in results page (/jobs/search-results/). Runs inside the page, so it is self-contained. The list renders only the
// cards near the viewport, but every list item carries its job ID; a card
// not rendered yet gives its ID alone and the posting read fills it in.
// Styled Unicode letters become plain (NFKC).
export function collectLinkedInResults() {
  if (!location.pathname.startsWith('/jobs/search')) return null;
  const clean = (value) =>
    String(value ?? '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim();
  const jobs = new Map();
  // A card reads title (often twice, once marked "(Verified job)"), company,
  // location, then dates and badges.
  const add = (id, card) => {
    if (!id) return;
    const job = jobs.get(id) ?? {id, title: '', company: '', location: ''};
    const lines = [
      ...new Set(
        String(card?.innerText ?? '')
          .split('\n')
          .map((line) => clean(line).replace(/\s*\(Verified job\)$/i, ''))
          .filter(Boolean),
      ),
    ];
    const link = card?.querySelector?.('a[href*="/jobs/view/"]');
    job.title ||= clean(link?.getAttribute('aria-label') || link?.innerText) || lines[0] || '';
    const rest = lines.filter((line) => line !== job.title);
    job.company ||= rest[0] ?? '';
    job.location ||= rest[1] ?? '';
    jobs.set(id, job);
  };
  // The 2026 layout marks each card with its job ID; the older one put it on
  // the list item.
  for (const item of document.querySelectorAll('[componentkey^="job-card-component-ref-"]'))
    if (!item.parentElement?.closest('[componentkey^="job-card-component-ref-"]'))
      add(item.getAttribute('componentkey').match(/(\d+)$/)?.[1], item);
  for (const item of document.querySelectorAll('[data-occludable-job-id], [data-job-id]'))
    add(item.getAttribute('data-occludable-job-id') || item.getAttribute('data-job-id'), item);
  for (const link of document.querySelectorAll('a[href*="/jobs/view/"]'))
    add(
      /** @type {HTMLAnchorElement} */ (link).href.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d+)/)?.[1],
      link.closest('li') ?? link.parentElement,
    );
  const text = document.querySelector('main')?.innerText ?? document.body?.innerText ?? '';
  return {
    url: location.href,
    jobs: [...jobs.values()],
    noResults: /No matching jobs found|Keine passenden Jobs/i.test(text),
  };
}
const signedInResults = (raw) => {
  if (!raw?.jobs || (!raw.jobs.length && !raw.noResults)) return null;
  const address = new URL(raw.url),
    start = Number(address.searchParams.get('start') ?? 0) || 0,
    next = new URL(address);
  next.searchParams.set('start', String(start + raw.jobs.length));
  const number = Math.floor(start / LINKEDIN_PAGE_SIZE) + 1;
  return {
    listings: raw.jobs.map((job) => ({
      ...job,
      url: `https://www.linkedin.com/jobs/view/${job.id}/`,
      text: [job.title, job.company, job.location].filter(Boolean).join(' · '),
    })),
    pagination: [
      {text: String(number), url: address.href, kind: 'link', current: true, disabled: false},
      ...(raw.jobs.length >= LINKEDIN_PAGE_SIZE
        ? [
            {
              text: String(number + 1),
              url: next.href,
              kind: 'link',
              current: false,
              disabled: false,
            },
          ]
        : []),
    ],
  };
};
// The cards of a signed-in results page in the collector's terms: the next
// page continues the saved search address at the offset after these cards.
export function linkedInBrowserCards(page, url) {
  if (page?.siteExtension !== 'linkedin') return null;
  const jobs = (page.links ?? [])
    .filter((link) => link.listing && link.id)
    .map((link) => ({
      url: link.url,
      title: link.title || '',
      company: link.company || '',
      location: link.location || '',
    }));
  const saved = new URL(url),
    start = Number(saved.searchParams.get('start') ?? 0) || 0;
  if (!jobs.length && !page.pagination?.length) return null;
  const nextUrl =
    jobs.length >= LINKEDIN_PAGE_SIZE
      ? (saved.searchParams.set('start', String(start + jobs.length)), saved.href)
      : null;
  return {
    url,
    jobs,
    page: Math.floor(start / LINKEDIN_PAGE_SIZE) + 1,
    totalPages: null,
    nextUrl,
    complete: !nextUrl,
  };
}

// Result pages hold cards only, so the app opens each new posting itself at
// the pacing above and hands the agent ready review batches (a collector).
// Both open in the user's signed-in browser.
const collector = cardCollector({
  templateId: 'job-search',
  searchUrl: linkedInSearchUrl,
  listingIn: 'browser',
  cardsInBrowser: {open: linkedInSignedInSearch, read: linkedInBrowserCards},
  detail: (job) => ({
    ...listingPage({
      browser: 'LinkedIn (signed-in browser)',
      url: job.url,
      title: job.company ? `${job.title} @ ${job.company}` : job.title,
      description: job.description,
      fields: {
        company: job.company,
        location: job.location,
        postedAt: job.publishedAt,
        ...job.criteria,
      },
      notes: job.closed ? ['No longer accepting applications.'] : [],
    }),
    cells: {company: job.company, location: job.location},
  }),
});

// Job-search scans use the collector; other reads (records, other templates)
// open the page in the browser, where the same page readers apply.
export default {
  id: 'linkedin',
  // The browser pacing of the collector's page views, shown on the Sources page.
  pacing: LINKEDIN_PACING,
  matches: (value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && linkedInHost(u.hostname);
    } catch {
      return false;
    }
  },
  collector,
  // One posting under every address LinkedIn gives it (country hosts, title
  // slugs, the guest endpoint): its job ID.
  listingKey: (url) => {
    const posting = linkedInAddress(url);
    return posting?.kind === 'detail' ? `https://www.linkedin.com/jobs/view/${posting.id}` : null;
  },
  // A posting opened in the browser (the collector's listing reads).
  dom: {
    listing: {
      handles: (url) => linkedInAddress(url)?.kind === 'detail',
      // Signed in, a country host with a title slug (de.linkedin.com/jobs/view/
      // senior-…-4437671367) shows an error page; the plain job address works.
      open: (url) => {
        const posting = linkedInAddress(url);
        return posting?.kind === 'detail'
          ? `https://www.linkedin.com/jobs/view/${posting.id}/`
          : url;
      },
      collect: collectLinkedInPosting,
      read: readLinkedInPosting,
    },
    // The signed-in results page (the collector's result pages).
    collect: collectLinkedInResults,
    results: signedInResults,
  },
  // The search address and the filters it accepts (observed 2026-10-19); the
  // collector opens it as the signed-in results page (linkedInSignedInSearch).
  search: {
    template: 'https://www.linkedin.com/jobs/search/?keywords={query}&location={location}',
    pagination: 'url_param',
    filters: [
      {param: 'f_WT', label: 'Work mode', values: {1: 'On-site', 2: 'Remote', 3: 'Hybrid'}},
      {
        param: 'f_TPR',
        label: 'Posted',
        values: {r86400: 'Last 24 hours', r604800: 'Last week', r2592000: 'Last month'},
      },
    ],
    notes:
      'Read in the signed-in browser, in relevance order. location is a country name (Germany, United States, Worldwide) or geoId=<LinkedIn geoId> replaces it. 25 cards per page, pages via &start=25,50,…',
  },
};
