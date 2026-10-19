// @ts-check
// Reed site extension (HTTP reader; per-site extensions requested 2026-10-05).
// reed.co.uk, the UK job board, serves its Next.js pages server-rendered: a
// results page carries its result list, total and filters in __NEXT_DATA__
// (25 per page, &pageno=N), and each listing carries a schema.org JobPosting
// with its salary and working option in the same state. The keyed API is not
// used: robots.txt disallows /api/. Facts observed over HTTP on 2026-10-16.
// Everything after the read stays generic.
import {decode, inlineText, listingPage} from './listing.mjs';
import {siteFetch, isMissing, readerPage, htmlPage, htmlTitle, pageEntries} from './http.mjs';
import {jobPostingHtml, jobPostingDetail} from './job-posting.mjs';

const BROWSER = 'Reed reader';
const ORIGIN = 'https://www.reed.co.uk';
export const REED_PAGE_SIZE = 25;
export const isReedUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?reed\.co\.uk$/.test(u.hostname) && !u.port;
  } catch {
    return false;
  }
};

// Addresses robots.txt disallows for every crawler (/jobs/*?*sortBy=,
// /*?sourceInternal=, /*?directjob, /*multipleParentSectorIds=).
const disallowed = (url) =>
  ['sortBy', 'sourceInternal', 'multipleParentSectorIds'].some((p) => url.searchParams.has(p)) ||
  [...url.searchParams.keys()].some((key) => key.startsWith('directjob'));

// /jobs/<slug>/<id> is one listing. /jobs, /jobs/<seo-search> (the address
// /jobs?keywords= redirects to) and /jobs/<company>/p<id> are result pages.
export function reedRequest(value) {
  if (!isReedUrl(value)) return null;
  const url = new URL(value);
  if (disallowed(url)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'jobs' || parts.length > 3) return null;
  if (parts.length === 3 && /^\d+$/.test(parts[2]))
    return {kind: 'detail', id: parts[2], url: `${ORIGIN}/jobs/${parts[1]}/${parts[2]}`};
  if (parts.length === 3 && !/^p\d+$/.test(parts[2])) return null;
  const page = url.searchParams.get('pageno') ?? '1';
  if (!/^[1-9]\d{0,3}$/.test(page)) return null;
  return {kind: 'search', number: Number(page), url: url.href};
}

export function reedNextData(html) {
  const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  try {
    return json ? (JSON.parse(json)?.props?.pageProps ?? null) : null;
  } catch {
    return null;
  }
}

// A card's link carries the search and session (source, q, sid, filter); the
// listing address without them is the one earlier records hold.
const listingUrl = (href) => {
  const path = new URL(decode(href), ORIGIN).pathname.match(/^\/jobs\/[^/]+\/\d+/)?.[0];
  return path ? `${ORIGIN}${path}` : null;
};
const WORK_MODES = {remote: 'remote', hybrid: 'hybrid', onSite: 'on-site'};
const text = (value) => (typeof value === 'string' ? value.trim() : '');

// The result list in __NEXT_DATA__: {jobs, total, page}, or null when it is
// missing or changed. The promoted listing Reed shows above every page's
// results comes first.
export function reedState(html) {
  const props = reedNextData(html),
    results = props?.searchResults,
    page = props?.criteria?.pageno;
  if (!Array.isArray(results?.jobs) || !Number.isSafeInteger(page)) return null;
  const items = [
    ...(Array.isArray(results.promotedJobs) ? results.promotedJobs : []),
    ...results.jobs,
  ];
  const jobs = new Map();
  for (const item of items) {
    const job = item?.jobDetail,
      url = typeof item?.url === 'string' ? listingUrl(item.url) : null;
    if (!Number.isSafeInteger(job?.jobId) || !url?.endsWith(`/${job.jobId}`) || !text(job.jobTitle))
      return null;
    if (!jobs.has(job.jobId))
      jobs.set(job.jobId, {
        id: job.jobId,
        url,
        title: text(job.jobTitle),
        company: text(job.ouName),
        location: text(job.displayLocationName),
        workMode: WORK_MODES[job.workingOption] ?? '',
        postedAt: text(job.displayDate).slice(0, 10),
      });
  }
  const total = results.count;
  return {
    jobs: [...jobs.values()],
    total: Number.isSafeInteger(total) && total >= 0 ? total : null,
    page,
  };
}

const item = (card, qa) =>
  inlineText(
    card
      .match(new RegExp(`<li data-qa="${qa}"[^>]*>([\\s\\S]*?)</li>`))?.[1]
      ?.replace(/<svg[\s\S]*?<\/svg>/g, '') ?? '',
  );
// The rendered result cards in order, each with the facts it shows; null when
// a card has no listing link (a changed layout).
export function reedCards(html) {
  const cards = [];
  for (const part of html.split(/<article\b[^>]*data-qa="job-card"/).slice(1)) {
    const end = part.indexOf('</article>'),
      card = end < 0 ? part : part.slice(0, end),
      id = Number(card.match(/^[^>]*data-id="job(\d+)"/)?.[1]),
      link = card.match(/<a\b[^>]*data-qa="job-card-title"[^>]*>([\s\S]*?)<\/a>/),
      url = link ? listingUrl(link[0].match(/href="([^"]+)"/)?.[1] ?? '') : null;
    if (!Number.isSafeInteger(id) || !url?.endsWith(`/${id}`)) return null;
    const postedBy = card.match(/data-qa="job-posted-by"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
    cards.push({
      id,
      url,
      title: inlineText(link[1]),
      company: inlineText(postedBy.match(/<a\b[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? ''),
      salary: item(card, 'job-metadata-salary'),
      location: item(card, 'job-metadata-location'),
    });
  }
  return cards;
}

// {jobs, total, more}: the state when it describes the rendered cards and the
// requested page, otherwise the cards with the page's own rel="next" link. A
// page with neither is an error, never an empty result.
export function parseReedSearch(html, number) {
  const state = reedState(html),
    cards = reedCards(html);
  if (!cards) throw Error('Reed results page has a job card without a listing link.');
  const shown = new Map(cards.map((card) => [card.id, card]));
  const fresh =
    state &&
    state.page === number &&
    state.jobs.length === shown.size &&
    state.jobs.every((job) => shown.has(job.id));
  if (fresh)
    return {
      // The card shows the pay as Reed words it ("Salary negotiable",
      // "Training Course"); the state has only bare numbers.
      jobs: state.jobs.map((job) => {
        const card = shown.get(job.id);
        return {...job, salary: card.salary, location: card.location || job.location};
      }),
      total: state.total,
      more: null,
    };
  if (!cards.length)
    throw Error(
      'Reed results page could not be read: it shows neither a result list nor job cards.',
    );
  return {
    jobs: [...shown.values()],
    total: null,
    more: /<link\b[^>]*rel="next"[^>]*href="[^"]+"/.test(html),
  };
}

const nextUrl = (url, number) => {
  const next = new URL(url);
  next.searchParams.set('pageno', String(number + 1));
  return next.href;
};

export function reedSearchPage(url, number, {jobs, total, more}) {
  const pages = total === null ? null : Math.max(1, Math.ceil(total / REED_PAGE_SIZE), number);
  const lines = [
    `Reed job search results, page ${pages ? `${number} of ${pages}` : number}${total === null ? '' : ` (${total} results)`}`,
  ];
  for (const job of jobs) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = [
      job.company,
      job.location,
      job.salary,
      job.workMode,
      job.postedAt && `posted ${job.postedAt}`,
    ].filter(Boolean);
    if (facts.length) lines.push(facts.join(' · '));
  }
  if (!jobs.length)
    lines.push('This results page has no job cards: the search has no further results.');
  const hasNext = pages ? number < pages : more;
  return readerPage({
    browser: BROWSER,
    url,
    title: 'Reed jobs',
    text: lines.join('\n'),
    links: jobs.map((job) => ({text: job.title, url: job.url, listing: true})),
    pagination: pageEntries(url, number, pages, hasNext ? nextUrl(url, number) : null),
  });
}

// Reed answers a page past the last one with 404, and so it does a broken
// search address. The first page's total tells them apart: past it, the
// search has ended; within it, the 404 is a failure.
async function reedMissingPage(url, request, status, options) {
  const failure = Error(
    `Reed has no results page ${request.number} for this search (HTTP ${status}).`,
  );
  if (request.number === 1) throw Object.assign(failure, {url});
  const first = new URL(request.url);
  first.searchParams.delete('pageno');
  const response = await siteFetch(first.href, {...options, site: 'Reed', url});
  const state = isMissing(response) ? null : reedState(await response.text());
  const pages = state?.total == null ? null : Math.ceil(state.total / REED_PAGE_SIZE);
  if (pages === null || request.number <= pages) throw Object.assign(failure, {url});
  return readerPage({
    browser: BROWSER,
    url,
    title: 'Reed jobs',
    text: `Reed job search results, page ${request.number}: past the last page (${state?.total} results on ${pages} pages). The search has no further results.`,
    pagination: pageEntries(url, request.number, null, null),
  });
}

// A listing through its JobPosting, with the salary, working option and
// contract type Reed states for it in the page state. A page without a
// current posting is read as its visible text; a missing page says so.
export function reedDetailPage(url, html, id) {
  if (!html.trim())
    return readerPage({
      browser: BROWSER,
      url,
      title: 'Reed job',
      text: 'This Reed job listing was not found; it has expired or been removed.',
    });
  const job = jobPostingDetail(jobPostingHtml(html));
  if (!job)
    return readerPage({
      browser: BROWSER,
      url,
      title: htmlTitle(html) || 'Reed job',
      text: htmlPage(html),
    });
  const state = reedNextData(html)?.consolidatedJobDetails?.jobDetails,
    own = state && String(state.id) === String(id) ? state : null;
  // A training course shows "Training Course" where a job shows its pay.
  const training = own?.isTrainingJob === true;
  return listingPage({
    browser: BROWSER,
    url,
    title: job.company ? `${job.title} @ ${job.company}` : job.title,
    description: job.description,
    fields: {
      ...job.fields,
      workMode: WORK_MODES[own?.jobLocation?.workingOption] ?? job.fields.workMode,
      salary: (!training && text(own?.jobSalary?.displaySalary)) || job.fields.salary,
      contractType: text(own?.jobContractType?.name),
    },
    notes: training ? ['Reed lists this as a training course.'] : [],
  });
}

export async function readReed(url, options = {}) {
  const request = reedRequest(url);
  if (!request) throw Error('Reed reader does not handle this address');
  const response = await siteFetch(request.url, {...options, site: 'Reed', url});
  if (request.kind === 'detail')
    return reedDetailPage(url, isMissing(response) ? '' : await response.text(), request.id);
  if (isMissing(response)) return reedMissingPage(url, request, response.status, options);
  return reedSearchPage(
    url,
    request.number,
    parseReedSearch(await response.text(), request.number),
  );
}

export default {
  id: 'reed',
  matches: isReedUrl,
  http: {handles: (url) => Boolean(reedRequest(url)), read: readReed},
  // The search address and the filters it accepts (observed 2026-10-16):
  // /jobs?keywords=&location= redirects to the SEO path with the same filters.
  // Results are in relevance order; robots.txt disallows sortBy, so no
  // ordering is declared and dateCreatedOffSet keeps to recent postings.
  search: {
    template: `${ORIGIN}/jobs?keywords={query}&location={location}`,
    pagination: 'url_param',
    filters: [
      {
        param: 'dateCreatedOffSet',
        label: 'Posted',
        values: {
          today: 'Today',
          lastthreedays: 'Last 3 days',
          lastweek: 'Last week',
          lasttwoweeks: 'Last 2 weeks',
        },
      },
      {
        param: 'workingOption',
        label: 'Remote/On-site',
        values: {remote: 'Remote', hybrid: 'Hybrid', onSite: 'On-site'},
      },
      {
        param: 'proximity',
        label: 'Distance (miles, with a location)',
        values: {0: '0', 1: '1', 3: '3', 5: '5', 10: '10', 15: '15', 20: '20', 30: '30', 50: '50'},
      },
      {param: 'salaryFrom', label: 'Salary from (£)'},
      {param: 'perm', label: 'Permanent', values: {true: 'Permanent only'}},
      {param: 'contract', label: 'Contract', values: {true: 'Contract only'}},
      {param: 'temp', label: 'Temporary', values: {true: 'Temporary only'}},
      {param: 'partTime', label: 'Part-time', values: {true: 'Part-time only'}},
      {
        param: 'hideTrainingJobs',
        label: 'Training courses',
        values: {true: 'Hide training courses'},
      },
    ],
    notes:
      'UK jobs. 25 results per page via &pageno=N; the page states its total, and the page after the last is HTTP 404. Relevance order with no newest-first sort (robots.txt disallows sortBy), so dateCreatedOffSet=today|lastthreedays|lastweek|lasttwoweeks keeps to recent postings (software engineer in London on 2026-10-16: 1112 in all, 668 last two weeks, 462 last week, 151 last three days, 29 today). Location is free text (London, Manchester); empty searches the UK; proximity is the radius in miles (default 10). Training courses appear among the results unless hideTrainingJobs=true. A promoted listing repeats above every page. Listings are /jobs/<slug>/<id>.',
  },
};
