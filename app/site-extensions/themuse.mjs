// @ts-check
// The Muse site extension (API collector; per-site extensions requested
// 2026-10-05). The public jobs API returns 20 postings per page with their
// full descriptions; mostly US employers, some remote and international. It
// has no text search (query= is ignored, observed 2026-10-11) and no date
// order (descending=true does not sort by date), so a scan reads its page
// budget and Jev's triage narrows the listings. Unauthenticated budget: 500
// requests per hour. Unknown parameters are ignored silently by the API, so
// the reader accepts only the documented ones.
import {htmlText, listingPage} from './listing.mjs';
import {READER_HEADERS} from './http.mjs';

const ORIGIN = 'https://www.themuse.com';
const API_PATH = '/api/public/jobs';
const SEARCH_PATHS = ['', '/jobs', '/search', API_PATH];
const FILTERS = ['category', 'level', 'location', 'company'];
const LISTING_PATH = /^\/jobs\/[a-z0-9-]+\/[a-z0-9-]+$/;
const MAX_BYTES = 16 * 1024 * 1024;
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'jobloop/1.0 (job search source reader)',
};

export const isTheMuseUrl = (value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      ['themuse.com', 'www.themuse.com'].includes(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
};

// A jobs address as the API address of one page. Pages count from 0. Facets
// repeat (category=A&category=B is either); other parameters are refused
// because the API would ignore them and list everything.
export function theMuseApiUrl(value) {
  if (!isTheMuseUrl(value)) throw Error('The Muse needs a valid HTTPS address.');
  const input = new URL(value);
  if (!SEARCH_PATHS.includes(input.pathname.replace(/\/$/, '')))
    throw Error('This The Muse address is not a job search; use the API address /api/public/jobs.');
  const page = input.searchParams.get('page') ?? '0';
  if (!/^\d{1,5}$/.test(page)) throw Error('Invalid The Muse page number.');
  const url = new URL(API_PATH, ORIGIN);
  for (const [key, value] of input.searchParams) {
    if (key === 'page' || key.startsWith('utm_') || !value) continue;
    if (!FILTERS.includes(key)) throw Error(`Unsupported The Muse filter: ${key}`);
    url.searchParams.append(key, value);
  }
  url.searchParams.set('page', String(Number(page)));
  return url.href;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const names = (value) =>
  Array.isArray(value) ? value.map((v) => text(v?.name)).filter(Boolean) : [];
const listingUrl = (value) => {
  try {
    const url = new URL(value);
    if (!isTheMuseUrl(url.href) || !LISTING_PATH.test(url.pathname)) return null;
    return `${ORIGIN}${url.pathname}`;
  } catch {
    return null;
  }
};
function jobRecord(job) {
  const url = listingUrl(job?.refs?.landing_page);
  if (!url || !Number.isSafeInteger(job.id) || !text(job.name) || !text(job.contents))
    throw Error(
      'The Muse listing address, id, title or description missing; the page is incomplete.',
    );
  const description = htmlText(job.contents);
  if (!description) throw Error('The Muse listing description could not be read.');
  return {
    url,
    id: job.id,
    title: text(job.name).slice(0, 300),
    company: text(job.company?.name),
    locations: names(job.locations),
    levels: names(job.levels),
    categories: names(job.categories),
    description,
    postedAt: text(job.publication_date) || null,
  };
}

export function parseTheMusePage(value, data) {
  const url = theMuseApiUrl(value),
    page = Number(new URL(url).searchParams.get('page'));
  if (
    !Array.isArray(data?.results) ||
    data.page !== page ||
    !Number.isSafeInteger(data.page_count) ||
    data.page_count < 0
  )
    throw Error('The Muse API response is malformed; an empty result was not assumed.');
  const nextUrl = page + 1 < data.page_count ? new URL(url) : null;
  nextUrl?.searchParams.set('page', String(page + 1));
  const jobs = data.results.map(jobRecord);
  if (!jobs.length && nextUrl)
    throw Error('The Muse results are incomplete; an empty page still has more pages.');
  return {
    url,
    jobs,
    page: page + 1,
    totalPages: Math.max(1, data.page_count),
    nextUrl: nextUrl?.href ?? null,
    complete: !nextUrl,
  };
}

const requestSignal = (signal, timeoutMs) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
async function readBody(url, {fetch, signal, timeoutMs, headers, json}, what) {
  const response = await fetch(url, {
    headers,
    redirect: json ? 'error' : 'follow',
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(Error(`The Muse HTTP ${response.status}; ${what}.`), {
      status: response.status,
    });
  }
  if (json && !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw Error('The Muse returned something other than JSON.');
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw Error('The Muse response exceeds the size limit.');
  return json ? JSON.parse(body) : body;
}

// One API page. A failed request is reported as it is; the collector worker
// keeps its checkpoint and controls retries.
export async function readTheMusePage(
  value,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const url = theMuseApiUrl(value);
  return parseTheMusePage(
    url,
    await readBody(
      url,
      {fetch, signal, timeoutMs, headers: HEADERS, json: true},
      'the scan did not finish',
    ),
  );
}

// One listing by its address, for listings that moved off the page they were
// queued from. The address carries no API id: the listing page names it in its
// page data, and the API posting must point back to the same address.
export async function readTheMuseDetail(
  url,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  if (listingUrl(url) !== url) throw Error('A single The Muse listing address is needed.');
  const options = {fetch, signal, timeoutMs},
    what = 'the address stays pending';
  const html = await readBody(url, {...options, headers: READER_HEADERS, json: false}, what);
  const id = html.replace(/&quot;/g, '"').match(/"sp_page_entity_id":"(\d{1,12})"/)?.[1];
  if (!id) throw Error('The Muse listing page names no posting id; the address stays pending.');
  const job = jobRecord(
    await readBody(`${ORIGIN}${API_PATH}/${id}`, {...options, headers: HEADERS, json: true}, what),
  );
  if (job.url !== url)
    throw Error('The Muse posting does not match the listing address; the address stays pending.');
  return job;
}

// Like the other extensions, this adapter only supplies observed listings.
// The common queue, Jev classifier and agent own every assessment and write.
export default {
  id: 'themuse',
  matches: isTheMuseUrl,
  collector: {
    templateId: 'job-search',
    searchUrl: theMuseApiUrl,
    // The API has no text search; categories and levels narrow it.
    acceptsQuery: () => false,
    readPage: readTheMusePage,
    readDetail: readTheMuseDetail,
    detail: (job) => ({
      ...listingPage({
        browser: 'The Muse API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {
          company: job.company,
          location: job.locations,
          level: job.levels,
          category: job.categories,
          postedAt: job.postedAt,
        },
      }),
      cells: {company: job.company, location: job.locations.join(', ')},
    }),
  },
  // The API address and its documented filters (observed 2026-10-11).
  search: {
    template: `${ORIGIN}${API_PATH}?category={query}`,
    pagination: 'url_param',
    filters: [
      {param: 'location', label: 'Location ("City, ST" or "Flexible / Remote")'},
      {
        param: 'level',
        label: 'Level',
        values: {
          'Entry Level': 'Entry level',
          'Mid Level': 'Mid level',
          'Senior Level': 'Senior level',
          Management: 'Management',
          Internship: 'Internship',
        },
      },
      {param: 'company', label: 'Company name'},
    ],
    notes:
      'Public JSON API without text search: {query} is a category name such as "Software Engineering", "Data and Analytics", "Product Management" or "Project Management". 20 postings per page with full descriptions; pages count from 0 via page=N. Not ordered by date, so a scan reads its page budget and Jev narrows. Facets repeat (location=A&location=B is either); a location search also returns "Flexible / Remote" postings. Any other parameter is refused because the API would ignore it. Budget: 500 requests per hour.',
  },
};
