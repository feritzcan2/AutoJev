// @ts-check
// Jobnet site extension (API collector; per-site extensions requested
// 2026-10-05). Jobnet (jobnet.dk) is the Danish public employment service. Its
// find-job page is a script app over a JSON search API (bff) that returns each
// hit with its full description as HTML, external postings included, so one
// request holds a page of listings and their text. Facts observed 2026-10-16:
// the API needs the x-csrf header (401 without it); orderType, resultsPerPage
// and pageNumber are required (400 without them); unknown parameters and some
// malformed values (a lower-case country, a 3-digit postal code) are ignored
// silently, so this module validates the site's own search parameters itself.
// Results stop at 10000 rows whatever the total says. robots.txt redirects to
// a login page, so the site states no crawl rules.
import {htmlText, listingPage} from './listing.mjs';
import {READER_HEADERS} from './http.mjs';

const ORIGIN = 'https://jobnet.dk';
const API_PATH = '/bff/FindJob/Search';
const SEARCH_PATHS = ['', '/find-job', API_PATH];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LISTING_PATH = /^\/find-job\/([0-9a-f-]{36})\/?$/;
const PAGE_SIZE = 20;
const MAX_ROWS = 10000;
const MAX_BYTES = 16 * 1024 * 1024;
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': READER_HEADERS['User-Agent'],
  'x-csrf': '1',
};
// The search parameters the find-job page itself reads, with the values the
// API accepts; the address keeps them in this order. Lists repeat.
const ORDERS = ['BestMatch', 'PublicationDate', 'ApplicationDate'];
const oneOf = (values) => (v) => values.includes(v);
const PARAMS = {
  regions: oneOf([
    'Nordjylland',
    'Midtjylland',
    'Syddanmark',
    'HovedstadenOgBornholm',
    'OevrigeSjaelland',
  ]),
  countries: (v) => /^[A-Z]{2}$/.test(v),
  postalCode: (v) => /^\d{4}$/.test(v),
  kmRadius: (v) => /^[1-9]\d{0,2}$/.test(v),
  workplaceFilter: oneOf(['NonFixed']),
  workHoursType: oneOf(['FullTime', 'PartTime']),
  workHourMin: (v) => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 36,
  workHourMax: (v) => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 36,
  employmentDurationType: oneOf(['Permanent', 'Temporary']),
  jobAnnouncementType: oneOf([
    'Ordinaert',
    'Efterloenner',
    'Foertidspension',
    'Fleksjob',
    'Handicapingenhindring',
    'Hotjob',
  ]),
  occupationAreas: (v) => /^\d{1,9}$/.test(v),
  occupationGroups: (v) => /^\d{1,9}$/.test(v),
  occupations: (v) => ID.test(v),
  aliasIdentifiers: (v) => ID.test(v),
};
const LISTS = new Set([
  'regions',
  'countries',
  'occupationAreas',
  'occupationGroups',
  'occupations',
  'aliasIdentifiers',
]);
// The find-job page searches a postal code within 50 km unless told otherwise;
// the API ignores a postal code without a radius.
const DEFAULT_KM = '50';

export const isJobnetUrl = (value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      ['jobnet.dk', 'www.jobnet.dk'].includes(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
};

// A Jobnet search address (the find-job page, the API search or the site root
// with the collector's q=) as the API address of one page. The site's own
// filters pass through after validation; anything else is dropped, as the API
// would drop it.
export function jobnetApiUrl(value) {
  if (!isJobnetUrl(value)) throw Error('Jobnet needs a valid HTTPS address.');
  const input = new URL(value),
    params = input.searchParams;
  if (!SEARCH_PATHS.includes(input.pathname.replace(/\/$/, '')))
    throw Error('This Jobnet address is not a job search; use /find-job?searchString=… instead.');
  const order = params.get('orderType') || 'PublicationDate',
    size = params.get('resultsPerPage') || String(PAGE_SIZE),
    page = params.get('pageNumber') || '1';
  if (!ORDERS.includes(order)) throw Error(`Unknown Jobnet sort order: ${order}.`);
  if (!/^[1-9]\d{0,2}$/.test(size) || Number(size) > 100)
    throw Error('Invalid Jobnet page size; 1–100 results per page are allowed.');
  if (!/^[1-9]\d{0,4}$/.test(page) || (Number(page) - 1) * Number(size) >= MAX_ROWS)
    throw Error('Invalid Jobnet page number; the site lists at most 10000 results.');
  const url = new URL(API_PATH, ORIGIN),
    query = (params.get('searchString') || params.get('q') || '').trim();
  if (query) url.searchParams.set('searchString', query);
  for (const [param, valid] of Object.entries(PARAMS)) {
    let values = [
      ...new Set(
        params
          .getAll(param)
          .map((v) => (param === 'countries' ? v.trim().toUpperCase() : v.trim()))
          .filter(Boolean),
      ),
    ];
    if (param === 'kmRadius')
      values = !url.searchParams.has('postalCode') ? [] : values.length ? values : [DEFAULT_KM];
    if (values.length > 1 && !LISTS.has(param))
      throw Error(`The Jobnet filter ${param} takes one value.`);
    for (const v of values) {
      if (!valid(v)) throw Error(`Invalid value for the Jobnet filter ${param}: ${v}.`);
      url.searchParams.append(param, v);
    }
  }
  url.searchParams.set('orderType', order);
  url.searchParams.set('resultsPerPage', size);
  url.searchParams.set('pageNumber', page);
  return url.href;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const day = (value) => text(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
// The search echoes its text with spaces around quotes and runs collapsed.
const words = (value) => text(value).replace(/"/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const webUrl = (value) => {
  try {
    const url = new URL(text(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};
// As the result card shows it: the postal code and district, else the country.
const place = (job) =>
  Number.isInteger(job.postalCode) || /^\d{4}$/.test(text(job.postalCode))
    ? [String(job.postalCode), text(job.postalDistrictName)].filter(Boolean).join(' ')
    : text(job.country);
// The card shows a date only for ExpirationDate; 1900-01-01 stands for none.
const deadline = (job) =>
  job.applicationDeadlineStatus === 'AsSoonAsPossible'
    ? 'As soon as possible'
    : job.applicationDeadlineStatus === 'ExpirationDate' &&
        !text(job.applicationDeadline).startsWith('1900-')
      ? day(job.applicationDeadline)
      : '';
function jobRecord(job) {
  const id = text(job?.jobAdId).toLowerCase();
  if (!ID.test(id) || !text(job.title) || !text(job.description))
    throw Error('A Jobnet listing id, title or description is missing; the page is incomplete.');
  const description = htmlText(job.description);
  if (!description) throw Error('A Jobnet listing description could not be read.');
  // Jobnet has a page only for its own postings; find-job/<id> of an external
  // one is a 404. Like Jobnet's result card, an external posting is its own
  // address (the employer's or another board's).
  const external = job.isExternal === true ? webUrl(job.jobAdUrl) : '';
  return {
    url: external || `${ORIGIN}/find-job/${id}`,
    id,
    title: text(job.title).slice(0, 300),
    company: text(job.hiringOrgName),
    location: place(job),
    occupation: text(job.occupation),
    employmentType:
      typeof job.workHourPartTime === 'boolean'
        ? job.workHourPartTime
          ? 'Part time'
          : 'Full time'
        : '',
    postedAt: day(job.publicationDate) || null,
    deadline: deadline(job),
    // External postings link to the employer or another board; Jobnet's own
    // have no link here.
    applyUrl: external,
    description,
  };
}

export function parseJobnetPage(value, data) {
  const url = jobnetApiUrl(value),
    params = new URL(url).searchParams,
    page = Number(params.get('pageNumber')),
    size = Number(params.get('resultsPerPage'));
  if (
    !Array.isArray(data?.jobAds) ||
    !Number.isSafeInteger(data.totalJobAdCount) ||
    data.totalJobAdCount < 0 ||
    data.jobAds.length > size
  )
    throw Error('Jobnet API response is malformed; an empty result was not assumed.');
  if (
    typeof data.searchString === 'string' &&
    words(data.searchString) !== words(params.get('searchString'))
  )
    throw Error('Jobnet answered a different search than the one requested.');
  const rows = Math.min(data.totalJobAdCount, MAX_ROWS),
    nextUrl = page * size < rows ? new URL(url) : null;
  nextUrl?.searchParams.set('pageNumber', String(page + 1));
  const jobs = data.jobAds.map(jobRecord);
  if (!jobs.length && (page - 1) * size < rows)
    throw Error('Jobnet results are incomplete; an empty page inside the stated total.');
  return {
    url,
    jobs,
    page,
    totalPages: Math.max(1, Math.ceil(rows / size)),
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
    throw Object.assign(Error(`Jobnet API HTTP ${response.status}; ${what}.`), {
      status: response.status,
    });
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw Error('Jobnet returned something other than JSON.');
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw Error('Jobnet API response exceeds the size limit.');
  return JSON.parse(body);
}

// One search page. A failed request is reported as it is; the collector worker
// keeps its checkpoint and controls retries.
export async function readJobnetPage(
  value,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const url = jobnetApiUrl(value);
  return parseJobnetPage(
    url,
    await readJson(url, {fetch, signal, timeoutMs}, 'the scan did not finish'),
  );
}

// One of Jobnet's own listings by its address, for listings that moved off the
// page they were queued from. The detail endpoint (JobAdDetails) answers 404
// for removed postings, while a search for the listing id returns the same
// record as a results page, with its full description. So the read is that
// search, matched on the exact id; without a match the listing is reported
// unavailable and stays pending, not removed. An external posting's address
// does not name its Jobnet id, so it is reported unavailable the same way.
export async function readJobnetDetail(
  url,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const id = isJobnetUrl(url) ? new URL(url).pathname.match(LISTING_PATH)?.[1] : null;
  if (!id || !ID.test(id))
    throw Error(
      isJobnetUrl(url)
        ? 'A single Jobnet listing address is needed.'
        : 'Jobnet re-reads only its own postings; this external posting stays pending.',
    );
  const search = new URL(API_PATH, ORIGIN);
  search.search = new URLSearchParams({
    searchString: id,
    orderType: 'BestMatch',
    resultsPerPage: String(PAGE_SIZE),
    pageNumber: '1',
  }).toString();
  const data = await readJson(search.href, {fetch, signal, timeoutMs}, 'the address stays pending');
  if (!Array.isArray(data?.jobAds))
    throw Error('Jobnet API response is malformed; the address stays pending.');
  const job = data.jobAds.find((j) => text(j?.jobAdId).toLowerCase() === id);
  if (!job) throw Error('Jobnet no longer lists this posting; the address stays pending.');
  return {...jobRecord(job), url};
}

// Like the other extensions, this adapter only supplies observed listings.
// The common queue, Jev classifier and agent own every assessment and write.
export default {
  id: 'jobnet',
  matches: isJobnetUrl,
  collector: {
    templateId: 'job-search',
    searchUrl: jobnetApiUrl,
    acceptsQuery: () => true,
    readPage: readJobnetPage,
    readDetail: readJobnetDetail,
    detail: (job) => ({
      ...listingPage({
        browser: 'Jobnet API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {
          company: job.company,
          location: job.location,
          occupation: job.occupation,
          employmentType: job.employmentType,
          postedAt: job.postedAt,
          deadline: job.deadline,
          applyUrl: job.applyUrl,
        },
      }),
      cells: {company: job.company, location: job.location},
    }),
  },
  // The find-job address; the collector maps it to the API search. Dates
  // descended across pages 1–3 and a whole 1971-listing region (2026-10-16).
  search: {
    template: `${ORIGIN}/find-job?searchString={query}&orderType=PublicationDate`,
    ordering: 'newest_first',
    pagination: 'url_param',
    filters: [
      {
        param: 'regions',
        label: 'Region',
        values: {
          Nordjylland: 'North Jutland',
          Midtjylland: 'Central Jutland',
          Syddanmark: 'Southern Denmark',
          HovedstadenOgBornholm: 'Capital Region and Bornholm',
          OevrigeSjaelland: 'Rest of Zealand',
        },
      },
      {param: 'workplaceFilter', label: 'Workplace', values: {NonFixed: 'No fixed workplace'}},
      {
        param: 'workHoursType',
        label: 'Working hours',
        values: {FullTime: 'Full time', PartTime: 'Part time'},
      },
      {
        param: 'employmentDurationType',
        label: 'Employment',
        values: {Permanent: 'Permanent', Temporary: 'Temporary'},
      },
      {param: 'postalCode', label: 'Postal code (4 digits)'},
      {param: 'kmRadius', label: 'Radius around the postal code (km, default 50)'},
      {param: 'countries', label: 'Country (ISO code, upper case)'},
    ],
    notes:
      "Jobnet's public search API, read by the Jobnet extension: 20 listings per page with full descriptions, external postings included; pages via pageNumber=N, at most 10000 results per search. orderType=PublicationDate is newest first by publication day. searchString needs every word (senior udvikler is narrower than udvikler); a quoted phrase matches exactly. Danish and English terms find different listings (udvikler 472, developer 346 on 2026-10-16), so search both. Jobnet's own listings are https://jobnet.dk/find-job/<id>; an external posting (most of them) is listed at its own address on the employer's site or another board, as Jobnet's result card links it.",
  },
};
