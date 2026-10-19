// @ts-check
// We Work Remotely site extension (user asked for one, 2026-10-16). Search,
// category and region pages list every result at once, grouped by category,
// among company-profile, category, RSS, region-filter and partner links; the
// generic reader left all of them to card triage. Each result card
// (li.new-listing-container) holds one /remote-jobs/<slug> listing link, and
// the active "All jobs / Hot jobs / Boosted" option states the result count.
// Listing pages show similar listings in the same cards but no such toolbar.
// Ad cards (li.listing-ad) share the card class and link to /listing_ads/ clicks.
// Search and listing pages answer plain HTTP with a Cloudflare challenge, so
// the site is read in Chrome; listings have no JobPosting and stay with the
// generic reader. Checked live 2026-10-16.
export const isWeWorkRemotelyUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?weworkremotely\.com$/.test(u.hostname);
  } catch {
    return false;
  }
};

// Runs inside the page through page.evaluate, so it must stay self-contained.
// It only reports what the page shows; weWorkRemotelyResults() decides.
export function collectWeWorkRemotelyPage() {
  const line = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const count = document.querySelector(
    '.topForm__job-filter__option.is-active [data-job-filter-count]',
  );
  return {
    url: location.href,
    toolbar: Boolean(document.querySelector('.topForm__job-filter')),
    total: count && !count.hasAttribute('hidden') ? line(count) : null,
    ads: document.querySelectorAll('li.new-listing-container.listing-ad').length,
    cards: [...document.querySelectorAll('li.new-listing-container:not(.listing-ad)')].map(
      (card) => ({
        hrefs: [...card.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? ''),
        title: line(card.querySelector('.new-listing__header__title__text')),
        company: line(card.querySelector('.new-listing__company-name')),
        headquarters: line(card.querySelector('.new-listing__company-headquarters')).replace(
          /^HQ:\s*/,
          '',
        ),
        tags: [...card.querySelectorAll('.new-listing__categories__category')]
          .map(line)
          .filter(Boolean),
        age: line(card.querySelector('.new-listing__header__icons__date')),
      }),
    ),
  };
}

const LISTING_PATH = /^\/remote-jobs\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/i;
// The card's listing address; its other links go to the company profile.
function listingUrl(hrefs, base) {
  const urls = hrefs
    .map((href) => {
      try {
        const u = new URL(href, base);
        u.hash = '';
        return isWeWorkRemotelyUrl(u.href) && LISTING_PATH.test(u.pathname) ? u.href : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return new Set(urls).size === 1 ? urls[0] : null;
}

// Returns {listings,pagination} for a page of result cards, or null when there
// are none (a page still loading, a changed layout) or the page is a listing
// with similar listings below it; the generic reader then handles the page.
export function weWorkRemotelyResults(raw) {
  if (!raw?.cards?.length || !isWeWorkRemotelyUrl(raw.url) || !raw.toolbar) return null;
  const listings = new Map();
  for (const card of raw.cards) {
    const url = listingUrl(card.hrefs ?? [], raw.url);
    if (!url) return null;
    if (!listings.has(url))
      listings.set(url, {
        url,
        text: card.title || '',
        siteCard: [card.title, card.company, card.headquarters, ...(card.tags ?? []), card.age]
          .filter(Boolean)
          .join(' · '),
      });
  }
  // Every result is on this page only when the page's own count
  // matches the cards shown (it counts a boosted listing shown twice twice).
  // A broad search shortens large groups to a "View all" category link; then
  // the counts differ and the generic pagination reader decides.
  const total = /^\d+$/.test(raw.total ?? '') ? Number(raw.total) : null;
  return {
    listings: [...listings.values()],
    pagination:
      total === raw.cards.length
        ? [{text: '1 of 1', url: raw.url, current: true, disabled: false, kind: 'link'}]
        : null,
  };
}

// The search address the site accepts (observed 2026-10-16). sort is a
// posting-date window, job_filter the promotion tabs; both are server-side.
const search = {
  template: 'https://weworkremotely.com/remote-jobs/search?term={query}',
  pagination: 'none',
  filters: [
    {
      param: 'sort',
      label: 'Posted',
      values: {
        'Past 24 Hours': 'Past 24 hours',
        'Past Week': 'Past week',
        'Past 2 Weeks': 'Past 2 weeks',
      },
    },
    {param: 'job_filter', label: 'Promotion', values: {hot: 'Hot jobs', boosted: 'Boosted jobs'}},
  ],
  notes:
    'Results are on one page, grouped by category, not by date (no pagination). A broad term shortens large groups to "View all N <category> jobs", which opens the whole category without the term, so those results are not on any searched page; sort=Past+Week (or Past+24+Hours, Past+2+Weeks) keeps searches small enough to show every result. Category pages (/categories/remote-<category>-jobs) list one category in full and ignore term.',
};

export default {
  id: 'weworkremotely',
  matches: isWeWorkRemotelyUrl,
  dom: {collect: collectWeWorkRemotelyPage, results: weWorkRemotelyResults},
  search,
};
