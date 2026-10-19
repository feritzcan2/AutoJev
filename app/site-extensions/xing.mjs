// @ts-check
// Xing site extension (HTTP reader; per-site extensions requested 2026-10-05).
// Logged-out job searches come server-rendered with their Apollo state (result
// list in order, total, page size) inside window.crate, and postings carry a
// schema.org JobPosting. Both are read over HTTP, so no tab waits on Xing's
// busy markers (observed 2026-10). Everything after the read stays generic.
import {decode} from './listing.mjs';
import {siteFetch, isMissing, readerPage, htmlPage, htmlTitle, pageEntries} from './http.mjs';
import {jobPostingHtml, jobPostingPage} from './job-posting.mjs';

const BROWSER = 'Xing reader';
const ORIGIN = 'https://www.xing.com';
export const XING_PAGE_SIZE = 20;
const xingHost = (host) => host === 'xing.com' || host.endsWith('.xing.com');

// Which page this address is: a search (also the /jobs/search/<slug> address
// Xing redirects to), a posting (/jobs/<slug>-<id>), or none.
export function xingRequest(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !xingHost(url.hostname)) return null;
  if (/^\/jobs\/search(?:\/[^/]+)?\/?$/.test(url.pathname)) return {kind: 'search', url: url.href};
  const id = url.pathname.match(/^\/jobs\/[a-z0-9-]+-(\d{6,})\/?$/i)?.[1];
  return id ? {kind: 'detail', id, url: url.href} : null;
}

// window.crate.serverData.APOLLO_STATE cut out of the runtime config script
// (the config around it is not JSON) and parsed; null when absent or changed.
export function xingState(html) {
  const start = html.indexOf('"APOLLO_STATE":');
  if (start < 0) return null;
  const open = html.indexOf('{', start);
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && !--depth) {
      try {
        return JSON.parse(html.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const salaryText = (salary) =>
  salary && (salary.minimum != null || salary.maximum != null)
    ? `${[salary.minimum, salary.maximum].filter((v) => v != null).join('–')} ${salary.currency ?? ''}`.trim()
    : '';
const SEARCH_KEY = 'jobSearchByQuery(';

// {jobs, hidden, total, limit, offset} of a results page: from the state's
// result list in its order, or from the rendered result cards when the state is
// missing. Logged out, Xing lists part of a page (all of it for a search
// without a location, observed 2026-10-17) as UnauthorizedJob without address
// or title; those count as hidden, not as missing results.
export function parseXingSearch(html) {
  const state = xingState(html);
  const key = Object.keys(state?.ROOT_QUERY ?? {}).find((k) => k.startsWith(SEARCH_KEY));
  if (key) {
    const result = state.ROOT_QUERY[key];
    let args = {};
    try {
      args = JSON.parse(key.slice(SEARCH_KEY.length, -1));
    } catch {}
    const items = (result.collection ?? []).map((item) => state[item?.jobDetail?.__ref]),
      readable = items.filter((job) => typeof job?.url === 'string' && job.title);
    const jobs = readable.map((job) => ({
      url: job.url,
      title: String(job.title),
      company: job.companyInfo?.companyNameOverride ?? '',
      locations: [...new Set((job.locations ?? [job.location]).map((l) => l?.city ?? ''))].filter(
        Boolean,
      ),
      employmentType: job.employmentType?.localizationValue ?? '',
      salary: salaryText(job.salary),
      refreshedAt: typeof job.refreshedAt === 'string' ? job.refreshedAt.slice(0, 10) : '',
    }));
    const total = result.boundedTotal?.total;
    return {
      jobs,
      hidden: items.length - readable.length,
      total: Number.isSafeInteger(total) && total >= 0 ? total : null,
      limit: Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : XING_PAGE_SIZE,
      offset: Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : null,
    };
  }
  const jobs = [];
  for (const m of html.matchAll(
    /data-testid="job-search-result"[^>]*>\s*<a href="(\/jobs\/[a-z0-9-]+-\d{6,})"[^>]*aria-label="([^"]*)"/gi,
  ))
    jobs.push({
      url: new URL(m[1], ORIGIN).href,
      title: decode(m[2]),
      company: '',
      locations: [],
      employmentType: '',
      salary: '',
      refreshedAt: '',
    });
  return {jobs, hidden: 0, total: null, limit: XING_PAGE_SIZE, offset: null};
}

// A results page lists its postings as listing links and numbers itself from
// the state's offset (or the page parameter); the next page exists while the
// stated total is not reached, or, without a total, while the page is full.
export function xingSearchPage(url, {jobs, hidden = 0, total, limit, offset}) {
  const address = new URL(url),
    requested = Number(address.searchParams.get('page') ?? 1) || 1,
    number = offset === null ? requested : Math.floor(offset / limit) + 1,
    pages = total === null ? null : Math.max(1, Math.ceil(total / limit));
  const unique = [...new Map(jobs.map((job) => [job.url, job])).values()];
  const lines = [`Xing job search results, page ${pages ? `${number} of ${pages}` : number}`];
  for (const job of unique) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = [
      job.company,
      job.locations.join(', '),
      job.employmentType,
      job.salary,
      job.refreshedAt && `refreshed ${job.refreshedAt}`,
    ].filter(Boolean);
    if (facts.length) lines.push(facts.join(' · '));
  }
  if (hidden)
    lines.push(
      unique.length
        ? `${hidden} more results on this page are shown only to signed-in Xing users and cannot be read here.`
        : `All ${hidden} results on this page are shown only to signed-in Xing users and cannot be read here; this is not the end of the search. A search with a location shows part of them.`,
    );
  else if (!unique.length)
    lines.push('This results page has no job cards: the search has no further results.');
  const more = pages ? number < pages : jobs.length + hidden >= limit;
  const next = new URL(address);
  next.searchParams.set('page', String(number + 1));
  return readerPage({
    browser: BROWSER,
    url: address.href,
    title: 'Xing jobs',
    text: lines.join('\n'),
    links: unique.map((job) => ({text: job.title, url: job.url, listing: true})),
    pagination: pageEntries(address.href, number, pages, more ? next.href : null),
  });
}

// A posting through its JobPosting; a page without a current posting is read
// as its visible text, a missing page says so.
export function xingDetailPage(url, html) {
  if (!html.trim())
    return readerPage({
      browser: BROWSER,
      url,
      title: 'Xing job',
      text: 'This Xing job posting was not found; it has been removed or is no longer available.',
    });
  return (
    jobPostingPage({url, browser: BROWSER, ...jobPostingHtml(html)}) ??
    readerPage({browser: BROWSER, url, title: htmlTitle(html) || 'Xing job', text: htmlPage(html)})
  );
}

export async function readXing(url, options = {}) {
  const request = xingRequest(url);
  if (!request) throw Error('Xing reader does not handle this address');
  const response = await siteFetch(request.url, {...options, site: 'Xing', url});
  if (isMissing(response))
    return request.kind === 'search'
      ? xingSearchPage(url, {jobs: [], hidden: 0, total: null, limit: XING_PAGE_SIZE, offset: null})
      : xingDetailPage(url, '');
  const html = await response.text();
  return request.kind === 'search'
    ? xingSearchPage(url, parseXingSearch(html))
    : xingDetailPage(url, html);
}

export default {
  id: 'xing',
  matches: (value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && xingHost(u.hostname);
    } catch {
      return false;
    }
  },
  http: {handles: (url) => Boolean(xingRequest(url)), read: readXing},
  // The logged-out search address (observed 2026-10 in the browser and over
  // HTTP). Results come in Xing's semantic relevance order and the site has no
  // sort control; sort parameters change nothing. Its "Veröffentlicht" filter
  // is sincePeriod; any other value returns an empty page.
  search: {
    template: `${ORIGIN}/jobs/search?keywords={query}&location={location}`,
    pagination: 'url_param',
    filters: [
      {
        param: 'sincePeriod',
        label: 'Posted',
        values: {LAST_24_HOURS: 'Last 24 hours', LAST_WEEK: 'Last week', LAST_MONTH: 'Last month'},
      },
    ],
    notes:
      '20 results per page via &page=N; the page states its total. Logged out, Xing hides part of each page from the reader (about half for developer in Berlin on 2026-10-17) and all of it when location is empty, so set a location. Relevance order, no date sort. sincePeriod=LAST_24_HOURS|LAST_WEEK|LAST_MONTH limits results to recent postings (backend engineer in Berlin on 2026-10-09: 142 in all, 80 last month, 25 last week, 5 last 24 hours), so a frequent scan reads only recent listings. Postings are /jobs/<slug>-<id>.',
  },
};
