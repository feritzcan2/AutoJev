// @ts-check
// Kariyer.net site extension, kind dom (per-site extensions requested
// 2026-10-05). Each result card (div[data-test="ad-card"]) is one large
// /is-ilani/<slug>-<id> link whose text runs title, company, cities, work
// model, badges and age together, next to many /is-ilanlari/... search, city
// and sector links that look like results to the generic reader. Pages are a
// numbered path suffix (/is-ilanlari/yazilim-2), not a page parameter.
// Sponsored cards ("Sponsorlu İlan") head every page, so one listing can show
// up on several pages. The Nuxt payload (window.__NUXT__.state.advertisement)
// lists the same cards with every city of the listing where the card shows
// "+N il daha"; it is the server snapshot and goes stale after in-page
// navigation. Listing pages carried no JobPosting, so they stay with the
// generic reader. Plain HTTP is blocked by PerimeterX; observed 2026-10-16
// from saved Chrome pages.
export const isKariyerNetUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?kariyer\.net$/.test(u.hostname);
  } catch {
    return false;
  }
};

// Runs inside the page through page.evaluate, so it must stay self-contained.
// It only reports what the page shows; kariyerNetResults() decides.
export function collectKariyerNetPage() {
  const line = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const state = /** @type {any} */ (window).__NUXT__?.state;
  const ads = state?.advertisement;
  const nav = document.querySelector('nav[data-test="pagination"]');
  const current = nav?.querySelector('a[aria-current="page"]');
  return {
    url: location.href,
    cards: [...document.querySelectorAll('div[data-test="ad-card"]')].map((card) => {
      const date = card.querySelector('[data-test="ad-date"]');
      // An updated listing's date starts with the icon's ligature name.
      const icon = line(date?.querySelector('i'));
      const age = line(date);
      return {
        href: card.querySelector('a[data-test="ad-card-item"]')?.getAttribute('href') ?? null,
        title: line(card.querySelector('[data-test="ad-card-title"]')),
        company: line(card.querySelector('[data-test="subtitle"]')),
        location: line(card.querySelector('[data-test="location"]')),
        workModel: line(card.querySelector('[data-test="work-model"]')),
        badges: [...card.querySelectorAll('[data-test="mapped-badges"]')].map(line).filter(Boolean),
        age: icon && age.startsWith(icon) ? age.slice(icon.length).trim() : age,
        sponsored: Boolean(card.querySelector('[data-test="ad-card-sponsored-item-title"]')),
      };
    }),
    items: Array.isArray(ads?.list)
      ? ads.list.map((i) => ({
          id: String(i?.jobId ?? ''),
          title: String(i?.title ?? ''),
          company: String(i?.subTitle ?? ''),
          cities: Array.isArray(i?.locations)
            ? i.locations.map((l) => String(l?.cityName ?? '')).filter(Boolean)
            : [],
          workModel: String(i?.workModelText ?? ''),
          workType: String(i?.workTypeText ?? ''),
          age: String(i?.time ?? ''),
          sponsored: Boolean(i?.isRealSponsored || i?.sponsored),
        }))
      : null,
    searchUrl: typeof ads?.searchUrl === 'string' ? ads.searchUrl : null,
    total: Number.isSafeInteger(ads?.adCount) ? ads.adCount : null,
    statePage: Number.isSafeInteger(state?.filters?.currentPage) ? state.filters.currentPage : null,
    paging: nav
      ? {
          current: current?.getAttribute('href') ?? null,
          page: line(current),
          next: nav.querySelector('a[aria-label="Go to next page"]')?.getAttribute('href') ?? null,
        }
      : null,
    // "Şu an 6 sayfa içerisinden 1. sayfadasınız": the page count the site states.
    summary: line(document.querySelector('.mobile-pagination .k-text')) || null,
  };
}

const LISTING_PATH = /^\/is-ilani\/[a-z0-9]+(?:-[a-z0-9]+)*-(\d+)\/?$/i;
// The listing address is its path; the listing page's canonical link has no query.
function listing(href, base) {
  try {
    const u = new URL(href, base);
    const id = u.pathname.match(LISTING_PATH)?.[1];
    if (!id || !isKariyerNetUrl(u.href)) return null;
    return {id, url: `${u.origin}${u.pathname}`};
  } catch {
    return null;
  }
}
const path = (value, base) => {
  try {
    return new URL(value, base).pathname;
  } catch {
    return null;
  }
};
const entry = (text, url, current) => ({text, url, current, disabled: false, kind: 'link'});

// The current page from the page's own pagination, which must describe this
// address; the next page is the site's own next link.
function pagination(raw) {
  const paging = raw.paging;
  if (!paging || path(paging.current, raw.url) !== path(raw.url)) return null;
  const page = /^\d+$/.test(paging.page ?? '') ? Number(paging.page) : null;
  if (!page) return null;
  const stated = /(\d+)\s*sayfa\b.*?(\d+)\.\s*sayfada/i.exec(raw.summary ?? '');
  const count = stated && Number(stated[2]) === page ? Number(stated[1]) : null;
  if (count !== null && count < page) return null;
  const pages = [entry(count ? `${page} of ${count}` : String(page), raw.url, true)];
  if (!paging.next) return count === null || count === page ? pages : null;
  if (count === page) return null;
  const next = new URL(paging.next, raw.url);
  if (
    next.origin !== new URL(raw.url).origin ||
    !next.pathname.startsWith('/is-ilanlari') ||
    next.pathname === path(raw.url)
  )
    return null;
  // Keep the filters of the address if the site's link leaves them out.
  for (const [key, value] of new URL(raw.url).searchParams)
    if (!next.searchParams.has(key)) next.searchParams.append(key, value);
  pages.push(entry(String(page + 1), next.href, false));
  return pages;
}

// Returns {listings,pagination} for a Kariyer.net result page, or null when the
// page shows no result cards (still loading, a bot check, a listing page, a
// changed layout); the generic reader then handles the page unchanged.
export function kariyerNetResults(raw) {
  if (!raw?.cards?.length || !isKariyerNetUrl(raw.url)) return null;
  const cards = [];
  for (const card of raw.cards) {
    const found = card.href ? listing(card.href, raw.url) : null;
    if (!found) return null;
    cards.push({...found, card});
  }
  const items = new Map((raw.items ?? []).map((i) => [i.id, i]));
  // The Nuxt payload is the server's first page; use it only while it holds
  // exactly the rendered cards of this address and page.
  const fresh =
    Array.isArray(raw.items) &&
    items.size === cards.length &&
    cards.every((c) => items.has(c.id)) &&
    path(raw.searchUrl ?? '', raw.url) === path(raw.url) &&
    (raw.statePage === null || String(raw.statePage) === (raw.paging?.page ?? '1'));
  const listings = new Map();
  for (const {id, url, card} of cards) {
    if (listings.has(url)) continue;
    const item = fresh ? items.get(id) : null;
    const facts = item
      ? [item.title, item.company, item.cities.join(', '), item.workModel, item.workType, item.age]
      : [card.title, card.company, card.location, card.workModel, ...(card.badges ?? []), card.age];
    listings.set(url, {
      url,
      text: card.title || item?.title || '',
      siteCard: [...facts, (item?.sponsored ?? card.sponsored) ? 'Sponsored' : '']
        .filter(Boolean)
        .join(' · '),
    });
  }
  return {listings: [...listings.values()], pagination: pagination(raw)};
}

// The results address the site uses (observed 2026-10-16). Filters (date,
// remote, city, sector, sort) are client-side controls whose addresses the
// saved pages do not show, so none is declared.
const search = {
  template: 'https://www.kariyer.net/is-ilanlari/{query}',
  pagination: 'next_link',
  filters: [],
  notes:
    '{query} is the site\'s search slug: lowercase, Turkish letters folded to ASCII, words joined with + (/is-ilanlari/bilgisayar+muhendisi); a city goes in front with a hyphen (/is-ilanlari/adana-bilgisayar+muhendisi). Page N is the same path with -N (/is-ilanlari/yazilim-2), 50 listings per page plus sponsored ones that repeat on every page. Default order is "Önerilen" (recommended), not by date.',
};

export default {
  id: 'kariyer-net',
  matches: isKariyerNetUrl,
  dom: {collect: collectKariyerNetPage, results: kariyerNetResults},
  search,
};
