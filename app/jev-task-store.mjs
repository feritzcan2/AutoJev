import {randomUUID} from 'node:crypto';
import {observedLinks} from './automation-scan.mjs';
import {jevDetailKey} from './jev-detail-urls.mjs';
import {siteKey} from './site-access.mjs';

const copy=value=>structuredClone(value);
// Helper tasks and raw page bodies belong to this app process. The parent
// queue and saved findings are durable; after app restart, read pending URLs
// again instead of recovering these temporary helper IDs from disk.
export class JevTaskStore {
 constructor(db,now=Date.now){this.db=db;this.now=now;this.epoch=randomUUID();this.tasks=new Map();this.bodies=new Map();this.briefs=new Map();this.briefJobs=new Map();this.detailWaits=new Map();this.hostWaits=new Map();}
 recordBriefUsage(owner,taskId,evidenceId,usage={},requestCount=1){
  this.fullEvidence(owner,taskId,evidenceId);const body=this.bodies.get(evidenceId),task=this.get(owner,taskId,body.jevTaskId);
  task.usage.calls+=requestCount;for(const key of ['input_tokens','output_tokens'])task.usage[key]+=Number.isSafeInteger(usage?.[key])?usage[key]:0;this.save(task);
 }
 detailWait(owner,taskId,url){
  for(const [map,key] of [[this.hostWaits,JSON.stringify([owner,taskId,siteKey(url)])],[this.detailWaits,JSON.stringify([owner,taskId,jevDetailKey(url)])]]){
   const wait=map.get(key);if(wait?.retryAt>this.now())return wait;map.delete(key);
  }
  return null;
 }
 deferDetail(owner,taskId,url,{error,retryAt,blockedSite,siteWait}){
  const wait={owner,taskId,error,retryAt,blockedSite,...(siteWait?{siteWait}: {})};this.detailWaits.set(JSON.stringify([owner,taskId,jevDetailKey(url)]),wait);
  if(blockedSite)this.hostWaits.set(JSON.stringify([owner,taskId,blockedSite]),wait);
 }
 create(owner,taskId,input){return this.save({id:randomUUID(),automationId:owner,taskId,input,status:'pending',createdAt:this.now(),steps:0,usage:{input_tokens:0,output_tokens:0,calls:0},items:[],visited:[],answers:{}});}
 get(owner,taskId,id){
  const task=this.tasks.get(id);
  if(!task||task.automationId!==owner||task.taskId!==taskId)throw Error('Jev görevi bu çalışma alanına ve atanmış işe ait değil veya uygulama kapanınca süresi doldu. Bekleyen adresler için yeni bir Jev okuma görevi başlat.');
  return copy(task);
 }
 save(task){
  const previous=this.tasks.get(task.id);
  if(previous&&(previous.automationId!==task.automationId||previous.taskId!==task.taskId))throw Error('Jev görevinin sahibi değiştirilemez.');
  if(!this.db.prepare('SELECT 1 FROM automations WHERE id=?').get(task.automationId))throw Error('Otomasyon bulunamadı');
  task.updatedAt=this.now();this.tasks.set(task.id,copy(task));return task;
 }
 list(owner,taskId){return [...this.tasks.values()].filter(t=>t.automationId===owner&&t.taskId===taskId).reverse().map(copy);}
 atomic(fn){
  const tasks=new Map(this.tasks),bodies=new Map(this.bodies),detailWaits=new Map(this.detailWaits),hostWaits=new Map(this.hostWaits);
  try{return fn();}catch(error){this.tasks=tasks;this.bodies=bodies;this.detailWaits=detailWaits;this.hostWaits=hostWaits;throw error;}
 }
 release(owner,taskId){
  for(const map of [this.detailWaits,this.hostWaits])for(const [key,wait] of map)if(wait.owner===owner&&(taskId===undefined||wait.taskId===taskId))map.delete(key);
  for(const [id,task] of this.tasks)if(task.automationId===owner&&(taskId===undefined||task.taskId===taskId)){
   this.tasks.delete(id);for(const [key,body] of this.bodies)if(body.jevTaskId===id){this.bodies.delete(key);this.briefs.delete(key);this.briefJobs.delete(key);}
  }
 }
 resumeAccess(owner,taskId,sites){
  const matching=wait=>sites.includes(wait.blockedSite??wait.siteWait?.site);
  for(const map of [this.detailWaits,this.hostWaits])for(const [key,wait] of map)if(wait.owner===owner&&wait.taskId===taskId&&matching(wait))map.delete(key);
  for(const task of this.list(owner,taskId)){
   for(const site of sites)if(task.blockedSites)delete task.blockedSites[site];
   for(const item of task.items)if(item.error==='access_barrier'&&matching(item))for(const key of ['error','retryAt','blockedSite','siteWait','readAttempts','readUrl'])delete item[key];
   if(task.issue?.reason==='access_barrier'&&(!task.issue.siteWait||sites.includes(task.issue.siteWait.site))){delete task.issue;task.status='continue';}
   this.save(task);
  }
 }
 observedUrls(owner,taskId,searchId){
  const ids=new Set(this.list(owner,taskId).filter(t=>(t.searchId??'default')===searchId).map(t=>t.id)),urls=new Set();
  for(const body of this.bodies.values())if(ids.has(body.jevTaskId)){
   const e=body.value;
   for(const value of [e.url,...observedLinks({content:[{type:'text',text:JSON.stringify({links:e.links})},{type:'text',text:e.text}]},e.url)]){
    try{const u=new URL(value);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)urls.add(u.href);}catch{}
   }
  }
  return [...urls];
 }
 evidence(task,page){
  this.get(task.automationId,task.taskId,task.id);
  // SPA pagination can change every listing while keeping the same URL.
  // Discovery checkpoints must retain the page each link was observed on.
  const old=task.input.operation==='scan_results'?undefined:[...this.bodies.values()].find(body=>body.jevTaskId===task.id&&body.value.url===page.url),id=old?.value.id??randomUUID();
  const value={id,url:page.url,title:page.title??'',text:page.text??'',links:page.links??[],pagination:page.pagination??[],at:this.now(),unreadFrames:page.reading?.unreadFrames??0};
  this.briefs.delete(id);
  this.bodies.set(id,{jevTaskId:task.id,value:copy(value)});return value;
 }
 readEvidence(owner,taskId,id,{offset=0,limit=6000}={}){
  const value=this.fullEvidence(owner,taskId,id);
  if(!Number.isSafeInteger(offset)||offset<0||offset>value.text.length||!Number.isSafeInteger(limit)||limit<1||limit>6000)throw Error('Geçersiz kanıt aralığı.');
  return {id,url:value.url,title:value.title,at:value.at,totalCharacters:value.text.length,offset,text:value.text.slice(offset,offset+limit),nextOffset:offset+limit<value.text.length?offset+limit:null,unreadFrames:value.unreadFrames};
 }
 fullEvidence(owner,taskId,id,jevTaskId){
  const body=this.bodies.get(id),task=body&&this.tasks.get(body.jevTaskId);
  if(!task||task.automationId!==owner||task.taskId!==taskId||jevTaskId&&body.jevTaskId!==jevTaskId)throw Error('Jev kanıtı bu göreve ait değil veya uygulama kapanınca süresi doldu. İlanı yeniden oku.');
  return copy(body.value);
 }
}
