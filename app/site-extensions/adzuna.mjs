// @ts-check
// Adzuna site extension (API collector; per-site extensions requested
// 2026-10-05). Adzuna's official search API covers 19 countries with the
// user's own free key (app ID and key, Site accounts). It returns only the
// first 500 characters of each description, so a listing here is a card, not
// the full text: Jev reads it as an ordinary page. The API has no single-job
// endpoint and Adzuna's own pages refuse plain HTTP (AWS WAF, 2026-10-16).
// Terms (developer.adzuna.com): 25 calls a minute, 250 a day; credit "The
// Adzuna API".
import {htmlText, listingPage} from './listing.mjs';

const API = 'https://api.adzuna.com/v1/api/jobs';
const PAGE_SIZE = 50;
const MAX_BYTES = 8 * 1024 * 1024;
// API country code → the country's Adzuna site, where its listings live.
export const ADZUNA_SITES = {
  at: 'www.adzuna.at',
  au: 'www.adzuna.com.au',
  be: 'www.adzuna.be',
  br: 'www.adzuna.com.br',
  ca: 'www.adzuna.ca',
  ch: 'www.adzuna.ch',
  de: 'www.adzuna.de',
  es: 'www.adzuna.es',
  fr: 'www.adzuna.fr',
  gb: 'www.adzuna.co.uk',
  in: 'www.adzuna.in',
  it: 'www.adzuna.it',
  mx: 'www.adzuna.com.mx',
  nl: 'www.adzuna.nl',
  nz: 'www.adzuna.co.nz',
  pl: 'www.adzuna.pl',
  sg: 'www.adzuna.sg',
  us: 'www.adzuna.com',
  za: 'www.adzuna.co.za',
};
const HOSTS = ['api.adzuna.com', ...Object.values(ADZUNA_SITES)];
const FILTERS = [
  'what',
  'what_and',
  'what_phrase',
  'what_or',
  'what_exclude',
  'title_only',
  'where',
  'distance',
  'max_days_old',
  'category',
  'salary_min',
  'salary_max',
  'full_time',
  'part_time',
  'contract',
  'permanent',
  'sort_by',
  'sort_dir',
];
const SEARCH_PATH = /^\/v1\/api\/jobs\/([a-z]*)\/search\/(\d+)\/?$/i;

export const isAdzunaUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && HOSTS.includes(u.hostname) && !u.port && !u.username;
  } catch {
    return false;
  }
};

// https://api.adzuna.com/v1/api/jobs/<country>/search/<page>?what=…, the
// address the template fills from the workspace country. The credentials are
// added to the request only, never to this address.
export function adzunaApiUrl(value) {
  if (!isAdzunaUrl(value)) throw Error('Adzuna needs a valid HTTPS address.');
  const input = new URL(value),
    match = input.hostname === 'api.adzuna.com' ? input.pathname.match(SEARCH_PATH) : null;
  if (!match) throw Error('This Adzuna address is not an API search.');
  const country = match[1].toLowerCase();
  if (!country)
    throw Error('Adzuna needs the workspace country (criteria.country); it searches one country.');
  if (!ADZUNA_SITES[country]) throw Error(`Adzuna does not serve the country "${match[1]}".`);
  const page = Number(match[2]);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw Error('Invalid Adzuna page.');
  const url = new URL(`${API}/${country}/search/${page}`);
  for (const key of FILTERS) {
    const v = input.searchParams.get(key);
    if (v) url.searchParams.set(key, v);
  }
  if (!url.searchParams.has('sort_by')) url.searchParams.set('sort_by', 'date');
  url.searchParams.set('results_per_page', String(PAGE_SIZE));
  return url.href;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const amount = (value) => (Number.isFinite(value) ? Math.round(value) : null);
function jobRecord(job, country) {
  const id = String(job?.id ?? '');
  if (!/^\d{1,20}$/.test(id) || !text(job.title))
    throw Error('An Adzuna listing id or title is missing; the page is not complete.');
  const range = [amount(job.salary_min), amount(job.salary_max)].filter((v) => v !== null),
    // A predicted salary is Adzuna's estimate, not what the employer stated.
    stated = range.length && String(job.salary_is_predicted) !== '1';
  return {
    url: `https://${ADZUNA_SITES[country]}/details/${id}`,
    title: htmlText(text(job.title)).slice(0, 300),
    company: text(job.company?.display_name),
    location: text(job.location?.display_name),
    category: text(job.category?.label),
    contractTime: text(job.contract_time),
    contractType: text(job.contract_type),
    salary: stated ? [...new Set(range)].join('–') : '',
    teaser: htmlText(text(job.description)),
    postedAt: text(job.created) || null,
  };
}

export function parseAdzunaPage(value, data) {
  const url = adzunaApiUrl(value),
    path = new URL(url).pathname.match(SEARCH_PATH),
    country = path[1],
    page = Number(path[2]);
  if (!Array.isArray(data?.results) || !Number.isSafeInteger(data.count))
    throw Error('Adzuna API response is malformed; an empty result was not assumed.');
  const totalPages = Math.max(1, Math.ceil(data.count / PAGE_SIZE)),
    nextUrl = page < totalPages ? new URL(url) : null;
  if (nextUrl) nextUrl.pathname = `/v1/api/jobs/${country}/search/${page + 1}`;
  const jobs = data.results.map((job) => jobRecord(job, country));
  if (!jobs.length && nextUrl)
    throw Error('Adzuna results are incomplete; an empty page still has more pages.');
  return {url, jobs, page, totalPages, nextUrl: nextUrl?.href ?? null, complete: !nextUrl};
}

const requestSignal = (signal, timeoutMs) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

// One search page. A failed request is reported as it is; the collector worker
// keeps its checkpoint and controls retries.
export async function readAdzunaPage(
  value,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000, credentials = null} = {},
) {
  const url = adzunaApiUrl(value);
  if (!credentials?.appId || !credentials?.appKey)
    throw Error(
      'Adzuna needs your API key: add its app ID and key under Configuration → Site accounts.',
    );
  const request = new URL(url);
  request.searchParams.set('app_id', credentials.appId);
  request.searchParams.set('app_key', credentials.appKey);
  const response = await fetch(request.href, {
    headers: {Accept: 'application/json'},
    redirect: 'error',
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(
      Error(
        [400, 401, 403].includes(response.status)
          ? `Adzuna refused the request (HTTP ${response.status}); check the saved app ID and key, and the daily call limit.`
          : `Adzuna API HTTP ${response.status}; the scan did not finish.`,
      ),
      {status: response.status},
    );
  }
  if (!response.headers.get('content-type')?.includes('json')) {
    await response.body?.cancel();
    throw Error('Adzuna returned something other than JSON.');
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw Error('Adzuna API response exceeds the size limit.');
  return parseAdzunaPage(url, JSON.parse(body));
}

export default {
  id: 'adzuna',
  matches: isAdzunaUrl,
  credentials: {
    label: 'Adzuna',
    help: 'Register a free application on developer.adzuna.com and enter its app ID and key. The free tier allows 250 calls a day.',
    signupUrl: 'https://developer.adzuna.com/signup',
    fields: [
      {key: 'appId', label: 'App ID'},
      {key: 'appKey', label: 'App key'},
    ],
  },
  collector: {
    templateId: 'job-search',
    searchUrl: adzunaApiUrl,
    acceptsQuery: () => false,
    readPage: readAdzunaPage,
    // The API has no single-job endpoint and the site refuses plain HTTP.
    readDetail: undefined,
    detail: (job) => ({
      ...listingPage({
        browser: 'Adzuna API',
        url: job.url,
        title: job.title,
        fields: {
          company: job.company,
          location: job.location,
          category: job.category,
          employmentType: [job.contractTime, job.contractType].filter(Boolean),
          salary: job.salary,
          postedAt: job.postedAt,
        },
        // The API cuts descriptions to 500 characters: a teaser, not the listing.
        notes: job.teaser
          ? [`Teaser from the Adzuna API (first 500 characters): ${job.teaser}`]
          : [],
      }),
      cells: {company: job.company, location: job.location},
    }),
  },
  // The API search (developer.adzuna.com Swagger spec, 2026-10).
  search: {
    template: `${API}/{country}/search/1?what={query}&sort_by=date`,
    pagination: 'url_param',
    filters: [
      {param: 'where', label: 'Place'},
      {param: 'distance', label: 'Distance from the place (km)'},
      {param: 'max_days_old', label: 'Posted within (days)'},
      {param: 'title_only', label: 'Words that must be in the title'},
      {param: 'what_exclude', label: 'Words to exclude'},
      {param: 'salary_min', label: 'Minimum salary'},
      {param: 'full_time', label: 'Full time', values: {1: 'Full time only'}},
      {param: 'part_time', label: 'Part time', values: {1: 'Part time only'}},
      {param: 'permanent', label: 'Permanent', values: {1: 'Permanent only'}},
      {param: 'contract', label: 'Contract', values: {1: 'Contract only'}},
    ],
    notes:
      "Official API with the user's own free key (Site accounts): 250 calls a day. One country per search through the path (/jobs/<country>/search/<page>, lowercase ISO code: at au be br ca ch de es fr gb in it mx nl nz pl sg us za). 50 listings per page; sort_by=date asks for newest first (documented; not verified with a key yet). Listing addresses follow the country site's /details/<id> form. Descriptions are cut to 500 characters, so listings carry a teaser only. No remote filter: put remote in what.",
  },
};
