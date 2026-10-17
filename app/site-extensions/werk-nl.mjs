// @ts-check
// Werk.nl site extension (HTTP reader; per-site extensions requested
// 2026-10-05). UWV's public vacancy search is an Angular page over a JSON API:
// POST .../api/search returns 20 vacancy cards per page with the total, and
// GET .../api/vacature/<ref> one vacancy with its text. Neither has HTML to
// read. Every API address first passes an Oracle Access Manager sign-on for
// anonymous visitors (three redirects that set session cookies; not a bot
// check), and the search needs Angular's XSRF-TOKEN cookie echoed in a header.
// The extension keeps no session: each read signs on with its own cookie jar.
// Cost per read: a results page 5 requests (3 redirects + the totals call that
// sets the token, then the search), a vacancy 4 (3 redirects + the vacancy).
// Both go through siteFetch, so the shared site access rules pace them.
// Observed 2026-10-16. Everything after the read stays generic.
import {siteFetch, isMissing, readerPage, pageEntries, READER_HEADERS} from './http.mjs';
import {listingPage} from './listing.mjs';

const BROWSER = 'Werk.nl reader';
const ORIGIN = 'https://www.werk.nl';
const API = `${ORIGIN}/werkzoekenden/mijn-werkmap/kia/publiek/zoekenvacatures/api`;
const SEARCH_PATH = new URL(`${API}/search`).pathname;
const DETAIL_PATH = /^\/nl\/vacatures\/([1-9]\d{0,11})\/?$/;
export const WERK_NL_PAGE_SIZE = 20;
const MAX_HOPS = 6;
const MAX_BYTES = 8 * 1024 * 1024;
const HEADERS = {
  'User-Agent': READER_HEADERS['User-Agent'],
  Accept: 'application/json',
  'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
};
// Facet property codes of the site's search (its filter enum, 2026-10-16).
const FACETS = [
  'JOB_CATEGORY',
  'JOB_EDUCATION',
  'JOB_UWV_ARBEIDSTIJD',
  'JOB_SHIFT_TYPE',
  'JOB_UWV_RIJBEWIJS',
  'JOB_UWV_TAAL',
  'JOB_CONTRACT_TYPE',
  'JOB_INDUSTRY_SECTOR',
  'JOB_UWV_PLAATSNAAM',
  'JOB_UWV_TYPEWERKLOCATIE',
  'JOB_LOCATION_COUNTRY',
];
// The distance choices the site offers, in km.
const DISTANCES = ['5', '10', '25', '50', '75', '100', '125', '150', '300'];

const werkHost = (host) => host === 'werk.nl' || host.endsWith('.werk.nl');
export const isWerkNlUrl = (value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      ['www.werk.nl', 'werk.nl'].includes(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
};

// The search address (the API search with the request as parameters) or a
// vacancy's public page (/nl/vacatures/<ref>); everything else stays with the
// browser.
export function werkNlRequest(value) {
  if (!isWerkNlUrl(value)) return null;
  const url = new URL(value);
  if (url.pathname.replace(/\/$/, '') === SEARCH_PATH) return {kind: 'search', url: url.href};
  const ref = url.pathname.match(DETAIL_PATH)?.[1];
  return ref ? {kind: 'detail', ref, url: `${ORIGIN}/nl/vacatures/${ref}`} : null;
}

// The JSON body the site's own search page posts for this address. Unknown or
// invalid parameters are refused rather than dropped, so a scan never reads a
// broader search as if it matched.
export function werkNlSearchBody(value) {
  const params = new URL(value).searchParams,
    page = params.get('page') ?? '1',
    location = params.get('location')?.trim() ?? '',
    distance = params.get('distance') ?? '';
  for (const key of new Set(params.keys()))
    if (!['keywords', 'location', 'distance', 'page', 'sort', ...FACETS].includes(key))
      throw Error(`Werk.nl search does not know the parameter "${key}".`);
  if (!/^[1-9]\d{0,4}$/.test(page)) throw Error('Invalid werk.nl page number.');
  if ((params.get('sort') ?? 'newest') !== 'newest')
    throw Error('Werk.nl search is read newest first only (sort=newest).');
  if (distance && !DISTANCES.includes(distance))
    throw Error(`Werk.nl distance must be one of ${DISTANCES.join(', ')} km.`);
  // Without a distance the site sorts by the place but does not narrow to it.
  if (location && !distance)
    throw Error(
      'A werk.nl location needs a distance in km; without one results are not limited to it.',
    );
  return {
    facets: FACETS.flatMap((code) =>
      params
        .getAll(code)
        .filter(Boolean)
        .map((v) => ({propertyCode: code, value: v})),
    ),
    keywords: params.get('keywords')?.trim() ?? '',
    location,
    ...(location ? {distanceFilter: {distance: Number(distance), alternatingLocation: false}} : {}),
    currentPage: Number(page),
    // by 1 = newest, direction 1 = descending (the site's own newest sort).
    sort: {by: 1, direction: 1},
    includeFirstExpansion: false,
    includeSecondExpansion: false,
  };
}

// A minimal cookie jar for one read: the sign-on hands its session over
// redirects, and each hop needs the cookies the hops before it set.
function storeCookies(jar, url, headers) {
  for (const line of headers.getSetCookie?.() ?? []) {
    const [pair, ...attributes] = line.split(';'),
      eq = pair.indexOf('=');
    if (eq < 1) continue;
    const cookie = {
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      domain: url.hostname,
      hostOnly: true,
      path: '/',
      expired: false,
    };
    for (const attribute of attributes) {
      const [key, ...rest] = attribute.split('='),
        v = rest.join('=').trim();
      const name = key.trim().toLowerCase();
      if (name === 'domain' && v) {
        const domain = v.replace(/^\./, '').toLowerCase();
        if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) continue;
        Object.assign(cookie, {domain, hostOnly: false});
      } else if (name === 'path' && v.startsWith('/')) cookie.path = v;
      else if (name === 'max-age') cookie.expired ||= Number(v) <= 0;
      else if (name === 'expires') cookie.expired ||= Date.parse(v) <= Date.now();
    }
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    if (cookie.expired) jar.delete(key);
    else jar.set(key, cookie);
  }
}
const cookiesFor = (jar, url) =>
  [...jar.values()].filter(
    (c) =>
      (c.hostOnly
        ? url.hostname === c.domain
        : url.hostname === c.domain || url.hostname.endsWith(`.${c.domain}`)) &&
      (url.pathname === c.path ||
        url.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)),
  );
export const jarCookie = (jar, url, name) =>
  cookiesFor(jar, new URL(url)).find((c) => c.name === name)?.value ?? null;

// A fetch that follows the sign-on redirects itself (bounded hops, werk.nl
// hosts only) with the jar's cookies; siteFetch wraps the whole chain as one
// request. Plumbing, not a retry: each hop is a different address.
export function jarFetch(fetch, jar) {
  return async (target, init = {}) => {
    let url = new URL(target),
      verb = init.method ?? 'GET',
      payload = init.body;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const cookie = cookiesFor(jar, url)
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      const response = await fetch(url.href, {
        ...init,
        method: verb,
        body: payload,
        redirect: 'manual',
        headers: {...init.headers, ...(cookie ? {Cookie: cookie} : {})},
      });
      storeCookies(jar, url, response.headers);
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
      await response.body?.cancel();
      url = new URL(location, url);
      if (url.protocol !== 'https:' || !werkHost(url.hostname))
        throw Error(`Werk.nl redirected outside werk.nl (${url.hostname}); the read stopped.`);
      if (response.status === 303 || (verb === 'POST' && response.status <= 302)) {
        verb = 'GET';
        payload = undefined;
      }
    }
    throw Error(`The werk.nl sign-on did not finish within ${MAX_HOPS} redirects.`);
  };
}

async function readJson(response, url) {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw Object.assign(Error('Werk.nl returned something other than JSON.'), {url});
  }
  const text = await response.text();
  if (text.length > MAX_BYTES)
    throw Object.assign(Error('The werk.nl response exceeds the size limit.'), {url});
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(Error('The werk.nl response is not valid JSON.'), {url});
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const day = (value) => (/^\d{4}-\d{2}-\d{2}/.test(text(value)) ? text(value).slice(0, 10) : '');
export const werkNlListingUrl = (ref) => `${ORIGIN}/nl/vacatures/${ref}`;
const hoursText = (min, max) => {
  const lo = Number.isFinite(min) && min > 0 ? min : 0,
    hi = Number.isFinite(max) && max > 0 ? max : 0;
  if (lo && hi) return `${lo === hi ? lo : `${lo}–${hi}`} hours per week`;
  if (hi) return `up to ${hi} hours per week`;
  return lo ? `at least ${lo} hours per week` : '';
};

// {jobs, total, page} of a search response; a malformed one is an error.
export function parseWerkNlSearch(data, page) {
  if (
    !Array.isArray(data?.items) ||
    !Number.isSafeInteger(data.totalResults) ||
    data.totalResults < 0
  )
    throw Error('The werk.nl search response is malformed; an empty result was not assumed.');
  const jobs = data.items.map((item) => {
    if (
      !Number.isSafeInteger(item?.referenceNumber) ||
      item.referenceNumber <= 0 ||
      !text(item.vacatureTitle)
    )
      throw Error(
        'A werk.nl search result has no reference number or title; the page is incomplete.',
      );
    return {
      url: werkNlListingUrl(item.referenceNumber),
      title: text(item.vacatureTitle).slice(0, 300),
      company: text(item.organisation),
      location: text(item.workLocationForeignCity) || text(item.workLocationCity),
      contract: text(item.contractType),
      hours: hoursText(item.minHours, item.maxHours),
      updated: day(item.modified),
    };
  });
  return {jobs, total: data.totalResults, page};
}

// A results page: its vacancies as listing links and the next page while the
// stated total is not reached. Past the last page the search has ended; an
// empty page within the total is incomplete, not the end.
export function werkNlSearchPage(url, {jobs, total, page}) {
  const pages = Math.max(1, Math.ceil(total / WERK_NL_PAGE_SIZE));
  if (!jobs.length && page <= pages && total > 0)
    throw Object.assign(
      Error(
        `Werk.nl returned no vacancies on page ${page} of ${pages}; the results are incomplete.`,
      ),
      {url},
    );
  const unique = [...new Map(jobs.map((job) => [job.url, job])).values()];
  const lines = [`Werk.nl vacancies, page ${page} of ${pages} (${total} results)`];
  for (const job of unique) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = [
      job.company,
      job.location,
      job.contract,
      job.hours,
      job.updated && `updated ${job.updated}`,
    ].filter(Boolean);
    if (facts.length) lines.push(facts.join(' · '));
  }
  if (!unique.length)
    lines.push('This results page lists no vacancies: the search has no further results.');
  const next = new URL(url);
  next.searchParams.set('page', String(page + 1));
  return readerPage({
    browser: BROWSER,
    url,
    title: 'Werk.nl vacancies',
    text: lines.join('\n'),
    links: unique.map((job) => ({text: job.title, url: job.url, listing: true})),
    pagination: pageEntries(url, page, pages, page < pages ? next.href : null),
  });
}

// Labels of the site's code lists (its Angular enums, 2026-10-16).
const CONTRACT = {1: 'Permanent', 2: 'Permanent or temporary', 3: 'Temporary'};
const WORKING_TIME = {1: 'Office hours', 2: 'Other than office hours'};
const PAY_TYPE = {
  2: 'Self-employed',
  3: 'Commission-based',
  4: 'According to the collective labour agreement (CAO)',
};
const APPLY_BY = {1: 'by post', 2: 'by phone', 3: 'by email', 4: 'online'};
const locationText = (place) => {
  const city = text(place?.city);
  if (place?.type === 2) return city ? `${city} (region)` : '';
  if (place?.type === 3) return 'Varying locations across the Netherlands';
  if (place?.type === 4) return [city, text(place.countryCode)].filter(Boolean).join(', ');
  return city;
};
const salaryText = (salary) => {
  const amount = Number(text(salary?.amountIndication));
  if (Number.isFinite(amount) && amount > 0)
    return `€${amount.toLocaleString('en-GB', {maximumFractionDigits: 2})} gross per month (indication)`;
  return PAY_TYPE[salary?.type] ?? '';
};
const webUrl = (value) => {
  try {
    const url = new URL(text(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};

// One vacancy: the site's description sections in its own order (the
// description, its continuation, the terms of employment) and the facts it states.
export function werkNlDetailPage(url, data, ref, now = Date.now()) {
  if (data === null)
    return readerPage({
      browser: BROWSER,
      url,
      title: 'Werk.nl vacancy',
      text: 'This werk.nl vacancy was not found; it has been removed or is no longer available.',
    });
  if (String(data?.referenceNumber) !== String(ref) || !text(data.title))
    throw Object.assign(
      Error('The werk.nl vacancy response is malformed or for another vacancy.'),
      {url},
    );
  const p = data.proposition ?? {},
    description = [p.function?.description, data.description, p.termsOfEmploymentDescription]
      .map(text)
      .filter(Boolean)
      .join('\n\n'),
    deadline = day(data.expirationDate),
    posted = day(data.createdDate),
    updated = day(data.modifiedDate),
    methods = Array.isArray(data.applicationMethods) ? data.applicationMethods : [];
  const notes = [];
  if (/(?:\.\.\.|…)$/.test(text(p.function?.description)))
    notes.push(
      'Werk.nl shows this description shortened; the full posting is at the apply address.',
    );
  if (deadline && Date.parse(`${deadline}T23:59:59Z`) < now)
    notes.push(`The application deadline (${deadline}) has passed.`);
  return listingPage({
    browser: BROWSER,
    url,
    title: text(data.title),
    description,
    fields: {
      company: text(data.employer?.organizationName),
      location: locationText(p.workLocation),
      employmentType: CONTRACT[p.contract?.type] ?? '',
      hours: hoursText(p.workhours?.minimumHours, p.workhours?.maximumHours),
      workingTime: WORKING_TIME[p.workhours?.werktijden] ?? '',
      salary: salaryText(p.salary),
      education: text(data.cvOffer?.educationLevel?.name),
      deadline,
      postedAt: posted,
      updatedAt: updated !== posted ? updated : '',
      applyUrl: webUrl(methods.find((m) => m?.sollicitatieWijze === 4)?.urlApplicationForm),
      applyBy: [...new Set(methods.map((m) => APPLY_BY[m?.sollicitatieWijze]).filter(Boolean))],
    },
    notes,
  });
}

async function readSearch(url, options) {
  const body = werkNlSearchBody(url),
    jar = new Map(),
    fetch = options.fetch ?? globalThis.fetch;
  // The site's own first API call; its answer sets the XSRF-TOKEN cookie.
  const handshake = await siteFetch(`${API}/search/totals`, {
    ...options,
    fetch: jarFetch(fetch, jar),
    site: 'Werk.nl',
    url,
    headers: HEADERS,
  });
  await handshake.body?.cancel();
  const token = jarCookie(jar, `${API}/search`, 'XSRF-TOKEN');
  if (!token)
    throw Object.assign(Error('The werk.nl sign-on gave no XSRF token; the search was not sent.'), {
      url,
    });
  let refused = '';
  const post = jarFetch(fetch, jar);
  const response = await siteFetch(`${API}/search`, {
    ...options,
    method: 'POST',
    body: JSON.stringify(body),
    fetch: async (target, init) => {
      const answer = await post(target, init);
      if (answer.status === 400) refused = (await answer.clone().text()).slice(0, 300);
      return answer;
    },
    site: 'Werk.nl',
    url,
    headers: {...HEADERS, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': token},
  }).catch((error) => {
    // The site says why (an unknown location, for instance).
    throw refused ? Object.assign(Error(`Werk.nl refused this search: ${refused}`), {url}) : error;
  });
  if (isMissing(response))
    throw Object.assign(Error(`Werk.nl search answered HTTP ${response.status}.`), {url});
  return werkNlSearchPage(url, parseWerkNlSearch(await readJson(response, url), body.currentPage));
}

async function readDetail(request, url, options) {
  const response = await siteFetch(`${API}/vacature/${request.ref}`, {
    ...options,
    fetch: jarFetch(options.fetch ?? globalThis.fetch, new Map()),
    site: 'Werk.nl',
    url,
    headers: HEADERS,
  });
  if (isMissing(response)) {
    await response.body?.cancel();
    return werkNlDetailPage(url, null, request.ref);
  }
  return werkNlDetailPage(url, await readJson(response, url), request.ref);
}

export async function readWerkNl(url, options = {}) {
  const request = werkNlRequest(url);
  if (!request) throw Error('Werk.nl reader does not handle this address');
  return request.kind === 'search' ? readSearch(url, options) : readDetail(request, url, options);
}

export default {
  id: 'werk-nl',
  matches: isWerkNlUrl,
  http: {handles: (url) => Boolean(werkNlRequest(url)), read: readWerkNl},
  // The site's search API, with the request as address parameters (the
  // Angular page keeps its search out of the address). Observed 2026-10-16.
  search: {
    template: `${API}/search?keywords={query}&location={location}&distance=25&sort=newest`,
    ordering: 'newest_first',
    pagination: 'url_param',
    filters: [
      {
        param: 'distance',
        label: 'Distance from the location (km)',
        values: Object.fromEntries(DISTANCES.map((d) => [d, `${d} km`])),
      },
      {
        param: 'JOB_CONTRACT_TYPE',
        label: 'Contract',
        values: {1: 'Permanent', 2: 'Permanent or temporary', 3: 'Temporary'},
      },
      {
        param: 'JOB_EDUCATION',
        label: 'Education level',
        values: {4: 'MBO', 5: 'HBO/bachelor', 6: 'WO/master', 7: 'Not stated'},
      },
      {param: 'JOB_CATEGORY', label: 'Occupation (as the site names it, e.g. Software engineer)'},
      {param: 'JOB_UWV_PLAATSNAAM', label: 'Town (exact, as the site writes it, e.g. UTRECHT)'},
      {param: 'JOB_UWV_ARBEIDSTIJD', label: 'Hours per week (site code 1–6)'},
    ],
    notes:
      "Werk.nl (UWV) is the Dutch public employment service. 20 vacancies per page via &page=N; the response states the total, so the last page is known. sort=newest is the site's newest-first sort (by last change, checked across 34 pages on 2026-10-16). keywords is free text; location is a Dutch place or postcode the site knows (an unknown place is refused) and needs distance, otherwise leave both empty for the whole country. Facet parameters repeat (JOB_CONTRACT_TYPE=1&JOB_CONTRACT_TYPE=3 is either). The site sometimes answers the same search with a wider result set (672 or 1740 results for 'developer' on 2026-10-16), so totals can change between pages. Vacancies are https://www.werk.nl/nl/vacatures/<reference>; descriptions from some feeds end shortened with '...', and applyUrl is the employer's own page.",
  },
};
