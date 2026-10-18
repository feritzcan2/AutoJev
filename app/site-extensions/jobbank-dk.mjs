// @ts-check
// Akademikernes Jobbank (jobbank.dk) site extension, kind dom (per-site
// extensions requested 2026-10-05). Plain HTTP gets a Cloudflare challenge,
// so the site is read in Chrome. A result card (div.job-item, name = the
// listing id) links its title to /job/<id>/<company>/<title>/ next to the
// company's "Talentefterspørgsel" and "Virksomhedsprofil" pages; the page
// also links job agents, RSS, articles and company lists. The generic reader
// left all of these to card triage. Pagination is the site's ul.pagination
// with the active page, the last page number and a "»" next link.
// Listing pages carry one schema.org JobPosting, which the generic reader
// (job-posting.mjs) already uses, so no listing reader is needed here.
// Observed 2026-10-16 from saved Chrome pages (results pages 1 and 2, one listing).
export const isJobbankDkUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /^(?:www\.)?jobbank\.dk$/.test(u.hostname);
  } catch {
    return false;
  }
};

// Runs inside the page through page.evaluate, so it must stay self-contained.
// It only reports what the page shows; jobbankDkResults() decides.
export function collectJobbankDkPage() {
  const line = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const pages = document.querySelector('ul.pagination');
  return {
    url: location.href,
    heading: line(document.querySelector('h1.page-title')) || null,
    cards: [...document.querySelectorAll('div.job-item')].map((card) => ({
      id: card.getAttribute('name') ?? '',
      href: card.querySelector('.job-content > a[href]')?.getAttribute('href') ?? null,
      title: line(card.querySelector('.job-header')),
      teaser: line(card.querySelector('.job-teaser')),
      updated: line(card.querySelector('.job-date-updated')),
      deadline: line(card.querySelector('.job-date-application')),
      recruiter: line(card.querySelector('.job-recruiter')),
    })),
    pages: pages
      ? [...pages.querySelectorAll('li')].map((item) => {
          const classes = (item.getAttribute('class') ?? '').split(/\s+/);
          return {
            text: line(item),
            href: item.querySelector('a')?.getAttribute('href') ?? null,
            active: classes.includes('active'),
            unavailable: classes.includes('unavailable'),
          };
        })
      : null,
  };
}

const LISTING_PATH = /^\/job\/(\d+)\/[^/]+\/[^/]+\/?$/;
const RESULTS_PATH = /^\/job\/?$/;
// The card's listing address without fragment; null unless it is this
// card's listing.
function listingUrl(card, base) {
  try {
    const u = new URL(card.href ?? '', base);
    u.hash = '';
    return isJobbankDkUrl(u.href) && LISTING_PATH.exec(u.pathname)?.[1] === card.id ? u.href : null;
  } catch {
    return null;
  }
}
const pageOf = (url) => {
  const page = new URL(url).searchParams.get('page');
  return page === null ? 1 : /^\d+$/.test(page) ? Number(page) : null;
};
// The result count leads the heading ("1.956 job og karriereopslag i dag").
const resultCount = (heading) => {
  const count = /^(\d{1,3}(?:\.\d{3})*)\s/.exec(heading ?? '')?.[1];
  return count ? Number(count.replace(/\./g, '')) : null;
};

// The next page from the page's own "»" link. The site redirects /job?… to
// /job/?… (observed 2026-10-16), so the next page is queued as it will load.
function nextPage(items, page, base) {
  const link = items.find((i) => i.text === '»' && !i.unavailable && i.href && i.href !== '#');
  if (!link) return null;
  try {
    const u = new URL(link.href, base);
    if (!isJobbankDkUrl(u.href) || !RESULTS_PATH.test(u.pathname) || pageOf(u.href) !== page + 1)
      return null;
    u.pathname = '/job/';
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function pagination(raw, listings) {
  const page = pageOf(raw.url);
  if (page === null) return null;
  const current = (text, count) => ({
    text: `${text} of ${count}`,
    url: raw.url,
    current: true,
    disabled: false,
    kind: 'link',
  });
  // Without page links the results fit on one page only when the stated
  // count says so.
  if (!raw.pages)
    return page === 1 && resultCount(raw.heading) === listings ? [current(1, 1)] : null;
  const active = raw.pages.filter((i) => i.active);
  const numbers = raw.pages.map((i) => (/^\d+$/.test(i.text) ? Number(i.text) : 0));
  const pageCount = Math.max(0, ...numbers);
  if (active.length !== 1 || Number(active[0].text) !== page || pageCount < page) return null;
  const pages = [current(page, pageCount)];
  if (page < pageCount) {
    const next = nextPage(raw.pages, page, raw.url);
    if (!next) return null;
    pages.push({text: String(page + 1), url: next, current: false, disabled: false, kind: 'link'});
  }
  return pages;
}

// Returns {listings,pagination} for a results page, or null when it shows no
// result cards (still loading, a listing page, a changed layout) or a card
// lacks its listing link; the generic reader then handles the page.
export function jobbankDkResults(raw) {
  if (!raw?.cards?.length || !isJobbankDkUrl(raw.url)) return null;
  if (!RESULTS_PATH.test(new URL(raw.url).pathname) || resultCount(raw.heading) === null)
    return null;
  const listings = new Map();
  for (const card of raw.cards) {
    const url = listingUrl(card, raw.url);
    if (!url) return null;
    if (!listings.has(url))
      listings.set(url, {
        url,
        text: card.title || '',
        siteCard: [
          card.title,
          card.teaser?.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'),
          card.recruiter,
          card.updated,
          card.deadline,
        ]
          .filter(Boolean)
          .join(' · '),
      });
  }
  return {listings: [...listings.values()], pagination: pagination(raw, listings.size)};
}

// The search form's GET parameters (observed 2026-10-16 on /job/). The
// multi-selects send one parameter per chosen value; a template carries one.
const search = {
  template: 'https://jobbank.dk/job/?key={query}',
  pagination: 'url_param',
  filters: [
    {
      param: 'cvtype',
      label: 'Job type',
      values: {
        3: 'Full time',
        6: 'Graduate/trainee',
        13: 'Part time',
        8: 'Temporary',
        12: 'PhD & postdoc',
        11: 'Freelance',
        15: 'Start-up project',
        14: 'Event',
        9: 'Internship',
        4: 'Student job',
        5: 'Student project/thesis',
      },
    },
    {
      param: 'udd',
      label: 'Education',
      values: {
        20: 'Administration',
        43: 'Civil engineering & construction',
        29: 'Architecture, art & design',
        47: 'Electronics & telecommunications',
        32: 'Food & veterinary',
        38: 'Human resources',
        28: 'Humanities',
        24: 'IT',
        23: 'Law',
        44: 'Chemistry, biotech & materials',
        45: 'Climate, environment & energy',
        37: 'Agriculture & nature',
        22: 'Marketing & business',
        48: 'Mechanical engineering & design',
        46: 'Mathematics, physics & nano',
        31: 'Medicine & health',
        30: 'Natural sciences',
        41: 'Organisation & management',
        35: 'Production, logistics & transport',
        34: 'Social sciences',
        25: 'Languages, media & communication',
        33: 'Engineering & technology',
        26: 'Teaching & pedagogy',
        21: 'Economics & auditing',
      },
    },
    {
      param: 'amt',
      label: 'Area',
      values: {
        2: 'Greater Copenhagen',
        3: 'North Zealand',
        14: 'East Zealand',
        4: 'West Zealand',
        5: 'South Zealand & islands',
        13: 'Funen',
        12: 'South Jutland',
        11: 'Southwest Jutland (Esbjerg)',
        9: 'West Jutland',
        10: 'Southeast Jutland',
        7: 'Central Jutland',
        8: 'East Jutland (Aarhus)',
        6: 'North Jutland',
        20: 'Bornholm',
        21: 'Øresund region',
        22: 'Greenland & Faroe Islands',
        23: 'Abroad (Sweden)',
        24: 'Abroad (Norway)',
        19: 'Abroad (other)',
      },
    },
    {
      param: 'erf',
      label: 'Field of work',
      values: {
        20: 'Administration',
        38: 'Architecture & design',
        22: 'Banking & insurance',
        43: 'Data & analytics',
        47: 'Export',
        41: 'Research & development',
        28: 'Human resources',
        49: 'Purchasing',
        34: 'Internet & multimedia',
        32: 'IT - hardware',
        33: 'IT - networks & telecom',
        31: 'IT - software',
        24: 'Law',
        35: 'Communication, media & social media',
        46: 'Design engineering & calculation',
        37: 'Art & culture',
        26: 'Management & planning',
        29: 'Marketing & advertising',
        40: 'Medicine & health',
        45: 'Natural sciences',
        23: 'Organisations & associations',
        52: 'Politics & society',
        44: 'Production',
        27: 'Project management',
        50: 'Consulting & support',
        30: 'Sales',
        39: 'Social services',
        42: 'Engineering',
        25: 'Top management',
        48: 'Transport & logistics',
        36: 'Teaching',
        21: 'Finance & public administration',
      },
    },
    {
      param: 'branche',
      label: 'Industry',
      values: {
        10359: 'Law firms & auditing',
        11669: 'Construction',
        11634: 'Electronics & machinery',
        16791: 'Trade unions, unemployment funds & pension funds',
        10358: 'Finance, insurance & pensions',
        10442: 'Research & education',
        15407: 'Food & groceries',
        10364: 'Retail & services',
        10331: 'IT & telecom',
        17209: 'Climate, energy & utilities',
        16826: 'Municipalities',
        10341: 'Culture, media & entertainment',
        10333: 'Pharma, biotech & chemistry',
        10363: 'Paper, furniture & materials',
        11626: 'Regions, health & social services',
        15586: 'Consulting',
        10362: 'Government, politics & society',
        10440: 'Transport',
        12450: 'Temp agencies & recruitment',
      },
    },
    {
      param: 'fjernarbejde',
      label: 'Remote work',
      values: {helt: 'Fully remote', delvist: 'Partly remote'},
    },
    {
      param: 'andet',
      label: 'Especially relevant for',
      values: {
        6: "Bachelor's degree holders",
        2: 'Recent graduates',
        5: 'Experienced candidates',
        4: 'International background',
      },
    },
    {param: 'antikey', label: 'Words to exclude'},
    {param: 'oprettet', label: 'Posted since (date)'},
  ],
  notes:
    'Search form parameters of /job/ (observed 2026-10-16): key keywords, antikey words to exclude, cvtype job type, udd education, amt area, erf field of work, branche industry, fjernarbejde=helt|delvist remote, andet relevance group, oprettet posted since (a date; its format is not verified), virk a company id. 20 cards per page via &page=N; the heading states the result count and the page links the last page. Pages are not in date order and the form has no sort; on page 1 promoted listings come first. Listings are /job/<id>/<company>/<title>/.',
};

export default {
  id: 'jobbank-dk',
  matches: isJobbankDkUrl,
  dom: {collect: collectJobbankDkPage, results: jobbankDkResults},
  search,
};
