import {conflictingIdentities} from './job-urls.mjs';
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu,' ').trim();
const companyKey=value=>normalize(value).replace(/(?:\s+(?:gmbh co kg|gmbh|ggmbh|ag|se|inc|llc|ltd|limited|plc|corporation))+$/,'');
const roleKey=value=>normalize(String(value??'').replace(/\((?:(?:[mfwxd]\s*\/\s*){2}[mfwxd]|all genders)\)/gi,''));
export const vacancyGroupKey=job=>companyKey(job.company)+'|'+roleKey(job.role);
function locationKey(value){
  if(!value||/konum.*belirtilmemiş|not specified|not provided|unknown|unspecified/i.test(value))return null;
  return normalize(String(value).replace(/\([^)]*\b(?:office|remote|hybrid|hibrit|onsite)\b[^)]*\)/gi,''))
    .replace(/\b(?:germany|deutschland|hybrid|hibrit|on site|onsite)\b/g,'').replace(/\s+/g,' ').trim()||null;
}

// Do not fuzzy-match companies or job titles. A missing imported location is
// a possible duplicate, not evidence that two vacancies are identical.
export function vacancyMatch(a,b){
  if(!companyKey(a.company)||companyKey(a.company)!==companyKey(b.company)||!roleKey(a.role)||roleKey(a.role)!==roleKey(b.role))return null;
  const x=locationKey(a.location),y=locationKey(b.location);
  return x&&y?(x===y?'exact':null):'possible';
}
const priority={already_submitted:4,submitted:4,submitting:3,uncertain:3,prepared:2,working:1};
export function applicationDuplicate(job,jobs){
  if(['submitted','already_submitted','skipped','submitting','uncertain'].includes(job.status))return null;
  const sameRecord=other=>(job.canonicalJobId??job.id)===(other.canonicalJobId??other.id);
  const canonical=job.canonicalJobId&&job.canonicalJobId!==job.id?jobs.find(other=>other.id===job.canonicalJobId):null;
  const previous=canonical??jobs.filter(other=>other.id!==job.id&&priority[other.status]&&(sameRecord(other)||!conflictingIdentities(job,other)&&vacancyMatch(job,other))&&
    ((priority[other.status]??0)>(priority[job.status]??0)||[other.createdAt,other.id].join('|')<[job.createdAt,job.id].join('|')))
    .sort((a,b)=>priority[b.status]-priority[a.status]||String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  return previous?{jobId:previous.id,company:previous.company,role:previous.role,status:previous.status,url:previous.url,match:sameRecord(previous)?'exact':'possible',reason:sameRecord(previous)?'Aynı ilan kimliği için önceki kayıt var; ana kaydı kullan, tekrar başvurma.':'Aynı şirket ve rol için önceki başvuru var; farklı ilan olduğu doğrulanmadan tekrar gönderilmez.'}:null;
}
export function annotateDuplicates(jobs){
  const groups=new Map(),identities=new Map();
  for(const job of jobs){for(const [map,key] of [[groups,vacancyGroupKey(job)],[identities,job.canonicalJobId??job.id]]){if(!map.has(key))map.set(key,[]);map.get(key).push(job);}}
  return jobs.map(job=>{const {duplicateApplication:ignored,...saved}=job;const peers=[...new Set([...groups.get(vacancyGroupKey(job)),...identities.get(job.canonicalJobId??job.id)])];const duplicateApplication=applicationDuplicate(saved,peers);return duplicateApplication?{...saved,duplicateApplication}:saved;});
}

export const canonicalJob=job=>!job.canonicalJobId||job.canonicalJobId===job.id;
export const uniqueJobCount=(jobs,statuses)=>new Set(jobs.filter(j=>statuses.includes(j.status)).map(j=>j.canonicalJobId??j.id)).size;
