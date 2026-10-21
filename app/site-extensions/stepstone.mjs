// StepStone site extension (the user asked for per-site extensions, 2026-10-05).
// A StepStone result card holds two links: the listing title and an image-only
// company-logo link to that company's job board. The generic reader cannot tell
// them apart, so scans kept opening company boards. The page also carries its
// own result list and paging state in window.__PRELOADED_STATE__.
export const isStepstoneUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?stepstone\.de$/.test(u.hostname);
  } catch {
    return false;
  }
};

// Runs inside the page through page.evaluate, so it must stay self-contained.
// It only reports what the page shows; stepstoneResults() decides.
export function collectStepstonePage() {
  const results = window.__PRELOADED_STATE__?.['app-unifiedResultlist']?.searchResults;
  const paging = results?.unifiedPagination;
  return {
    url: location.href,
    cards: [...document.querySelectorAll('article[data-at="job-item"]')].map((card) => {
      const title = card.querySelector('a[data-at="job-item-title"]');
      return {
        id: card.id.replace(/^job-item-/, ''),
        url: title?.href ?? null,
        title: (title?.innerText ?? '').replace(/\s+/g, ' ').trim(),
      };
    }),
    items: Array.isArray(results?.items)
      ? results.items.map((i) => ({
          id: String(i.id),
          title: String(i.title ?? ''),
          url: String(i.url ?? ''),
          company: String(i.companyName ?? ''),
          location: String(i.location ?? ''),
          posted: String(i.datePosted ?? '').slice(0, 10),
        }))
      : null,
    paging: paging
      ? {page: paging.page, pageCount: paging.pageCount, template: paging.template}
      : null,
  };
}

// The result-list tracking parameter changes with every position; the listing
// address without it is the one earlier records hold.
const listingUrl = (value, base) => {
  const u = new URL(value, base);
  u.searchParams.delete('rltr');
  return u.href;
};
const pageNumber = (value) => {
  const page = new URL(value).searchParams.get('page');
  return page === null ? 1 : Number(page);
};

// The address this page was opened at, when it is this same results page.
// StepStone rewrites its address after load and drops the sort (seen live
// 2026-10-20), so the address the scan opened is the one to page from.
const openedPage = (opened, page) => {
  if (!isStepstoneUrl(opened ?? '')) return null;
  try {
    return pageNumber(opened) === page ? new URL(opened) : null;
  } catch {
    return null;
  }
};

function pagination(raw, opened) {
  const {page, pageCount, template} = raw.paging ?? {};
  if (
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(pageCount) ||
    page < 1 ||
    pageCount < page
  )
    return null;
  const pages = [
    {text: `${page} of ${pageCount}`, url: raw.url, current: true, disabled: false, kind: 'link'},
  ];
  if (page < pageCount) {
    // The page's own template is another search for a free-text query (live:
    // "Compliance%20Remote" page 1 of 149, its template's page 2 "2 of 1"),
    // while the opened address with page=N continues the same list.
    let next = openedPage(opened, page);
    if (next) next.searchParams.set('page', String(page + 1));
    else {
      if (typeof template !== 'string' || !/%7bpage%7d|\{page\}/i.test(template)) return null;
      // The template can drop the sort and filters of the address, so the
      // next page keeps those the current address still shows.
      next = new URL(template.replace(/%7bpage%7d|\{page\}/i, String(page + 1)), raw.url);
      for (const [key, value] of new URL(raw.url).searchParams)
        if (key !== 'page' && !next.searchParams.has(key)) next.searchParams.append(key, value);
    }
    pages.push({
      text: String(page + 1),
      url: next.href,
      current: false,
      disabled: false,
      kind: 'link',
    });
  }
  return pages;
}

// Returns {listings,pagination} for a StepStone result page, or null when the
// page shows no result cards (still loading, a detail page, or a changed
// layout); the generic reader then handles the page unchanged.
export function stepstoneResults(raw, {opened} = {}) {
  if (!raw?.cards?.length) return null;
  const items = new Map((raw.items ?? []).map((i) => [i.id, i]));
  // The preloaded list can be stale after in-page navigation. Use it only
  // when it describes the rendered cards and the page in the address.
  const fresh =
    raw.items !== null &&
    raw.items !== undefined &&
    raw.cards.every((c) => items.has(c.id)) &&
    (!raw.paging || raw.paging.page === pageNumber(raw.url));
  const cards = new Map(raw.cards.map((c) => [c.id, c]));
  const entries = fresh
    ? raw.items.map((item) => ({item, card: cards.get(item.id)}))
    : raw.cards.map((card) => ({card}));
  const listings = [];
  for (const {item, card} of entries) {
    const address = card?.url || item?.url;
    if (!address) return null;
    listings.push({
      url: listingUrl(address, raw.url),
      text: card?.title || item?.title || '',
      ...(item
        ? {
            siteCard: [item.title, item.company, item.location, item.posted]
              .filter(Boolean)
              .join(' · '),
          }
        : {}),
    });
  }
  return {listings, pagination: fresh ? pagination(raw, opened) : null};
}

// The results address StepStone accepts (observed 2026-10). {query} is a
// hyphenated search slug; a city goes into the path (/jobs/{query}/in-berlin).
const search = {
  template: 'https://www.stepstone.de/jobs/{query}?sort=2&action=sort_publish',
  ordering: 'newest_first',
  pagination: 'url_param',
  filters: [
    {param: 'fdl', label: 'Listing language', values: {en: 'English', de: 'German'}},
    {param: 'radius', label: 'Radius (km, with a city)', values: {10: '10', 30: '30', 50: '50'}},
  ],
  notes:
    'sort=2&action=sort_publish orders by date. Pages via &page=N. For one city use /jobs/{query}/in-<city>; radius applies only with a city.',
};

export default {
  id: 'stepstone',
  matches: isStepstoneUrl,
  dom: {pageWorld: true, collect: collectStepstonePage, results: stepstoneResults},
  search,
};
