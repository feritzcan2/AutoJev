// Indeed site extension (user asked for one, 2026-10-10). Most result cards
// link through ad-click redirects (/pagead/clk, /rc/clk) whose address changes
// on every page load, so a saved record never matched its queued card and some
// redirects ended in the Indeed Apply flow. Every card carries its listing id
// (data-jk); /viewjob?jk=<id> is the stable listing address. Each page also
// holds one hidden card (aria-hidden, not in the page's own result list) that
// is not a listing. Checked live on de.indeed.com 2026-10-10.
export const isIndeedUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:[a-z]{2,3}\.)?indeed\.com$/.test(u.hostname);
  } catch {
    return false;
  }
};

// Runs inside the page through page.evaluate, so it must stay self-contained.
// It only reports what the page shows; indeedResults() decides.
export function collectIndeedPage() {
  const results =
    window.mosaic?.providerData?.['mosaic-provider-jobcards']?.metaData?.mosaicProviderJobCardsModel
      ?.results;
  return {
    url: location.href,
    cards: [...document.querySelectorAll('a[data-jk]')].map((a) => ({
      id: String(a.dataset.jk ?? ''),
      title: (a.innerText ?? '').replace(/\s+/g, ' ').trim(),
      hidden: Boolean(a.closest('[aria-hidden="true"]')),
    })),
    items: Array.isArray(results)
      ? results.map((r) => ({
          id: String(r.jobkey ?? ''),
          title: String(r.displayTitle ?? r.title ?? ''),
          company: String(r.company ?? ''),
          location: String(r.formattedLocation ?? ''),
          posted: Number.isFinite(r.pubDate) ? new Date(r.pubDate).toISOString().slice(0, 10) : '',
        }))
      : null,
    next: document.querySelector('a[data-testid="pagination-page-next"]')?.href ?? null,
  };
}

const JOB_ID = /^[0-9a-f]{16}$/;
const pageNumber = (value) =>
  Math.floor(Number(new URL(value).searchParams.get('start') ?? 0) / 10) + 1;

// The next page keeps the search and filters of the current address.
function pagination(raw) {
  const pages = [
    {text: String(pageNumber(raw.url)), url: raw.url, current: true, disabled: false, kind: 'link'},
  ];
  if (raw.next) {
    const next = new URL(raw.next, raw.url);
    if (next.origin !== new URL(raw.url).origin) return null;
    for (const [key, value] of new URL(raw.url).searchParams)
      if (!['start', 'vjk'].includes(key) && !next.searchParams.has(key))
        next.searchParams.append(key, value);
    pages.push({
      text: String(pageNumber(next.href)),
      url: next.href,
      current: false,
      disabled: false,
      kind: 'link',
    });
  }
  return pages;
}

// Returns {listings,pagination} for an Indeed result page, or null when the
// page has no result list (still loading, a detail or sign-in page, or a
// changed layout); the generic reader then handles the page unchanged.
export function indeedResults(raw) {
  if (!raw?.items?.length || !raw.cards?.length) return null;
  const shown = new Map(
    raw.cards.filter((c) => !c.hidden && JOB_ID.test(c.id)).map((c) => [c.id, c]),
  );
  // The result list must describe the rendered cards; otherwise it is stale.
  if (![...shown.keys()].every((id) => raw.items.some((i) => i.id === id))) return null;
  const origin = new URL(raw.url).origin;
  const listings = raw.items
    .filter((item) => shown.has(item.id))
    .map((item) => ({
      url: `${origin}/viewjob?jk=${item.id}`,
      text: item.title || shown.get(item.id).title,
      siteCard: [item.title, item.company, item.location, item.posted].filter(Boolean).join(' · '),
    }));
  return listings.length ? {listings, pagination: pagination(raw)} : null;
}

// The results address of the Indeed site the source uses. sort=date puts the
// newest listings first by Indeed's own date (user asked, 2026-10-18; checked
// on uk. and de.indeed.com), while the default relevance order mixes dates
// over every page. Without a signed-in session only page 1 is readable, so the
// sort decides which listings a scan sees. The order is not certain enough for
// newest_first: posted dates differ from it by a day or two, a few refreshed
// older listings can lead page 1, and later pages could not be checked.
// fromage keeps only recent listings.
const search = (url) => ({
  template: `${new URL(url).origin}/jobs?q={query}&l={location}&sort=date`,
  pagination: 'url_param',
  filters: [
    {
      param: 'fromage',
      label: 'Posted',
      values: {1: 'Last 24 hours', 3: 'Last 3 days', 7: 'Last 7 days', 14: 'Last 14 days'},
    },
    {
      param: 'radius',
      label: 'Radius (km)',
      values: {0: 'City only', 10: '10', 25: '25', 50: '50'},
    },
  ],
  notes:
    'Pages via &start=10,20,… Listings open as /viewjob?jk=<id>. Without a signed-in Indeed session the second results page may ask to sign in.',
});

export default {
  id: 'indeed',
  matches: isIndeedUrl,
  dom: {collect: collectIndeedPage, results: indeedResults},
  search,
};
