// @ts-check
// LinkedIn site extension (HTTP reader): a site exception the user explicitly
// requested (2026-10-05). LinkedIn's public jobs-guest endpoints return plain job cards
// and posting markup, so search pages and postings are read over HTTP instead
// of a browser tab and returned as ordinary Jev page objects. Everything after
// the read (known listings, assessment, evidence, queue) stays generic.
// Card and posting parsing follows github.com/MadsLorentzen/ai-job-search (MIT).
import {decode, htmlText, inlineText, listingPage} from './listing.mjs';
import {siteFetch, isMissing, readerPage, READER_HEADERS} from './http.mjs';
import {cardCollector} from '../sources/card-collector.mjs';

const SEARCH_PATH = '/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
export const LINKEDIN_PAGE_SIZE = 10;
// LinkedIn answers guest reads with 429 after a few dozen requests from one
// address, even with seconds between them (2026-10-18: about 35 in 13
// minutes; 2026-10-19: about 27 in 10 minutes, then about 41 in 45 minutes at
// 30-40 s spacing). The limit looks hourly, around 40. The reference CLI stays
// low volume: about two result pages per query and postings only for a
// shortlist. So the guest reads keep 45-75 s apart (about one a minute) and at
// most 15 per hour; the rest of a scan resumes when the window frees
// (SiteAccess.spend). After a 429 LinkedIn kept refusing for over two hours
// (2026-10-19 04:17-06:20, which used up 30 and 90 minute retries), so
// retries wait one and three hours. On 2026-10-19 09:34 and 10:04 a 429 came
// after about 21 requests in 18 minutes and 27 in an hour, so 30 was too many.
export const LINKEDIN_PACING = {
  minIntervalMs: 45000,
  jitterMs: 30000,
  budget: {requests: 15, windowMs: 60 * 60000},
  retryDelaysMs: [60 * 60000, 180 * 60000],
};
// The guest endpoints serve the page's own XHR calls, which send this header.
const GUEST_HEADERS = {...READER_HEADERS, 'X-Requested-With': 'XMLHttpRequest'};

const linkedInHost = (host) => host === 'linkedin.com' || host.endsWith('.linkedin.com');
// Which guest request serves this address: a search page, a posting, or none.
export function linkedInGuestRequest(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !linkedInHost(url.hostname)) return null;
  if (url.pathname === SEARCH_PATH) return {kind: 'search', url: url.href};
  const id =
    url.pathname.match(/^\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/)?.[1] ??
    url.pathname.match(/^\/jobs-guest\/jobs\/api\/jobPosting\/(\d{6,})\/?$/)?.[1];
  return id ? {kind: 'detail', id, url: url.href} : null;
}

const clean = inlineText;
// Inner HTML of the first <div> carrying this class, following nested divs.
function divContent(html, className) {
  const open = new RegExp(`<div[^>]*class="[^"]*${className}[^"]*"[^>]*>`, 'i').exec(html);
  if (!open) return null;
  let i = open.index + open[0].length,
    depth = 1;
  while (depth > 0) {
    const nextOpen = html.indexOf('<div', i),
      nextClose = html.indexOf('</div>', i);
    if (nextClose < 0) return null;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      i = nextClose + 6;
    }
  }
  return html.slice(open.index + open[0].length, i - 6);
}

export function parseJobCards(html) {
  const cards = [];
  for (const chunk of html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1)) {
    const id = chunk.match(/^(\d+)/)?.[1];
    if (!id) continue;
    const href = chunk.match(/class="base-card__full-link[^"]*"[^>]*href="([^"]+)"/i)?.[1];
    const title =
      clean(chunk.match(/class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '') ||
      clean(chunk.match(/class="sr-only"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
    if (!title) continue;
    const company =
      clean(chunk.match(/class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/i)?.[1] ?? '') ||
      null;
    const location =
      clean(chunk.match(/class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '') ||
      null;
    const date =
      chunk.match(/class="job-search-card__listdate[^"]*"[^>]*datetime="([^"]+)"/i)?.[1] ?? null;
    // Tracking parameters change per request; the posting address does not.
    const url = href ? decode(href).split('?')[0] : `https://www.linkedin.com/jobs/view/${id}`;
    cards.push({id, title, company, location, date, url});
  }
  return cards;
}

export function parseJobDetail(html) {
  const title = clean(
    html.match(
      /class="(?:top-card-layout__title|topcard__title)[^"]*"[^>]*>([\s\S]*?)<\/h[12]>/i,
    )?.[1] ?? '',
  );
  const company =
    clean(html.match(/class="topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '') ||
    null;
  const location =
    clean(
      html.match(/class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ??
        '',
    ) || null;
  const description =
    htmlText(
      divContent(html, 'show-more-less-html__markup') ??
        divContent(html, 'description__text') ??
        '',
    ) || null;
  const criteria = [];
  for (const m of html.matchAll(
    /class="description__job-criteria-subheader"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?class="description__job-criteria-text[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
  ))
    criteria.push([clean(m[1]), clean(m[2])]);
  const descStart = html.search(/class="(?:show-more-less-html__markup|description__text)/i),
    top = descStart < 0 ? html : html.slice(0, descStart);
  return {
    title,
    company,
    location,
    description,
    criteria,
    closed: /closed-job__flavor|no longer accepting applications/i.test(top),
  };
}

const page = (url, title, text, links, pagination = []) =>
  readerPage({browser: 'LinkedIn guest reader', url, title, text, links, pagination});

// A results page lists its cards as known listings (links marked listing) and
// numbers itself; a full page links the next offset, a short or empty page
// links none, which is the end of the search.
export function linkedInSearchPage(url, cards) {
  const address = new URL(url),
    start = Number(address.searchParams.get('start') ?? 0) || 0,
    number = Math.floor(start / LINKEDIN_PAGE_SIZE) + 1;
  const lines = [`LinkedIn job search results, page ${number}`];
  for (const card of cards)
    lines.push(
      `Link: ${card.title} — ${card.url}`,
      [card.company, card.location, card.date && `posted ${card.date}`].filter(Boolean).join(' · '),
    );
  if (!cards.length)
    lines.push('This results page has no job cards: the search has no further results.');
  const next = new URL(address);
  next.searchParams.set('start', String(start + LINKEDIN_PAGE_SIZE));
  const pagination = [
    {text: String(number), url: address.href, kind: 'link', current: true, disabled: false},
    ...(cards.length >= LINKEDIN_PAGE_SIZE
      ? [{text: String(number + 1), url: next.href, kind: 'link', current: false, disabled: false}]
      : []),
  ];
  return page(
    address.href,
    'LinkedIn jobs',
    lines.join('\n'),
    cards.map((card) => ({text: card.title, url: card.url, listing: true})),
    pagination,
  );
}

export function linkedInDetailPage(url, html) {
  if (!html.trim())
    return page(
      url,
      'LinkedIn job',
      'This LinkedIn job posting was not found; it has been removed or is no longer available.',
      [],
    );
  const job = parseJobDetail(html);
  return listingPage({
    browser: 'LinkedIn guest reader',
    url,
    title: job.company ? `${job.title} @ ${job.company}` : job.title || 'LinkedIn job',
    description: job.description,
    fields: {company: job.company, location: job.location, ...Object.fromEntries(job.criteria)},
    notes: job.closed ? ['No longer accepting applications.'] : [],
  });
}

// One guest request through the shared site access rules (./http.mjs).
export async function readLinkedInGuest(url, options = {}) {
  const request = linkedInGuestRequest(url);
  if (!request) throw Error('LinkedIn guest reader does not handle this address');
  const target = request.kind === 'search' ? request.url : DETAIL_URL + request.id;
  const response = await siteFetch(target, {
    ...LINKEDIN_PACING,
    headers: GUEST_HEADERS,
    ...options,
    site: 'LinkedIn',
    url,
  });
  if (isMissing(response))
    return request.kind === 'search' ? linkedInSearchPage(url, []) : linkedInDetailPage(url, '');
  const html = await response.text();
  return request.kind === 'search'
    ? linkedInSearchPage(url, parseJobCards(html))
    : linkedInDetailPage(url, html);
}

const guestFetch = (target, url, options) =>
  siteFetch(target, {
    ...LINKEDIN_PACING,
    headers: GUEST_HEADERS,
    ...options,
    site: 'LinkedIn',
    url,
  });

// The collector's result page: the cards of one guest search page. A full
// page links the next offset; a short or empty one ends the search.
export async function readLinkedInCards(url, options = {}) {
  const request = linkedInGuestRequest(url);
  if (request?.kind !== 'search') throw Error('A LinkedIn jobs-guest search address is required.');
  const response = await guestFetch(request.url, url, options),
    cards = isMissing(response) ? [] : parseJobCards(await response.text());
  const address = new URL(url),
    start = Number(address.searchParams.get('start') ?? 0) || 0,
    next = new URL(address);
  next.searchParams.set('start', String(start + LINKEDIN_PAGE_SIZE));
  const nextUrl = cards.length >= LINKEDIN_PAGE_SIZE ? next.href : null;
  return {
    url: address.href,
    jobs: cards.map((card) => ({
      url: card.url,
      title: card.title,
      company: card.company,
      location: card.location,
      publishedAt: card.date,
    })),
    page: Math.floor(start / LINKEDIN_PAGE_SIZE) + 1,
    totalPages: null,
    nextUrl,
    complete: !nextUrl,
  };
}

// The collector's listing read: one posting's full text by its address.
export async function readLinkedInListing(url, options = {}) {
  const request = linkedInGuestRequest(url);
  if (request?.kind !== 'detail') throw Error('A LinkedIn job posting address is required.');
  const response = await guestFetch(DETAIL_URL + request.id, url, options);
  if (isMissing(response))
    throw Object.assign(Error('This LinkedIn job posting was removed.'), {
      status: response.status,
    });
  const job = parseJobDetail(await response.text());
  if (!job.title || !job.description)
    throw Error('The LinkedIn posting has no readable title or description.');
  return {
    url,
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description,
    criteria: Object.fromEntries(job.criteria),
    closed: job.closed,
  };
}

// A saved search address as the guest search the collector pages through.
export function linkedInSearchUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !linkedInHost(url.hostname))
    throw Error('A LinkedIn address is required.');
  if (url.pathname !== SEARCH_PATH)
    throw Error(
      'The LinkedIn collector pages through jobs-guest search addresses; save a search recipe with the guest search template.',
    );
  const search = new URL(`https://www.linkedin.com${SEARCH_PATH}`);
  for (const [key, entry] of url.searchParams)
    if (key !== 'start') search.searchParams.append(key, entry);
  return search.href;
}

// One posting page open in the browser (logged in or not). Runs inside the
// page, so it is self-contained. The logged-in layout comes first, then the
// guest layout; the first heading and the job details block are the fallback.
export function collectLinkedInPosting() {
  const text = (selectors) => {
    for (const selector of selectors) {
      const value = document
        .querySelector(selector)
        ?.innerText?.replace(/[ \t]+/g, ' ')
        .trim();
      if (value) return value;
    }
    return '';
  };
  return {
    url: location.href,
    title: text([
      '.job-details-jobs-unified-top-card__job-title h1',
      '.job-details-jobs-unified-top-card__job-title',
      '.top-card-layout__title',
      'main h1',
      'h1',
    ]),
    company: text([
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.topcard__org-name-link',
    ]),
    location: text([
      '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
      '.job-details-jobs-unified-top-card__bullet',
      '.topcard__flavor--bullet',
    ]),
    description: text([
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

// Result pages hold cards only, so the app reads each new posting itself at
// the pacing above and hands the agent ready review batches (a collector).
const collector = cardCollector({
  templateId: 'job-search',
  searchUrl: linkedInSearchUrl,
  readCards: readLinkedInCards,
  readListing: readLinkedInListing,
  // Postings open in the user's browser; the guest API serves the result pages.
  listingIn: 'browser',
  detail: (job) => ({
    ...listingPage({
      browser: 'LinkedIn guest reader',
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
// use the HTTP reader, which hands guest pages to Jev as ordinary pages.
export default {
  id: 'linkedin',
  // The Sources page shows request rates against this pacing.
  pacing: LINKEDIN_PACING,
  matches: (value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && linkedInHost(u.hostname);
    } catch {
      return false;
    }
  },
  http: {handles: (url) => Boolean(linkedInGuestRequest(url)), read: readLinkedInGuest},
  collector,
  // A posting opened in the browser (the collector's listing reads).
  dom: {
    listing: {
      handles: (url) => linkedInGuestRequest(url)?.kind === 'detail',
      collect: collectLinkedInPosting,
      read: readLinkedInPosting,
    },
  },
  // The guest search address and the filters it accepts (observed 2026-10).
  search: {
    template: `https://www.linkedin.com${SEARCH_PATH}?keywords={query}&location={location}&sortBy=DD`,
    ordering: 'newest_first',
    pagination: 'url_param',
    filters: [
      {param: 'f_WT', label: 'Work mode', values: {1: 'On-site', 2: 'Remote', 3: 'Hybrid'}},
      {
        param: 'f_TPR',
        label: 'Posted',
        values: {r86400: 'Last 24 hours', r604800: 'Last week', r2592000: 'Last month'},
      },
    ],
    notes: 'sortBy=DD orders newest first. 10 cards per page, pages via &start=10,20,…',
  },
};
