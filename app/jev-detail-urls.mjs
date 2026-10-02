// Keep the observed navigation URL. Only the comparison key removes browser
// text highlights, a trailing slash and common tracking parameters; routes and
// IDs stay. The list is cross-site analytics/ads provenance, not site rules.
export const TRACKING_PARAMETER=/^(?:utm_.+|fbclid|gclid|dclid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|trk|trkInfo|trackingId|gh_src)$/i;
export function jevDetailKey(raw){
 const url=new URL(raw);
 if(url.hash.includes(':~:text=')){const fragment=url.hash.split(':~:')[0];url.hash=fragment==='#'?'':fragment;}
 for(const key of [...url.searchParams.keys()])if(TRACKING_PARAMETER.test(key))url.searchParams.delete(key);
 url.pathname=url.pathname.replace(/\/$/,'')||'/';
 url.searchParams.sort();return url.href;
}
export function uniqueJevDetails(items){
 const groups=new Map();
 for(const item of items){
  const key=jevDetailKey(item.url),old=groups.get(key);
  if(!old){groups.set(key,{...item,aliases:[...new Set([item.url,...(item.aliases??[])])]});continue;}
  const aliases=[...new Set([...old.aliases,item.url,...(item.aliases??[])])];
  groups.set(key,{...(item.collected&&!old.collected?item:old),url:old.url,aliases});
 }
 return [...groups.values()].map(item=>{if(item.aliases.length===1)delete item.aliases;return item;});
}
