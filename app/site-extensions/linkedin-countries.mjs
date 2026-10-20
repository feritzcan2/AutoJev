// @ts-check
// LinkedIn's geoId for a country, by ISO 3166 code: [geoId, ...names]. Each
// is LinkedIn's first country suggestion for the name (jobs-guest typeahead,
// geoTypes=COUNTRY_REGION, 2026-10-20), confirmed by a second LinkedIn answer:
// its public results page titled "Jobs in <name>", or for DE, US and GB the
// geoId the signed-in search used. Countries missing here are learned in a
// trial round (sources/search-learning.mjs); add one only from LinkedIn's own
// answers.
export const LINKEDIN_COUNTRIES = {
  AD: [106296266, 'Andorra'],
  AE: [104305776, 'United Arab Emirates'],
  AF: [101240012, 'Afghanistan'],
  AG: [100270819, 'Antigua and Barbuda'],
  AI: [102287072, 'Anguilla'],
  AL: [102845717, 'Albania'],
  AM: [103030111, 'Armenia'],
  AO: [105371935, 'Angola'],
  AR: [100446943, 'Argentina'],
  AT: [103883259, 'Austria'],
  AU: [101452733, 'Australia'],
  BE: [100565514, 'Belgium'],
  BR: [106057199, 'Brazil'],
  CA: [101174742, 'Canada'],
  CH: [106693272, 'Switzerland'],
  CL: [104621616, 'Chile'],
  DE: [101282230, 'Germany'],
  GB: [101165590, 'United Kingdom'],
  NL: [102890719, 'Netherlands', 'The Netherlands'],
  US: [103644278, 'United States', 'United States of America'],
};
