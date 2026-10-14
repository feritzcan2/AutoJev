// @ts-check
// Indeed country sites for the job-search template. Every site answers the
// same results address (/jobs?q=&l=) and the same listing links, so one
// recipe serves all of them; each site joins a workspace searching in its
// country. Hosts answered on 2026-10-09 (bot check over plain HTTP, pages
// open in the browser as the live German source does).
const INDEED_SITES = [
  ['www', 'US', 'United States'],
  ['uk', 'GB', 'United Kingdom'],
  ['ie', 'IE', 'Ireland'],
  ['ca', 'CA', 'Canada'],
  ['au', 'AU', 'Australia'],
  ['nz', 'NZ', 'New Zealand'],
  ['de', 'DE', 'Germany'],
  ['at', 'AT', 'Austria'],
  ['ch', 'CH', 'Switzerland'],
  ['fr', 'FR', 'France'],
  ['be', 'BE', 'Belgium'],
  ['nl', 'NL', 'Netherlands'],
  ['lu', 'LU', 'Luxembourg'],
  ['es', 'ES', 'Spain'],
  ['it', 'IT', 'Italy'],
  ['pt', 'PT', 'Portugal'],
  ['pl', 'PL', 'Poland'],
  ['cz', 'CZ', 'Czechia'],
  ['hu', 'HU', 'Hungary'],
  ['ro', 'RO', 'Romania'],
  ['gr', 'GR', 'Greece'],
  ['se', 'SE', 'Sweden'],
  ['no', 'NO', 'Norway'],
  ['fi', 'FI', 'Finland'],
  ['dk', 'DK', 'Denmark'],
  ['tr', 'TR', 'Türkiye'],
  ['ua', 'UA', 'Ukraine'],
  ['in', 'IN', 'India'],
  ['sg', 'SG', 'Singapore'],
  ['hk', 'HK', 'Hong Kong'],
  ['my', 'MY', 'Malaysia'],
  ['ph', 'PH', 'Philippines'],
  ['id', 'ID', 'Indonesia'],
  ['jp', 'JP', 'Japan'],
  ['kr', 'KR', 'South Korea'],
  ['tw', 'TW', 'Taiwan'],
  ['ae', 'AE', 'United Arab Emirates'],
  ['sa', 'SA', 'Saudi Arabia'],
  ['il', 'IL', 'Israel'],
  ['za', 'ZA', 'South Africa'],
  ['ng', 'NG', 'Nigeria'],
  ['br', 'BR', 'Brazil'],
  ['mx', 'MX', 'Mexico'],
  ['ar', 'AR', 'Argentina'],
  ['cl', 'CL', 'Chile'],
  ['co', 'CO', 'Colombia'],
  ['pe', 'PE', 'Peru'],
];
const instructions =
  'Use the current workspace criteria and the source query. Process the result pages in order. If a rate limit or verification page appears, report it and do not try to get past it. These instructions grant no permission to act.';
export const indeedSources = INDEED_SITES.map(([subdomain, country, name]) => {
  const host = `${subdomain}.indeed.com`;
  return {
    url: `https://${host}/`,
    name: `Indeed (${name})`,
    countries: [country],
    enabled: true,
    instructions,
    recipe: {
      entry: {kind: 'url_template', template: `https://${host}/jobs?q={query}&l={location}`},
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'The site extension reads result cards as viewjob?jk=<id> (the page links are ad-click redirects). Pages via start=10,20,… sort=date gives no date order; fromage limits to recent days.',
    },
  };
});
