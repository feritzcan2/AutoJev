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
 * Fetches `target` for the page requested as `url`. Resolves with the response
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
  } = {},
) {
  const token = siteAccess?.begin(target) ?? null;
  const delay = siteAccess?.pace(target) ?? 0;
  if (delay) {
    await wait(delay);
    signal?.throwIfAborted();
  }
  const response = await fetch(target, {
    headers,
    redirect: 'follow',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  if (BLOCKED_STATUSES.has(response.status)) {
    const blocked = siteAccess?.complete(target, token, {
      status: response.status,
      reason: 'rate_limit',
    });
    if (blocked) throw Object.assign(new SiteWaitError(blocked), {url});
    throw Object.assign(Error(`${site} denied access (HTTP ${response.status}).`), {url});
  }
  siteAccess?.complete(target, token, {status: response.status});
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
