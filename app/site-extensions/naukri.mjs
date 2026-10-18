// @ts-check
// Naukri.com site extension (kind dom; per-site extensions requested
// 2026-10-05). Over plain HTTP the results pages are an empty Next.js shell and
// the site's own job API asks for reCAPTCHA, so the site is read in Chrome.
// Each result card (div.srp-jobtuple-wrapper[data-job-id]) holds the listing
// title link next to links to the company's Naukri job board and to its
// AmbitionBox rating and reviews; the generic reader left all of them to card
// triage. The page states its range ("21 - 39 of 42417") and links its pages
// as /<search>-jobs-N with the current page marked; an address past the last
// page answers with page 1, so the page number is checked against the page.
// Listing pages carry one current JobPosting and stay with the generic reader.
// Observed 2026-10-16 from saved Chrome pages.
export const isNaukriUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?naukri\.com$/.test(u.hostname);
  } catch {
    return false;
  }
};

// Runs inside the page through page.evaluate, so it must stay self-contained.
// It only reports what the page shows; naukriResults() decides.
export function collectNaukriPage() {
  const line = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const list = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((script) => {
      try {
        return JSON.parse(script.textContent ?? '');
      } catch {
        return null;
      }
    })
    .find((block) => block?.['@type'] === 'ItemList');
  const pages = document.querySelector('[class*="pagination"] [class*="pages"]');
  return {
    url: location.href,
    range: line(document.querySelector('#jobs-list-header [class*="count-string"]')) || null,
    cards: [...document.querySelectorAll('.srp-jobtuple-wrapper')].map((card) => {
      const title = card.querySelector('a.title');
      return {
        id: card.getAttribute('data-job-id') ?? '',
        href: title?.getAttribute('href') ?? null,
        title: line(title),
        company: line(card.querySelector('.comp-name, .client-company-name')),
        // Experience (or a walk-in date), pay and place, as the card shows them.
        details: [...card.querySelectorAll('.job-details > span')].map(line).filter(Boolean),
        // "Walk-in", "Internship"...
        kind: line(card.querySelector('.tuple-tags-container')),
        posted: line(card.querySelector('.job-post-day')),
      };
    }),
    items: Array.isArray(list?.itemListElement)
      ? list.itemListElement.map((item) => String(item?.url ?? ''))
      : null,
    pages: pages
      ? [...pages.querySelectorAll('a')].map((a) => ({
          text: line(a),
          href: a.getAttribute('href'),
          selected: /selected/i.test(a.getAttribute('class') ?? ''),
        }))
      : null,
    next: (() => {
      const next = [...document.querySelectorAll('[class*="pagination"] a')].find(
        (a) => line(a) === 'Next',
      );
      return next && !next.hasAttribute('disabled') ? (next.getAttribute('href') ?? null) : null;
    })(),
  };
}

// 20 results per page: page 2 starts at result 21 (2026-10-16). The range
// check below rejects a page where that no longer holds.
const PAGE_SIZE = 20;
const JOB_ID = /^\d{6,}$/;
// /<search>-jobs is page 1, /<search>-jobs-N page N (also /...-jobs-in-<city>-N).
const pageNumber = (value) => {
  const n = new URL(value).pathname.match(/-(\d+)\/?$/)?.[1];
  return n ? Number(n) : 1;
};
// The listing id ends the path; the query only carries tracking (src, sid, xp,
// px...), so the stable address is the path alone.
function listingUrl(card, base) {
  if (!card.href || !JOB_ID.test(card.id)) return null;
  try {
    const u = new URL(card.href, base);
    return isNaukriUrl(u.href) && new RegExp(`^/job-listings-[^/]*-${card.id}$`).test(u.pathname)
      ? `${u.origin}${u.pathname}`
      : null;
  } catch {
    return null;
  }
}

function pagination(raw) {
  const range = String(raw.range ?? '').match(/^(\d+)\s*-\s*(\d+)\s+of\s+(\d+)$/i);
  if (!range) return null;
  const [start, end, total] = range.slice(1).map(Number);
  const page = pageNumber(raw.url);
  // The page shown must be the page in the address: a redirect or a page past
  // the end shows page 1 under another number.
  if (
    start !== (page - 1) * PAGE_SIZE + 1 ||
    end < start ||
    end - start >= PAGE_SIZE ||
    end > total ||
    raw.cards.length > end - start + 1
  )
    return null;
  const selected = (raw.pages ?? []).filter((p) => p.selected);
  if (raw.pages?.length ? selected.length !== 1 || selected[0].text !== String(page) : page !== 1)
    return null;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const entries = [
    {text: `${page} of ${pageCount}`, url: raw.url, current: true, disabled: false, kind: 'link'},
  ];
  if (page < pageCount && raw.next) {
    const next = new URL(raw.next, raw.url);
    if (next.origin !== new URL(raw.url).origin || pageNumber(next.href) !== page + 1) return null;
    // The page links carry only the path; the search and its filters stay.
    for (const [key, value] of new URL(raw.url).searchParams)
      if (!next.searchParams.has(key)) next.searchParams.append(key, value);
    entries.push({
      text: String(page + 1),
      url: next.href,
      current: false,
      disabled: false,
      kind: 'link',
    });
  }
  return entries;
}

// Returns {listings,pagination} for a Naukri results page, or null when the
// page shows no result cards (still loading, a listing page, a changed
// layout) or a card has no listing link; the generic reader then keeps it.
export function naukriResults(raw) {
  if (!raw?.cards?.length || !isNaukriUrl(raw.url)) return null;
  const listings = new Map(),
    urls = [];
  for (const card of raw.cards) {
    const url = listingUrl(card, raw.url);
    if (!url) return null;
    urls.push(url);
    if (!listings.has(url))
      listings.set(url, {
        url,
        text: card.title || '',
        siteCard: [card.title, card.company, card.kind, ...(card.details ?? []), card.posted]
          .filter(Boolean)
          .join(' · '),
      });
  }
  // The page's ItemList names the rendered cards in order; one that names
  // other listings is left from an earlier page, so the paging is not trusted.
  const stale =
    raw.items !== null &&
    raw.items !== undefined &&
    (raw.items.length !== urls.length ||
      raw.items.some((item, i) => {
        try {
          const u = new URL(item, raw.url);
          return `${u.origin}${u.pathname}` !== urls[i];
        } catch {
          return true;
        }
      }));
  return {listings: [...listings.values()], pagination: stale ? null : pagination(raw)};
}

// The results address seen on the site (2026-10-16): /<slug>-jobs with the
// search words hyphenated; pages are /<slug>-jobs-N. Only wfhType=2 (Remote)
// appears as a link; the date and experience filters are page controls
// without a visible address parameter. sort=f is the site's "Date" sort (user
// asked for date order, 2026-10-18): listing ages ran from "Just now" to
// "1 day ago" without a step back across pages 1, 2 and 8 of two searches,
// while the default relevance order mixed weeks; the next-page links keep it.
const search = {
  template: 'https://www.naukri.com/{query}-jobs?sort=f',
  ordering: 'newest_first',
  pagination: 'url_param',
  filters: [{param: 'wfhType', label: 'Work mode', values: {2: 'Remote'}}],
  notes:
    "{query} is a lowercase hyphenated slug (software-developer, data-analyst). Pages are /{query}-jobs-2, -3, ... with 20 results each; an address past the last page shows page 1. The site's own links also add k=<words> (e.g. /backend-developer-jobs?k=Backend developer). sort=f lists the newest first.",
};

export default {
  id: 'naukri',
  matches: isNaukriUrl,
  dom: {collect: collectNaukriPage, results: naukriResults},
  search,
};
