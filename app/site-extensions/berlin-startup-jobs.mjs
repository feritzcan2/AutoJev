// @ts-check
// Berlin Startup Jobs site extension (HTTP reader; per-site extensions
// requested 2026-10-05). A WordPress board: category pages list job cards
// server-side with the site's own next-page link, and each listing carries a
// schema.org JobPosting. The site search (?s=) renders only in the browser, so
// it is not read. Everything after the read stays generic.
import {decode, inlineText} from './listing.mjs';
import {siteFetch, isMissing, readerPage, htmlPage, htmlTitle, pageEntries} from './http.mjs';
import {jobPostingHtml, jobPostingPage} from './job-posting.mjs';

const BROWSER = 'Berlin Startup Jobs reader';
export const isBerlinStartupJobsUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?berlinstartupjobs\.com$/.test(u.hostname);
  } catch {
    return false;
  }
};

// /<category>/ and /<category>/page/N/ list jobs; /<category>/<slug>/ is one
// listing. Company pages, the home page and the site search are not read.
export function berlinStartupJobsRequest(value) {
  if (!isBerlinStartupJobsUrl(value)) return null;
  const url = new URL(value);
  if (url.searchParams.has('s')) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 1 && parts[0] !== 'page') return {kind: 'list', number: 1, url: url.href};
  if (parts.length === 3 && parts[1] === 'page' && /^[1-9]\d*$/.test(parts[2]))
    return {kind: 'list', number: Number(parts[2]), url: url.href};
  if (parts.length === 2 && !['companies', 'page'].includes(parts[0]))
    return {kind: 'detail', url: url.href};
  return null;
}

// {jobs, nextUrl, totalPages} of a job list page, or null when the page shows
// no job list (a static page, a changed layout).
export function parseBerlinStartupJobsList(html) {
  if (!/class="jobs-list-items"/.test(html)) return null;
  const jobs = [];
  for (const card of html.split(/<li class="bjs-jlid[^"]*">/).slice(1)) {
    const title = card.match(/class="bjs-jlid__h"[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!title) continue;
    jobs.push({
      url: decode(title[1]),
      title: inlineText(title[2]),
      company: inlineText(card.match(/class="bjs-jlid__b"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ''),
      teaser: inlineText(
        card.match(/class="bjs-jlid__description"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '',
      ).slice(0, 300),
    });
  }
  const next = html.match(/<a class="next page-numbers" href="([^"]+)"/i)?.[1];
  const numbers = [...html.matchAll(/class="page-numbers[^"]*"[^>]*>(\d+)</g)].map((m) =>
    Number(m[1]),
  );
  return {
    jobs,
    nextUrl: next ? decode(next) : null,
    totalPages: numbers.length ? Math.max(...numbers) : null,
  };
}

export function berlinStartupJobsListPage(url, number, html) {
  const list = parseBerlinStartupJobsList(html);
  const title = htmlTitle(html) || 'Berlin Startup Jobs';
  if (!list) return readerPage({browser: BROWSER, url, title, text: htmlPage(html)});
  const pages = list.totalPages ? Math.max(list.totalPages, number) : null;
  const lines = [`${title}, page ${pages ? `${number} of ${pages}` : number}`];
  for (const job of list.jobs) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = [job.company, job.teaser].filter(Boolean);
    if (facts.length) lines.push(facts.join(' · '));
  }
  if (!list.jobs.length)
    lines.push('This page lists no jobs: the category has no further results.');
  return readerPage({
    browser: BROWSER,
    url,
    title,
    text: lines.join('\n'),
    links: list.jobs.map((job) => ({text: job.title, url: job.url, listing: true})),
    pagination: pageEntries(url, number, pages, list.nextUrl),
  });
}

export function berlinStartupJobsDetailPage(url, html) {
  if (!html.trim())
    return readerPage({
      browser: BROWSER,
      url,
      title: 'Berlin Startup Jobs',
      text: 'This job listing was not found; it has been removed or is no longer available.',
    });
  return (
    jobPostingPage({url, browser: BROWSER, ...jobPostingHtml(html)}) ??
    readerPage({
      browser: BROWSER,
      url,
      title: htmlTitle(html) || 'Berlin Startup Jobs',
      text: htmlPage(html),
    })
  );
}

export async function readBerlinStartupJobs(url, options = {}) {
  const request = berlinStartupJobsRequest(url);
  if (!request) throw Error('Berlin Startup Jobs reader does not handle this address');
  const response = await siteFetch(request.url, {...options, site: 'Berlin Startup Jobs', url});
  const html = isMissing(response) ? '' : await response.text();
  return request.kind === 'list'
    ? berlinStartupJobsListPage(url, request.number, html)
    : berlinStartupJobsDetailPage(url, html);
}

export default {
  id: 'berlin-startup-jobs',
  matches: isBerlinStartupJobsUrl,
  http: {handles: (url) => Boolean(berlinStartupJobsRequest(url)), read: readBerlinStartupJobs},
  // Category pages (observed 2026-10). {query} is a category slug, not free text.
  search: {
    template: 'https://berlinstartupjobs.com/{query}/',
    ordering: 'newest_first',
    pagination: 'url_param',
    filters: [],
    notes:
      '{query} is a category slug: engineering, product-management, marketing, sales, finance, operations, hr-recruiting, internships, other. 25 listings per page, pages via /{query}/page/N/. Newest first by datePosted across pages, featured listings included (32 engineering listings checked 2026-10-09). The site search (?s=) renders only in the browser and is not read.',
  },
};
