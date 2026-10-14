// @ts-check
// Hacker News "Ask HN: Who is hiring?" site extension (API collector;
// per-site extensions requested 2026-10-05). The monthly thread by the
// whoishiring account holds one job per top-level comment. The public Algolia
// HN API searches those comments; numericFilters=parent_id keeps replies out,
// so its page count is exact. One request holds a page of comments with their
// full text.
import {htmlText, inlineText, listingPage} from './listing.mjs';

const ALGOLIA = 'https://hn.algolia.com/api/v1';
const HN = 'https://news.ycombinator.com';
const PAGE_SIZE = 50;
const LATEST = 'latest';
const THREAD_TITLE = /^Ask HN: Who is hiring\?/i;
const MAX_BYTES = 16 * 1024 * 1024;
const HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'jobloop/1.0 (job search source reader)',
};

const host = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
};
export const isHnHiringUrl = (value) =>
  ['news.ycombinator.com', 'hn.algolia.com'].includes(host(value)?.hostname ?? '');

// The thread of an address: a story id or "latest" (the newest Who is hiring
// thread, resolved when the page is read).
function threadOf(u) {
  if (u.hostname === 'hn.algolia.com') {
    if (u.pathname !== '/api/v1/search')
      throw Error('This Algolia address is not a comment search.');
    const tag = (u.searchParams.get('tags') ?? '').match(/(?:^|,)story_(\d+|latest)(?:,|$)/)?.[1];
    if (!tag) throw Error('The Algolia search names no Who is hiring thread.');
    return tag;
  }
  if (['', '/', '/news', '/jobs', '/ask'].includes(u.pathname)) return LATEST;
  const id = u.pathname === '/item' ? u.searchParams.get('id') : null;
  if (!id || !/^\d{1,12}$/.test(id))
    throw Error('Use the Hacker News front page or a Who is hiring thread address.');
  return id;
}

// One comment search page: the thread, the query and Algolia's 0-based page.
// The address is the source's own form; readPage adds the reply filter.
export function hnHiringSearchUrl(value) {
  const u = host(value);
  if (!u || !isHnHiringUrl(value)) throw Error('Hacker News needs a valid HTTPS address.');
  const thread = threadOf(u),
    page = u.hostname === 'hn.algolia.com' ? (u.searchParams.get('page') ?? '0') : '0',
    query = (u.searchParams.get('query') ?? u.searchParams.get('q') ?? '').trim();
  if (!/^\d{1,3}$/.test(page)) throw Error('Invalid Hacker News search page.');
  const url = new URL(`${ALGOLIA}/search`);
  url.searchParams.set('tags', `comment,story_${thread}`);
  if (query) url.searchParams.set('query', query);
  url.searchParams.set('hitsPerPage', String(PAGE_SIZE));
  url.searchParams.set('page', String(Number(page)));
  return url.href;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
// HN comment HTML opens paragraphs with <p> and never closes them.
const commentText = (html) => htmlText(html.replace(/<p>/gi, '\n\n'));
const firstLine = (html) => inlineText(html.split(/<p>/i)[0]).slice(0, 200);
function jobRecord(item, thread) {
  const id = String(item?.objectID ?? item?.id ?? ''),
    html = text(item?.comment_text ?? item?.text);
  if (!/^\d+$/.test(id) || !html)
    throw Error('Hacker News comment id or text missing; the page is incomplete.');
  if (String(item.parent_id) !== String(thread) || String(item.story_id) !== String(thread))
    throw Error('Hacker News returned a comment outside the requested thread.');
  const description = commentText(html),
    title = firstLine(html) || description.split('\n')[0].slice(0, 200);
  if (!description) throw Error('Hacker News comment text could not be read.');
  return {
    url: `${HN}/item?id=${id}`,
    title,
    company: title.includes('|') ? title.split('|')[0].trim() : '',
    description,
    postedAt: text(item.created_at) || null,
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
    throw Object.assign(Error(`Hacker News API HTTP ${response.status}; ${what}.`), {
      status: response.status,
    });
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw Error('Hacker News API returned something other than JSON.');
  }
  const body = await response.text();
  if (body.length > MAX_BYTES) throw Error('Hacker News API response exceeds the size limit.');
  return JSON.parse(body);
}

// The newest "Who is hiring?" story; the account also posts "Who wants to be
// hired?" and "Freelancer?" threads.
export function latestHiringThread(data) {
  if (!Array.isArray(data?.hits)) throw Error('Hacker News thread list is malformed.');
  const story = data.hits.find(
    (h) => THREAD_TITLE.test(text(h?.title)) && /^\d+$/.test(h.objectID),
  );
  if (!story) throw Error('No Who is hiring thread found in the newest whoishiring posts.');
  return story.objectID;
}

export function parseHnHiringPage(value, thread, data) {
  const url = hnHiringSearchUrl(value),
    page = Number(new URL(url).searchParams.get('page'));
  if (
    !Array.isArray(data?.hits) ||
    data.page !== page ||
    !Number.isSafeInteger(data.nbPages) ||
    !Number.isSafeInteger(data.nbHits)
  )
    throw Error('Hacker News API response is malformed; an empty result was not assumed.');
  const jobs = data.hits.map((hit) => jobRecord(hit, thread));
  // Later pages stay in the thread this page was read from, also after a new
  // month's thread appears.
  const next = page + 1 < data.nbPages ? new URL(url) : null;
  next?.searchParams.set('tags', `comment,story_${thread}`);
  next?.searchParams.set('page', String(page + 1));
  if (!jobs.length && next)
    throw Error('Hacker News results are incomplete; an empty page still has more pages.');
  return {
    url,
    jobs,
    page: page + 1,
    totalPages: Math.max(1, data.nbPages),
    nextUrl: next?.href ?? null,
    complete: !next,
  };
}

// One search page. "latest" costs one more request for the thread list. A
// failed request is reported as it is; the collector worker keeps its
// checkpoint and controls retries.
export async function readHnHiringPage(
  value,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const url = hnHiringSearchUrl(value),
    options = {fetch, signal, timeoutMs},
    tagged = new URL(url).searchParams.get('tags').replace(/^comment,story_/, '');
  const thread =
    tagged === LATEST
      ? latestHiringThread(
          await readJson(
            `${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=10`,
            options,
            'the scan did not finish',
          ),
        )
      : tagged;
  const request = new URL(url);
  request.searchParams.set('tags', `comment,story_${thread}`);
  request.searchParams.set('numericFilters', `parent_id=${thread}`);
  return parseHnHiringPage(
    url,
    thread,
    await readJson(request.href, options, 'the scan did not finish'),
  );
}

// One job comment by its address, for listings that moved off the page they
// were queued from. A deleted comment has no text and stays pending.
export async function readHnHiringDetail(
  url,
  {fetch = globalThis.fetch, signal = undefined, timeoutMs = 20000} = {},
) {
  const u = host(url),
    id =
      u?.hostname === 'news.ycombinator.com' && u.pathname === '/item'
        ? u.searchParams.get('id')
        : null;
  if (!id || !/^\d{1,12}$/.test(id)) throw Error('A single Hacker News comment address is needed.');
  const item = await readJson(
    `${ALGOLIA}/items/${id}`,
    {fetch, signal, timeoutMs},
    'the address stays pending',
  );
  if (item?.type !== 'comment') throw Error('This Hacker News item is not a job comment.');
  return {...jobRecord(item, item.parent_id), url};
}

// Like the other extensions, this adapter only supplies observed listings.
// The common queue, Jev classifier and agent own every assessment and write.
export default {
  id: 'hn-hiring',
  matches: isHnHiringUrl,
  collector: {
    templateId: 'job-search',
    searchUrl: hnHiringSearchUrl,
    acceptsQuery: () => true,
    readPage: readHnHiringPage,
    readDetail: readHnHiringDetail,
    detail: (job) => ({
      ...listingPage({
        browser: 'Hacker News API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {company: job.company, postedAt: job.postedAt},
      }),
      cells: {company: job.company},
    }),
  },
  // The comment search of the newest thread (Algolia HN API, observed 2026-10).
  search: {
    template: `${ALGOLIA}/search?tags=comment,story_latest&query={query}`,
    pagination: 'url_param',
    filters: [],
    notes:
      'Ask HN: Who is hiring? is a monthly thread (first weekday of the month, by whoishiring); every top-level comment is one job, usually "Company | Role | Location | Remote | Pay" on its first line, mostly US companies. story_latest reads the newest thread; story_<id> pins one. query is an Algolia full-text search over the comment: all words must match (a few words such as "backend remote" or a city, not a sentence); an empty query lists the whole thread (about 250-400 jobs). 50 comments per page via page=0,1,…; relevance order, not by date.',
  },
};
