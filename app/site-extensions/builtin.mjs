// @ts-check
// Built In site extension (HTTP reader; per-site extensions requested
// 2026-10-05). US tech and startup jobs: search pages list job cards
// server-side with numbered pagination, and each listing carries a schema.org
// JobPosting. Without a location in the address the site searches around the
// requester's own location (Germany from Berlin), so searches name one.
import {decode, inlineText} from './listing.mjs';
import {siteFetch, isMissing, readerPage, htmlPage, htmlTitle, pageEntries} from './http.mjs';
import {jobPostingHtml, jobPostingPage} from './job-posting.mjs';

const ORIGIN = 'https://builtin.com';
const BROWSER = 'Built In reader';
const LISTING_PATH = /^\/job\/[^/]+\/(\d+)\/?$/;
export const isBuiltInUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?builtin\.com$/.test(u.hostname) && !u.port;
  } catch {
    return false;
  }
};

// /jobs and /jobs/<filter>/… (work mode, category, level path segments) are
// searches; /job/<slug>/<id> is one listing.
export function builtInRequest(value) {
  if (!isBuiltInUrl(value)) return null;
  const url = new URL(value);
  if (LISTING_PATH.test(url.pathname)) return {kind: 'detail', url: url.href};
  if (!/^\/jobs(?:\/[a-z0-9-]+)*\/?$/.test(url.pathname)) return null;
  const page = url.searchParams.get('page') ?? '1';
  if (!/^[1-9]\d{0,4}$/.test(page)) return null;
  return {kind: 'search', number: Number(page), url: url.href};
}

// The text of the card element that follows an icon, e.g. the location after
// fa-location-dot.
const afterIcon = (card, icon) =>
  inlineText(
    card.match(
      new RegExp(
        `${icon}[^"]*"[^>]*></i>(?:\\s*</div>)?\\s*(?:<div>)?\\s*<span[^>]*>([\\s\\S]*?)</span>`,
      ),
    )?.[1] ?? '',
  );
// "2 Locations" cards list the places in their tooltip.
const locations = (card) => {
  const tooltip = card.match(/aria-label="Job locations" data-bs-title="([^"]*)"/)?.[1];
  if (!tooltip) return afterIcon(card, 'fa-location-dot');
  return [...decode(tooltip).matchAll(/<div[^>]*>([\s\S]*?)<\/div>/g)]
    .map((m) => inlineText(m[1]))
    .filter(Boolean)
    .join('; ');
};

// {jobs, nextUrl, totalPages} of a search page, or null when the page shows no
// job list (a static page, a changed layout). A list without cards is a
// search without (further) results.
export function parseBuiltInSearch(html) {
  if (!/id="jobs-list"/.test(html)) return null;
  const jobs = [];
  for (const card of html.split(/<div id="job-card-\d+" data-id="job-card"/).slice(1)) {
    const link = card.match(/<a href="([^"]+)"[^>]*data-id="job-card-title"[^>]*>([\s\S]*?)<\/a>/);
    const path = link && new URL(decode(link[1]), ORIGIN).pathname;
    if (!path || !LISTING_PATH.test(path)) continue;
    jobs.push({
      url: `${ORIGIN}${path.replace(/\/$/, '')}`,
      title: inlineText(link[2]),
      company: inlineText(
        card.match(/data-id="company-title"[^>]*>\s*<span>([\s\S]*?)<\/span>/)?.[1] ?? '',
      ),
      posted: inlineText(card.match(/fa-clock[^"]*"[^>]*><\/i>([^<]*)</)?.[1] ?? ''),
      workMode: afterIcon(card, 'fa-house-building'),
      location: locations(card),
      salary: afterIcon(card, 'fa-sack-dollar'),
      level: afterIcon(card, 'fa-trophy'),
      teaser: inlineText(
        card.match(/class="fs-sm fw-regular mb-md text-gray-04">([\s\S]*?)<\/div>/)?.[1] ?? '',
      ).slice(0, 300),
    });
  }
  const next = html.match(/<a href="([^"]+)" aria-label="Go to Next Page"/)?.[1];
  const numbers = [...html.matchAll(/aria-label="Go to [Pp]age (\d+)"/g)].map((m) => Number(m[1]));
  return {
    jobs,
    nextUrl: next ? new URL(decode(next), ORIGIN).href : null,
    totalPages: numbers.length ? Math.max(...numbers) : null,
  };
}

export function builtInSearchPage(url, number, html) {
  const list = parseBuiltInSearch(html);
  if (!list)
    return readerPage({
      browser: BROWSER,
      url,
      title: htmlTitle(html) || 'Built In jobs',
      text: htmlPage(html),
    });
  const jobs = list.jobs.filter((job, i) => list.jobs.findIndex((j) => j.url === job.url) === i);
  const pages = list.totalPages ? Math.max(list.totalPages, number) : null;
  const lines = [`Built In job search results, page ${pages ? `${number} of ${pages}` : number}`];
  for (const job of jobs) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = [
      job.company,
      job.location,
      job.workMode,
      job.salary,
      job.level,
      job.posted && `posted ${job.posted}`,
      job.teaser,
    ].filter(Boolean);
    if (facts.length) lines.push(facts.join(' · '));
  }
  if (!jobs.length)
    lines.push('This results page has no job cards: the search has no further results.');
  return readerPage({
    browser: BROWSER,
    url,
    title: 'Built In jobs',
    text: lines.join('\n'),
    links: jobs.map((job) => ({text: job.title, url: job.url, listing: true})),
    pagination: pageEntries(url, number, pages, jobs.length ? list.nextUrl : null),
  });
}

// A posting through its JobPosting; a page without a current posting is read
// as its visible text, a missing page says so.
export function builtInDetailPage(url, html) {
  if (!html.trim())
    return readerPage({
      browser: BROWSER,
      url,
      title: 'Built In job',
      text: 'This Built In job posting was not found; it has been removed or is no longer available.',
    });
  return (
    jobPostingPage({url, browser: BROWSER, ...jobPostingHtml(html)}) ??
    readerPage({
      browser: BROWSER,
      url,
      title: htmlTitle(html) || 'Built In job',
      text: htmlPage(html),
    })
  );
}

export async function readBuiltIn(url, options = {}) {
  const request = builtInRequest(url);
  if (!request) throw Error('Built In reader does not handle this address');
  const response = await siteFetch(request.url, {...options, site: 'Built In', url});
  const html = isMissing(response) ? '' : await response.text();
  if (request.kind === 'detail') return builtInDetailPage(url, html);
  return html
    ? builtInSearchPage(url, request.number, html)
    : readerPage({
        browser: BROWSER,
        url,
        title: 'Built In jobs',
        text: 'This Built In search address was not found.',
      });
}

export default {
  id: 'builtin',
  matches: isBuiltInUrl,
  http: {handles: (url) => Boolean(builtInRequest(url)), read: readBuiltIn},
  // One listing under every title slug it had (an edited title changes the
  // slug, and searches can still list the old one): its job ID.
  listingKey: (url) => {
    const id = isBuiltInUrl(url) && new URL(url).pathname.match(LISTING_PATH)?.[1];
    return id ? `${ORIGIN}/job/${id}` : null;
  },
  // The search address (observed 2026-10-11 over HTTP and in the site's
  // script). No sort control: results are mostly but not strictly newest
  // first ("One Month Ago" cards among recent ones), so no ordering is claimed.
  search: {
    template: `${ORIGIN}/jobs?search={query}&country=USA&allLocations=true`,
    pagination: 'url_param',
    filters: [
      {
        param: 'daysSinceUpdated',
        label: 'Posted',
        values: {1: 'Past 24 hours', 3: 'Past 3 days', 7: 'Past week', 30: 'Past month'},
      },
      {param: 'country', label: 'Country (ISO alpha-3, e.g. USA)'},
      {param: 'state', label: 'State (with country)'},
      {param: 'city', label: 'City (with state and country)'},
      {
        param: 'searcharea',
        label: 'Search area (with a city)',
        values: {
          '5mi': 'Within 5 miles',
          '10mi': 'Within 10 miles',
          '25mi': 'Within 25 miles',
          '50mi': 'Within 50 miles',
          '100mi': 'Within 100 miles',
        },
      },
    ],
    notes:
      "25 cards per page via &page=N; the page links its last page and the next one. Without country/city the site searches around the requester's own location, so keep country=USA&allLocations=true (or city/state/country). Path segments narrow further: /jobs/remote, /jobs/hybrid or /jobs/office for work mode, then a category (engineering, data-analytics, ai-machine-learning, product-management, designer, cyber-security, sales, marketing, finance, …) and a level (internship, entry-level, junior, mid-level, senior, expert-leader), e.g. /jobs/remote/engineering/senior?search=…. No sort control and no strict date order; daysSinceUpdated=1|3|7|30 limits to recent postings. Listings are /job/<slug>/<id>.",
  },
};
