// LinkedIn site extension (HTTP reader): a site exception the user explicitly
// requested (2026-10-05). LinkedIn's public jobs-guest endpoints return plain job cards
// and posting markup, so search pages and postings are read over HTTP instead
// of a browser tab and returned as ordinary Jev page objects. Everything after
// the read (known listings, assessment, evidence, queue) stays generic.
// Card and posting parsing follows github.com/MadsLorentzen/ai-job-search (MIT).
import {SiteWaitError} from '../browser/site-access.mjs';

const SEARCH_PATH = '/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
export const LINKEDIN_PAGE_SIZE = 10;
const BLOCKED_STATUSES = new Set([403, 429, 999]);
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; AutoJev/1.0)',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

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

const entity = (cp) => (cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '');
const decode = (text) =>
  text
    .replace(/&#(\d+);/g, (_, d) => entity(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => entity(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
const clean = (html) =>
  decode(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
const blockText = (html) =>
  decode(
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|ul|ol|div|h\d)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
    blockText(
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

const ready = {loading: false, reason: null};
const page = (url, title, text, links, pagination = []) => ({
  browser: 'LinkedIn guest reader',
  url,
  title,
  text,
  links,
  pagination,
  status: 'ready',
  reading: {scope: 'site_reader', truncated: false, readiness: ready, unreadFrames: 0},
});

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
  const lines = [
    job.title || 'LinkedIn job',
    [job.company, job.location].filter(Boolean).join(' · '),
    ...(job.closed ? ['No longer accepting applications.'] : []),
    ...job.criteria.map(([k, v]) => `${k}: ${v}`),
    '',
    job.description ?? '',
  ];
  return page(
    url,
    job.company ? `${job.title} @ ${job.company}` : job.title || 'LinkedIn job',
    lines.join('\n').trim(),
    [],
  );
}

// One guest request through the shared site access rules: an active site wait
// stops it before sending, pacing spaces requests after an incident, and a
// block status starts the same shared wait a browser read would.
export async function readLinkedInGuest(
  url,
  {
    fetch = globalThis.fetch,
    signal,
    siteAccess,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const request = linkedInGuestRequest(url);
  if (!request) throw Error('LinkedIn guest reader does not handle this address');
  const target = request.kind === 'search' ? request.url : DETAIL_URL + request.id;
  const token = siteAccess?.begin(target) ?? null;
  const delay = siteAccess?.pace(target) ?? 0;
  if (delay) {
    await wait(delay);
    signal?.throwIfAborted();
  }
  const response = await fetch(target, {
    headers: HEADERS,
    redirect: 'follow',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (BLOCKED_STATUSES.has(response.status)) {
    const blocked = siteAccess?.complete(target, token, {
      status: response.status,
      reason: 'rate_limit',
    });
    if (blocked) throw Object.assign(new SiteWaitError(blocked), {url});
    throw Object.assign(Error(`LinkedIn erişimi reddetti (HTTP ${response.status}).`), {url});
  }
  siteAccess?.complete(target, token, {status: response.status});
  if (response.status === 404 || response.status === 410)
    return request.kind === 'search' ? linkedInSearchPage(url, []) : linkedInDetailPage(url, '');
  if (!response.ok)
    throw Object.assign(Error(`LinkedIn isteği başarısız oldu (HTTP ${response.status}).`), {url});
  const html = await response.text();
  return request.kind === 'search'
    ? linkedInSearchPage(url, parseJobCards(html))
    : linkedInDetailPage(url, html);
}

// No browser tab: the worker reads guest search pages and postings through
// reader.read and hands them to Jev as ordinary pages.
export default {
  id: 'linkedin',
  matches: (value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && linkedInHost(u.hostname);
    } catch {
      return false;
    }
  },
  reader: {handles: (url) => Boolean(linkedInGuestRequest(url)), read: readLinkedInGuest},
};
