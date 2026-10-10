// @ts-check
// Indeed country sites for the job-search template. Every site answers the
// same results address (/jobs?q=&l=) and the same listing links, so one
// recipe serves all of them; each site joins a workspace searching in its
// country. Hosts answered on 2026-10-09 (bot check over plain HTTP, pages
// open in the browser as the live German source does).
const INDEED_SITES = [
  ['www', 'US', 'ABD'],
  ['uk', 'GB', 'Birleşik Krallık'],
  ['ie', 'IE', 'İrlanda'],
  ['ca', 'CA', 'Kanada'],
  ['au', 'AU', 'Avustralya'],
  ['nz', 'NZ', 'Yeni Zelanda'],
  ['de', 'DE', 'Almanya'],
  ['at', 'AT', 'Avusturya'],
  ['ch', 'CH', 'İsviçre'],
  ['fr', 'FR', 'Fransa'],
  ['be', 'BE', 'Belçika'],
  ['nl', 'NL', 'Hollanda'],
  ['lu', 'LU', 'Lüksemburg'],
  ['es', 'ES', 'İspanya'],
  ['it', 'IT', 'İtalya'],
  ['pt', 'PT', 'Portekiz'],
  ['pl', 'PL', 'Polonya'],
  ['cz', 'CZ', 'Çekya'],
  ['hu', 'HU', 'Macaristan'],
  ['ro', 'RO', 'Romanya'],
  ['gr', 'GR', 'Yunanistan'],
  ['se', 'SE', 'İsveç'],
  ['no', 'NO', 'Norveç'],
  ['fi', 'FI', 'Finlandiya'],
  ['dk', 'DK', 'Danimarka'],
  ['tr', 'TR', 'Türkiye'],
  ['ua', 'UA', 'Ukrayna'],
  ['in', 'IN', 'Hindistan'],
  ['sg', 'SG', 'Singapur'],
  ['hk', 'HK', 'Hong Kong'],
  ['my', 'MY', 'Malezya'],
  ['ph', 'PH', 'Filipinler'],
  ['id', 'ID', 'Endonezya'],
  ['jp', 'JP', 'Japonya'],
  ['kr', 'KR', 'Güney Kore'],
  ['tw', 'TW', 'Tayvan'],
  ['ae', 'AE', 'Birleşik Arap Emirlikleri'],
  ['sa', 'SA', 'Suudi Arabistan'],
  ['il', 'IL', 'İsrail'],
  ['za', 'ZA', 'Güney Afrika'],
  ['ng', 'NG', 'Nijerya'],
  ['br', 'BR', 'Brezilya'],
  ['mx', 'MX', 'Meksika'],
  ['ar', 'AR', 'Arjantin'],
  ['cl', 'CL', 'Şili'],
  ['co', 'CO', 'Kolombiya'],
  ['pe', 'PE', 'Peru'],
];
const instructions =
  'Güncel çalışma alanı kriterlerini ve kaynak sorgusunu kullan. Sonuç sayfalarını sırayla işle. Hız sınırı veya doğrulama sayfası çıkarsa bildir, aşmaya çalışma. Bu talimat işlem yetkisi vermez.';
export const indeedSources = INDEED_SITES.map(([subdomain, country, name]) => {
  const host = `${subdomain}.indeed.com`;
  return {
    url: `https://${host}/`,
    name: `Indeed (${name})`,
    countries: [country],
    intervalMinutes: 30,
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
