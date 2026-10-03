import {randomUUID} from 'node:crypto';

export const siteKey=url=>new URL(url).hostname.toLowerCase().replace(/^www\./,'');
// Two addresses belong to the same site when their registrable domains match,
// so a www redirect or a job board on a subdomain still counts as the source.
const siteDomain=host=>{const labels=host.split('.');const keep=labels.length>2&&labels.at(-2).length<=3&&labels.at(-1).length<=3?3:2;return labels.slice(-keep).join('.');};
export const sameSite=(a,b)=>{const x=siteKey(a),y=siteKey(b);return x===y||siteDomain(x)===siteDomain(y);};
const minute=60000;
// Adaptive pacing: a site that answered with a rate limit or a verification
// challenge within the last hours keeps a minimum gap between navigations,
// growing with its incidents. Sites without incidents are never slowed.
const PACE_WINDOW=6*60*minute,PACE_STEP=4000,PACE_MAX=12000;
export const siteRetryDelay=attempt=>[5*minute,10*minute][attempt-1]??null;
export function migrateSiteAccessRetries(db){
 if(db.prepare('PRAGMA user_version').get().user_version>=31||!db.prepare("SELECT 1 FROM sqlite_master WHERE name='browser_site_waits'").get())return;
 const waits=new Map();
 for(const row of db.prepare('SELECT site,data FROM browser_site_waits').all()){
  const old=JSON.parse(row.data),delay=siteRetryDelay(old.attempts),wait={...old,attempts:Math.min(old.attempts,3),retryAt:delay===null?null:old.blockedAt+delay};
  if(delay===null){wait.token=null;wait.leaseUntil=0;}
  db.prepare('UPDATE browser_site_waits SET data=? WHERE site=?').run(JSON.stringify(wait),row.site);waits.set(row.site,wait);
 }
 for(const table of ['automation_runs','automations']){
  if(!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table))continue;
  for(const row of db.prepare(`SELECT id,data FROM ${table}`).all()){
   const data=JSON.parse(row.data);let changed=false;
   const update=wait=>{const current=waits.get(wait?.site);if(!current||current.blockedAt!==wait.blockedAt)return wait;changed=true;return {...wait,retryAt:current.retryAt,...('reason' in wait?{attempts:current.attempts,exhausted:current.retryAt===null}: {})};};
   if(data.siteWait)data.siteWait=update(data.siteWait);
   for(const source of Object.values(data.sourceState??{})){
    const recovery=source.accessRecovery;if(!recovery?.waits)continue;
    const previous=Math.max(...recovery.waits.map(w=>w.retryAt));recovery.waits=recovery.waits.map(update);
    const next=recovery.waits.some(w=>w.retryAt===null)?null:Math.max(...recovery.waits.map(w=>w.retryAt));
    if(next===null||recovery.retryAt===previous){recovery.retryAt=next;if(recovery.state==='fresh')source.nextRunAt=next;}
   }
   for(const [key,retry] of Object.entries(data.retryPlan??{})){
    const run=db.prepare('SELECT data FROM automation_runs WHERE id=?').get(key);if(!run)continue;
    const wait=JSON.parse(run.data).siteWait;if(!wait||!waits.has(wait.site))continue;
    if(wait.retryAt===null)delete data.retryPlan[key];else retry.at=wait.retryAt;changed=true;
   }
   if(changed)db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(data),row.id);
  }
 }
}
export function accessBarrier({status,title='',text=''}){
 if(status===429)return 'rate_limit';
 // A quoted error in a listing is not a site-wide access barrier.
 const page=text.trim();if(page.length>12000)return null;
 // Require both a challenge title and its verification body. Listings may
 // legitimately mention Cloudflare or quote a verification error.
 const challengeTitle=/^(?:Just a moment[.!…]*|Additional Verification Required|Attention Required!?\s*\|\s*Cloudflare)$/i.test(title.trim());
 const verificationLine=/^(?:Additional Verification Required|Verify you are human(?: by completing the action below)?[.!]?|Verifying you are human[.!…]*|Performing security verification[.!…]*|Checking your browser(?: before accessing [^\n]+)?[.!…]*)\s*$/im.test(page)||/This page is displayed while the website verifies you are not a bot/i.test(page);
 if(challengeTitle&&verificationLine&&/(?:\bCloudflare\b|\b(?:Your )?Ray ID\b)/i.test(page))return 'verification';
 return /^(?:Your IP (?:address |range )?(?:has been |is )?(?:temporarily )?blocked\.?|IP (?:address |range )?(?:has been |is )?(?:temporarily )?blocked\.?)/i.test(page)?'ip_block':null;
}
export function retryAfterTime(value,now){
 if(!value)return null;
 const at=/^\d+$/.test(value.trim())?now+Number(value)*1000:Date.parse(value);
 return Number.isFinite(at)&&at>now?at:null;
}
export class SiteWaitError extends Error{
 constructor(wait){super(wait.message);this.code='SITE_WAIT';this.wait=wait;}
}
export class SiteAccess{
 constructor(db,{now=Date.now,changed=()=>{}}={}){
  Object.assign(this,{db,now,changed});this.incidents=new Map();this.paced=new Map();
  db.exec('CREATE TABLE IF NOT EXISTS browser_site_waits(site TEXT PRIMARY KEY,data TEXT NOT NULL)');
 }
 row(url){return JSON.parse(this.db.prepare('SELECT data FROM browser_site_waits WHERE site=?').get(siteKey(url))?.data??'null');}
 save(value){this.db.prepare('INSERT INTO browser_site_waits(site,data) VALUES(?,?) ON CONFLICT(site) DO UPDATE SET data=excluded.data').run(value.site,JSON.stringify(value));this.changed();return value;}
 status(url){
  const row=this.row(url);if(!row||row.recovered)return null;
  const {token,leaseUntil=0,...state}=row,exhausted=row.attempts>=3,retryAt=exhausted?null:Math.max(row.retryAt,leaseUntil),probing=!exhausted&&leaseUntil>this.now();
  return {...state,retryAt,exhausted,probing,waiting:exhausted||retryAt>this.now(),message:`${row.site}: ${row.reason==='ip_block'?'IP engeli':row.reason==='verification'?'Erişim doğrulaması':'İstek sınırı'} nedeniyle ortak bekleme. ${exhausted?'Üçüncü erişim hatası; otomatik deneme durduruldu. Devam etmek için müdahale gerekiyor.':probing?'Tek bir erişim kontrolü sürüyor.':`Otomatik devam: ${new Date(retryAt).toLocaleString('tr-TR')}.`} Diğer siteler çalışmaya devam edebilir.`};
 }
 begin(url){
  const wait=this.status(url);if(!wait)return null;
  if(wait.waiting)throw new SiteWaitError(wait);
  const token=randomUUID();this.save({...this.row(url),token,leaseUntil:this.now()+minute});return token;
 }
 assertAction(url){const wait=this.status(url);if(wait)throw new SiteWaitError(wait);}
 // Only the explicit user-response path may retire an old cooldown early.
 // A later incident or an in-flight probe must not be cleared by a stale card.
 acknowledge(waits){
  for(const wait of waits){const row=this.row('https://'+wait.site);if(row&&(row.blockedAt!==wait.blockedAt||row.leaseUntil>this.now()))throw Error('Bu sitede yeni bir erişim beklemesi var. Güncel müdahale kartını kontrol et.');}
  for(const wait of waits)this.db.prepare('DELETE FROM browser_site_waits WHERE site=?').run(wait.site);
  this.changed();
 }
 // A successful page probe lets the scan continue, but must not give a scan
 // that keeps failing a fresh retry budget. Retire it only when that task ends.
 finish(waits){
  for(const wait of waits){const row=this.row('https://'+wait.site);if(row?.recovered&&row.blockedAt===wait.blockedAt)this.db.prepare('DELETE FROM browser_site_waits WHERE site=?').run(wait.site);}
  this.changed();
 }
 block(url,reason,retryAfter,token){
  const previous=this.row(url);
  // Re-reading an existing barrier must not keep extending the wait.
  if(previous&&!previous.recovered&&(previous.attempts>=3||previous.retryAt>this.now()||previous.leaseUntil>this.now()&&previous.token!==token))return this.status(url);
  const attempts=(previous?.attempts??0)+1,now=this.now();
  // The workspace policy uses fixed delays, independent of Retry-After.
  const delay=siteRetryDelay(attempts);
  this.save({site:siteKey(url),reason,attempts,blockedAt:now,retryAt:delay===null?null:now+delay,token:null,leaseUntil:0});
  this.incidents.set(siteKey(url),{at:now,count:(this.incidents.get(siteKey(url))?.count??0)+1});
  return this.status(url);
 }
 // Milliseconds the caller should wait before navigating to this site. Each
 // call reserves the next slot, so concurrent workers queue instead of bursting.
 pace(url){
  const site=siteKey(url),now=this.now(),row=this.incidents.has(site)?null:this.row(url);
  const incident=this.incidents.get(site)??(row?{at:row.blockedAt,count:row.attempts}:null);
  if(!incident||now-incident.at>PACE_WINDOW)return 0;
  const gap=Math.min(PACE_STEP*incident.count,PACE_MAX),next=Math.max(now,(this.paced.get(site)??0)+gap);
  this.paced.set(site,next);return next-now;
 }
 complete(url,token,{status,reason,retryAfter}={}){
  if(reason)return this.block(url,reason,retryAfter,token);
  const previous=this.row(url);if(!previous||!token||previous.token!==token)return null;
  if(status>=200&&status<400){this.save({...previous,recovered:true,token:null,leaseUntil:0,retryAt:null});return null;}
  // A failed/uncertain probe is not proof that access recovered.
  return this.block(url,previous.reason,retryAfter,token);
 }
}
