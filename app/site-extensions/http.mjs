// @ts-check
// Shared plumbing of the HTTP site readers: one request through the shared site
// access rules (an active site wait stops it before sending, pacing spaces
// requests after an incident, a block status starts the same wait a browser
// read would) and the page shapes a reader hands to Jev.
import {SiteWaitError} from '../browser/site-access.mjs';
import {htmlText} from './listing.mjs';

export const READER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; AutoJev/1.0)',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const BLOCKED_STATUSES = new Set([403, 429, 999]);
const MISSING_STATUSES = new Set([404, 410]);

/**
 * Fetches `target` for the page requested as `url` (a GET, or the `method` and
 * `body` a site's own search endpoint needs). `minIntervalMs` is the site's
 * stated minimum spacing between requests (a robots.txt crawl delay), applied by
 * the shared pacing, `jitterMs` a random addition to that spacing, and
 * `budget` ({requests, windowMs}) the most requests the site takes in a window
 * before it gets a shared wait (SiteAccess.spend), `retryDelaysMs` the site's
 * own cooldown before each automatic retry after a block, and `accessUrl` the
 * address its waits, pacing and budget are counted under (default `target`): a
 * site's public API can be counted apart from its signed-in pages, so a block
 * of one does not stop the other. Resolves with the response
 * (status 404/410 included, so the reader can say the listing is gone); any
 * other failure is an error carrying `url`.
 */
export async function siteFetch(
  target,
  {
    fetch = globalThis.fetch,
    signal = undefined,
    siteAccess = undefined,
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
    site = 'Site',
    url = target,
    headers = READER_HEADERS,
    timeoutMs = 15000,
    method = 'GET',
    body = undefined,
    minIntervalMs = 0,
    jitterMs = 0,
    budget = undefined,
    retryDelaysMs = undefined,
    accessUrl = target,
  } = {},
) {
  const token = siteAccess?.begin(accessUrl) ?? null,
    cooldown = retryDelaysMs ? {retryDelays: retryDelaysMs} : {};
  const held = budget ? siteAccess?.spend?.(accessUrl, budget) : null;
  if (held) throw Object.assign(new SiteWaitError(held), {url});
  const delay = siteAccess?.pace(accessUrl, minIntervalMs, jitterMs) ?? 0;
  if (delay) {
    await wait(delay);
    signal?.throwIfAborted();
  }
  const response = await fetch(target, {
    method,
    headers,
    body,
    redirect: 'follow',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  if (BLOCKED_STATUSES.has(response.status)) {
    const blocked = siteAccess?.complete(accessUrl, token, {
      status: response.status,
      reason: 'rate_limit',
      ...cooldown,
    });
    if (blocked) throw Object.assign(new SiteWaitError(blocked), {url});
    throw Object.assign(Error(`${site} denied access (HTTP ${response.status}).`), {url});
  }
  siteAccess?.complete(accessUrl, token, {status: response.status, ...cooldown});
  if (!response.ok && !MISSING_STATUSES.has(response.status))
    throw Object.assign(Error(`${site} request failed (HTTP ${response.status}).`), {url});
  return response;
}
export const isMissing = (response) => MISSING_STATUSES.has(response.status);

// An ordinary ready page from a reader: no tab, nothing left to load.
export const readerPage = ({browser, url, title, text, links = [], pagination = []}) => ({
  browser,
  url,
  title,
  text,
  links,
  pagination,
  status: 'ready',
  reading: {scope: 'site_reader', truncated: false, readiness: ready(), unreadFrames: 0},
});
const ready = () => ({loading: false, reason: null});

// The visible text of fetched HTML, as a browser would show it, for pages
// without a structured listing.
export const htmlPage = (html) =>
  htmlText(
    html
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/^[\s\S]*?<body\b[^>]*>/i, ''),
  );
export const htmlTitle = (html) =>
  htmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');

// Generic pagination entries: the current page (with the page count when the
// site states it) and the next page when there is one.
export const pageEntries = (url, number, total, nextUrl) => [
  {
    text: total ? `${number} of ${total}` : String(number),
    url,
    kind: 'link',
    current: true,
    disabled: false,
  },
  ...(nextUrl
    ? [{text: String(number + 1), url: nextUrl, kind: 'link', current: false, disabled: false}]
    : []),
];
