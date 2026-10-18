// @ts-check
// Gupy site extension (API collector; per-site extensions requested
// 2026-10-05). portal.gupy.io is Brazil's job portal for the companies that
// recruit through Gupy. Its public search API returns each posting with its
// full description (plain text), the career page name, city, state, work mode
// and contract type; sortBy=publishedDate&sortOrder=desc is strictly newest
// first across pages. Observed 2026-10-16 without login or challenge;
// robots.txt allows everything. The API ignores unknown and repeated
// parameters and answers an unknown filter value with zero results, so the
// reader passes only the known filters and values.
import {decode, htmlText, listingPage} from './listing.mjs';
import {READER_HEADERS} from './http.mjs';

const ORIGIN = 'https://portal.gupy.io';
const API_PATH = '/api/job-search/jobs';
// Above 10 listings per page pagination.total stops at 100 (observed
// 2026-10-16); at 10 it is the real count.
const PAGE_SIZE = 10;
// The API refuses offset + limit above 10000.
const MAX_ROWS = 10000;
const MAX_BYTES = 16 * 1024 * 1024;
const LISTING_PATH = /^\/jobs\/(\d{1,12})\/?$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Old postings of closed company accounts still appear in results, with a host
// like q2bank&66802&inactive.gupy.io that does not resolve; their listing
// pages answer 404 under the plain subdomain too (observed 2026-10-16).
const INACTIVE_ACCOUNT = /^https:\/\/[a-z0-9-]+&\d+&inactive\.gupy\.io\//;
const WORK_MODES = {remote: 'remote', hybrid: 'hybrid', 'on-site': 'on-site'};
// The contract types the portal names (its own labels, 2026-10-16); only the
// ones with a clear employment type map to one.
const TYPES = {
  vacancy_type_effective: 'permanent employee (CLT)',
  vacancy_type_internship: 'internship',
  vacancy_type_apprentice: 'apprenticeship',
  vacancy_type_trainee: 'trainee',
  vacancy_type_temporary: 'temporary',
  vacancy_type_intermittent: 'intermittent (CLT)',
  vacancy_legal_entity: 'contractor (legal entity, PJ)',
  vacancy_type_freelancer: 'freelance',
  vacancy_type_autonomous: 'self-employed',
  vacancy_type_outsource: 'outsourced (third party)',
  vacancy_type_summer: 'summer job',
  vacancy_type_volunteer: 'volunteer',
  vacancy_type_talent_pool: null,
  vacancy_type_associate: null,
  vacancy_type_parter: null,
  vacancy_type_lecturer: null,
};
// API filters, and the names the portal's own results address uses for them.
const FILTERS = ['workplaceType', 'type', 'state', 'city', 'careerPageName', 'isPWD', 'badge'];
const PAGE_FILTERS = {
  term: 'jobName',
  'workplaceTypes[]': 'workplaceType',
  workplaceTypes: 'workplaceType',
  'jobTypes[]': 'type',
  jobTypes: 'type',
  state: 'state',
  city: 'city',
  careerPageName: 'careerPageName',
  pwd: 'isPWD',
  gupyBadge: 'badge',
};
// Filters that take a comma list (either value); the API drops a repeated one.
const LISTS = ['workplaceType', 'type', 'city'];

const parsed = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
};
// A company's listing host: <subdomain>.gupy.io/jobs/<id>.
const listingHost = (u) => {
  const sub = u.hostname.endsWith('.gupy.io') ? u.hostname.slice(0, -8) : '';
  return SUBDOMAIN.test(sub) && !['www', 'portal'].includes(sub) ? sub : null;
};
export const isGupyListingUrl = (value) => {
  const u = parsed(value);
  return Boolean(u && listingHost(u) && LISTING_PATH.test(u.pathname));
};
export const isGupyUrl = (value) => {
  const u = parsed(value);
  return Boolean(u && (u.hostname === 'portal.gupy.io' || isGupyListingUrl(u.href)));
};

// The portal's results address keeps its search in one path segment
// (/job-search/term=java&workplaceTypes[]=remote).
function pagePairs(segment) {
  return segment
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('='),
        part = (s) => decodeURIComponent(s.replace(/\+/g, ' '));
      return at < 0 ? [part(pair), ''] : [part(pair.slice(0, at)), part(pair.slice(at + 1))];
    });
}

function filterValue(key, values) {
  const list = values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  if (!list.length) return null;
  if (list.length > 1 && !LISTS.includes(key))
    throw Error(`Gupy reads one ${key} value per search.`);
  if (key === 'workplaceType' && list.some((v) => !WORK_MODES[v]))
    throw Error('Gupy work mode must be remote, hybrid or on-site.');
  if (key === 'type' && list.some((v) => !(v in TYPES)))
    throw Error(`Unknown Gupy contract type: ${list.find((v) => !(v in TYPES))}`);
  if (key === 'isPWD') {
    if (!['true', 'false'].includes(list[0])) throw Error('Invalid Gupy disability filter.');
    return list[0] === 'true' ? 'true' : null;
  }
  if (key === 'badge') {
    if (!['true', 'friendlyBadge'].includes(list[0])) throw Error('Invalid Gupy badge filter.');
    return 'friendlyBadge';
  }
  return list.join(',');
}

// A results address (the portal's /job-search/term=… page, the portal root
// with ?q= or the API search) as the API address of one page, newest first.
export function gupyApiUrl(value) {
  const input = parsed(value);
  if (input?.hostname !== 'portal.gupy.io') throw Error('Gupy needs a valid HTTPS portal address.');
  const path = input.pathname.replace(/\/$/, ''),
    pairs = [...input.searchParams];
  if (path.startsWith('/job-search/')) {
    const segment = path.slice('/job-search/'.length);
    if (segment.includes('/')) throw Error('This Gupy address is not a job search.');
    for (const [key, v] of pagePairs(segment)) {
      if (key === 'page') continue;
      if (!PAGE_FILTERS[key]) throw Error(`Unsupported Gupy search filter: ${key}`);
      pairs.push([PAGE_FILTERS[key], v]);
    }
  } else if (!['', '/job-search', API_PATH].includes(path))
    throw Error('This Gupy address is not a job search; use /job-search/term=… or the API.');
  const offset = input.searchParams.get('offset') ?? '0';
  if (!/^\d{1,5}$/.test(offset) || Number(offset) % PAGE_SIZE || Number(offset) >= MAX_ROWS)
    throw Error('Invalid Gupy page position.');
  const sortBy = input.searchParams.get('sortBy'),
    sortOrder = input.searchParams.get('sortOrder');
  if ((sortBy && sortBy !== 'publishedDate') || (sortOrder && sortOrder !== 'desc'))
    throw Error('Gupy searches are read newest first (sortBy=publishedDate&sortOrder=desc).');
  const terms = [],
    filters = new Map();
  for (const [raw, v] of pairs) {
    const key = PAGE_FILTERS[raw] ?? raw;
    if (key === 'q' || key === 'jobName') terms.push(v.trim());
    else if (FILTERS.includes(key)) filters.set(key, [...(filters.get(key) ?? []), v]);
    else if (!/^(?:utm_.*|page|offset|limit|sortBy|sortOrder)$/.test(key))
      throw Error(`Unsupported Gupy filter: ${key}`);
  }
  const term = [...new Set(terms.filter(Boolean))];
  if (term.length > 1) throw Error('Gupy reads one search term per search.');
  const url = new URL(API_PATH, ORIGIN);
  if (term[0]) url.searchParams.set('jobName', term[0]);
  for (const key of FILTERS) {
    const v = filters.has(key) ? filterValue(key, filters.get(key)) : null;
    if (v) url.searchParams.set(key, v);
  }
  url.searchParams.set('sortBy', 'publishedDate');
  url.searchParams.set('sortOrder', 'desc');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('offset', String(Number(offset)));
  return url.href;
}

const text = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
// The API gives the description as text with HTML entities; tags only if any.
const plainText = (value) =>
  /<\/?[a-z][a-z0-9]*\b[^>]*>/i.test(value)
    ? htmlText(value)
    : decode(value)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
const date = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function jobRecord(job) {
  const id = Number.isSafeInteger(job?.id) ? job.id : null,
    link = parsed(job?.jobUrl),
    sub = link && listingHost(link);
  if (!id || !sub || !text(job.name) || typeof job.description !== 'string')
    throw Error('Gupy listing id, address, title or description missing; the page is incomplete.');
  return {
    url: `https://${sub}.gupy.io/jobs/${id}`,
    id,
    title: text(job.name).slice(0, 300),
    company: text(job.careerPageName),
    location: [text(job.city), text(job.state)].filter(Boolean).join(', '),
    workMode: WORK_MODES[job.workplaceType] ?? '',
    type: text(job.type),
    description: plainText(job.description),
    postedAt: date(job.publishedDate),
    deadline: date(job.applicationDeadline),
    disabilities: job.disabilities === true,
    closed: false,
  };
}

export function parseGupyPage(value, data) {
  const url = gupyApiUrl(value),
    offset = Number(new URL(url).searchParams.get('offset')),
    p = data?.pagination;
  if (
    !Array.isArray(data?.data) ||
    data.data.length > PAGE_SIZE ||
    p?.offset !== offset ||
    p.limit !== PAGE_SIZE ||
    !Number.isSafeInteger(p.total) ||
    p.total < 0
  )
    throw Error('Gupy API response is malformed; an empty result was not assumed.');
  const skipped = data.data
      .filter((job) => INACTIVE_ACCOUNT.test(job?.jobUrl ?? ''))
      .map((job) => ({id: job.id, title: text(job.name), reason: 'inactive company account'})),
    jobs = data.data.filter((job) => !INACTIVE_ACCOUNT.test(job?.jobUrl ?? '')).map(jobRecord);
  // The total moves while the index updates, so only a full page means more.
  if (!data.data.length && p.total > offset)
    throw Error('Gupy results are incomplete; an empty page while the total says more remain.');
  const next = offset + PAGE_SIZE,
    nextUrl = data.data.length === PAGE_SIZE && next < MAX_ROWS ? new URL(url) : null;
  nextUrl?.searchParams.set('offset', String(next));
  return {
    url,
    jobs,
    page: offset / PAGE_SIZE + 1,
    totalPages: Math.max(1, Math.ceil(Math.min(p.total, MAX_ROWS) / PAGE_SIZE)),
    nextUrl: nextUrl?.href ?? null,
    complete: !nextUrl,
    // Postings without a reachable listing page, left out of the page.
    skipped,
  };
}

const requestSignal = (signal, timeoutMs) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
async function readBody(url, {fetch, signal, timeoutMs, json}, what) {
  const response = await fetch(url, {
    headers: json
      ? {Accept: 'application/json', 'User-Agent': READER_HEADERS['User-Agent']}
      : READER_HEADERS,
    redirect: json ? 'error' : 'manual',
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const moved = response.status >= 300 && response.status < 400,
      gone = [404, 410].includes(response.status);
    throw Object.assign(
      Error(
        moved
          ? `Gupy listing page redirects (HTTP ${response.status}); the listing is not public or has closed, and ${what}.`
          : gone
            ? `Gupy listing is no longer published (HTTP ${response.status}); ${what}.`
            : `Gupy HTTP ${response.status}; ${what}.`,
      ),
      {status: response.status},
    );
  }
  if (json && !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw Error('Gupy returned something other than JSON.');
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw Error('Gupy response exceeds the size limit.');
  return json ? JSON.parse(body) : body;
}

// One search page. A failed request is reported as it is; the collector worker
// keeps its checkpoint and controls retries.
export async function readGupyPage(
  value,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const url = gupyApiUrl(value);
  return parseGupyPage(
    url,
    await readBody(url, {fetch, signal, timeoutMs, json: true}, 'the scan did not finish'),
  );
}

// The listing page's own Next.js data. Its JobPosting block is present only
// for some postings and is HTML-escaped inside the script tag.
export function gupyListingJob(html, url) {
  const u = parsed(url),
    sub = u && listingHost(u),
    id = u?.pathname.match(LISTING_PATH)?.[1];
  const raw = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  let job;
  try {
    job = raw ? JSON.parse(raw)?.props?.pageProps?.job : null;
  } catch {
    job = null;
  }
  if (!job || String(job.id) !== id || !text(job.name)) return null;
  const sections = [
    ['', job.description],
    ['Responsibilities', job.responsibilities],
    ['Requirements and qualifications', job.prerequisites],
    ['Additional information', job.relevantExperiences],
  ]
    .map(([heading, body]) => [heading, typeof body === 'string' ? htmlText(body) : ''])
    .filter(([, body]) => body)
    .map(([heading, body]) => (heading ? `${heading}\n${body}` : body));
  return {
    url: `https://${sub}.gupy.io/jobs/${id}`,
    id: Number(id),
    title: text(job.name).slice(0, 300),
    company: text(job.careerPage?.name),
    location: [...new Set([job.addressCity, job.addressState, job.addressCountry].map(text))]
      .filter(Boolean)
      .join(', '),
    workMode: WORK_MODES[job.workplaceType] ?? '',
    type: text(job.jobType),
    description: sections.join('\n\n'),
    postedAt: date(job.publishedAt),
    deadline: date(job.registerEndDate),
    disabilities: job.handicapped === true,
    closed: text(job.status) !== 'published',
  };
}

// One listing by its address, for listings that moved off the page they were
// queued from and for record scoring.
export async function readGupyDetail(
  url,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  if (!isGupyListingUrl(url)) throw Error('A single Gupy listing address is needed.');
  const u = new URL(url),
    page = `${u.origin}/jobs/${u.pathname.match(LISTING_PATH)?.[1]}`;
  const job = gupyListingJob(
    await readBody(page, {fetch, signal, timeoutMs, json: false}, 'the address stays pending'),
    page,
  );
  if (!job) throw Error('The Gupy listing page has no listing data; the address stays pending.');
  return {...job, url};
}

// Like the other extensions, this adapter only supplies observed listings.
// The common queue, Jev classifier and agent own every assessment and write.
export default {
  id: 'gupy',
  matches: isGupyUrl,
  collector: {
    templateId: 'job-search',
    searchUrl: gupyApiUrl,
    acceptsQuery: () => true,
    readPage: readGupyPage,
    readDetail: readGupyDetail,
    detail: (job) => ({
      ...listingPage({
        browser: 'Gupy API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {
          company: job.company,
          location: job.location,
          workMode: job.workMode,
          employmentType: TYPES[job.type] ?? null,
          postedAt: job.postedAt,
          deadline: job.deadline,
          disabilities: job.disabilities ? 'Also open to people with disabilities (PcD)' : null,
        },
        notes: [
          ...(job.type === 'vacancy_type_talent_pool'
            ? ['Talent pool posting (banco de talentos), not one specific opening.']
            : []),
          ...(job.closed ? ['The listing page no longer shows it as published.'] : []),
        ],
      }),
      cells: {company: job.company, location: job.location},
    }),
  },
  // The API search and its filters (observed 2026-10-16). Dates fall strictly
  // across pages under this sort.
  search: {
    template: `${ORIGIN}${API_PATH}?jobName={query}&sortBy=publishedDate&sortOrder=desc`,
    ordering: 'newest_first',
    pagination: 'url_param',
    filters: [
      {
        param: 'workplaceType',
        label: 'Work mode',
        values: {remote: 'Remote', hybrid: 'Hybrid', 'on-site': 'On-site'},
      },
      {
        param: 'type',
        label: 'Contract type',
        values: {
          vacancy_type_effective: 'Permanent (CLT)',
          vacancy_legal_entity: 'Contractor (PJ)',
          vacancy_type_internship: 'Internship',
          vacancy_type_apprentice: 'Apprentice',
          vacancy_type_trainee: 'Trainee',
          vacancy_type_temporary: 'Temporary',
          vacancy_type_freelancer: 'Freelance',
          vacancy_type_autonomous: 'Self-employed',
          vacancy_type_talent_pool: 'Talent pool',
        },
      },
      {param: 'state', label: 'State (full name with accents, e.g. São Paulo)'},
      {param: 'city', label: 'City (exact name with accents, e.g. Curitiba)'},
      {param: 'careerPageName', label: 'Career page name (exact)'},
      {
        param: 'isPWD',
        label: 'Disability',
        values: {true: 'Also open to people with disabilities'},
      },
    ],
    notes:
      'Public JSON API of portal.gupy.io (Brazil), 10 listings per page with full descriptions via offset=10,20,… (offset+limit at most 10000). jobName matches words of the title; use Portuguese titles (desenvolvedor, analista, engenheiro de software). sortBy=publishedDate&sortOrder=desc is newest first. state and city are exact, case-sensitive names; workplaceType, type and city take a comma list (remote,hybrid), a repeated parameter is refused because the API would drop it. Any other parameter is refused. Listings are https://<company>.gupy.io/jobs/<id>.',
  },
};
