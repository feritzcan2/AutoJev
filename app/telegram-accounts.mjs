import {readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {TelegramStore} from './telegram-store.mjs';
import {TelegramBot,TelegramApi} from './telegram.mjs';

const unreadable='Kayıtlı Telegram ayarı okunamadı. Bu adayın bot token’ını yeniden kaydet.';

export class Telegram{
 constructor({store,data,encrypt,decrypt,answer,queueApplication,withdrawApplication,changed=()=>{},apiFactory=token=>new TelegramApi(token),now=Date.now}){
  Object.assign(this,{store,file:path.join(data,'telegram.json'),encrypt,decrypt,answer,queueApplication,withdrawApplication,changed,apiFactory,now});
  this.db=new TelegramStore(store,now);this.workers=new Map();this.errors=new Map();this.configuring=false;
 }
 async migrateLegacy(){
  if(this.db.meta('candidate-configs-migrated'))return;
  let legacy;
  try{legacy=JSON.parse(await readFile(this.file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(legacy&&(!Number.isSafeInteger(legacy.bot?.id)||!legacy.bot.username||typeof legacy.secret!=='string'))throw Error(unreadable);
  this.db.transaction(()=>{
   if(legacy){
    const owners=this.store.db.prepare('SELECT candidate_id FROM telegram_links UNION SELECT candidate_id FROM telegram_pairs').all().map(row=>row.candidate_id);
    const candidates=this.store.candidates();if(!owners.length&&candidates.length===1)owners.push(candidates[0].id);
    for(const candidate of owners)if(!this.db.config(candidate))this.db.saveConfig(candidate,legacy);
    this.store.db.prepare("UPDATE telegram_links SET bot_id=? WHERE bot_id='' AND candidate_id IN (SELECT candidate_id FROM telegram_configs WHERE bot_id=?)").run(String(legacy.bot.id),String(legacy.bot.id));
    const scoped=new TelegramStore(this.store,this.now,legacy.bot.id);
    for(const key of ['offset','sendAfter'])scoped.setMeta(key,this.db.meta(key,0));
   }
   this.db.setMeta('candidate-configs-migrated',1);
  });
  if(legacy)await rm(this.file,{force:true});
 }
 async load(){
  try{await this.migrateLegacy();}catch{this.loadError=unreadable;}
  for(const botId of new Set(this.db.configs().map(config=>config.bot_id)))await this.sync(botId);
 }
 async sync(botId){
  botId=String(botId);
  const old=this.workers.get(botId);if(old)await old.stop();this.workers.delete(botId);this.errors.delete(botId);
  const configs=this.db.configs().filter(config=>config.bot_id===botId),saved=(configs.find(config=>config.data.enabled)||configs[0])?.data;
  if(!saved)return;
  try{
   const worker=new TelegramBot({store:this.store,botId,answer:this.answer,queueApplication:this.queueApplication,withdrawApplication:this.withdrawApplication,changed:this.changed,now:this.now});
   worker.config={enabled:configs.some(config=>config.data.enabled),bot:saved.bot};worker.api=this.apiFactory(this.decrypt(saved.secret));
   this.workers.set(botId,worker);if(worker.config.enabled)worker.start();
  }catch{this.errors.set(botId,unreadable);}
 }
 status(candidate=null){
  const config=candidate?this.db.config(candidate):null,worker=config&&this.workers.get(config.bot_id);
  return {configured:Boolean(config),enabled:Boolean(config?.data.enabled),running:Boolean(config?.data.enabled&&worker?.controller),
   bot:config?.data.bot??null,error:(config?this.errors.get(config.bot_id)||worker?.error:null)||this.loadError||null,candidate:this.db.status(candidate)};
 }
 async configure(candidate,input){
  this.store.profile(candidate);
  if(this.configuring)throw Error('Telegram ayarı kaydediliyor.');this.configuring=true;
  let affected=[];
  try{
   if(!input||typeof input.enabled!=='boolean')throw Error('Geçersiz Telegram ayarı');
   const previous=this.db.config(candidate),typed=typeof input.token==='string'?input.token.trim():'';
   const token=typed||(previous?this.decrypt(previous.data.secret):'');
   if(!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token))throw Error('BotFather’dan aldığın bot token’ını gir.');
   const api=this.apiFactory(token);let bot=previous?.data.bot;
   if(input.enabled||typed||!bot){
    bot=await api.call('getMe');if(!bot?.is_bot||!bot.username||!Number.isSafeInteger(bot.id))throw Error('Geçerli bir Telegram botu gerekli.');
    const webhook=await api.call('getWebhookInfo');if(webhook?.url)throw Error('Bu botta webhook etkin. AutoJev için ayrı bir bot oluştur veya mevcut webhook’u kaldır.');
   }
   const config={enabled:input.enabled,bot:{id:bot.id,username:bot.username},secret:this.encrypt(token)},botId=String(bot.id);
   affected=[...new Set([previous?.bot_id,botId].filter(Boolean))];
   // Finish in-flight requests before moving a candidate's queues to another bot.
   await Promise.all(affected.map(id=>this.workers.get(id)?.stop()));
   this.store.profile(candidate);
   this.db.transaction(()=>{
    if(previous?.bot_id!==botId)this.db.clearConnection(candidate);
    this.db.saveConfig(candidate,config);
    // A rotated token for a shared bot must also replace its other saved copies.
    for(const other of this.db.configs())if(other.bot_id===botId&&other.candidate_id!==candidate)this.db.saveConfig(other.candidate_id,{...other.data,bot:config.bot,secret:config.secret});
   });
   this.loadError=null;
  }finally{
   try{for(const id of affected)await this.sync(id);}finally{this.configuring=false;}
  }
  this.changed(candidate);return this.status(candidate);
 }
 worker(candidate,{enabled=false}={}){
  this.store.profile(candidate);const config=this.db.config(candidate),worker=config&&this.workers.get(config.bot_id);
  if(this.configuring)throw Error('Telegram ayarı kaydediliyor.');
  if(!worker||(enabled&&!config.data.enabled))throw Error('Önce bu adayın Telegram botunu kaydedip aç.');
  return worker;
 }
 pairing(candidate){return this.worker(candidate,{enabled:true}).pairing(candidate);}
 unlink(candidate){if(this.configuring)throw Error('Telegram ayarı kaydediliyor.');this.db.unlink(candidate);this.changed(candidate);return this.status(candidate);}
 preferences(candidate,input){const worker=this.worker(candidate);worker.preferences(candidate,input);return this.status(candidate);}
 retry(candidate){this.worker(candidate).retry(candidate);return this.status(candidate);}
 sendUnsentJobs(candidate,input){return this.worker(candidate,{enabled:true}).sendUnsentJobs(candidate,input);}
 async removeCandidate(candidate){
  if(this.configuring)throw Error('Telegram ayarı kaydediliyor.');
  const botId=this.db.config(candidate)?.bot_id;if(!botId)return;
  this.configuring=true;
  try{
   await this.workers.get(botId)?.stop();
   this.db.transaction(()=>{this.db.clearConnection(candidate);this.store.db.prepare('DELETE FROM telegram_configs WHERE candidate_id=?').run(candidate);});
  }finally{try{await this.sync(botId);}finally{this.configuring=false;}}
 }
 async stop(){await Promise.allSettled([...this.workers.values()].map(worker=>worker.stop()));}
}
