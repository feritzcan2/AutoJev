// @ts-check
// Dice site extension (HTTP reader; per-site extensions requested 2026-10-05).
// Search pages come server-rendered: the result list, page count and total sit
// in the page's React Server Components payload (self.__next_f), and every
// posting carries a schema.org JobPosting. The search page also renders the
// first result's detail panel with "Similar Jobs" cards; those are not results
// (observed 2026-10). Everything after the read stays generic.
import {decode, inlineText} from './listing.mjs';
import {siteFetch, isMissing, readerPage, htmlPage, htmlTitle, pageEntries} from './http.mjs';
import {jobPostingHtml, jobPostingPage} from './job-posting.mjs';

const BROWSER = 'Dice reader';
const ORIGIN = 'https://www.dice.com';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDiceUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?dice\.com$/.test(u.hostname) && !u.port;
  } catch {
    return false;
  }
};

// /jobs is a search; /job-detail/<guid> is one posting.
export function diceRequest(value) {
  if (!isDiceUrl(value)) return null;
  const url = new URL(value);
  if (/^\/jobs\/?$/.test(url.pathname)) {
    const page = url.searchParams.get('page') ?? '1';
    return /^[1-9]\d{0,3}$/.test(page)
      ? {kind: 'search', number: Number(page), url: url.href}
      : null;
  }
  const guid = url.pathname.match(/^\/job-detail\/([^/]+)\/?$/)?.[1];
  return guid && GUID.test(guid) ? {kind: 'detail', url: `${ORIGIN}/job-detail/${guid}`} : null;
}

const listingUrl = (guid) => `${ORIGIN}/job-detail/${guid}`;
// The page's RSC payload as one string: the pushed chunks are JSON strings.
function serverPayload(html) {
  let text = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g))
    try {
      text += JSON.parse(`"${m[1]}"`);
    } catch {
      return '';
    }
  return text;
}
// The JSON object that starts at `open`, or null.
function objectAt(text, open) {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && !--depth) {
      try {
        return JSON.parse(text.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
const date = (value) => (typeof value === 'string' ? value.slice(0, 10) : '');
const text = (value) => (typeof value === 'string' ? value.trim() : '');

// The result list from the RSC payload: {jobs, page, pages, total}, or null.
export function diceState(html) {
  const payload = serverPayload(html),
    start = payload.indexOf('{"jobList":');
  const list = start < 0 ? null : objectAt(payload, start)?.jobList;
  if (!Array.isArray(list?.data) || !Number.isSafeInteger(list.meta?.currentPage)) return null;
  const jobs = list.data
    .filter((job) => GUID.test(job?.guid ?? '') && text(job.title))
    .map((job) => ({
      guid: job.guid,
      url: listingUrl(job.guid),
      title: text(job.title),
      company: text(job.companyName),
      location: text(job.jobLocation?.displayName),
      employmentType: text(job.employmentType),
      workplace: Array.isArray(job.workplaceTypes) ? job.workplaceTypes.join(', ') : '',
      salary: text(job.salary).replace(/^\$\$/, '$'),
      postedAt: date(job.postedDate),
    }));
  if (jobs.length !== list.data.length) return null;
  const {pageCount, totalResults} = list.meta;
  return {
    jobs,
    page: list.meta.currentPage,
    pages: Number.isSafeInteger(pageCount) && pageCount >= 0 ? pageCount : null,
    total: Number.isSafeInteger(totalResults) && totalResults >= 0 ? totalResults : null,
  };
}

// The rendered result cards, in order, without the detail panel's "Similar
// Jobs" cards that follow the result list.
export function diceCards(html) {
  const start = html.indexOf('aria-label="Job search results"');
  if (start < 0) return [];
  const end = html.indexOf('Similar Jobs', start);
  const cards = [];
  for (const part of html
    .slice(start, end < 0 ? undefined : end)
    .split('data-job-guid="')
    .slice(1)) {
    const guid = part.slice(0, part.indexOf('"'));
    const title = part.match(
      /data-testid="job-search-job-detail-link"[^>]*aria-label="([^"]*)"/,
    )?.[1];
    if (!GUID.test(guid) || !title) continue;
    cards.push({
      guid,
      url: listingUrl(guid),
      title: decode(title),
      company: inlineText(
        part.match(/data-testid="job-card-company-name"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '',
      ),
    });
  }
  return cards;
}

// {jobs, page, pages, total}: the state when it matches the rendered cards and
// the requested page, otherwise the cards alone without page numbers.
export function parseDiceSearch(html, number) {
  const state = diceState(html),
    cards = diceCards(html);
  const fresh =
    state &&
    state.page === number &&
    state.jobs.length === cards.length &&
    state.jobs.every((job, i) => job.guid === cards[i].guid);
  return fresh ? state : {jobs: cards, page: number, pages: null, total: null};
}

export function diceSearchPage(url, number, html) {
  const {jobs, pages, total} = parseDiceSearch(html, number);
  const lines = [
    `Dice job search results, page ${pages ? `${number} of ${pages}` : number}${total === null ? '' : ` (${total} results)`}`,
  ];
  for (const job of jobs) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = [
      job.company,
      job.location,
      job.workplace,
      job.employmentType,
      job.salary,
      job.postedAt && `posted ${job.postedAt}`,
    ].filter(Boolean);
    if (facts.length) lines.push(facts.join(' · '));
  }
  if (!jobs.length)
    lines.push('This results page has no job cards: the search has no further results.');
  const next = new URL(url);
  next.searchParams.set('page', String(number + 1));
  return readerPage({
    browser: BROWSER,
    url,
    title: htmlTitle(html) || 'Dice jobs',
    text: lines.join('\n'),
    links: jobs.map((job) => ({text: job.title, url: job.url, listing: true})),
    pagination: pageEntries(url, number, pages, pages && number < pages ? next.href : null),
  });
}

// A posting through its JobPosting. Dice answers a removed posting with HTTP
// 200 and a "Job Not Found" page whose body renders only in the browser.
export function diceDetailPage(url, html) {
  if (!html.trim() || /^Job Not Found\b/i.test(htmlTitle(html)))
    return readerPage({
      browser: BROWSER,
      url,
      title: 'Dice job',
      text: 'This Dice job posting was not found; it has been removed or is no longer available.',
    });
  return (
    jobPostingPage({url, browser: BROWSER, ...jobPostingHtml(html)}) ??
    readerPage({browser: BROWSER, url, title: htmlTitle(html) || 'Dice job', text: htmlPage(html)})
  );
}

export async function readDice(url, options = {}) {
  const request = diceRequest(url);
  if (!request) throw Error('Dice reader does not handle this address');
  const response = await siteFetch(request.url, {...options, site: 'Dice', url});
  const html = isMissing(response) ? '' : await response.text();
  return request.kind === 'search'
    ? diceSearchPage(request.url, request.number, html)
    : diceDetailPage(url, html);
}

export default {
  id: 'dice',
  matches: isDiceUrl,
  http: {handles: (url) => Boolean(diceRequest(url)), read: readDice},
  // The search address and the filters it accepts (observed 2026-10-11).
  // Results are in relevance order; sortBy=date and sortBy=postedDate change
  // nothing, so no ordering is declared.
  search: {
    template: `${ORIGIN}/jobs?q={query}&location={location}`,
    pagination: 'url_param',
    filters: [
      {
        param: 'filters.postedDate',
        label: 'Posted',
        values: {ONE: 'Today', THREE: 'Last 3 days', SEVEN: 'Last 7 days'},
      },
      {
        param: 'filters.workplaceTypes',
        label: 'Workplace',
        values: {Remote: 'Remote', 'On-Site': 'On-site', Hybrid: 'Hybrid'},
      },
      {
        param: 'filters.employmentType',
        label: 'Employment type',
        values: {
          FULLTIME: 'Full-time',
          PARTTIME: 'Part-time',
          CONTRACTS: 'Contract',
          THIRD_PARTY: 'Third party',
        },
      },
    ],
    notes:
      'US tech jobs. 30 results per page via &page=N; the page states its page count and total. Relevance order, no date sort (sortBy is ignored); filters.postedDate=ONE|THREE|SEVEN limits to recent postings. Location is free text (New York, Austin, TX); without it the search covers the US. Listings are /job-detail/<guid>; "Similar Jobs" cards beside the results are not results.',
  },
};
