// @ts-check
// Starting sources for the job-search template. Workspace copies remain editable.
// Sources without countries join every workspace; country sources are added
// in setup for users searching in those countries (ISO 3166 alpha-2).
import {indeedSources} from './indeed.mjs';
import {arbeitnowSources} from './arbeitnow.mjs';
export const jobSearchSources = [
  {
    url: 'https://www.linkedin.com/jobs/',
    name: 'LinkedIn',
    enabled: true,
    instructions:
      "Use the current workspace criteria and the source query. The logged-out jobs-guest results address returns only listing cards; do not go to the login wall. Keep each query's pagination and remaining details in the scan queue. Tell an empty result apart from an access block; report a login or verification block and do not try to get past it. These instructions grant no permission to act; applications run from record tasks.",
    recipe: {
      entry: {
        kind: 'url_template',
        template:
          'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords={query}&location={location}&sortBy=DD',
      },
      pagination: 'url_param',
      ordering: 'newest_first',
      loginRequired: false,
      notes:
        'Logged-out jobs-guest endpoint: no page shell and no login wall, only listing cards. sortBy=DD puts the newest first. 10 listings per page, paginated with start=10,20,….',
    },
  },
  {
    url: 'https://html.duckduckgo.com/html/',
    name: 'Company career pages',
    enabled: true,
    instructions:
      "Run a web search with the target role and location to find single listings on companies' own career pages. Skip results from aggregators and job boards; they are separate sources. These instructions grant no permission to act.",
  },
  {
    url: 'https://freehire.me/',
    name: 'FreeHire',
    enabled: true,
    instructions:
      'A multi-country, tech-focused aggregator. The FreeHire extension reads its public JSON API: listings arrive with their full descriptions, newest first. Fetch one page with collect_source_page; Jev narrows the listings by the profile, then score and save the rest. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template:
          'https://freehire.me/api/v1/agent/jobs/search?q=%22{query}%22&q_fields=title&countries={country}&sort=created_at',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'FreeHire site extension: public JSON API, 25 listings per page with full descriptions via offset=N. {query} is a role title; the quotes make every word required and q_fields=title matches titles only. {country} is the workspace country code; an empty one searches worldwide. sort=created_at is newest first, so the page budget reads the newest listings. An unknown parameter stops the scan.',
    },
  },
  {
    url: 'https://weworkremotely.com/',
    name: 'We Work Remotely',
    enabled: true,
    instructions:
      'Worldwide remote job listings. Category pages are a single page. Some listings require sign-up for the full text; do not fill in the sign-up form, assess with the visible listing text. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://weworkremotely.com/categories/remote-{query}-jobs',
      },
      pagination: 'none',
      maxPages: 1,
      loginRequired: false,
      notes:
        '{query} is a category slug, not free text: /categories/remote-<slug>-jobs (back-end-programming was read; the home page lists the other categories). Each category is one page without pagination. Listings are /remote-jobs/<company>-<title> links; company, sign-up and plan links are not listings.',
    },
  },
  {
    url: 'https://himalayas.app/',
    name: 'Himalayas',
    enabled: true,
    instructions:
      'The Himalayas extension fetches worldwide remote listings with their full descriptions from the official API through a CLI. Jev first compares them with the profile and filters them out, then the agent scores and saves the rest. Fetch one page with collect_source_page; move to the next page only after reviewing and approving the Jev batch. Country and query come from the URL recipe: an empty country code searches worldwide. The API is cached. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://himalayas.app/jobs/api/search?country={country}&q={query}&sort=recent',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Himalayas site extension: CLI supplies full JSON descriptions to the common Jev review queue. {country} is the workspace country code (criteria.country); an empty one searches worldwide. The agent scores and saves retained listings before advancing each page. Search pages use page=N and offset/limit/totalCount; a short page is not the end. Browser page caps and date cutoffs do not apply.',
    },
  },
  ...indeedSources,
  {
    url: 'https://www.dice.com/',
    name: 'Dice',
    countries: ['US'],
    enabled: true,
    instructions:
      'United States, tech jobs. The Dice extension reads search pages and postings over HTTP: 30 results per page with the page count stated. Results are in relevance order, not by date; filters.postedDate keeps to recent postings. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template:
          'https://www.dice.com/jobs?q={query}&location={location}&filters.postedDate=SEVEN',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Dice site extension: 30 results per page via &page=N, the page states its page count and total. Relevance order; sortBy is ignored, so filters.postedDate=ONE|THREE|SEVEN limits to recent postings. filters.workplaceTypes=Remote|On-Site|Hybrid and filters.employmentType=FULLTIME|PARTTIME|CONTRACTS|THIRD_PARTY also work. Location is free text; empty searches the whole US. Listings are /job-detail/<guid>; the Similar Jobs cards beside the results are not results.',
    },
  },
  {
    url: 'https://builtin.com/jobs',
    name: 'Built In',
    countries: ['US'],
    enabled: true,
    instructions:
      'United States tech and startup jobs. The Built In extension reads search pages and listings over HTTP. Without a location the site searches around the requester, so keep country=USA&allLocations=true (or a city/state). Results have no strict date order; process the pages in order. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://builtin.com/jobs?search={query}&country=USA&allLocations=true',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        "Built In site extension: 25 cards per page via &page=N; the page links its last page. country=USA&allLocations=true searches the whole US (without it the site uses the requester's location). Path segments narrow: /jobs/remote|hybrid|office, then a category (engineering, data-analytics, ai-machine-learning, …) and a level (junior, mid-level, senior, expert-leader). daysSinceUpdated=1|3|7|30 limits to recent postings. No sort control. Listings are /job/<slug>/<id> and carry a JobPosting.",
    },
  },
  {
    url: 'https://www.simplyhired.com/',
    name: 'SimplyHired',
    countries: ['US'],
    enabled: true,
    instructions:
      'United States. The SimplyHired extension reads search pages and listings over HTTP. Results are in relevance order, not by date; process the pages in order. Most listings come from Indeed. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.simplyhired.com/search?q={query}&l={location}&t=7',
      },
      pagination: 'next_link',
      loginRequired: false,
      notes:
        'SimplyHired extension: 20 results per page; the next page is the same address with the cursor the page gives, not a page number. Relevance order, no date sort; t=N keeps postings from the last N days (1, 3, 7, 14, 30). Postings are /job/<jobKey>; most come from Indeed.',
    },
  },
  {
    url: 'https://www.themuse.com/',
    name: 'The Muse',
    countries: ['US'],
    enabled: true,
    instructions:
      'United States, plus some remote postings. The Muse extension reads its public JSON API: listings arrive with their full descriptions. There is no text search; searches are categories. Fetch one page with collect_source_page; Jev narrows the listings by the profile, then score and save the rest. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.themuse.com/api/public/jobs?category={query}',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'The Muse site extension: public JSON API without text search. {query} is a category name such as "Software Engineering", "Data and Analytics", "Product Management". 20 postings per page with full descriptions, pages from 0 via page=N, not ordered by date, so a scan reads its page budget. location="City, ST" (also returns Flexible / Remote) and level=Entry Level|Mid Level|Senior Level|Management|Internship narrow it. Any other parameter is refused. Budget: 500 requests per hour.',
    },
  },
  {
    url: 'https://jobs.workable.com/',
    name: 'Workable',
    enabled: true,
    instructions:
      "Workable's central job search across employers that use Workable, worldwide. The Workable extension reads its public JSON API: listings arrive with their full descriptions in relevance order. Fetch one page with collect_source_page; Jev narrows the listings by the profile, then score and save the rest. These instructions grant no permission to act.",
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://jobs.workable.com/api/v1/jobs?query={query}&location={location}',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Workable site extension: public JSON API, 20 listings per page with full descriptions, relevance order (not by date). Pages follow the API cursor (page=N&pageToken=…); do not build page addresses. {location} is a place name ("United States", "Berlin"); an empty one searches worldwide. day_range=1|7|30 keeps recent postings; workplace=remote|hybrid|on_site. Unknown filters or values stop the scan.',
    },
  },
  {
    url: 'https://news.ycombinator.com/',
    name: 'Hacker News: Who is hiring?',
    enabled: true,
    instructions:
      'The monthly Ask HN: Who is hiring? thread, mostly US tech companies, many remote. The Hacker News extension reads the newest thread through the public Algolia API; every top-level comment is one job. Fetch one page with collect_source_page; Jev narrows the listings by the profile, then score and save the rest. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://hn.algolia.com/api/v1/search?tags=comment,story_latest&query={query}',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Hacker News site extension: story_latest is the newest Who is hiring? thread (a new one each month). {query} is a short Algolia full-text search where every word must match (a role word, "remote" or a city), not a sentence; an empty query lists the whole thread (about 250-400 jobs). 50 comments per page via page=0,1,…, relevance order.',
    },
  },
  {
    url: 'https://www.stepstone.de/',
    name: 'StepStone',
    countries: ['DE'],
    enabled: true,
    instructions:
      'Germany. The results address has the form /jobs/<search-slug>/in-<city>?radius=30; sort=2&action=sort_publish sorts by date, fdl=en shows only listings written in English (use it only when the criteria ask for English listings). Listings are /stellenangebote--…-inline.html links; "Popular jobs" and location links are other searches. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.stepstone.de/jobs/{query}?sort=2&action=sort_publish',
      },
      pagination: 'url_param',
      maxPages: 5,
      loginRequired: false,
      notes:
        '{query} is a hyphenated search slug (senior-backend-engineer). This searches all of Germany; for one city use /jobs/{query}/in-<city>?radius=30. sort=2&action=sort_publish orders by date, so the first pages hold the newest listings. Pages via &page=N.',
    },
  },
  {
    url: 'https://www.xing.com/jobs/',
    name: 'Xing',
    countries: ['DE', 'AT', 'CH'],
    enabled: true,
    instructions:
      'Germany, Austria and Switzerland. The Xing extension reads logged-out search pages and listings over HTTP; do not go to the login wall. Results are in semantic relevance order, not by date; process the pages in order. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.xing.com/jobs/search?keywords={query}&location={location}',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Logged-out search read by the Xing extension: 20 results per page via &page=N, the page states its total. Semantic relevance order, no date sort. Postings are /jobs/<slug>-<id>.',
    },
  },
  {
    url: 'https://berlinstartupjobs.com/engineering/',
    name: 'Berlin Startup Jobs',
    countries: ['DE'],
    enabled: true,
    instructions:
      'Berlin startup listings, grouped into category pages (engineering, product-management, marketing, sales, finance, operations, hr-recruiting, internships, other). Use the category that fits the criteria as {query}; the extension reads the pages and listings over HTTP. The site search (?s=) only works in a browser; do not use it. These instructions grant no permission to act.',
    recipe: {
      entry: {kind: 'url_template', template: 'https://berlinstartupjobs.com/{query}/'},
      pagination: 'url_param',
      ordering: 'newest_first',
      loginRequired: false,
      notes:
        '{query} is a category slug, not free text (engineering was read; product-management, marketing, sales, finance, operations, hr-recruiting, internships, other exist). 25 listings per page, pages via /{query}/page/N/, newest first by posting date. Listings are /<category>/<slug>/ links; /companies/ links are not listings.',
    },
  },
  ...arbeitnowSources,
  {
    url: 'https://www.jobindex.dk/',
    name: 'Jobindex',
    countries: ['DK'],
    enabled: true,
    instructions:
      'Denmark. Use the current criteria and the source query; on the /jobsoegning search page, process the date-sorted results page by page and keep track of the total result count. Use search terms suited to Denmark. Do not read an access block as zero results. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.jobindex.dk/jobsoegning?q={query}',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes: 'Paginated with page=2; results come sorted by date.',
    },
  },
  {
    url: 'https://jobnet.dk/',
    name: 'Jobnet',
    countries: ['DK'],
    enabled: true,
    instructions:
      'Denmark. Use the current criteria and the source query; the search page has occupation, region and working hours filters. Sort by publication date and process every result page. When an external listing shows only a summary, read the missing requirements from the actual listing. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'search_form',
        url: 'https://job.jobnet.dk/CV/FindWork',
        fields: [
          {
            key: 'query',
            label: 'Søg på stilling, fag, firma',
          },
        ],
      },
      pagination: 'auto',
      loginRequired: false,
    },
  },
  {
    url: 'https://jobdanmark.dk/',
    name: 'Jobdanmark',
    countries: ['DK'],
    enabled: true,
    instructions:
      'Denmark. Use the current criteria and the source query; search with the text, municipality and category filters and follow the pagination to the end. Do not skip the remaining records on the same page. These instructions grant no permission to act.',
  },
  {
    url: 'https://jobbank.dk/',
    name: 'Akademikernes Jobbank',
    countries: ['DK'],
    enabled: true,
    instructions:
      'Danish listings for academics and university-educated candidates. Use the current criteria and the source query; there are type, location, field and education filters. Process the /job/ result pages to the end. Do not record an access error as an empty result. These instructions grant no permission to act.',
  },
].map((source) => ({
  ...source,
  query: 'Current listings matching the saved target roles, country and work preferences',
}));
