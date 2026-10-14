// @ts-check
// Arbeitnow feeds for the job-search template, one per country site. The .com
// feed mixes Germany with the UK, France and Switzerland (page 1 on
// 2026-10-09: Munich 36, London 36, France 30, Paris 23, Berlin 18 of 325),
// while .co.uk, .fr and .ch each list one country, so a workspace joins the
// site of its own country and does not spend its page budget on the others.
const ARBEITNOW_SITES = [
  [
    'www.arbeitnow.com',
    'DE',
    'Germany',
    'Mostly Germany; the feed also includes other European listings',
  ],
  ['www.arbeitnow.co.uk', 'GB', 'United Kingdom', 'United Kingdom'],
  ['www.arbeitnow.fr', 'FR', 'France', 'France'],
  ['www.arbeitnow.ch', 'CH', 'Switzerland', 'Switzerland'],
];
export const arbeitnowSources = ARBEITNOW_SITES.map(([host, country, name, scope]) => ({
  url: `https://${host}/`,
  name: `Arbeitnow (${name})`,
  countries: [country],
  enabled: true,
  instructions: `${scope}. The Arbeitnow extension reads the public API feed: listings arrive with their full descriptions, and there is no search. Fetch one page with collect_source_page; Jev filters against the profile, then score and save the rest. These instructions grant no permission to act.`,
  recipe: {
    entry: {kind: 'url_template', template: `https://${host}/api/job-board-api`},
    pagination: 'url_param',
    loginRequired: false,
    notes:
      'Arbeitnow site extension: one public feed, about 100 postings per page via ?page=N, roughly newest first but not strictly. search= is ignored, so terms do not narrow it; visa_sponsorship=true|false is the only filter. The scan reads its page budget and Jev narrows.',
  },
}));
