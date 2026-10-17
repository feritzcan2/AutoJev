// @ts-check
// Jobindex site extension (HTTP reader; per-site extensions requested
// 2026-10-05). The user decided to follow jobindex.dk's robots.txt, which
// disallows paging, sorting and filtering /jobsoegning and any address with
// two "+" in its query. So a search is read from the site's RSS feed
// (/jobsoegning.rss?q=, ISO-8859-1, the 20 newest listings by pubDate) and has
// one page. Listings are read from /jobannonce/<tid>: ads Jobindex hosts give
// their text in .jobtext-jobad__body with the stated facts beside it; other
// ads redirect to the employer's site; expired ones redirect to the archive
// host, whose robots.txt disallows everything, so that redirect is not
// followed. Facts observed 2026-10-16. Everything after the read stays generic.
import {decode, htmlText, inlineText, listingPage} from './listing.mjs';
import {siteFetch, isMissing, readerPage, htmlPage, htmlTitle, pageEntries} from './http.mjs';
import {jobPostingHtml, jobPostingPage} from './job-posting.mjs';

const BROWSER = 'Jobindex reader';
const ORIGIN = 'https://www.jobindex.dk';
export const isJobindexUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?jobindex\.dk$/.test(u.hostname);
  } catch {
    return false;
  }
};

// robots.txt Disallow rules for the search paths (read 2026-10-16), matched
// like a crawler matches them: from the path start, "*" for any characters.
const ROBOTS_DISALLOW = [
  '/jobsoegning?companyid=230',
  '/jobsoegning*q=ofir',
  '/jobsoegning*q=job+ofir',
  '/jobsoegning?*&*&',
  '/jobsoegning*page=',
  '/jobsoegning*sort=',
  '/jobsoegning*jobage=',
  '/jobsoegning*archive=',
  '/jobsoegning*_supid=',
  '/jobsoegning*companyid=',
  '/jobsoegning*radius=',
  '/jobsoegning*subid=',
  '/jobsoegning*flag=',
  '/jobsoegning*geoareaid=',
  '/jobsoegning*?*+*+',
  '/jobsoegning*q=www',
  '/jobsoegning*q=http',
  '/*?*@',
].map(
  (rule) =>
    new RegExp(
      `^${rule
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}`,
    ),
);
export const robotsAllows = (value) => {
  const url = new URL(value);
  return !ROBOTS_DISALLOW.some((rule) => rule.test(url.pathname + url.search));
};

const TID = /^[a-z]?\d+$/i;
export const jobindexListingUrl = (tid) => `${ORIGIN}/jobannonce/${tid}`;

// What this address is: a search (with the feed it reads, or why robots.txt
// refuses it), a listing, or none. Searches read only q: the feed address is
// form encoded like the app's recipes (a space is "+"), and robots.txt is
// checked on that address, so a term of three or more words is refused rather
// than sent with %20 to slip past the "+" rule.
export function jobindexRequest(value) {
  if (!isJobindexUrl(value)) return null;
  const url = new URL(value);
  if (/^\/jobsoegning(?:\.rss)?$/.test(url.pathname)) {
    const other = [...url.searchParams.keys()].find((key) => key !== 'q'),
      q = url.searchParams.get('q')?.trim() ?? '',
      feed = new URL('/jobsoegning.rss', ORIGIN);
    if (q) feed.searchParams.set('q', q);
    const refused = other
      ? `the "${other}" parameter: robots.txt disallows paging, sorting and filtering the search, so the reader reads only q`
      : !robotsAllows(feed.href) || !robotsAllows(url.href)
        ? /\+.*\+/.test(feed.search)
          ? 'a search term of three or more words, which puts two "+" in the address; use at most two words per term'
          : `the search term "${q}"`
        : null;
    return {kind: 'search', url: url.href, feed: feed.href, refused};
  }
  const tid =
    url.pathname.match(/^\/jobannonce\/([^/]+)(?:\/[^/]*)?\/?$/)?.[1] ??
    url.pathname.match(/^\/vis-job\/([^/]+)\/?$/)?.[1];
  return tid && TID.test(tid) ? {kind: 'detail', tid, fetch: jobindexListingUrl(tid)} : null;
}

// The feed in its declared charset: the header's, else the XML declaration's.
async function feedText(response) {
  const bytes = new Uint8Array(await response.arrayBuffer()),
    head = new TextDecoder('latin1').decode(bytes.subarray(0, 200)),
    charset =
      response.headers.get('content-type')?.match(/charset=["']?([\w-]+)/i)?.[1] ??
      head.match(/<\?xml[^>]*encoding=["']([\w-]+)/i)?.[1] ??
      'utf-8';
  return new TextDecoder(charset).decode(bytes);
}

const element = (xml, name) => {
  const raw = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '';
  return decode(raw.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1'));
};
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
// The day the feed states, without moving it across time zones.
const day = (pubDate) => {
  const m = pubDate.match(/(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})/);
  const month = m ? MONTHS.indexOf(m[2]) + 1 : 0;
  return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};

// {title, jobs} of the RSS feed, or null when the response is not the feed.
export function parseJobindexFeed(xml) {
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) return null;
  const jobs = [];
  for (const item of xml.split(/<item\b[^>]*>/i).slice(1)) {
    const link = element(item, 'link').trim(),
      tid = link.match(/\/(?:vis-job|jobannonce)\/([a-z]?\d+)\b/i)?.[1];
    let url = tid ? jobindexListingUrl(tid) : null;
    if (!url)
      try {
        url = /^https?:$/.test(new URL(link).protocol) ? link : null;
      } catch {}
    if (!url) continue;
    const teaser = element(item, 'description'),
      title = inlineText(element(item, 'title')),
      heading = inlineText(teaser.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1] ?? '');
    jobs.push({
      url,
      // The item title is "<title>, <company>" when it extends the heading.
      title: heading || title,
      company: heading && title.startsWith(`${heading}, `) ? title.slice(heading.length + 2) : '',
      location: inlineText(
        teaser.match(/class="jix_robotjob--area"[^>]*>([\s\S]*?)<\//i)?.[1] ?? '',
      ),
      teaser: [...teaser.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => inlineText(m[1]))
        .filter(Boolean)
        .join(' ')
        .slice(0, 300),
      postedAt: day(element(item, 'pubDate')),
    });
  }
  return {title: inlineText(element(xml.split(/<item\b/i)[0], 'title')), jobs};
}

const card = (job) =>
  [job.company, job.location, job.postedAt && `published ${job.postedAt}`, job.teaser]
    .filter(Boolean)
    .join(' · ');

export function jobindexSearchPage(url, xml) {
  const feed = parseJobindexFeed(xml);
  if (!feed)
    throw Object.assign(Error('Jobindex did not return its RSS feed for this search.'), {url});
  const unique = [...new Map(feed.jobs.map((job) => [job.url, job])).values()],
    title = feed.title || 'Jobindex';
  const lines = [
    `${title}: the newest ${unique.length} listings, newest first (Jobindex RSS feed).`,
    "Jobindex's robots.txt disallows paging and sorting the search, so this is the only page of this search.",
  ];
  for (const job of unique) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = card(job);
    if (facts) lines.push(facts);
  }
  if (!unique.length) lines.push('This search has no results.');
  return readerPage({
    browser: BROWSER,
    url,
    title,
    text: lines.join('\n'),
    links: unique.map((job) => ({
      text: job.title,
      url: job.url,
      listing: true,
      siteCard: [job.title, card(job)].filter(Boolean).join(' · '),
    })),
    pagination: pageEntries(url, 1, 1, null),
  });
}

// Labels of the facts a hosted ad states (Danish pages; English for the
// site's English interface). "Not stated" values are left out.
/** @type {Array<[RegExp, string]>} */
const FACTS = [
  [/^(?:Virksomhed|Company)$/i, 'company'],
  [/^(?:Lokation|Location)$/i, 'location'],
  [/^(?:Indrykket|Published|Posted)$/i, 'postedAt'],
  [/^(?:Ansøgningsfrist|Application deadline|Deadline)$/i, 'deadline'],
  [/^(?:Ansættelsestype|Employment type)$/i, 'employmentType'],
  [/^(?:Hjemmearbejde|Work from home|Remote work)$/i, 'workFromHome'],
  [/^(?:Ugentlig arbejdstid|Weekly working hours)$/i, 'workingHours'],
];
const NOT_STATED = /^(?:Ikke oplyst|Not stated)$/i;
const fact = (label, value, fields) => {
  const key = FACTS.find(([pattern]) => pattern.test(inlineText(label).replace(/:$/, '')))?.[1];
  if (key && value && !NOT_STATED.test(value) && !fields[key]) fields[key] = value;
};
const valueText = (html) =>
  html.match(/<time\b[^>]*datetime="([^"]+)"/i)?.[1] ??
  inlineText(html.replace(/<svg\b[\s\S]*?<\/svg>/gi, ''));

// The ad Jobindex hosts in its own layout: title, body and stated facts, or
// null for an employer-designed ad page without that layout.
export function parseJobindexAd(html) {
  const start = html.search(/<section\b[^>]*class="jobtext-jobad__body"/i);
  if (start < 0) return null;
  const open = html.indexOf('>', start) + 1,
    end = html.indexOf('</section>', open);
  if (end < 0) return null;
  const close = html.indexOf('</article>', end),
    article = html.slice(
      Math.max(0, html.lastIndexOf('<article', start)),
      close < 0 ? undefined : close,
    ),
    fields = /** @type {Record<string, string>} */ ({});
  for (const m of article.matchAll(
    /class="jobtext-jobad__metadata-item"[^>]*>\s*<svg\b[^>]*aria-label="([^"]+)"[\s\S]*?<\/svg>([\s\S]*?)<\/div>/gi,
  ))
    fact(decode(m[1]), inlineText(m[2]), fields);
  for (const m of article.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi))
    fact(m[1], valueText(m[2]), fields);
  return {
    title: inlineText(article.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? ''),
    description: htmlText(html.slice(open, end)),
    fields,
  };
}

// external: the employer address a listing redirected to; archived: Jobindex
// redirected it to its archive (expired).
export function jobindexDetailPage(url, html, {external = null, archived = false} = {}) {
  if (archived || !html.trim())
    return readerPage({
      browser: BROWSER,
      url,
      title: 'Jobindex',
      text: archived
        ? 'This job listing has expired: Jobindex moved it to its archive.'
        : 'This job listing was not found; it has been removed or is no longer available.',
    });
  const posting = jobPostingPage({url, browser: BROWSER, ...jobPostingHtml(html)});
  if (posting) return posting;
  const ad = external ? null : parseJobindexAd(html);
  if (ad?.description) {
    const read = listingPage({
      browser: BROWSER,
      url,
      title: ad.fields.company ? `${ad.title} @ ${ad.fields.company}` : ad.title,
      description: ad.description,
      fields: ad.fields,
    });
    if (read.listing) return read;
  }
  const text = htmlPage(html);
  return readerPage({
    browser: BROWSER,
    url,
    title: htmlTitle(html) || 'Jobindex',
    text: external
      ? `This Jobindex listing is published on the employer's site: ${external}\n\n${text}`
      : text,
  });
}

export async function readJobindex(url, options = {}) {
  const request = jobindexRequest(url);
  if (!request) throw Error('Jobindex reader does not handle this address');
  if (request.kind === 'search') {
    if (request.refused)
      throw Object.assign(
        Error(`Jobindex's robots.txt disallows this search address (${request.refused}).`),
        {url},
      );
    const response = await siteFetch(request.feed, {...options, site: 'Jobindex', url});
    if (isMissing(response))
      throw Object.assign(Error(`Jobindex search feed not found (HTTP ${response.status}).`), {
        url,
      });
    return jobindexSearchPage(url, await feedText(response));
  }
  // The first answer's redirect is read here: the archive is not fetched, and
  // the employer address is kept for the page text. The read keeps `url`.
  const fetch = options.fetch ?? globalThis.fetch;
  let external = null,
    archived = false;
  const response = await siteFetch(request.fetch, {
    ...options,
    site: 'Jobindex',
    url,
    fetch: async (target, init) => {
      const first = await fetch(target, {...init, redirect: 'manual'}),
        location = first.status >= 300 && first.status < 400 ? first.headers.get('location') : null;
      if (!location) return first;
      const next = new URL(location, target);
      if (
        /(?:^|\.)jobindexarkiv\.dk$/.test(next.hostname) ||
        (isJobindexUrl(next.href) && next.pathname.startsWith('/arkiv/'))
      ) {
        archived = true;
        return new Response('', {status: 410});
      }
      if (!isJobindexUrl(next.href)) external = next.href;
      return fetch(next.href, init);
    },
  });
  const html = isMissing(response) ? '' : await response.text();
  return jobindexDetailPage(url, html, {external, archived});
}

export default {
  id: 'jobindex',
  matches: isJobindexUrl,
  http: {handles: (url) => Boolean(jobindexRequest(url)), read: readJobindex},
  // The search address (observed 2026-10-16). The reader reads it from the RSS
  // feed, which lists by pubDate, newest first.
  search: {
    template: 'https://www.jobindex.dk/jobsoegning?q={query}',
    ordering: 'newest_first',
    pagination: 'none',
    filters: [],
    notes:
      "Jobindex's robots.txt (followed by the user's decision) disallows page=, sort=, jobage=, geoareaid=, subid=, radius=, companyid= and other filters on /jobsoegning, and any address with two '+' in its query. So each search is read from the RSS feed /jobsoegning.rss?q=<term>: its 20 newest listings by publication day, one page, no paging. Use terms of one or two words; a longer term or an extra parameter is refused. Two words match either word; in quotes (\"data engineer\") they match the phrase. Listings are /jobannonce/<tid>; ads hosted by Jobindex give their full text, others redirect to the employer's site.",
  },
};
