// @ts-check
// Site extensions: per-site readers the user explicitly asked for (2026-10-05).
// Triage, scoring, queues and records stay generic; an extension only reads.
//
// Contract: {id, matches(url)} plus one way of reading the site.
// - dom: {collect, results} runs on the page already open in Chrome. collect
//   runs inside the page and must be self-contained; results(raw) returns
//   {listings:[{url,text}],pagination} or null (the generic reader keeps the page).
//   pagination holds the current page and, when there is one, the next page
//   with its url; null when the extension cannot tell. A pagination without a
//   next page tells the scan that this is the last results page.
//   Optionally dom.listing {handles(url), collect, read(raw)} reads one posting
//   page: collect runs inside the page like dom.collect, read(raw) returns
//   {title, company, location, description, fields, closed} or null. Its text
//   becomes the page's listing evidence (like a schema.org JobPosting).
// - http: {handles(url), read(url, options)} replaces the browser tab for the
//   addresses it handles and returns ordinary Jev page objects, or null for an
//   address it finds it cannot read without a browser (a redirect to another
//   site that renders its content with scripts); the browser tab reads it then.
// - collector: {templateId,searchUrl,acceptsQuery,readPage,readDetail,detail}
//   reads an API; the shared source worker queues its listings for Jev.
//   A card collector (../sources/card-collector.mjs) reads result cards from
//   the API and each listing separately; with listingIn: 'browser' the app
//   opens each listing in the browser and reads it with dom.listing.
// Optionally `credentials` ({label, help, signupUrl, fields:[{key,label}]}) for
// an API that needs the user's own account: the values are entered under Site
// accounts (../sources/site-credentials.mjs) and reach the collector's reads
// as `options.credentials`.
// Optionally `search` (./search.mjs), or search(url) for a site with one host
// per country: the results address, its order and the filters the site
// accepts, so recipes are built from known parameters.
// A reader that reads a single listing returns it through listingPage()
// (./listing.mjs): title, the listing's own description and named facts. Jev
// then skips filtering site chrome out of that text. Without a description the
// page is an ordinary page.
import {listingPage} from './listing.mjs';
import stepstone from './stepstone.mjs';
import himalayas from './himalayas/index.mjs';
import linkedin from './linkedin.mjs';
import xing from './xing.mjs';
import berlinStartupJobs from './berlin-startup-jobs.mjs';
import arbeitnow from './arbeitnow.mjs';
import indeed from './indeed.mjs';
import freehire from './freehire.mjs';
import dice from './dice.mjs';
import builtIn from './builtin.mjs';
import workable from './workable.mjs';
import simplyhired from './simplyhired.mjs';
import hnHiring from './hn-hiring.mjs';
import themuse from './themuse.mjs';
import weWorkRemotely from './weworkremotely.mjs';
import franceTravail from './france-travail.mjs';
import adzuna from './adzuna.mjs';
import jobdanmark from './jobdanmark.mjs';
import jobnet from './jobnet.mjs';
import reed from './reed.mjs';
import gupy from './gupy.mjs';
import werkNl from './werk-nl.mjs';
import jobindex from './jobindex.mjs';
import duckduckgo from './duckduckgo.mjs';
import wantedly from './wantedly.mjs';
import jobbankCa from './jobbank-ca.mjs';
import jobbankDk from './jobbank-dk.mjs';
import naukri from './naukri.mjs';
import kariyerNet from './kariyer-net.mjs';
import nationaleVacaturebank from './nationale-vacaturebank.mjs';

export const SITE_EXTENSIONS = [
  stepstone,
  himalayas,
  linkedin,
  xing,
  berlinStartupJobs,
  arbeitnow,
  indeed,
  freehire,
  dice,
  builtIn,
  workable,
  simplyhired,
  hnHiring,
  themuse,
  weWorkRemotely,
  franceTravail,
  adzuna,
  jobdanmark,
  jobnet,
  reed,
  gupy,
  werkNl,
  jobindex,
  duckduckgo,
  wantedly,
  jobbankCa,
  jobbankDk,
  naukri,
  kariyerNet,
  nationaleVacaturebank,
];
export const siteExtensionFor = (url) => SITE_EXTENSIONS.find((e) => e.matches(url)) ?? null;
// What reads this source for the source list: api (collector, only for its
// template), http (reader) or browser (DOM extension on the open page), with
// the site's results address and filters (`search`, ./search.mjs) when known.
export function siteExtensionKind(url, templateId) {
  const extension = siteExtensionFor(url);
  if (!extension) return null;
  if (extension.collector && extension.collector.templateId !== templateId) return null;
  return {
    id: extension.id,
    kind: extension.collector ? 'api' : extension.http ? 'http' : 'browser',
    // A site with one host per country gives the search of this address.
    ...(extension.search
      ? {search: typeof extension.search === 'function' ? extension.search(url) : extension.search}
      : {}),
  };
}
// The HTTP reader that serves this address instead of a browser tab, if any.
export const siteReaderFor = (url) => {
  const reader = siteExtensionFor(url)?.http;
  return reader?.handles(url) ? reader : null;
};

// Marks the extension's listings as listings and every other link on the page
// as not a listing. Links stay visible to agents (filters, sorting); Jev scans
// only queue the marked listings.
export function applySiteExtension(document, read, id) {
  const listings = new Map(read.listings.map((l) => [l.url, l])),
    seen = new Set();
  const links = (document.links ?? []).map((link) => {
    const listing = listings.get(link.url);
    if (!listing) return {...link, listing: false};
    seen.add(link.url);
    return {...listing, ...link, text: link.text || listing.text, listing: true};
  });
  for (const listing of read.listings)
    if (!seen.has(listing.url)) {
      seen.add(listing.url);
      links.push({...listing, listing: true});
    }
  return {
    ...document,
    links,
    pagination: read.pagination ?? document.pagination,
    siteExtension: id,
    ...(read.pagination ? {paginationBy: id} : {}),
  };
}

// Reads the extension data of the page in this slot. Errors and unknown pages
// leave the generic document unchanged.
export async function readSiteExtension(slot, document) {
  const extension = siteExtensionFor(document.url);
  const dom = extension?.dom;
  if (!dom) return document;
  if (dom.listing?.handles(document.url)) {
    const raw = await slot.page.evaluate(dom.listing.collect).catch(() => null);
    const job = raw?.url === document.url ? dom.listing.read(raw) : null;
    return job?.description ? {...document, siteListing: siteListing(document.url, job)} : document;
  }
  if (!dom.collect) return document;
  const raw = await slot.page.evaluate(dom.collect).catch(() => null);
  // A redirect between the two reads would mix two pages.
  const read = raw?.url === document.url ? dom.results(raw) : null;
  return read ? applySiteExtension(document, read, extension.id) : document;
}
// A posting a site's own reader read, in the shape of the page's listing
// evidence: its text (title, facts, description) and named facts.
function siteListing(url, job) {
  const page = listingPage({
    url,
    title: job.company ? `${job.title} @ ${job.company}` : job.title,
    description: job.description,
    fields: {company: job.company, location: job.location, ...job.fields},
    notes: job.closed ? ['No longer accepting applications.'] : [],
  });
  return {text: page.text, fields: page.listing?.fields ?? {}};
}
