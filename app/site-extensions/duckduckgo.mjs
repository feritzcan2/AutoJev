// @ts-check
// DuckDuckGo HTML results site extension (HTTP reader; per-site extensions
// requested 2026-10-05) for the "Company career pages" source. The HTML
// endpoint answers a plain GET ?q= with ten server-rendered web results; each
// result__a links through a /l/?uddg=<target> redirect (later pages link the
// target directly). Each organic result's target is a listing link; ads and
// DuckDuckGo's own addresses are not. Later pages exist only as a POST form
// carrying a vqd token; a GET with s=/dc= does not page, so a search has one
// page. The career pages themselves stay with the generic reader. Observed
// 2026-10-16 (html.duckduckgo.com/robots.txt: "Allow: /").
import {SiteWaitError} from '../browser/site-access.mjs';
import {decode, inlineText} from './listing.mjs';
import {siteFetch, isMissing, readerPage, pageEntries} from './http.mjs';

const BROWSER = 'DuckDuckGo reader';
const BASE = 'https://html.duckduckgo.com/html/';
export const isDuckDuckGoHtmlUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'html.duckduckgo.com';
  } catch {
    return false;
  }
};
const ddgHost = (host) => host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com');

// A GET search: q plus the region (kl) and time (df) filters the endpoint
// honours. Paging parameters only work in its POST form, so an address with
// them (or without q) is left to the generic reader.
const PARAMS = new Set(['q', 'kl', 'df']);
export function duckDuckGoRequest(value) {
  if (!isDuckDuckGoHtmlUrl(value)) return null;
  const url = new URL(value);
  if (!/^\/html\/?$/.test(url.pathname) || !url.searchParams.get('q')?.trim()) return null;
  return [...url.searchParams.keys()].every((key) => PARAMS.has(key)) ? {url: url.href} : null;
}

// The address a result link leads to: the uddg target of DuckDuckGo's
// redirect, or the link itself. null when it is not a web address.
export function resultTarget(href) {
  try {
    const link = new URL(decode(href), BASE);
    const target =
      ddgHost(link.hostname) && link.pathname === '/l/' && link.searchParams.get('uddg')
        ? new URL(link.searchParams.get('uddg') ?? '')
        : link;
    return /^https?:$/.test(target.protocol) ? target.href : null;
  } catch {
    return null;
  }
}

// {results, empty} of a results page, or null when the page has no results
// list (a bot check, an error page, a changed layout).
export function parseDuckDuckGoResults(html) {
  if (!/<div\b[^>]*id="links"/i.test(html)) return null;
  const results = [];
  let empty = false;
  for (const block of html.split(/<div class="result\b/).slice(1)) {
    const classes = block.slice(0, block.indexOf('"'));
    if (/\bresult--no-result\b/.test(classes)) {
      empty = true;
      continue;
    }
    const anchor = block.match(/<a\b[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const href = anchor?.[0].match(/\shref="([^"]+)"/i)?.[1];
    const url = href ? resultTarget(href) : null;
    if (!anchor || !url) continue;
    results.push({
      url,
      title: inlineText(anchor[1]),
      snippet: inlineText(block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ''),
      shown: inlineText(block.match(/class="result__url"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ''),
      // Ads, and results that stay on DuckDuckGo (its ad clicks), are not listings.
      listing: !/\bresult--ad\b/.test(classes) && !ddgHost(new URL(url).hostname),
    });
  }
  return {results, empty: empty || !results.length};
}

export function duckDuckGoSearchPage(url, html, {status = 200, siteAccess = undefined} = {}) {
  const parsed = parseDuckDuckGoResults(html);
  if (!parsed) {
    // DuckDuckGo answers a suspected bot with a challenge page instead of results.
    if (status === 202 || /anomaly|captcha|challenge/i.test(html)) {
      const blocked = siteAccess?.block?.(url, 'verification');
      if (blocked) throw Object.assign(new SiteWaitError(blocked), {url});
      throw Object.assign(Error('DuckDuckGo asked for a bot check instead of results.'), {url});
    }
    throw Object.assign(Error('DuckDuckGo returned no results list for this search.'), {url});
  }
  const query = new URL(url).searchParams.get('q')?.trim() ?? '';
  const listings = [
    ...new Map(parsed.results.filter((r) => r.listing).map((r) => [r.url, r])).values(),
  ];
  const lines = [
    `DuckDuckGo web results for "${query}"`,
    "Later result pages are only reachable through DuckDuckGo's POST form, so this is the only page of this search.",
  ];
  for (const result of parsed.results) {
    lines.push(`${result.listing ? 'Link' : 'Ad'}: ${result.title} — ${result.url}`);
    const facts = [result.shown, result.snippet].filter(Boolean).join(' · ');
    if (facts) lines.push(facts);
  }
  if (parsed.empty) lines.push('This search has no results.');
  return readerPage({
    browser: BROWSER,
    url,
    title: query ? `${query} at DuckDuckGo` : 'DuckDuckGo',
    text: lines.join('\n'),
    links: [
      ...listings.map((r) => ({
        text: r.title,
        url: r.url,
        listing: true,
        siteCard: [r.title, r.shown, r.snippet].filter(Boolean).join(' · '),
      })),
      ...parsed.results
        .filter((r) => !r.listing)
        .map((r) => ({text: r.title, url: r.url, listing: false})),
    ],
    pagination: pageEntries(url, 1, 1, null),
  });
}

export async function readDuckDuckGo(url, options = {}) {
  const request = duckDuckGoRequest(url);
  if (!request) throw Error('DuckDuckGo reader does not handle this address');
  const response = await siteFetch(request.url, {...options, site: 'DuckDuckGo', url});
  if (isMissing(response))
    throw Object.assign(Error(`DuckDuckGo results page not found (HTTP ${response.status}).`), {
      url,
    });
  return duckDuckGoSearchPage(url, await response.text(), {
    status: response.status,
    siteAccess: options.siteAccess,
  });
}

// The search address (observed 2026-10-16): relevance order, no date sort.
const search = {
  template: 'https://html.duckduckgo.com/html/?q={query}',
  pagination: 'none',
  filters: [
    {
      param: 'kl',
      label: 'Region',
      values: {
        'ar-es': 'Argentina',
        'au-en': 'Australia',
        'at-de': 'Austria',
        'be-fr': 'Belgium (fr)',
        'be-nl': 'Belgium (nl)',
        'br-pt': 'Brazil',
        'bg-bg': 'Bulgaria',
        'ca-en': 'Canada (en)',
        'ca-fr': 'Canada (fr)',
        'ct-ca': 'Catalonia',
        'cl-es': 'Chile',
        'cn-zh': 'China',
        'co-es': 'Colombia',
        'hr-hr': 'Croatia',
        'cz-cs': 'Czech Republic',
        'dk-da': 'Denmark',
        'ee-et': 'Estonia',
        'fi-fi': 'Finland',
        'fr-fr': 'France',
        'de-de': 'Germany',
        'gr-el': 'Greece',
        'hk-tzh': 'Hong Kong',
        'hu-hu': 'Hungary',
        'is-is': 'Iceland',
        'in-en': 'India (en)',
        'id-en': 'Indonesia (en)',
        'ie-en': 'Ireland',
        'il-en': 'Israel (en)',
        'it-it': 'Italy',
        'jp-jp': 'Japan',
        'kr-kr': 'Korea',
        'lv-lv': 'Latvia',
        'lt-lt': 'Lithuania',
        'my-en': 'Malaysia (en)',
        'mx-es': 'Mexico',
        'nl-nl': 'Netherlands',
        'nz-en': 'New Zealand',
        'no-no': 'Norway',
        'pk-en': 'Pakistan (en)',
        'pe-es': 'Peru',
        'ph-en': 'Philippines (en)',
        'pl-pl': 'Poland',
        'pt-pt': 'Portugal',
        'ro-ro': 'Romania',
        'ru-ru': 'Russia',
        'xa-ar': 'Saudi Arabia',
        'sg-en': 'Singapore',
        'sk-sk': 'Slovakia',
        'sl-sl': 'Slovenia',
        'za-en': 'South Africa',
        'es-ca': 'Spain (ca)',
        'es-es': 'Spain (es)',
        'se-sv': 'Sweden',
        'ch-de': 'Switzerland (de)',
        'ch-fr': 'Switzerland (fr)',
        'tw-tzh': 'Taiwan',
        'th-en': 'Thailand (en)',
        'tr-tr': 'Turkey',
        'us-en': 'US (English)',
        'us-es': 'US (Spanish)',
        'ua-uk': 'Ukraine',
        'uk-en': 'United Kingdom',
        'vn-en': 'Vietnam (en)',
      },
    },
    {
      param: 'df',
      label: 'Time',
      values: {d: 'Past day', w: 'Past week', m: 'Past month', y: 'Past year'},
    },
  ],
  notes:
    'A web search: {query} is free text (role, place and words such as careers or jobs; site: and -site: work as on DuckDuckGo). Ten results per search in relevance order; later pages are only reachable through a POST form, so each search is one page. Each organic result address is a listing link, read by the generic reader; ads are not listings. kl=<region> (dk-da, de-de, uk-en, us-en, …) and df=d|w|m|y (past day, week, month, year) are honoured; other parameters are left to the browser.',
};

export default {
  id: 'duckduckgo',
  matches: isDuckDuckGoHtmlUrl,
  http: {handles: (url) => Boolean(duckDuckGoRequest(url)), read: readDuckDuckGo},
  search,
};
