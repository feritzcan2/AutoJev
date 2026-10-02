import {TRACKING_PARAMETER} from './jev-detail-urls.mjs';
// A canonical URL drops the hash, trailing slash and common tracking
// parameters so the same page observed twice compares equal.
export function canonicalJobUrl(raw){
  if(typeof raw!=='string'||!raw.trim()||raw.length>3000)throw Error('Geçersiz ilan bağlantısı');
  const url=new URL(raw.trim());
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz ilan bağlantısı');
  url.hash='';
  for(const key of [...url.searchParams.keys()])if(TRACKING_PARAMETER.test(key))url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString().replace(/\/$/,'');
}

// Identity is the canonical URL. Application-step pages of the same listing
// (…/apply, …/application, …/confirmation, …/thanks) share its identity. No
// site-specific routes: any other URL difference is a different record.
const STEP_SEGMENT=/\/(?:apply|application|applications|confirmation|thanks|already-received|success)$/i;
export function listingIdentity(raw){
  let url;
  try{url=new URL(canonicalJobUrl(raw));}catch{return null;}
  const path=url.pathname.replace(STEP_SEGMENT,'')||'/';
  const base=url.origin+path;
  return {namespace:'url',id:base,key:'url:'+base};
}

export const jobUrlKey=url=>listingIdentity(url)?.key??'url:'+canonicalJobUrl(url);
export const jobIdentities=job=>[...new Set([job.url,job.proof?.url].map(url=>listingIdentity(url)?.key).filter(Boolean))];
export function conflictingIdentities(a,b){
  const split=key=>[key.slice(0,key.lastIndexOf(':')),key.slice(key.lastIndexOf(':')+1)];
  const left=(a.listingKeys??jobIdentities(a)).filter(k=>!k.startsWith('url:')).map(split),right=(b.listingKeys??jobIdentities(b)).filter(k=>!k.startsWith('url:')).map(split);
  return left.some(([namespace,id])=>right.some(([other,value])=>namespace===other&&id!==value))&&!left.some(([namespace,id])=>right.some(([other,value])=>namespace===other&&id===value));
}
