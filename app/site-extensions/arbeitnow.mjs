// @ts-check
// Arbeitnow site extension (API collector; per-site extensions requested
// 2026-10-05). The public job-board API lists postings with their full
// descriptions: the .com feed mixes Germany, the UK, France and Switzerland,
// the .co.uk/.fr/.ch sites each list one country. It has no search (search= is
// ignored, observed 2026-10), only the documented visa_sponsorship filter, so
// one feed serves every query and Jev's triage narrows it. Terms of use: a
// free API, do not abuse, link back to the site.
import {htmlText, listingPage} from './listing.mjs';
import {READER_HEADERS} from './http.mjs';
import {jobPostingDetail, jobPostingHtml} from './job-posting.mjs';

const ORIGIN = 'https://www.arbeitnow.com';
const API_PATH = '/api/job-board-api';
const SITES = ['arbeitnow.com', 'arbeitnow.co.uk', 'arbeitnow.fr', 'arbeitnow.ch'];
const LISTING_PATH = /^\/jobs\/companies\/[^/]+\/[^/]+\/?$/;
const MAX_BYTES = 16 * 1024 * 1024;
const site = (hostname) => SITES.find((s) => hostname === s || hostname === `www.${s}`) ?? null;
export const isArbeitnowUrl = (value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' && Boolean(site(u.hostname)) && !u.port && !u.username && !u.password
    );
  } catch {
    return false;
  }
};

// Any address on a site means that site's feed; the page number and the
// documented visa_sponsorship filter carry over, nothing else.
export function arbeitnowApiUrl(value) {
  if (!isArbeitnowUrl(value)) throw Error('A valid HTTPS address is required for Arbeitnow.');
  const input = new URL(value),
    page = input.searchParams.get('page') ?? '1',
    visa = input.searchParams.get('visa_sponsorship');
  if (!/^[1-9]\d{0,5}$/.test(page)) throw Error('Invalid Arbeitnow page number.');
  if (visa !== null && !['true', 'false'].includes(visa))
    throw Error('Invalid Arbeitnow visa sponsorship filter.');
  const url = new URL(API_PATH, `https://www.${site(input.hostname)}`);
  if (visa !== null) url.searchParams.set('visa_sponsorship', visa);
  url.searchParams.set('page', page);
  return url.href;
}

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
function jobRecord(job) {
  if (!text(job?.url) || !text(job.title) || !text(job.description))
    throw Error(
      'An Arbeitnow listing address, title or description is missing; the page is not complete.',
    );
  const url = new URL(job.url);
  if (!isArbeitnowUrl(url.href) || !LISTING_PATH.test(url.pathname))
    throw Error('The Arbeitnow listing address could not be verified.');
  url.search = '';
  url.hash = '';
  const description = htmlText(job.description);
  if (!description) throw Error('The Arbeitnow listing description could not be read.');
  return {
    url: url.href,
    title: text(job.title).slice(0, 300),
    company: text(job.company_name),
    location: text(job.location),
    remote: job.remote === true,
    tags: strings(job.tags),
    jobTypes: strings(job.job_types),
    description,
    publishedAt: Number.isFinite(job.created_at)
      ? new Date(job.created_at * 1000).toISOString()
      : null,
  };
}

export function parseArbeitnowPage(value, data) {
  const url = arbeitnowApiUrl(value),
    page = Number(new URL(url).searchParams.get('page'));
  if (!data || !Array.isArray(data.data) || !Number.isSafeInteger(data.meta?.current_page))
    throw Error('Invalid Arbeitnow API response format; an empty result was not accepted.');
  if (data.meta.current_page !== page)
    throw Error('Arbeitnow returned a different page than the one requested.');
  const next = data.links?.next ?? null;
  if (next !== null && typeof next !== 'string')
    throw Error('Invalid Arbeitnow continuation link.');
  // The feed's next link is only the sign that more pages exist; the next
  // address keeps this request's own filter.
  const nextUrl = next ? url.replace(/page=\d+$/, `page=${page + 1}`) : null;
  const jobs = data.data.map(jobRecord);
  if (!jobs.length && nextUrl)
    throw Error(
      'Arbeitnow results are incomplete; there is a continuation link despite an empty page.',
    );
  return {url, jobs, page, totalPages: null, nextUrl, complete: nextUrl === null};
}

const requestSignal = (signal, timeoutMs) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

// One feed page. A failed request is reported as it is; the collector worker
// keeps its checkpoint and controls retries.
export async function readArbeitnowPage(
  value,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const url = arbeitnowApiUrl(value);
  const response = await fetch(url, {
    headers: {Accept: 'application/json', 'User-Agent': READER_HEADERS['User-Agent']},
    redirect: 'error',
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(Error(`Arbeitnow API HTTP ${response.status}; the scan is not complete.`), {
      status: response.status,
    });
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw Error('Arbeitnow returned content other than JSON.');
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw Error('The Arbeitnow API page exceeded the size limit.');
  return parseArbeitnowPage(url, JSON.parse(body));
}

// One listing page by its address, through the posting's JobPosting, for
// listings that moved off the feed page they were queued from.
export async function readArbeitnowDetail(
  url,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  if (!isArbeitnowUrl(url) || !LISTING_PATH.test(new URL(url).pathname))
    throw Error('A single Arbeitnow listing address is required.');
  const response = await fetch(url, {
    headers: READER_HEADERS,
    redirect: 'follow',
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`Arbeitnow listing page HTTP ${response.status}; the address stays pending.`);
  }
  const job = jobPostingDetail(jobPostingHtml(await response.text()));
  if (!job)
    throw Error(
      'The Arbeitnow listing page has no current listing data; the address stays pending.',
    );
  return {
    url,
    title: job.title,
    company: job.company,
    location: [].concat(job.fields.location ?? []).join(', '),
    remote: job.fields.workMode === 'remote',
    tags: [],
    jobTypes: [].concat(job.fields.employmentType ?? []),
    description: job.description,
    publishedAt: job.fields.postedAt ?? null,
  };
}

// Like the other extensions, this adapter only supplies observed listings.
// The common queue, Jev classifier and agent own every assessment and write.
export default {
  id: 'arbeitnow',
  matches: isArbeitnowUrl,
  collector: {
    templateId: 'job-search',
    searchUrl: arbeitnowApiUrl,
    acceptsQuery: () => false,
    readPage: readArbeitnowPage,
    readDetail: readArbeitnowDetail,
    detail: (job) => ({
      ...listingPage({
        browser: 'Arbeitnow API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {
          company: job.company,
          location: job.location,
          workMode: job.remote ? 'remote' : null,
          employmentType: job.jobTypes,
          tags: job.tags,
          postedAt: job.publishedAt,
        },
      }),
      cells: {company: job.company, location: job.location},
    }),
  },
  // The feed address and its one documented filter (observed 2026-10).
  search: {
    template: `${ORIGIN}${API_PATH}`,
    pagination: 'url_param',
    filters: [
      {
        param: 'visa_sponsorship',
        label: 'Visa sponsorship',
        values: {true: 'Only with sponsorship', false: 'Without sponsorship'},
      },
    ],
    notes:
      'A public feed without search (search= is ignored). The .com feed lists Europe (DE, UK, FR, CH); the .co.uk, .fr and .ch sites list one country each, so use that host as the source address for one country. About 100 postings per page via ?page=N, roughly newest first but not strictly; a scan reads its page budget and Jev narrows the listings.',
  },
};
