import {randomUUID} from 'node:crypto';

export const siteKey=url=>new URL(url).hostname.toLowerCase().replace(/^www\./,'');
const minute=60000;
export function accessBarrier({status,text=''}){
 if(status===429)return 'rate_limit';
 // A quoted error in a listing is not a site-wide access barrier.
 const page=text.trim();if(page.length>12000)return null;
 return /^(?:IP-Bereich vorübergehend gesperrt\.?|Your IP (?:address |range )?(?:has been |is )?(?:temporarily )?blocked\.?|IP (?:address |range )?(?:has been |is )?(?:temporarily )?blocked\.?)/i.test(page)?'ip_block':null;
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
  Object.assign(this,{db,now,changed});
  db.exec('CREATE TABLE IF NOT EXISTS browser_site_waits(site TEXT PRIMARY KEY,data TEXT NOT NULL)');
 }
 row(url){return JSON.parse(this.db.prepare('SELECT data FROM browser_site_waits WHERE site=?').get(siteKey(url))?.data??'null');}
 save(value){this.db.prepare('INSERT INTO browser_site_waits(site,data) VALUES(?,?) ON CONFLICT(site) DO UPDATE SET data=excluded.data').run(value.site,JSON.stringify(value));this.changed();return value;}
 status(url){
  const row=this.row(url);if(!row)return null;
  const {token,leaseUntil=0,...state}=row,retryAt=Math.max(row.retryAt,leaseUntil),probing=leaseUntil>this.now();
  return {...state,retryAt,probing,waiting:retryAt>this.now(),message:`${row.site}: ${row.reason==='ip_block'?'IP engeli':'İstek sınırı'} nedeniyle ortak bekleme. ${probing?'Tek bir erişim kontrolü sürüyor.':`Sonraki kontrol: ${new Date(retryAt).toLocaleString('tr-TR')}.`} Diğer siteler çalışmaya devam edebilir.`};
 }
 begin(url){
  const wait=this.status(url);if(!wait)return null;
  if(wait.waiting)throw new SiteWaitError(wait);
  const token=randomUUID();this.save({...this.row(url),token,leaseUntil:this.now()+minute});return token;
 }
 assertAction(url){const wait=this.status(url);if(wait)throw new SiteWaitError(wait);}
 block(url,reason,retryAfter,token){
  const previous=this.row(url);
  // Re-reading an existing barrier must not keep extending the wait.
  if(previous&&(previous.retryAt>this.now()||previous.leaseUntil>this.now()&&previous.token!==token))return this.status(url);
  const attempts=(previous?.attempts??0)+1,now=this.now();
  this.save({site:siteKey(url),reason,attempts,blockedAt:now,retryAt:retryAfterTime(retryAfter,now)??now+Math.min(120,30*2**Math.min(attempts-1,2))*minute,token:null,leaseUntil:0});
  return this.status(url);
 }
 complete(url,token,{status,reason,retryAfter}={}){
  if(reason)return this.block(url,reason,retryAfter,token);
  const previous=this.row(url);if(!previous||!token||previous.token!==token)return null;
  if(status>=200&&status<400){this.db.prepare('DELETE FROM browser_site_waits WHERE site=?').run(previous.site);this.changed();return null;}
  // A failed/uncertain probe is not proof that access recovered.
  this.save({...previous,token:null,leaseUntil:0,retryAt:this.now()+minute});return this.status(url);
 }
}
