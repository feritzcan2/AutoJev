// Only known vacancy routes yield an identity. Login, search and generic success
// pages must never become an identity shared by unrelated applications.
export function canonicalJobUrl(raw){
  if(typeof raw!=='string'||!raw.trim()||raw.length>3000)throw Error('Geçersiz ilan bağlantısı');
  const url=new URL(raw.trim());
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz ilan bağlantısı');
  url.hash='';
  for(const key of [...url.searchParams.keys()])if(/^(utm_|trk$|trackingId$|ref$|source$|gh_src$)/i.test(key))url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString().replace(/\/$/,'');
}

export function listingIdentity(raw){
  let url,path;
  try{url=new URL(canonicalJobUrl(raw));path=decodeURIComponent(url.pathname);}catch{return null;}
  const host=url.hostname.toLowerCase(),match=(pattern)=>path.match(pattern);
  const identity=(namespace,id)=>({namespace,id,key:`${namespace}:${id}`});
  let m;
  if(/^(?:[a-z]{2,3}\.)?linkedin\.com$/.test(host)&&(m=match(/^\/jobs\/view\/(?:[^/]*-)?(\d+)(?:\/)?$/)))return identity('linkedin',m[1]);
  if(/^(?:www\.)?stepstone\.(?:de|at|be|nl|fr|com)$/.test(host)&&(m=match(/--(\d+)-inline\.html$/)))return identity('stepstone:'+host.replace(/^www\./,''),m[1]);
  if((m=host.match(/^([a-z0-9-]+)\.jobs\.personio\.(?:de|com)$/))){const job=match(/^\/job\/(\d+)(?:\/(?:application|apply))?\/?$/);if(job)return identity('personio:'+m[1],job[1]);}
  if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(host)&&(m=match(/^\/([^/]+)\/jobs\/(\d+)(?:\/(?:confirmation|application))?\/?$/)))return identity('greenhouse:'+m[1].toLowerCase(),m[2]);
  if(['jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com'].includes(host)&&(m=match(/^\/([^/]+)\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:\/(?:apply|application|thanks|confirmation|already-received))?\/?$/i)))return identity((host==='jobs.ashbyhq.com'?'ashby:':'lever:')+m[1].toLowerCase(),m[2].toLowerCase());
  if(host==='join.com'&&(m=match(/^\/companies\/([^/]+)\/(\d+)(?:-[^/]*)?\/?$/)))return identity('join:'+m[1].toLowerCase(),m[2]);
  if(host==='jobs.smartrecruiters.com'&&(m=match(/^\/([^/]+)\/(\d+)(?:-[^/]*)?\/?$/)))return identity('smartrecruiters:'+m[1].toLowerCase(),m[2]);
  if(/^(?:[a-z]{2}|www)\.indeed\.com$/.test(host)&&['/viewjob','/rc/clk'].includes(path)&&/^[a-z0-9]+$/i.test(url.searchParams.get('jk')??''))return identity('indeed',url.searchParams.get('jk'));
  if(['n26.com','www.n26.com'].includes(host)&&(m=match(/^\/[a-z]{2}-[a-z]{2}\/careers\/positions\/(\d+)\/?$/)))return identity('n26',m[1]);
  return null;
}

export const jobUrlKey=url=>listingIdentity(url)?.key??'url:'+canonicalJobUrl(url);
export const jobIdentities=job=>[...new Set([job.url,job.proof?.url].map(url=>listingIdentity(url)?.key).filter(Boolean))];
export function conflictingIdentities(a,b){
  const split=key=>[key.slice(0,key.lastIndexOf(':')),key.slice(key.lastIndexOf(':')+1)];
  const left=(a.listingKeys??jobIdentities(a)).filter(k=>!k.startsWith('url:')).map(split),right=(b.listingKeys??jobIdentities(b)).filter(k=>!k.startsWith('url:')).map(split);
  return left.some(([namespace,id])=>right.some(([other,value])=>namespace===other&&id!==value))&&!left.some(([namespace,id])=>right.some(([other,value])=>namespace===other&&id===value));
}
