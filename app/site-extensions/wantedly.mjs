// @ts-check
// Wantedly site extension (HTTP reader; per-site extensions requested
// 2026-10-05). Wantedly is a Japanese job board on Next.js: a search page and
// each listing come server-rendered with their Apollo state in __NEXT_DATA__,
// so both are read over HTTP without a tab (observed 2026-10-16). Results come
// from the state's offset search (10 per page, total stated); a listing's own
// text is its role and working-style sections and its job conditions, which
// the state holds in full while its JobPosting carries only a teaser.
// Everything after the read stays generic.
import {htmlText, inlineText, listingPage} from './listing.mjs';
import {siteFetch, isMissing, readerPage, htmlPage, htmlTitle, pageEntries} from './http.mjs';

const BROWSER = 'Wantedly reader';
const ORIGIN = 'https://www.wantedly.com';
export const WANTEDLY_PAGE_SIZE = 10;
// The site serves at most 100 result pages whatever total it states: page 101
// of a 3989-result search was empty (2026-10-16).
export const WANTEDLY_MAX_PAGES = 100;
const SEARCH_KEY = 'searchedJobPostsUsingOffset(';
const LISTING_KEY = 'projectPage(';

export const isWantedlyUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?wantedly\.com$/.test(u.hostname);
  } catch {
    return false;
  }
};

// /projects is the search, /projects/<id> one listing; company pages, stories
// and the rest of the site are not read.
export function wantedlyRequest(value) {
  if (!isWantedlyUrl(value)) return null;
  const url = new URL(value);
  if (/^\/projects\/?$/.test(url.pathname)) {
    const page = url.searchParams.get('page') ?? '1';
    if (!/^[1-9]\d*$/.test(page)) return null;
    return {kind: 'search', number: Number(page), url: url.href};
  }
  const id = url.pathname.match(/^\/projects\/(\d+)\/?$/)?.[1];
  return id ? {kind: 'detail', id, url: `${ORIGIN}/projects/${id}`} : null;
}
export const wantedlyListingUrl = (id) => `${ORIGIN}/projects/${id}`;

// The Apollo cache of the page and a resolver for its {__ref} links; null
// when the page carries no parsable state.
export function wantedlyState(html) {
  const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!json) return null;
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const cache = data?.props?.pageProps?.__apollo?.graphqlGatewayInitialState;
  if (!cache?.ROOT_QUERY) return null;
  const resolve = (value) => (value?.__ref ? cache[value.__ref] : value) ?? null;
  return {cache, resolve};
}
const args = (key, prefix) => {
  try {
    return JSON.parse(key.slice(prefix.length, -1));
  } catch {
    return null;
  }
};
const unique = (values) => [...new Set(values.filter(Boolean))];
const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const job = (post, resolve) => ({
  id: String(post.id),
  url: wantedlyListingUrl(post.id),
  title: inlineText(String(post.title)),
  company: inlineText(String(resolve(post.company)?.name ?? '')),
  occupation: inlineText(String(post.occupationName ?? '')),
  hiringTypes: (post.hiringTypes ?? []).map((type) => type?.label).filter(Boolean),
  postedAt: typeof post.publishedAt === 'string' ? post.publishedAt.slice(0, 10) : '',
});

// {jobs, total, pageSize} from the offset search the state holds for this
// address, or null when the state is missing or answers another request: a
// different page, other search terms or another order (without an order the
// site drops every search parameter and lists all postings).
export function parseWantedlyState(html, url) {
  const state = wantedlyState(html);
  const index = state?.resolve(state.cache.ROOT_QUERY.projectIndexPageJobPostIndex);
  if (!index) return null;
  const address = new URL(url),
    number = Number(address.searchParams.get('page') ?? 1),
    keywords = unique(address.searchParams.getAll('keywords').map((k) => k.trim())),
    order = address.searchParams.get('order') ?? '';
  for (const key of Object.keys(index).filter((k) => k.startsWith(SEARCH_KEY))) {
    const input = args(key, SEARCH_KEY)?.input;
    const params = input?.searchParameters ?? null;
    if (input?.pageNumber !== number) continue;
    const executed = unique((params?.keywords ?? []).map((k) => k?.key));
    if (!sameList(executed, keywords) || (params?.order?.key ?? '') !== order) continue;
    const result = state.resolve(index[key]);
    if (!Array.isArray(result?.jobPosts)) return null;
    const total = result.totalCount;
    return {
      jobs: result.jobPosts
        .map((item) => state.resolve(item?.jobPost))
        .filter((post) => post?.id && post.title)
        .map((post) => job(post, state.resolve)),
      total: Number.isSafeInteger(total) && total >= 0 ? total : null,
      pageSize:
        Number.isSafeInteger(input.pageSize) && input.pageSize > 0
          ? input.pageSize
          : WANTEDLY_PAGE_SIZE,
    };
  }
  return null;
}

// The rendered result cards, for a page whose state is missing or stale. The
// page renders a second, infinite-scroll list for small screens that starts
// at page 1, so cards cannot tell which page this is.
export function parseWantedlyCards(html) {
  const parts = html.split(/<a\b(?=[^>]*data-testid="project-list-item-link")/).slice(1);
  const jobs = new Map();
  for (const part of parts) {
    const id = part.match(/^[^>]*href="\/projects\/(\d+)"/)?.[1];
    if (!id || jobs.has(id)) continue;
    const title = inlineText(
      part.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? part.match(/\balt="([^"]*)"/)?.[1] ?? '',
    );
    if (title)
      jobs.set(id, {
        id,
        url: wantedlyListingUrl(id),
        title,
        company: '',
        occupation: '',
        hiringTypes: [],
        postedAt: '',
      });
  }
  return [...jobs.values()];
}

const searchLines = (jobs) =>
  jobs.flatMap((job) => {
    const facts = [
      job.company,
      job.occupation,
      job.hiringTypes.join(', '),
      job.postedAt && `posted ${job.postedAt}`,
    ].filter(Boolean);
    return [`Link: ${job.title} — ${job.url}`, ...(facts.length ? [facts.join(' · ')] : [])];
  });
const listingLinks = (jobs) => jobs.map((job) => ({text: job.title, url: job.url, listing: true}));

// A results page: the state's list with its position and next page, the
// rendered cards without pagination when the state does not answer this
// address, and an error when the page shows neither (a block or error page,
// a changed layout), so a failed read never looks like an empty search.
export function wantedlySearchPage(url, number, html) {
  const title = htmlTitle(html) || 'Wantedly job search';
  const parsed = parseWantedlyState(html, url);
  if (!parsed) {
    const cards = parseWantedlyCards(html);
    if (!cards.length)
      throw Object.assign(
        Error(
          'Wantedly results page shows no result cards, and its search state is missing or answers another page, terms or order.',
        ),
        {url},
      );
    return readerPage({
      browser: BROWSER,
      url,
      title,
      text: [
        `${title}, page ${number}`,
        'The search state of this page is missing or answers another request, so the page position and the next page are unknown; the cards may include listings from earlier pages.',
        ...searchLines(cards),
      ].join('\n'),
      links: listingLinks(cards),
    });
  }
  const {jobs, total, pageSize} = parsed;
  const pages =
    total === null
      ? null
      : Math.max(number, Math.min(WANTEDLY_MAX_PAGES, Math.ceil(total / pageSize)));
  const lines = [
    `${title}, page ${pages ? `${number} of ${pages}` : number}${total === null ? '' : ` (${total} results stated)`}`,
    ...searchLines(jobs),
  ];
  if (!jobs.length)
    lines.push('This results page lists no jobs: the search has no further results.');
  const more = jobs.length > 0 && (pages ? number < pages : jobs.length >= pageSize);
  const next = new URL(url);
  next.searchParams.set('page', String(number + 1));
  return readerPage({
    browser: BROWSER,
    url,
    title,
    text: lines.join('\n'),
    links: listingLinks(jobs),
    pagination: pageEntries(url, number, pages, more ? next.href : null),
  });
}

const SALARY_UNITS = {
  HOURLY: 'per hour',
  DAILY: 'per day',
  MONTHLY: 'per month',
  YEARLY: 'per year',
  ANNUAL: 'per year',
  NEGOTIABLE: 'negotiable',
};
function salaryText(salary) {
  if (!salary || typeof salary !== 'object') return '';
  const {minValue: min, maxValue: max} = salary;
  const range =
    min != null && max != null
      ? `${min}–${max}`
      : min != null
        ? `from ${min}`
        : max != null
          ? `up to ${max}`
          : '';
  const unit = salary.type
    ? (SALARY_UNITS[salary.type] ?? String(salary.type).toLowerCase().replace(/_/g, ' '))
    : '';
  const stated = [range, unit].filter(Boolean).join(' ');
  const note = inlineText(String(salary.description ?? ''));
  return [stated, note].filter(Boolean).join('; ');
}
const body = (section) =>
  String(section?.body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const section = (heading, text) => (text ? `${heading}\n${text}` : '');

// The listing in the page's state, or null. Its own text is the role ("こんな
// ことやります"), the stated duties and the working style ("どうやっているのか",
// where postings state remote work, contract and visa terms). The company's
// business and mission sections, member profiles, stories, other listings and
// the recruiter's contact details are left out.
export function parseWantedlyListing(html, id) {
  const state = wantedlyState(html);
  if (!state) return null;
  const key = Object.keys(state.cache.ROOT_QUERY).find(
    (k) => k.startsWith(LISTING_KEY) && String(args(k, LISTING_KEY)?.projectId) === id,
  );
  const page = key ? state.resolve(state.cache.ROOT_QUERY[key]) : null;
  const post = state.resolve(page?.jobPost);
  if (!post || String(post.id) !== id || !post.title) return null;
  const terms = state.resolve(page.jobDescription);
  const place = post.location ?? {};
  const address = [place.line1, place.line2]
    .map((v) => inlineText(String(v ?? '')))
    .filter(Boolean);
  const company = inlineText(
    String(state.resolve(post.company)?.name ?? terms?.employersName ?? ''),
  );
  const duties = String(terms?.workDuties ?? '').trim();
  return {
    title: inlineText(String(post.title)),
    company,
    open: post.lifecycleState === 'OPEN',
    state: String(post.lifecycleState ?? ''),
    description: [
      section('What you will do', body(post.detailDescription)),
      section('Duties', duties && htmlText(duties)),
      section('How we work', body(post.howDescription)),
    ]
      .filter(Boolean)
      .join('\n\n'),
    fields: {
      company,
      location: unique([inlineText(String(place.prefecture ?? '')), address.join(' ')]),
      workLocation: inlineText(String(terms?.workLocation ?? '')),
      employmentType: (post.hiringTypes ?? []).map((type) => type?.label),
      occupation: inlineText(String(post.occupationName ?? '')),
      salary: salaryText(terms?.salary),
      postedAt: post.publishedAt,
    },
  };
}

// A listing through its state; a page without it is read as its visible text
// (its JobPosting holds only a teaser), a missing page says so.
export function wantedlyDetailPage(url, id, html) {
  if (!html.trim())
    return readerPage({
      browser: BROWSER,
      url,
      title: 'Wantedly job',
      text: 'This Wantedly listing was not found; it has been removed or is no longer available.',
    });
  const listing = parseWantedlyListing(html, id);
  if (!listing)
    return readerPage({
      browser: BROWSER,
      url,
      title: htmlTitle(html) || 'Wantedly job',
      text: htmlPage(html),
    });
  return listingPage({
    browser: BROWSER,
    url,
    title: listing.company ? `${listing.title} @ ${listing.company}` : listing.title,
    description: listing.description,
    fields: listing.fields,
    notes: listing.open
      ? []
      : [
          `Wantedly marks this listing as ${listing.state || 'not open'}: recruitment has ended and it accepts no applications.`,
        ],
  });
}

export async function readWantedly(url, options = {}) {
  const request = wantedlyRequest(url);
  if (!request) throw Error('Wantedly reader does not handle this address');
  const response = await siteFetch(request.url, {...options, site: 'Wantedly', url});
  if (request.kind === 'search') {
    if (isMissing(response))
      throw Object.assign(Error(`Wantedly search page not found (HTTP ${response.status}).`), {
        url,
      });
    return wantedlySearchPage(url, request.number, await response.text());
  }
  return wantedlyDetailPage(url, request.id, isMissing(response) ? '' : await response.text());
}

const OCCUPATIONS = {
  jp__engineering: 'Engineering',
  jp__design_and_art: 'Art / Design',
  jp__pm_and_web_direction: 'Project/Product Management',
  jp__editing_and_writing: 'Editing / Writing',
  jp__marketing: 'Marketing / Public Relations',
  jp__sales: 'Sales / Business Development',
  jp__customer_success_and_support: 'Customer Relations',
  jp__corporate: 'Corporate',
  jp__consulting: 'Consulting',
  jp__medical: 'Medical',
  jp__others: 'Others',
};

export default {
  id: 'wantedly',
  matches: isWantedlyUrl,
  http: {handles: (url) => Boolean(wantedlyRequest(url)), read: readWantedly},
  // The site's own search address (observed 2026-10-16). order=recent is the
  // "Newest" order; without an order the site ignores the search terms and
  // lists every posting. Even "recent" is not one date order: the list starts
  // over at the newest postings after a block of results (page 9 of
  // "engineer" went from 2026-08-15 back to 2026-10-16), so no ordering is
  // declared. Filter values come from the page's own search items.
  search: {
    template: `${ORIGIN}/projects?new=true&keywords={query}&order=recent`,
    pagination: 'url_param',
    filters: [
      {
        param: 'hiringTypes',
        label: 'Hiring type',
        values: {
          mid_career: 'Mid-career',
          newgrad: 'New graduate',
          internship: 'Internship',
          part_time: 'Contract / part-time',
          freelance: 'Freelance',
          side_job: 'Side job',
        },
      },
      {
        param: 'areas',
        label: 'Area',
        values: {
          tokyo: 'Tokyo',
          osaka: 'Osaka',
          nagoya: 'Nagoya',
          kyoto: 'Kyoto',
          fukuoka: 'Fukuoka',
          sapporo: 'Sapporo',
          tohoku: 'Hokkaido - Tohoku',
          kanto: 'Kanto',
          hokuriku: 'Hokuriku - Koushinetsu',
          tokai: 'Tokai',
          kinki: 'Kinki',
          chugoku: 'Chugoku - Shikoku',
          kyushu: 'Kyushu - Okinawa',
        },
      },
      {param: 'occupationTypes', label: 'Occupation', values: OCCUPATIONS},
      {
        param: 'featureTags',
        label: 'Feature',
        values: {
          remote_visit: 'Online interviews OK',
          international: 'Foreign nationalities welcome',
          student: 'Students welcome',
          weekend: 'Weekend commitment only',
          fresh: 'New to Wantedly',
        },
      },
    ],
    notes:
      '10 results per page via &page=N; the page states its total, but the site serves at most 100 pages. A keywords value is one term (a space makes it a phrase); repeat &keywords= to require several terms. Most postings are in Japanese, so Japanese terms find far more (バックエンド: 27515, backend: 210 on 2026-10-16). order=recent must stay: without it the terms are ignored. The order restarts at the newest postings after a block of results, so it is not strictly newest first. Unknown filter values are ignored silently. Listings are /projects/<id>.',
  },
};
