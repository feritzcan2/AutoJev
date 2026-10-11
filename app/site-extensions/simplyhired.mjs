// @ts-check
// SimplyHired site extension (HTTP reader; per-site extensions requested
// 2026-10-05). Searches come server-rendered with their Next.js data (result
// list, result count, cursors for the following pages) and postings carry a
// schema.org JobPosting; both are read over HTTP without a tab (observed
// 2026-10-11). Card links carry per-view tracking; the listing address is
// /job/<jobKey>, which stays the same across reloads.
import {decode} from './listing.mjs';
import {siteFetch, isMissing, readerPage, htmlPage, htmlTitle, pageEntries} from './http.mjs';
import {jobPostingHtml, jobPostingPage} from './job-posting.mjs';

const BROWSER = 'SimplyHired reader';
const ORIGIN = 'https://www.simplyhired.com';
export const SIMPLYHIRED_PAGE_SIZE = 20;
const JOB_KEY = /^[A-Za-z0-9_-]{20,}$/;
const isHost = (host) => host === 'simplyhired.com' || host === 'www.simplyhired.com';
const jobUrl = (key) => `${ORIGIN}/job/${key}`;

// Which page this address is: a search, a posting (/job/<jobKey>), or none.
export function simplyHiredRequest(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !isHost(url.hostname) || url.port) return null;
  if (/^\/search\/?$/.test(url.pathname)) return {kind: 'search', url: url.href};
  const key = url.pathname.match(/^\/job\/([^/]+)\/?$/)?.[1];
  return key && JOB_KEY.test(key) ? {kind: 'detail', key, url: jobUrl(key)} : null;
}

// The page's __NEXT_DATA__ props; null when absent or changed.
export function simplyHiredData(html) {
  const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!json) return null;
  try {
    return JSON.parse(json)?.props?.pageProps ?? null;
  } catch {
    return null;
  }
}

const day = (ms) => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : '';
};
const text = (value) => (typeof value === 'string' ? value.trim() : '');

// {jobs, total, page, nextCursor} of a results page: from the page data in its
// order, or from the rendered title links when the data is missing (then
// without count or next page).
export function parseSimplyHiredSearch(html) {
  const data = simplyHiredData(html);
  if (Array.isArray(data?.jobs)) {
    const jobs = data.jobs
      .filter((job) => JOB_KEY.test(text(job?.jobKey)) && text(job.title))
      .map((job) => ({
        url: jobUrl(job.jobKey),
        title: text(job.title),
        company: text(job.company),
        location: text(job.location),
        salary: text(job.salaryInfo),
        postedAt: day(job.dateOnIndeed),
        sponsored: String(job.sponsored) === 'True',
      }));
    const page = Number(data.currentPageNumber),
      total = Number(data.resultCount),
      cursor = data.pageCursors?.[String(page + 1)];
    return {
      jobs,
      total: Number.isSafeInteger(total) && total >= 0 ? total : null,
      page: Number.isSafeInteger(page) && page > 0 ? page : null,
      nextCursor: typeof cursor === 'string' && cursor ? cursor : null,
    };
  }
  const jobs = [];
  for (const m of html.matchAll(
    /<a\b[^>]*href="\/job\/([A-Za-z0-9_-]{20,})"[^>]*>([^<]+)<\/a>\s*<\/h2>/g,
  ))
    jobs.push({
      url: jobUrl(m[1]),
      title: decode(m[2]).trim(),
      company: '',
      location: '',
      salary: '',
      postedAt: '',
      sponsored: false,
    });
  return {jobs, total: null, page: null, nextCursor: null};
}

// A results page lists its postings as listing links. The next page is the
// address with the cursor the site gives for it; there is no other way to
// address it.
export function simplyHiredSearchPage(url, {jobs, total, page, nextCursor}) {
  const address = new URL(url),
    number = page ?? 1,
    pages = total === null ? null : Math.max(1, Math.ceil(total / SIMPLYHIRED_PAGE_SIZE));
  const unique = [...new Map(jobs.map((job) => [job.url, job])).values()];
  const lines = [
    `SimplyHired job search results, page ${pages ? `${number} of ${pages}` : number}`,
  ];
  for (const job of unique) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = [
      job.company,
      job.location,
      job.salary,
      job.postedAt && `posted ${job.postedAt}`,
      job.sponsored && 'sponsored',
    ].filter(Boolean);
    if (facts.length) lines.push(facts.join(' · '));
  }
  if (!unique.length)
    lines.push('This results page has no job cards: the search has no further results.');
  let next = null;
  if (nextCursor && unique.length) {
    next = new URL(address);
    next.searchParams.set('cursor', nextCursor);
  }
  return readerPage({
    browser: BROWSER,
    url: address.href,
    title: 'SimplyHired jobs',
    text: lines.join('\n'),
    links: unique.map((job) => ({text: job.title, url: job.url, listing: true})),
    pagination: pageEntries(address.href, number, pages, next?.href ?? null),
  });
}

const GONE =
  'This SimplyHired job posting was not found; it has been removed or is no longer available.';
// A posting through its JobPosting; the site's own "not available" page and a
// missing page say so; anything else is read as its visible text.
export function simplyHiredDetailPage(url, html) {
  const data = simplyHiredData(html);
  if (!html.trim() || data?.jobFound === false || data?.expired === true)
    return readerPage({browser: BROWSER, url, title: 'SimplyHired job', text: GONE});
  return (
    jobPostingPage({url, browser: BROWSER, ...jobPostingHtml(html)}) ??
    readerPage({
      browser: BROWSER,
      url,
      title: htmlTitle(html) || 'SimplyHired job',
      text: htmlPage(html),
    })
  );
}

export async function readSimplyHired(url, options = {}) {
  const request = simplyHiredRequest(url);
  if (!request) throw Error('SimplyHired reader does not handle this address');
  const response = await siteFetch(request.url, {...options, site: 'SimplyHired', url});
  if (isMissing(response))
    return request.kind === 'search'
      ? simplyHiredSearchPage(url, {jobs: [], total: null, page: null, nextCursor: null})
      : simplyHiredDetailPage(url, '');
  const html = await response.text();
  return request.kind === 'search'
    ? simplyHiredSearchPage(url, parseSimplyHiredSearch(html))
    : simplyHiredDetailPage(url, html);
}

export default {
  id: 'simplyhired',
  matches: (value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && isHost(u.hostname);
    } catch {
      return false;
    }
  },
  http: {handles: (url) => Boolean(simplyHiredRequest(url)), read: readSimplyHired},
  // The search address and its filters (observed over HTTP 2026-10-11: each
  // value shows in the page's appliedFilters and narrows the count). Results
  // come in relevance order; s=d is accepted but the dates stay unordered, so
  // no ordering is declared.
  search: {
    template: `${ORIGIN}/search?q={query}&l={location}`,
    pagination: 'next_link',
    filters: [
      {
        param: 't',
        label: 'Posted',
        values: {
          1: 'Last 24 hours',
          3: 'Last 3 days',
          7: 'Last 7 days',
          14: 'Last 14 days',
          30: 'Last 30 days',
        },
      },
      {param: 'wl', label: 'Work location', values: {remote: 'Remote', 'hybrid-remote': 'Hybrid'}},
      {
        param: 'jt',
        label: 'Job type',
        values: {
          CF3CP: 'Full-time',
          NJXCK: 'Contract',
          '75GKK': 'Part-time',
          VDTG7: 'Internship',
          '4HKF7': 'Temporary',
          '7SBAT': 'Temp-to-hire',
        },
      },
    ],
    notes:
      'United States. 20 results per page; the next page is the same address with the cursor the page gives (cursor=…), not a page number. Relevance order, no date sort. t=N limits to postings from the last N days (backend engineer in New York on 2026-10-11: 897 in all, 65 last 7 days, 1 last 24 hours), so a frequent scan reads only recent listings. Postings are /job/<jobKey>; most come from Indeed, so expect overlap with an Indeed source.',
  },
};
