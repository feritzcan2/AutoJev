// Site extensions: per-site readers the user explicitly asked for (2026-10-05).
// DOM extensions read the page already loaded in Chrome. CLI extensions provide
// collector {templateId,searchUrl,readPage,detail}; the shared source worker puts
// their evidence into Jev's queue. HTTP readers provide reader {handles,read}
// and replace the browser tab for the addresses they handle. All keep triage,
// scoring and records generic. Unknown DOM pages retain the generic reader result.
//
// Adding a site: export {id, matches(url), collect, results} from a module in
// this folder and list it below. collect runs inside the page and must be
// self-contained; results(raw) returns {listings:[{url,text}],pagination} or null.
import stepstone from './stepstone.mjs';
import himalayas from './himalayas.mjs';
import linkedin from './linkedin.mjs';

export const SITE_EXTENSIONS=[stepstone,himalayas,linkedin];
export const siteExtensionFor=url=>SITE_EXTENSIONS.find(e=>e.matches(url))??null;
// What reads this source for the source list: api (collector, only for its
// template), http (reader) or browser (DOM extension on the open page).
export function siteExtensionKind(url,templateId){
 const extension=siteExtensionFor(url);if(!extension)return null;
 if(extension.collector)return extension.collector.templateId===templateId?{id:extension.id,kind:'api'}:null;
 return {id:extension.id,kind:extension.reader?'http':'browser'};
}
// The HTTP reader that serves this address instead of a browser tab, if any.
export const siteReaderFor=url=>{const reader=siteExtensionFor(url)?.reader;return reader?.handles(url)?reader:null;};

// Marks the extension's listings as listings and every other link on the page
// as not a listing. Links stay visible to agents (filters, sorting); Jev scans
// only queue the marked listings.
export function applySiteExtension(document,read,id){
 const listings=new Map(read.listings.map(l=>[l.url,l])),seen=new Set();
 const links=(document.links??[]).map(link=>{
  const listing=listings.get(link.url);
  if(!listing)return {...link,listing:false};
  seen.add(link.url);return {...listing,...link,text:link.text||listing.text,listing:true};
 });
 for(const listing of read.listings)if(!seen.has(listing.url)){seen.add(listing.url);links.push({...listing,listing:true});}
 return {...document,links,pagination:read.pagination??document.pagination,siteExtension:id};
}

// Reads the extension data of the page in this slot. Errors and unknown pages
// leave the generic document unchanged.
export async function readSiteExtension(slot,document){
 const extension=siteExtensionFor(document.url);
 if(!extension?.collect)return document;
 const raw=await slot.page.evaluate(extension.collect).catch(()=>null);
 // A redirect between the two reads would mix two pages.
 const read=raw?.url===document.url?extension.results(raw):null;
 return read?applySiteExtension(document,read,extension.id):document;
}
