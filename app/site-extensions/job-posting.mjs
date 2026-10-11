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
      walk(JSON.parse(block));
    } catch {}
  return found;
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
      remoteRegion: []
        .concat(job.applicantLocationRequirements ?? [])
        .map(named)
        .map(plain),
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
