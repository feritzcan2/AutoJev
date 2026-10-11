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
    intervalMinutes: 15,
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
    intervalMinutes: 60,
    enabled: true,
    instructions:
      "Run a web search with the target role and location to find single listings on companies' own career pages. Skip results from aggregators and job boards; they are separate sources. These instructions grant no permission to act.",
  },
  {
    url: 'https://freehire.me/',
    name: 'FreeHire',
    intervalMinutes: 30,
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
    intervalMinutes: 60,
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
    intervalMinutes: 60,
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
    url: 'https://www.stepstone.de/',
    name: 'StepStone',
    countries: ['DE'],
    intervalMinutes: 30,
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
    intervalMinutes: 30,
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
    intervalMinutes: 120,
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
    intervalMinutes: 30,
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
    intervalMinutes: 30,
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
    intervalMinutes: 30,
    enabled: true,
    instructions:
      'Denmark. Use the current criteria and the source query; search with the text, municipality and category filters and follow the pagination to the end. Do not skip the remaining records on the same page. These instructions grant no permission to act.',
  },
  {
    url: 'https://jobbank.dk/',
    name: 'Akademikernes Jobbank',
    countries: ['DK'],
    intervalMinutes: 30,
    enabled: true,
    instructions:
      'Danish listings for academics and university-educated candidates. Use the current criteria and the source query; there are type, location, field and education filters. Process the /job/ result pages to the end. Do not record an access error as an empty result. These instructions grant no permission to act.',
  },
].map((source) => ({
  ...source,
  query: 'Current listings matching the saved target roles, country and work preferences',
}));
