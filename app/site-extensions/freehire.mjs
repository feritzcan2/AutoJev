// @ts-check
// FreeHire site extension (API collector; per-site extensions requested
// 2026-10-05). The site asks bots to read its public, unauthenticated JSON API
// instead of the pages (robots.txt, llms.txt). The agent search endpoint
// returns every hit with its full description, so one request holds a page of
// listings and their text. Budget: 300 requests per minute for that endpoint.
// A filter the API does not read is dropped and reported in
// meta.ignored_params; a scan stops there instead of reading the whole
// catalogue as if it matched.
import {htmlText, listingPage} from './listing.mjs';

const ORIGIN = 'https://freehire.me';
const API_PATH = '/api/v1/agent/jobs/search';
const SEARCH_PATHS = ['', '/jobs', '/api/v1/jobs/search', API_PATH];
const LISTING_PATH = /^\/jobs\/([a-z0-9][a-z0-9-]*)\/?$/;
const PAGE_SIZE = 25;
// The API refuses offset + limit above 10000.
const MAX_ROWS = 10000;
const MAX_BYTES = 16 * 1024 * 1024;
// The site asks callers to name their project.
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'jobloop/1.0 (job search source reader)',
};

export const isFreehireUrl = (value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      ['freehire.me', 'www.freehire.me'].includes(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
};

// A results address (the site's /jobs page or the API search) as the agent
// search API address of one page. Filters pass through unchanged; the API
// reports the ones it does not read.
export function freehireApiUrl(value) {
  if (!isFreehireUrl(value)) throw Error('FreeHire needs a valid HTTPS address.');
  const input = new URL(value);
  if (!SEARCH_PATHS.includes(input.pathname.replace(/\/$/, '')))
    throw Error('This FreeHire address is not a job search; use /jobs?… or the API search.');
  const page = input.searchParams.get('page'),
    offset =
      input.searchParams.get('offset') ?? (page ? String((Number(page) - 1) * PAGE_SIZE) : '0');
  if (!/^\d{1,5}$/.test(offset) || Number(offset) % PAGE_SIZE || Number(offset) >= MAX_ROWS)
    throw Error('Invalid FreeHire page position.');
  const url = new URL(API_PATH, ORIGIN);
  for (const [key, value] of input.searchParams)
    if (!/^(?:utm_|page$|offset$|limit$|description_format$)/.test(key) && value)
      url.searchParams.append(key, value);
  if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'created_at');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', offset);
  return url.href;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const salaryText = (e) => {
  if (!Number.isFinite(e?.salary_min) && !Number.isFinite(e?.salary_max)) return '';
  const range = [e.salary_min, e.salary_max].filter(Number.isFinite).join('–');
  return [range, text(e.salary_currency), text(e.salary_period) && `per ${text(e.salary_period)}`]
    .filter(Boolean)
    .join(' ');
};
// The employer's own address, where an applicant goes, without FreeHire's
// tracking parameters.
const applyUrl = (value) => {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    for (const key of [...url.searchParams.keys()])
      if (key.startsWith('utm_')) url.searchParams.delete(key);
    return url.href;
  } catch {
    return '';
  }
};
function jobRecord(job) {
  const slug = text(job?.public_slug);
  if (!LISTING_PATH.test(`/jobs/${slug}`) || !text(job.title) || !text(job.description))
    throw Error('FreeHire listing slug, title or description missing; the page is incomplete.');
  const description = htmlText(job.description);
  if (!description) throw Error('FreeHire listing description could not be read.');
  return {
    url: `${ORIGIN}/jobs/${slug}`,
    title: text(job.title).slice(0, 300),
    company: text(job.company),
    location: text(job.location),
    workMode: text(job.work_mode),
    employmentType: text(job.enrichment?.employment_type),
    salary: salaryText(job.enrichment),
    applyUrl: applyUrl(job.url),
    description,
    postedAt: text(job.posted_at) || null,
    closed: Boolean(job.closed_at),
  };
}

export function parseFreehirePage(value, data) {
  const url = freehireApiUrl(value),
    offset = Number(new URL(url).searchParams.get('offset')),
    meta = data?.meta;
  if (!Array.isArray(data?.data) || !Number.isSafeInteger(meta?.total) || meta.offset !== offset)
    throw Error('FreeHire API response is malformed; an empty result was not assumed.');
  if (Array.isArray(meta.ignored_params) && meta.ignored_params.length)
    throw Error(
      `FreeHire ignored these search parameters, so the results are not the requested search: ${meta.ignored_params
        .map((p) => (p.did_you_mean ? `${p.param} (did you mean ${p.did_you_mean}?)` : p.param))
        .join(', ')}`,
    );
  const rows = Math.min(meta.total, MAX_ROWS),
    next = offset + PAGE_SIZE,
    nextUrl = next < rows && next + PAGE_SIZE <= MAX_ROWS ? new URL(url) : null;
  nextUrl?.searchParams.set('offset', String(next));
  const jobs = data.data.map(jobRecord);
  if (!jobs.length && nextUrl)
    throw Error('FreeHire results are incomplete; an empty page still has more pages.');
  return {
    url,
    jobs,
    page: offset / PAGE_SIZE + 1,
    totalPages: Math.max(1, Math.ceil(rows / PAGE_SIZE)),
    nextUrl: nextUrl?.href ?? null,
    complete: !nextUrl,
  };
}

const requestSignal = (signal, timeoutMs) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
async function readJson(url, {fetch, signal, timeoutMs}, what) {
  const response = await fetch(url, {
    headers: HEADERS,
    redirect: 'error',
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(Error(`FreeHire API HTTP ${response.status}; ${what}.`), {
      status: response.status,
    });
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw Error('FreeHire returned something other than JSON.');
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw Error('FreeHire API response exceeds the size limit.');
  return JSON.parse(body);
}

// One search page. A failed request is reported as it is; the collector worker
// keeps its checkpoint and controls retries.
export async function readFreehirePage(
  value,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const url = freehireApiUrl(value);
  return parseFreehirePage(
    url,
    await readJson(url, {fetch, signal, timeoutMs}, 'the scan did not finish'),
  );
}

// One listing by its address, for listings that moved off the page they were
// queued from. The job endpoint also serves closed postings.
export async function readFreehireDetail(
  url,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const slug = isFreehireUrl(url) ? new URL(url).pathname.match(LISTING_PATH)?.[1] : null;
  if (!slug) throw Error('A single FreeHire listing address is needed.');
  const data = await readJson(
    `${ORIGIN}/api/v1/jobs/${slug}`,
    {fetch, signal, timeoutMs},
    'the address stays pending',
  );
  return {...jobRecord(data?.data), url};
}

// Like the other extensions, this adapter only supplies observed listings.
// The common queue, Jev classifier and agent own every assessment and write.
export default {
  id: 'freehire',
  matches: isFreehireUrl,
  collector: {
    templateId: 'job-search',
    searchUrl: freehireApiUrl,
    acceptsQuery: () => true,
    readPage: readFreehirePage,
    readDetail: readFreehireDetail,
    detail: (job) => ({
      ...listingPage({
        browser: 'FreeHire API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {
          company: job.company,
          location: job.location,
          workMode: job.workMode,
          employmentType: job.employmentType,
          salary: job.salary,
          postedAt: job.postedAt,
          applyUrl: job.applyUrl,
        },
        notes: job.closed ? ['No longer accepting applications.'] : [],
      }),
      cells: {company: job.company, location: job.location},
    }),
  },
  // The API search address and its common filters (openapi.yaml, 2026-10).
  // sort=created_at is strictly newest first, so a scan reads the newest pages
  // of its page budget. No ordering is declared yet.
  search: {
    template: `${ORIGIN}${API_PATH}?q=%22{query}%22&q_fields=title&sort=created_at`,
    pagination: 'url_param',
    filters: [
      {param: 'countries', label: 'Country (ISO code, lowercase)'},
      {
        param: 'regions',
        label: 'Region',
        values: {
          eu: 'Europe',
          uk: 'United Kingdom',
          north_america: 'North America',
          latam: 'Latin America',
          apac: 'Asia-Pacific',
          mena: 'Middle East and North Africa',
          africa: 'Africa',
          cis: 'CIS',
          global: 'Global',
        },
      },
      {param: 'cities', label: 'City'},
      {
        param: 'work_mode',
        label: 'Work mode',
        values: {remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site'},
      },
      {
        param: 'seniority',
        label: 'Seniority',
        values: {
          intern: 'Intern',
          junior: 'Junior',
          middle: 'Mid-level',
          senior: 'Senior',
          lead: 'Lead',
          staff: 'Staff',
          principal: 'Principal',
          c_level: 'C-level',
        },
      },
      {param: 'skills', label: 'Skill (slug)'},
      {param: 'visa_sponsorship', label: 'Visa sponsorship', values: {true: 'Sponsoring only'}},
    ],
    notes:
      "Public JSON API, 25 listings per page with full descriptions; pages via offset=25,50,… (offset+limit at most 10000). sort=created_at orders by when FreeHire first saw a posting, newest first, so the page budget reads the newest listings. q matches stemmed words: unquoted words are ORed, a quoted term needs all its words; q_fields=title keeps matches to the title. Facets repeat (countries=de&countries=at is either); countries, regions and cities join one OR group, so name only one place. An unknown parameter stops the scan with the API's ignored_params report. Listings are https://freehire.me/jobs/<slug>; applyUrl is the employer's own address.",
  },
};
