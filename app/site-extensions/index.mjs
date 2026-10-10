// @ts-check
// Site extensions: per-site readers the user explicitly asked for (2026-10-05).
// Triage, scoring, queues and records stay generic; an extension only reads.
//
// Contract: {id, matches(url)} plus one way of reading the site.
// - dom: {collect, results} runs on the page already open in Chrome. collect
//   runs inside the page and must be self-contained; results(raw) returns
//   {listings:[{url,text}],pagination} or null (the generic reader keeps the page).
// - http: {handles(url), read(url, options)} replaces the browser tab for the
//   addresses it handles and returns ordinary Jev page objects.
// - collector: {templateId,searchUrl,acceptsQuery,readPage,readDetail,detail}
//   reads an API; the shared source worker queues its listings for Jev.
// Optionally `search` (./search.mjs), or search(url) for a site with one host
// per country: the results address, its order and the filters the site
// accepts, so recipes are built from known parameters.
// A reader that reads a single listing returns it through listingPage()
// (./listing.mjs): title, the listing's own description and named facts. Jev
// then skips filtering site chrome out of that text. Without a description the
// page is an ordinary page.
import stepstone from './stepstone.mjs';
import himalayas from './himalayas/index.mjs';
import linkedin from './linkedin.mjs';
import xing from './xing.mjs';
import berlinStartupJobs from './berlin-startup-jobs.mjs';
import arbeitnow from './arbeitnow.mjs';
import indeed from './indeed.mjs';

export const SITE_EXTENSIONS = [
  stepstone,
  himalayas,
  linkedin,
  xing,
  berlinStartupJobs,
  arbeitnow,
  indeed,
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
  };
}

// Reads the extension data of the page in this slot. Errors and unknown pages
// leave the generic document unchanged.
export async function readSiteExtension(slot, document) {
  const extension = siteExtensionFor(document.url);
  const dom = extension?.dom;
  if (!dom) return document;
  const raw = await slot.page.evaluate(dom.collect).catch(() => null);
  // A redirect between the two reads would mix two pages.
  const read = raw?.url === document.url ? dom.results(raw) : null;
  return read ? applySiteExtension(document, read, extension.id) : document;
}
