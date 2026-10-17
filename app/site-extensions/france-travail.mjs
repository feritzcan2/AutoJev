// @ts-check
// France Travail site extension (API collector; per-site extensions requested
// 2026-10-05). The official "Offres d'emploi v2" API (francetravail.io) lists
// French job offers with their full descriptions. It needs the user's own
// application (client ID and secret, Site accounts); each page read asks for a
// token with the client-credentials grant, so nothing is kept between reads.
// The site's own search pages are not read: robots.txt disallows motsCles=.
// Observed 2026-10-16: the token and search endpoints answer (400 for a wrong
// client, 401 without a token); responses with a real account are not yet
// verified and follow the API documentation.
import {htmlText, listingPage} from './listing.mjs';

const TOKEN_URL =
  'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const API = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres';
const SITE = 'https://candidat.francetravail.fr/offres/recherche';
const SCOPE = 'api_offresdemploiv2 o2dsoffre';
const PAGE_SIZE = 50;
// The API serves offers up to the 1150th of a search (range end 1149).
const MAX_ROWS = 1150;
const MAX_BYTES = 16 * 1024 * 1024;
const HOSTS = ['candidat.francetravail.fr', 'www.francetravail.fr', 'api.francetravail.io'];
// Search parameters the API documents; the site's tri= is the API's sort.
const FILTERS = [
  'motsCles',
  'sort',
  'publieeDepuis',
  'departement',
  'commune',
  'distance',
  'region',
  'typeContrat',
  'natureContrat',
  'experience',
  'tempsPlein',
  'codeROME',
  'origineOffre',
];
const DETAIL_PATH = /^\/offres\/recherche\/detail\/([0-9A-Z]{4,12})\/?$/;

export const isFranceTravailUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && HOSTS.includes(u.hostname) && !u.port && !u.username;
  } catch {
    return false;
  }
};

// The site's search address, or the API search, as one API page. The page
// number (page=N) becomes the API range; filters the API documents pass on.
export function franceTravailApiUrl(value) {
  if (!isFranceTravailUrl(value)) throw Error('France Travail needs a valid HTTPS address.');
  const input = new URL(value),
    api = input.hostname === 'api.francetravail.io';
  if (
    api
      ? !input.pathname.startsWith('/partenaire/offresdemploi/v2/offres/search')
      : input.pathname.replace(/\/$/, '') !== '/offres/recherche'
  )
    throw Error('This France Travail address is not a job search.');
  const range = input.searchParams.get('range'),
    page = input.searchParams.get('page') ?? '1',
    start = range ? Number(range.split('-')[0]) : (Number(page) - 1) * PAGE_SIZE;
  if (
    !/^[1-9]\d{0,3}$/.test(page) ||
    !Number.isSafeInteger(start) ||
    start % PAGE_SIZE ||
    start >= MAX_ROWS
  )
    throw Error('Invalid France Travail page position.');
  const url = new URL(`${API}/search`);
  for (const key of FILTERS) {
    const v =
      input.searchParams.get(key === 'sort' && !api ? 'tri' : key) ?? input.searchParams.get(key);
    if (v) url.searchParams.set(key, v);
  }
  if (!url.searchParams.has('sort')) url.searchParams.set('sort', '1');
  url.searchParams.set('range', `${start}-${Math.min(start + PAGE_SIZE, MAX_ROWS) - 1}`);
  return url.href;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
export const franceTravailListingUrl = (id) => `${SITE}/detail/${id}`;
function jobRecord(offer) {
  const id = text(offer?.id);
  if (!/^[0-9A-Z]{4,12}$/.test(id) || !text(offer.intitule))
    throw Error('A France Travail offer id or title is missing; the page is not complete.');
  const description = htmlText(text(offer.description));
  const apply = text(offer.contact?.urlPostulation) || text(offer.origineOffre?.urlOrigine);
  return {
    url: franceTravailListingUrl(id),
    title: text(offer.intitule).slice(0, 300),
    company: text(offer.entreprise?.nom),
    location: text(offer.lieuTravail?.libelle),
    employmentType: text(offer.typeContratLibelle) || text(offer.typeContrat),
    hours: text(offer.dureeTravailLibelleConverti) || text(offer.dureeTravailLibelle),
    salary: text(offer.salaire?.libelle) || text(offer.salaire?.commentaire),
    experience: text(offer.experienceLibelle),
    applyUrl: /^https?:\/\//.test(apply) ? apply : '',
    description,
    postedAt: text(offer.dateCreation) || null,
  };
}

// "offres 0-49/1234": the API's total for the search.
const total = (range) => {
  const match = /\/(\d+)\s*$/.exec(range ?? '');
  return match ? Number(match[1]) : null;
};
export function parseFranceTravailPage(value, data, contentRange) {
  const url = franceTravailApiUrl(value),
    [start] = new URL(url).searchParams.get('range').split('-').map(Number);
  // 204 No Content: the search has no offers.
  if (data === null) {
    if (start)
      throw Error(
        'France Travail returned no offers for a later page; the search is not complete.',
      );
    return {url, jobs: [], page: 1, totalPages: 1, nextUrl: null, complete: true};
  }
  const count = total(contentRange);
  if (!Array.isArray(data?.resultats) || count === null)
    throw Error('France Travail API response is malformed; an empty result was not assumed.');
  const rows = Math.min(count, MAX_ROWS),
    next = start + PAGE_SIZE,
    nextUrl = next < rows ? new URL(url) : null;
  nextUrl?.searchParams.set('range', `${next}-${Math.min(next + PAGE_SIZE, MAX_ROWS) - 1}`);
  const jobs = data.resultats.map(jobRecord);
  if (!jobs.length && nextUrl)
    throw Error('France Travail results are incomplete; an empty page still has more pages.');
  return {
    url,
    jobs,
    page: start / PAGE_SIZE + 1,
    totalPages: Math.max(1, Math.ceil(rows / PAGE_SIZE)),
    nextUrl: nextUrl?.href ?? null,
    complete: !nextUrl,
  };
}

const requestSignal = (signal, timeoutMs) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
const missingAccount = () =>
  Error(
    'France Travail needs your API application: add its client ID and secret under Configuration → Site accounts.',
  );

// A token for this read. A refused account is reported as it is.
export async function franceTravailToken(
  credentials,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  if (!credentials?.clientId || !credentials?.clientSecret) throw missingAccount();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: SCOPE,
    }).toString(),
    redirect: 'error',
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(
      Error(
        [400, 401].includes(response.status)
          ? 'France Travail refused the saved API application; check the client ID, the secret and that the application is subscribed to "Offres d\'emploi v2".'
          : `France Travail token request HTTP ${response.status}; the scan is not complete.`,
      ),
      {status: response.status},
    );
  }
  const token = (await response.json())?.access_token;
  if (typeof token !== 'string' || !token) throw Error('France Travail returned no access token.');
  return token;
}

async function readApi(url, options, what) {
  const {fetch = globalThis.fetch, signal, timeoutMs = 20000, credentials} = options;
  const token = await franceTravailToken(credentials, {fetch, signal, timeoutMs});
  const response = await fetch(url, {
    headers: {Accept: 'application/json', Authorization: `Bearer ${token}`},
    redirect: 'error',
    signal: requestSignal(signal, timeoutMs),
  });
  if (response.status === 204) return {data: null, response};
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(Error(`France Travail API HTTP ${response.status}; ${what}.`), {
      status: response.status,
    });
  }
  if (!response.headers.get('content-type')?.includes('json')) {
    await response.body?.cancel();
    throw Error('France Travail returned something other than JSON.');
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw Error('France Travail API response exceeds the size limit.');
  return {data: JSON.parse(body), response};
}

// One search page. A failed request is reported as it is; the collector worker
// keeps its checkpoint and controls retries.
export async function readFranceTravailPage(value, options = {}) {
  const url = franceTravailApiUrl(value);
  const {data, response} = await readApi(url, options, 'the scan did not finish');
  return parseFranceTravailPage(url, data, response.headers.get('content-range'));
}

// One offer by its listing address, for offers that moved off their page.
export async function readFranceTravailDetail(url, options = {}) {
  const id = isFranceTravailUrl(url) ? new URL(url).pathname.match(DETAIL_PATH)?.[1] : null;
  if (!id) throw Error('A single France Travail offer address is needed.');
  const {data, response} = await readApi(`${API}/${id}`, options, 'the address stays pending');
  if (response.status === 204 || !data)
    throw Error('France Travail has no such offer any more; the address stays pending.');
  return {...jobRecord(data), url};
}

export default {
  id: 'france-travail',
  matches: isFranceTravailUrl,
  credentials: {
    label: 'France Travail',
    help: 'Create an application on francetravail.io, subscribe it to the "Offres d\'emploi v2" API and enter its client ID and secret. Access may need a request to France Travail.',
    signupUrl: 'https://francetravail.io/data/api/offres-emploi',
    fields: [
      {key: 'clientId', label: 'Client ID'},
      {key: 'clientSecret', label: 'Client secret'},
    ],
  },
  collector: {
    templateId: 'job-search',
    searchUrl: franceTravailApiUrl,
    acceptsQuery: () => false,
    readPage: readFranceTravailPage,
    readDetail: readFranceTravailDetail,
    detail: (job) => ({
      ...listingPage({
        browser: 'France Travail API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {
          company: job.company,
          location: job.location,
          employmentType: job.employmentType,
          hours: job.hours,
          salary: job.salary,
          experience: job.experience,
          postedAt: job.postedAt,
          applyUrl: job.applyUrl,
        },
      }),
      cells: {company: job.company, location: job.location},
    }),
  },
  // The site's search address; the reader turns it into the API search
  // (documentation of "Offres d'emploi v2", 2026-10).
  search: {
    template: `${SITE}?motsCles={query}&tri=1`,
    pagination: 'url_param',
    filters: [
      {
        param: 'publieeDepuis',
        label: 'Published within (days)',
        values: {1: '1 day', 3: '3 days', 7: '7 days', 14: '14 days', 31: '31 days'},
      },
      {param: 'departement', label: 'Département (code, e.g. 75)'},
      {param: 'region', label: 'Region (code, e.g. 11)'},
      {param: 'commune', label: 'Commune (INSEE code)'},
      {param: 'distance', label: 'Distance from the commune (km)'},
      {param: 'typeContrat', label: 'Contract type (CDI, CDD, MIS, …)'},
      {param: 'tempsPlein', label: 'Working time', values: {true: 'Full time', false: 'Part time'}},
      {
        param: 'experience',
        label: 'Experience',
        values: {1: 'Under 1 year', 2: '1 to 3 years', 3: 'Over 3 years'},
      },
      {param: 'origineOffre', label: 'Origin', values: {1: 'France Travail', 2: 'Partners'}},
    ],
    notes:
      "Official API with the user's own application (Site accounts). 50 offers per page with full descriptions through range=0-49, 50-99, …; a search serves at most 1150 offers, so narrow it with publieeDepuis or a département. tri=1 (API sort=1) orders by creation date, newest first. Listings are https://candidat.francetravail.fr/offres/recherche/detail/<id>.",
  },
};
