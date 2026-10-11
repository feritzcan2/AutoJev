// @ts-check
// Workable site extension (API collector; per-site extensions requested
// 2026-10-05). jobs.workable.com is Workable's central job search across the
// employers that use it; its page reads the same public JSON API this reads.
// Each hit carries its full description, requirements and benefits, so one
// request holds a page of listings and their text. Results are in relevance
// order (observed 2026-10-11), pages follow an opaque nextPageToken. A filter
// value the API does not know gives an empty result rather than an error, so
// filters are checked here against the values the site offers.
import {htmlText, listingPage} from './listing.mjs';
import {READER_HEADERS} from './http.mjs';

const ORIGIN = 'https://jobs.workable.com';
const API_PATH = '/api/v1/jobs';
const SEARCH_PATHS = ['', '/search', API_PATH];
const LISTING_PATH = /^\/view\/([A-Za-z0-9]{8,40})(?:\/[^/]*)?\/?$/;
const PAGE_SIZE = 20;
const MAX_BYTES = 16 * 1024 * 1024;
// The filters the site's own search offers, with their values (2026-10).
const FILTERS = {
  workplace: ['remote', 'hybrid', 'on_site'],
  employment_type: ['full_time', 'part_time', 'contract', 'temporary', 'other'],
  day_range: ['1', '7', '30'],
};
const WORK_MODES = {remote: 'remote', hybrid: 'hybrid', on_site: 'onsite'};

export const isWorkableUrl = (value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      u.hostname === 'jobs.workable.com' &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
};

// A search address (the site's /search page or the API) as the API address of
// one page. page and pageToken are the reader's own position: page counts the
// pages read, pageToken is the cursor the previous page returned.
export function workableApiUrl(value) {
  if (!isWorkableUrl(value)) throw Error('Workable needs a valid HTTPS jobs.workable.com address.');
  const input = new URL(value);
  if (!SEARCH_PATHS.includes(input.pathname.replace(/\/$/, '')))
    throw Error('This Workable address is not a job search; use /search?query=… or the API.');
  const url = new URL(API_PATH, ORIGIN),
    params = input.searchParams;
  for (const key of new Set(params.keys()))
    if (
      !/^utm_/.test(key) &&
      !['query', 'location', 'page', 'pageToken', ...Object.keys(FILTERS)].includes(key)
    )
      throw Error(`Unsupported Workable filter: ${key}`);
  for (const key of ['query', 'location', ...Object.keys(FILTERS)]) {
    const values = params.getAll(key).filter(Boolean);
    if (values.length > 1) throw Error(`Repeated Workable filter: ${key}`);
    const [value] = values;
    if (!value || (key === 'day_range' && value === '0')) continue;
    if (FILTERS[key] && !FILTERS[key].includes(value))
      throw Error(`Unknown Workable ${key} value: ${value} (expected ${FILTERS[key].join(', ')})`);
    url.searchParams.set(key, value);
  }
  const page = params.get('page') ?? '1',
    token = params.get('pageToken');
  if (!/^[1-9]\d{0,4}$/.test(page) || (page === '1') !== !token)
    throw Error('Invalid Workable page position.');
  if (token) {
    if (!/^[A-Za-z0-9_=-]{1,2000}$/.test(token)) throw Error('Invalid Workable page token.');
    url.searchParams.set('page', page);
    url.searchParams.set('pageToken', token);
  }
  return url.href;
}

// The request the API answers: the reader's page count stays out of it.
const requestUrl = (url) => {
  const request = new URL(url);
  request.searchParams.delete('page');
  return request.href;
};

const text = (value) => (typeof value === 'string' ? value.trim() : '');
function jobRecord(job) {
  const id = text(job?.url).match(
    /^https:\/\/jobs\.workable\.com\/view\/([A-Za-z0-9]{8,40})(?:\/|$)/,
  )?.[1];
  if (!id || !text(job.title) || !text(job.description))
    throw Error('Workable listing address, title or description missing; the page is incomplete.');
  const description = [
    htmlText(job.description),
    text(job.requirementsSection) && `Requirements\n${htmlText(job.requirementsSection)}`,
    text(job.benefitsSection) && `Benefits\n${htmlText(job.benefitsSection)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!description) throw Error('Workable listing description could not be read.');
  const place = job.location ?? {};
  return {
    url: `${ORIGIN}/view/${id}`,
    title: text(job.title).slice(0, 300),
    company: text(job.company?.title),
    location: [place.city, place.subregion, place.countryName].map(text).filter(Boolean).join(', '),
    workMode: WORK_MODES[job.workplace] ?? '',
    employmentType: text(job.employmentType),
    applyUrl: /^https?:\/\//.test(text(job.linkoutUrl)) ? text(job.linkoutUrl) : '',
    description,
    postedAt: text(job.created) || null,
    closed: text(job.state) !== 'published',
  };
}

export function parseWorkablePage(value, data) {
  const url = workableApiUrl(value),
    page = Number(new URL(url).searchParams.get('page') ?? '1');
  if (!Array.isArray(data?.jobs) || !Number.isSafeInteger(data.totalSize))
    throw Error('Workable API response is malformed; an empty result was not assumed.');
  const token = data.nextPageToken ?? null;
  if (token !== null && typeof token !== 'string')
    throw Error('Workable next page token is invalid.');
  const jobs = data.jobs.map(jobRecord),
    more = Boolean(token) && page * PAGE_SIZE < data.totalSize;
  if (!jobs.length && more)
    throw Error('Workable results are incomplete; an empty page still has more pages.');
  let nextUrl = null;
  if (more) {
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('pageToken', token);
    nextUrl = workableApiUrl(next.href);
  }
  return {
    url,
    jobs,
    page,
    totalPages: Math.max(1, Math.ceil(data.totalSize / PAGE_SIZE)),
    nextUrl,
    complete: !nextUrl,
  };
}

const requestSignal = (signal, timeoutMs) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
async function readJson(url, {fetch, signal, timeoutMs}, what) {
  const response = await fetch(url, {
    headers: {Accept: 'application/json', 'User-Agent': READER_HEADERS['User-Agent']},
    redirect: 'error',
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(Error(`Workable API HTTP ${response.status}; ${what}.`), {
      status: response.status,
    });
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw Error('Workable returned something other than JSON.');
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw Error('Workable API response exceeds the size limit.');
  return JSON.parse(body);
}

// One search page. A failed request is reported as it is; the collector worker
// keeps its checkpoint and controls retries.
export async function readWorkablePage(
  value,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const url = workableApiUrl(value);
  return parseWorkablePage(
    url,
    await readJson(requestUrl(url), {fetch, signal, timeoutMs}, 'the scan did not finish'),
  );
}

// One listing by its address, for listings that moved off the page they were
// queued from.
export async function readWorkableDetail(
  url,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const id = isWorkableUrl(url) ? new URL(url).pathname.match(LISTING_PATH)?.[1] : null;
  if (!id) throw Error('A single Workable listing address is needed.');
  const job = await readJson(
    `${ORIGIN}${API_PATH}/${id}`,
    {fetch, signal, timeoutMs},
    'the address stays pending',
  );
  return {...jobRecord(job), url};
}

// Like the other extensions, this adapter only supplies observed listings.
// The common queue, Jev classifier and agent own every assessment and write.
export default {
  id: 'workable',
  matches: isWorkableUrl,
  collector: {
    templateId: 'job-search',
    searchUrl: workableApiUrl,
    acceptsQuery: () => true,
    readPage: readWorkablePage,
    readDetail: readWorkableDetail,
    detail: (job) => ({
      ...listingPage({
        browser: 'Workable API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {
          company: job.company,
          location: job.location,
          workMode: job.workMode,
          employmentType: job.employmentType,
          postedAt: job.postedAt,
          applyUrl: job.applyUrl,
        },
        notes: job.closed ? ['No longer accepting applications.'] : [],
      }),
      cells: {company: job.company, location: job.location},
    }),
  },
  // The API search address and the filters the site's search offers (2026-10).
  // Relevance order only, so no ordering is declared.
  search: {
    template: `${ORIGIN}${API_PATH}?query={query}&location={location}`,
    pagination: 'url_param',
    filters: [
      {
        param: 'workplace',
        label: 'Workplace',
        values: {remote: 'Remote', hybrid: 'Hybrid', on_site: 'On-site'},
      },
      {
        param: 'employment_type',
        label: 'Employment type',
        values: {
          full_time: 'Full-time',
          part_time: 'Part-time',
          contract: 'Contract',
          temporary: 'Temporary',
          other: 'Other',
        },
      },
      {
        param: 'day_range',
        label: 'Posted',
        values: {1: 'Last 24 hours', 7: 'Last week', 30: 'Last month'},
      },
    ],
    notes:
      'Workable\'s public job search API across employers using Workable: 20 listings per page with full descriptions, in relevance order (not by date). Pages follow the API\'s nextPageToken, which the reader carries as page=N&pageToken=…; do not build page addresses yourself. location is a place name ("United States", "Berlin"); an empty one searches worldwide. day_range=1|7|30 keeps recent postings. Unknown filters or values stop the scan. Listings are https://jobs.workable.com/view/<id>.',
  },
};
