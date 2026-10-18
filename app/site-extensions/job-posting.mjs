// @ts-check
// schema.org JobPosting: many job sites embed the listing they show as
// structured data for search engines. Its description is the listing's own
// text without site chrome, so Jev need not filter the rendered page. Nothing
// here names a site; a page without exactly one matching, current posting
// keeps its rendered text.
import {decode, htmlText, inlineText, listingPage} from './listing.mjs';

// Shorter "descriptions" are teasers, not the listing.
const MIN_DESCRIPTION = 200;
const plain = (value) =>
  htmlText(String(value ?? ''))
    .replace(/­/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const words = (value) =>
  ` ${plain(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
const named = (value) => (value && typeof value === 'object' ? (value.name ?? value.value) : value);

// Some sites write raw line breaks and tabs inside the strings of a block.
// Browsers and search engines still read it, so escape them before giving up.
function escapeControls(text) {
  let out = '',
    inString = false,
    escaped = false;
  for (const ch of text) {
    if (inString && !escaped && ch < ' ') {
      out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
      continue;
    }
    if (ch === '"' && !escaped) inString = !inString;
    escaped = inString && !escaped && ch === '\\';
    out += ch;
  }
  return out;
}
const parseBlock = (block) => {
  try {
    return JSON.parse(block);
  } catch {
    return JSON.parse(escapeControls(block));
  }
};

function postings(blocks) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if ([].concat(value['@type'] ?? []).includes('JobPosting')) found.push(value);
      if (value['@graph']) walk(value['@graph']);
    }
  };
  for (const block of blocks)
    try {
      walk(parseBlock(block));
    } catch {}
  return found;
}

// ISO 3166-1 alpha-2: the officially assigned country codes.
const ISO_COUNTRIES = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS ' +
    'BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE ' +
    'EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM ' +
    'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC ' +
    'LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA ' +
    'NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO ' +
    'TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
  ).split(' '),
);
// Some postings list nearly every country code one by one for a role open
// anywhere. Name the few that are left out instead; a shorter list stays whole.
const NEARLY_ALL = 25;
function regions(values) {
  const list = [...new Set(values.filter(Boolean))],
    codes = list.map((value) => value.toUpperCase());
  if (list.length < 100 || !codes.every((code) => /^[A-Z]{2}$/.test(code))) return list;
  const given = new Set(codes),
    missing = [...ISO_COUNTRIES].filter((code) => !given.has(code)),
    other = codes.filter((code) => !ISO_COUNTRIES.has(code));
  if (missing.length > NEARLY_ALL) return list;
  return [
    (missing.length ? `All ISO countries except ${missing.join(', ')}` : 'All ISO countries') +
      (other.length ? ` and ${other.join(', ')}` : '') +
      ` (${list.length} listed)`,
  ];
}

const place = (locations) =>
  [].concat(locations ?? []).map((location) => {
    const address = location?.address ?? location;
    if (!address || typeof address !== 'object') return plain(address);
    const parts = [address.addressLocality, address.addressRegion, named(address.addressCountry)]
      .map(plain)
      .filter(Boolean);
    return [...new Set(parts)].join(', ');
  });

function salary(value) {
  const pay = [].concat(value ?? [])[0];
  if (!pay || typeof pay !== 'object') return plain(pay);
  const amount = pay.value && typeof pay.value === 'object' ? pay.value : {value: pay.value};
  const range =
    amount.minValue != null && amount.maxValue != null
      ? `${amount.minValue}–${amount.maxValue}`
      : (amount.value ?? amount.minValue ?? amount.maxValue);
  if (range == null) return '';
  return [range, pay.currency, amount.unitText && `per ${String(amount.unitText).toLowerCase()}`]
    .filter(Boolean)
    .join(' ');
}

/**
 * The current posting the page shows, or null: its title, company, own
 * description and the facts it states.
 * @param {{title?: string, headings?: string[], jobPostings?: string[]}} page
 */
export function jobPostingDetail({title, headings = [], jobPostings = []}, now = Date.now()) {
  const found = postings(jobPostings);
  // Several postings are a results page or related listings, not this listing.
  if (found.length !== 1) return null;
  const [job] = found;
  const name = plain(job.title ?? job.name);
  // The page must show this posting; stale or foreign data stays unused.
  if (!name || ![title, ...headings].some((shown) => words(shown).includes(words(name))))
    return null;
  if (Date.parse(job.validThrough) < now) return null;
  const raw = String(job.description ?? '');
  // Some sites escape the description's HTML once more.
  const description = htmlText(!raw.includes('<') && raw.includes('&lt;') ? decode(raw) : raw)
    .replace(/­/g, '')
    .trim();
  if (description.length < MIN_DESCRIPTION) return null;
  const company = plain(named(job.hiringOrganization));
  return {
    title: name,
    company,
    description,
    fields: {
      company,
      location: place(job.jobLocation),
      workMode: [].concat(job.jobLocationType ?? []).includes('TELECOMMUTE') ? 'remote' : null,
      remoteRegion: regions(
        []
          .concat(job.applicantLocationRequirements ?? [])
          .map(named)
          .map(plain),
      ),
      employmentType: job.employmentType,
      salary: salary(job.baseSalary),
      postedAt: job.datePosted,
      validThrough: job.validThrough,
    },
  };
}

/**
 * The page's structured listing as a listing page, or null.
 * @param {{url: string, browser?: string, title?: string, headings?: string[], jobPostings?: string[]}} page
 */
export function jobPostingPage(page, now = Date.now()) {
  const job = jobPostingDetail(page, now);
  if (!job) return null;
  const read = listingPage({
    browser: page.browser ?? 'JobPosting',
    url: page.url,
    title: job.company ? `${job.title} @ ${job.company}` : job.title,
    description: job.description,
    fields: job.fields,
  });
  return read.listing ? read : null;
}

/**
 * The listing in the page's structured data, or null.
 * @param {{url: string, title?: string, headings?: string[], jobPostings?: string[]}} page
 * @returns {{text: string, fields: Record<string, string>} | null}
 */
export function jobPostingListing(page, now = Date.now()) {
  const read = jobPostingPage(page, now);
  return read ? {text: read.text, fields: read.listing.fields} : null;
}

// The same inputs read from fetched HTML, for readers without a DOM: the
// structured-data blocks that mention a posting, the page title and its h1s.
export function jobPostingHtml(html) {
  return {
    title: inlineText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''),
    headings: [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
      .map((m) => inlineText(m[1]))
      .slice(0, 5),
    jobPostings: [
      ...html.matchAll(
        // Attribute values may encode the plus (ld&#x2B;json); a browser decodes them.
        /<script\b[^>]*type=["']application\/ld(?:\+|&#x2B;|&#43;)json["'][^>]*>([\s\S]*?)<\/script>/gi,
      ),
    ]
      .map((m) => m[1])
      .filter((block) => block.includes('JobPosting')),
  };
}
