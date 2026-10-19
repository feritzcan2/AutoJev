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
      "Use the current workspace criteria and the source query. The app opens LinkedIn's results pages and postings in the user's signed-in browser and reads them itself. Keep each query's pagination and remaining details in the scan queue. Tell an empty result apart from an access block; report a login or verification block and do not try to get past it. These instructions grant no permission to act; applications run from record tasks.",
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.linkedin.com/jobs/search/?keywords={query}&location={location}',
      },
      pagination: 'url_param',
      loginRequired: true,
      notes:
        'Read in the signed-in browser, in relevance order. location is a country (Germany, United States, Worldwide), or geoId=<LinkedIn geoId> replaces it. f_WT=1|2|3 (on-site, remote, hybrid) and f_TPR=r86400|r604800|r2592000 filter. 25 listings per page, paginated with start=25,50,….',
    },
  },
  {
    url: 'https://html.duckduckgo.com/html/',
    name: 'Company career pages',
    enabled: true,
    instructions:
      "Run a web search with the target role and location to find single listings on companies' own career pages. The DuckDuckGo extension reads the first ten results of each search over HTTP; later result pages are not read, so use several focused terms (role, city, words like careers or jobs, -site: for job boards). Skip results from aggregators and job boards; they are separate sources. A bot check is an access block, not zero results. These instructions grant no permission to act.",
    recipe: {
      entry: {kind: 'url_template', template: 'https://html.duckduckgo.com/html/?q={query}'},
      pagination: 'none',
      loginRequired: false,
      notes:
        'DuckDuckGo HTML extension: ten web results per search in relevance order, one page (later pages are a POST form). Each organic result address is a listing link read by the generic reader; ads are not listings. kl=<region> (dk-da, de-de, uk-en, us-en, …) and df=d|w|m|y limit region and age.',
    },
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
    remote: true,
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
    remote: true,
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
    countries: ['US'],
    remote: true,
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
      "Denmark. The Jobindex extension reads each search from the site's RSS feed over HTTP: the 20 newest listings, newest first, on one page. Jobindex's robots.txt disallows paging, sorting and filters, so use several short terms (one or two words, a phrase in quotes) instead of one long one. Listings hosted by Jobindex arrive with their full text; others open on the employer's site. Do not read a refused or blocked search as zero results. These instructions grant no permission to act.",
    recipe: {
      entry: {kind: 'url_template', template: 'https://www.jobindex.dk/jobsoegning?q={query}'},
      pagination: 'none',
      ordering: 'newest_first',
      loginRequired: false,
      notes:
        'Jobindex site extension: robots.txt is followed, so page=, sort=, jobage= and other filters are refused and so is a query with two \'+\' (three or more words). Each search reads /jobsoegning.rss?q=<term>: the 20 newest listings by publication day, one page. Two words match either word; quotes ("data engineer") match the phrase. Listings are /jobannonce/<tid>; hosted ads give full text and stated facts, external ones redirect to the employer, expired ones say so.',
    },
  },
  {
    url: 'https://jobnet.dk/',
    name: 'Jobnet',
    countries: ['DK'],
    enabled: true,
    instructions:
      'Denmark. Use the current criteria and the source query; Jobnet is the public employment service and lists both its own and relayed (external) postings with full text. Search with short Danish or English role words (each search term must match every word), add the region, working-hours or employment filters the criteria call for, and process every result page. Postings without a fixed workplace are the closest thing to remote. For an external posting, applyUrl is where to apply. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://jobnet.dk/find-job?searchString={query}&orderType=PublicationDate',
      },
      pagination: 'url_param',
      ordering: 'newest_first',
      loginRequired: false,
      notes:
        'Jobnet site extension: public search API, 20 listings per page with full descriptions (external postings included), pages via pageNumber=N, at most 10000 results per search, newest first by publication day. Filters: regions=Nordjylland|Midtjylland|Syddanmark|HovedstadenOgBornholm|OevrigeSjaelland (repeatable), workplaceFilter=NonFixed (no fixed workplace), workHoursType=FullTime|PartTime, employmentDurationType=Permanent|Temporary, postalCode=NNNN with kmRadius (default 50), countries=DK|SE|…. Listings are https://jobnet.dk/find-job/<id>.',
    },
  },
  {
    url: 'https://jobdanmark.dk/',
    name: 'Jobdanmark',
    countries: ['DK'],
    enabled: true,
    instructions:
      "Danish listings of all kinds. The Jobdanmark extension reads the search over HTTP and each listing's own text, company, workplace, job type, dates and apply link. Use the current criteria and the source query; narrow with the municipality, region, category and job type parameters, and follow the pagination to the last page. Do not record an access error or a failed search as an empty result. These instructions grant no permission to act.",
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://jobdanmark.dk/jobsoeger/find-job?freetext={query}',
      },
      pagination: 'url_param',
      ordering: 'newest_first',
      loginRequired: false,
      notes:
        "Jobdanmark site extension: the page address becomes the site's JSON search, 30 listings per page via &p=N with the page count stated. freetext matches title and text, also word prefixes; repeated parameters of one filter are ORed. municipality takes a name (Aarhus, København), administrativeRegion a region (Region Hovedstaden), region a part of the country (Fyn, Nordsjælland), zip a postcode, category an id (227978 = IT, engineering and energy), jobtype fuldtid|deltid|fleksjob|elev|studiejob|praktik; an unknown municipality gives no results. Promoted listings come first on page 1, then the newest; no sort parameter. Listings are https://jobdanmark.dk/job/<slug>; a removed one redirects to the search.",
    },
  },
  {
    url: 'https://jobbank.dk/',
    name: 'Akademikernes Jobbank',
    countries: ['DK'],
    enabled: true,
    instructions:
      'Danish listings for academics and university-educated candidates. The Akademikernes Jobbank extension reads the result pages in Chrome: 20 listings per page with the result count and page count stated; listings are read from their structured data. Use the current criteria and the source query; narrow with the job type, education, area, field of work and remote parameters, and follow the pagination to the last page. Results are not in date order. Do not record an access error, a Cloudflare check or a page that has not loaded as an empty result. These instructions grant no permission to act.',
    recipe: {
      entry: {kind: 'url_template', template: 'https://jobbank.dk/job/?key={query}'},
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Akademikernes Jobbank site extension (DOM, plain HTTP gets a Cloudflare challenge): 20 cards per page via &page=N; the heading states the result count and the page links the last page. Search form parameters of /job/: key keywords, antikey words to exclude, cvtype job type (3 full time, 6 graduate/trainee, 13 part time, 9 internship, 4 student job, 12 PhD & postdoc), udd education (24 = IT), amt area (2 Greater Copenhagen, 8 East Jutland (Aarhus), 13 Funen, 6 North Jutland, …), erf field of work (31 = IT - software), branche industry, fjernarbejde=helt|delvist remote, andet relevance group (2 = recent graduates), virk company id, oprettet posted since (a date; format not verified). No sort parameter; page 1 opens with promoted listings. Listings are /job/<id>/<company>/<title>/ and carry a schema.org JobPosting.',
    },
  },
  {
    url: 'https://www.reed.co.uk/',
    name: 'Reed',
    countries: ['GB'],
    enabled: true,
    instructions:
      'United Kingdom, all sectors. The Reed extension reads search pages and listings over HTTP: 25 results per page with the total stated. Results are in relevance order, not by date; dateCreatedOffSet keeps to recent postings. Training courses are listed among the jobs unless hideTrainingJobs=true. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template:
          'https://www.reed.co.uk/jobs?keywords={query}&location={location}&dateCreatedOffSet=lastweek&hideTrainingJobs=true',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Reed site extension: 25 results per page via &pageno=N; the page states its total and the page after the last is HTTP 404. Relevance order; there is no newest-first sort (robots.txt disallows sortBy), so dateCreatedOffSet=today|lastthreedays|lastweek|lasttwoweeks limits to recent postings. workingOption=remote|hybrid|onSite, perm|contract|temp|partTime=true, salaryFrom=<£> and proximity=<miles> (default 10) also work. /jobs?keywords=&location= redirects to the SEO path with the same filters. Location is free text; empty searches the UK. Listings are /jobs/<slug>/<id>; a promoted listing repeats above every page.',
    },
  },
  {
    url: 'https://portal.gupy.io/',
    name: 'Gupy',
    countries: ['BR'],
    enabled: true,
    instructions:
      'Brazil. The Gupy extension reads the public JSON API of portal.gupy.io, the job portal of companies that recruit through Gupy: listings arrive with their full descriptions, newest first. Search with Portuguese role titles (desenvolvedor, analista, engenheiro de software). Fetch one page with collect_source_page; Jev narrows the listings by the profile, then score and save the rest. Do not read an API error as zero results. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template:
          'https://portal.gupy.io/api/job-search/jobs?jobName={query}&sortBy=publishedDate&sortOrder=desc',
      },
      pagination: 'url_param',
      ordering: 'newest_first',
      loginRequired: false,
      notes:
        'Gupy site extension: public JSON API, 10 listings per page with full descriptions via offset=10,20,… (offset+limit at most 10000); a page with fewer than 10 is the last. {query} matches words of the title. sortBy=publishedDate&sortOrder=desc is strictly newest first. workplaceType=remote|hybrid|on-site and type=vacancy_type_effective|vacancy_legal_entity|vacancy_type_internship|… take a comma list; state and city are exact, accented names (São Paulo). Repeated or unknown parameters are refused because the API would ignore them. Listings are https://<company>.gupy.io/jobs/<id>.',
    },
  },
  {
    url: 'https://www.werk.nl/',
    name: 'Werk.nl (UWV)',
    countries: ['NL'],
    enabled: true,
    instructions:
      "Netherlands. Werk.nl is UWV, the Dutch public employment service. The Werk.nl extension reads the site's vacancy search over HTTP, newest first, and each vacancy's own text, employer, place, contract, hours, salary indication, deadline and apply link. Use the current criteria and the source query; search with short Dutch or English role words, add a place with a distance or the contract and education filters the criteria call for, and follow the pagination to the last page. Some descriptions are shortened by the site; the full posting is at applyUrl. Do not record an access error or a refused search as an empty result. These instructions grant no permission to act.",
    recipe: {
      entry: {
        kind: 'url_template',
        template:
          'https://www.werk.nl/werkzoekenden/mijn-werkmap/kia/publiek/zoekenvacatures/api/search?keywords={query}&sort=newest',
      },
      pagination: 'url_param',
      ordering: 'newest_first',
      loginRequired: false,
      notes:
        "Werk.nl site extension: the address becomes the site's JSON search (keywords, location, distance and facet parameters), 20 vacancies per page via &page=N with the total stated, newest first. location takes a Dutch place or postcode the site knows and needs distance=5|10|25|50|75|100|125|150|300 (km); an unknown place is refused. Facets repeat: JOB_CONTRACT_TYPE=1|2|3 (permanent, either, temporary), JOB_EDUCATION=4|5|6|7 (MBO, HBO/bachelor, WO/master, not stated), JOB_UWV_PLAATSNAAM=<TOWN> (exact, upper case), JOB_CATEGORY=<occupation>. Unknown parameters stop the read. Vacancies are https://www.werk.nl/nl/vacatures/<reference>.",
    },
  },
  {
    url: 'https://www.wantedly.com/',
    name: 'Wantedly',
    countries: ['JP'],
    enabled: true,
    instructions:
      'Japan. The Wantedly extension reads search pages and listings over HTTP: 10 results per page with the total stated. Most listings are in Japanese, so use Japanese search terms alongside English ones. Keep order=recent in the address; the order is not strictly by date, so process the pages in order. Do not read an access block as zero results. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.wantedly.com/projects?new=true&keywords={query}&order=recent',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Wantedly site extension: 10 results per page via &page=N; the page states its total, but the site serves at most 100 pages. order=recent must stay, because without an order the site ignores the search terms. It restarts at the newest postings after a block of results, so it is not strictly newest first. A keywords value is one term (a space makes a phrase); repeat &keywords= to require several. Filters: hiringTypes=mid_career|newgrad|internship|part_time|freelance|side_job, areas=tokyo|osaka|kanto|…, occupationTypes=jp__engineering|…, featureTags=international|remote_visit|…; unknown values are ignored silently. Listings are /projects/<id>.',
    },
  },
  {
    url: 'https://www.jobbank.gc.ca/',
    name: 'Job Bank',
    countries: ['CA'],
    enabled: true,
    instructions:
      "Canada, the Government of Canada's national job board. The Job Bank extension reads search pages and postings over HTTP: 25 results per page with the result count stated, newest first. Narrow by province with fprov; a location in the search text is ignored. Most postings come from partner boards such as Talent.com, and some of them show no description on Job Bank; then assess with the stated facts and the partner link. Do not read an access block as zero results. These instructions grant no permission to act.",
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.jobbank.gc.ca/jobsearch/jobsearch?searchstring={query}&sort=D',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        "Job Bank site extension: 25 results per page via &page=N; the page states its result count. sort=D is newest first by posting date (sort=M is best match). Use searchstring; term= alone ignores the keyword and locationstring is ignored, so narrow with fprov=AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT. fage=2|30 keeps the last 48 hours or 30 days; fskl=15141 remote, fskl=100000 hybrid; fper=F|P; fter=P|T|S|C; flg=E|F|B; fsrc=16 keeps Job Bank's own verified postings. Postings are /jobsearch/jobposting/<id>; expired ones answer 410. robots.txt asks for a 5-second crawl delay.",
    },
  },
  {
    url: 'https://www.naukri.com/',
    name: 'Naukri',
    countries: ['IN'],
    enabled: true,
    instructions:
      "India, all sectors. The Naukri extension reads the result pages in Chrome; listings are read from their structured data. Search with the role as a lowercase hyphenated slug in the path (software-developer, data-analyst), save concrete slugs as the recipe's terms, and add wfhType=2 for remote roles only. Pages are /<slug>-jobs-2, -3, … with 20 results each, newest first. Do not record an access block, a CAPTCHA or a page that has not loaded as an empty result. These instructions grant no permission to act.",
    recipe: {
      entry: {kind: 'url_template', template: 'https://www.naukri.com/{query}-jobs?sort=f'},
      ordering: 'newest_first',
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Naukri site extension (DOM; plain HTTP is an empty Next.js shell and the job API asks for reCAPTCHA): {query} is a hyphenated role slug. 20 results per page via the -N path suffix; the header states the total ("1 - 20 of N"). sort=f lists the newest first. An address past the last page shows page 1, which the extension does not read as page N. wfhType=2 keeps remote roles. Listings are /job-listings-<slug>-<id> and carry a schema.org JobPosting.',
    },
  },
  {
    url: 'https://www.kariyer.net/',
    name: 'Kariyer.net',
    countries: ['TR'],
    enabled: true,
    instructions:
      "Türkiye. The Kariyer.net extension reads result pages in Chrome: each card is one listing, and sponsored listings come first and repeat on later pages. Use the current criteria and the source query as the site's path slug, and follow the pages in order. PerimeterX may show a human check; report it as an access block, not as zero results, and do not try to get past it. These instructions grant no permission to act.",
    recipe: {
      entry: {kind: 'url_template', template: 'https://www.kariyer.net/is-ilanlari/{query}'},
      pagination: 'next_link',
      loginRequired: false,
      notes:
        'Kariyer.net DOM extension. {query} is the search slug: lowercase, Turkish letters folded to ASCII, words joined with + (bilgisayar+muhendisi); a city goes first with a hyphen (adana-bilgisayar+muhendisi). Page N is the same path with -N (/is-ilanlari/yazilim-2), 50 listings per page plus sponsored ones. Default order is recommended, not by date. Listings are /is-ilani/<slug>-<id>.',
    },
  },
  {
    url: 'https://www.nationalevacaturebank.nl/',
    name: 'Nationale Vacaturebank',
    countries: ['NL'],
    enabled: true,
    instructions:
      'Netherlands, a large Dutch job board (DPG Media). The Nationale Vacaturebank extension reads the result cards in Chrome; listings are read from their structured data. A DPG Media privacy gate (myprivacy.dpgmedia.nl) can appear before the search; treat it like any other consent prompt. Results load ten at a time as the page is scrolled; the address has no page parameter. Two promoted "Topbaan" listings stay on top of every search. Tell an empty result apart from the privacy gate or an access block, and report a block without trying to get past it. These instructions grant no permission to act.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.nationalevacaturebank.nl/vacature/zoeken?query={query}',
      },
      pagination: 'infinite_scroll',
      loginRequired: false,
      notes:
        'Nationale Vacaturebank DOM extension: result cards are /vacature/<id>/<slug> links; preview company/place links and menu pages are not listings. ?page=N is ignored (same first results), so more results come only from scrolling. Listing pages carry a schema.org JobPosting read by the generic reader. The page orders by date through its API, but no ordering is declared. Plain HTTP is blocked by the Akamai WAF.',
    },
  },
].map((source) => ({
  ...source,
  query: 'Current listings matching the saved target roles, country and work preferences',
}));
