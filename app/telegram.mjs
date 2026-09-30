import {setTimeout as delay} from 'node:timers/promises';
import {TelegramStore,applicationCompleted} from './telegram-store.mjs';
import {TelegramConversation,clip} from './telegram-conversation.mjs';
import {applicationQueueState} from './application-queue.mjs';

const errors={400:'Telegram isteği kabul etmedi.',401:'Bot token’ı geçersiz. Yapılandırmadan güncelle.',403:'Aday botu engellemiş olabilir. Telegram’da botu açıp yeniden dene.',409:'Bu bot başka bir uygulama veya webhook tarafından kullanılıyor.',429:'Telegram gönderim sınırına ulaşıldı; yeniden denenecek.'};
const deletable=data=>['new_job','submission','question'].includes(data.kind)||data.kind==='message'&&Boolean(data.questionId)&&!data.promptId;
const jobCard=data=>['new_job','submission'].includes(data.kind);
const html=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const jobHeading=job=>`<b>${html(job.role)}</b>\n🏢 <b>${html(job.company)}</b>${job.location?`\n📍 ${html(job.location)}`:''}`;
const jobStatus=job=>{
 let status={found:'🔵 İlan bulundu',working:'🟣 Başvuru hazırlanıyor',prepared:'🟢 Gönderime hazır',submitting:'🟣 Başvuru gönderiliyor',submitted:'✅ Başvuru gönderildi',already_submitted:'✅ Başvuru gönderildi',blocked:'🟠 Bilgi / işlem bekliyor',uncertain:'🟠 Gönderim sonucu doğrulanmalı',skipped:'⚫ Elendi'}[job.status]??'⚪ Durum bilinmiyor';
 if(job.status==='submitted'&&(job.candidateSubmission||job.manualOutcome==='manual_submitted'))status+=' (kullanıcı beyanı)';
 if(job.status==='blocked'&&job.missingDocuments)status='🟠 Eksik belge bekliyor';
 if(job.manualOutcome==='withdrawn')return '🔴 Başvurudan vazgeçildi';
 if(job.followupStopped)status=job.status==='skipped'?'⚫ Başvuru takibi bırakıldı':`${status} · Takip bırakıldı`;
 return status;
};
const withDeleteButton=(row,body)=>deletable(row.data)&&body.reply_markup?.inline_keyboard?{...body,reply_markup:{inline_keyboard:[...body.reply_markup.inline_keyboard,[{text:jobCard(row.data)?'🗑 Sil · Vazgeç':'🗑 Sil',style:'danger',callback_data:`d:${row.id}`}]]}}:body;
export class TelegramApi{
 constructor(token,{fetcher=fetch}={}){this.token=token;this.fetcher=fetcher;}
 async call(method,body={},signal){
  let response,result;
  try{
   response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([AbortSignal.timeout(method==='getUpdates'?40000:15000),...(signal?[signal]:[])])});
   result=await response.json();
  }catch{throw Object.assign(Error('Telegram’a ulaşılamıyor. İnternet bağlantısını kontrol et; yeniden denenecek.'),{code:0});}
  if(!response.ok||!result.ok){
   const code=Number(result.error_code)||response.status;
   // Classify only these known edit outcomes; never expose remote descriptions or tokens.
   const description=method==='editMessageText'&&code===400?String(result.description??'').toLowerCase():'';
   const editResult=description.startsWith('bad request: message is not modified')?'unchanged':description==='bad request: message to edit not found'?'missing':null;
   throw Object.assign(Error(errors[code]??'Telegram geçici bir hata döndürdü; yeniden denenecek.'),{code,editResult,retryAfter:Math.max(0,Number(result.parameters?.retry_after)||0)});
  }
  return result.result;
 }
}

// One polling worker per bot. Candidate assignments are enforced by TelegramStore.
export class TelegramBot{
 constructor({store,botId,answer,queueApplication,withdrawApplication,changed=()=>{},now=Date.now}){
  if(botId==null)throw Error('Telegram bot kimliği gerekli.');
  Object.assign(this,{store,queueApplication,withdrawApplication,changed,now});
  this.db=new TelegramStore(store,now,botId);this.conversation=new TelegramConversation(this.db,{answer,changed});
  this.config={enabled:false,bot:null};this.error=null;this.api=null;this.controller=null;this.flushPromise=null;this.nextChatSend=new Map();
 }
 status(candidate=null){return {configured:Boolean(this.api),enabled:Boolean(this.config.enabled),running:Boolean(this.controller),bot:this.config.bot,error:this.error,candidate:this.db.status(candidate)};}
 pairing(candidate){
  if(!this.api||!this.config.enabled)throw Error('Önce Telegram botunu kaydedip aç.');
  const {token,expires}=this.db.pair(candidate);return {url:`https://t.me/${this.config.bot.username}?start=${token}`,expires};
 }
 unlink(candidate){this.db.unlink(candidate);this.changed(candidate);return this.status(candidate);}
 preferences(candidate,input){const link=this.db.preferences(candidate,input);this.db.openQuestions(link);this.changed(candidate);return this.status(candidate);}
 retry(candidate){this.store.profile(candidate);this.db.retry(candidate);return this.status(candidate);}
 sendUnsentJobs(candidate){
  if(!this.api||!this.config.enabled||!this.config.bot)throw Error('Önce Telegram botunu kaydedip aç.');
  const result=this.db.queueUnsentJobs(candidate,this.config.bot.id);this.changed(candidate);return result;
 }
 start(){
  if(this.controller||!this.api)return;
  this.controller=new AbortController();const {signal}=this.controller;
  this.pollPromise=this.poll(signal).catch(()=>{if(!signal.aborted)this.error='Telegram bağlantısı durdu. Ayarlardan kapatıp yeniden aç.';});
  const tick=()=>{if(!this.flushPromise)this.flush(signal).catch(()=>{if(!signal.aborted)this.error='Telegram mesaj kuyruğu işlenemedi.';});};
  tick();this.timer=setInterval(tick,3000);this.timer.unref?.();
 }
 async stop(){
  clearInterval(this.timer);this.controller?.abort();
  await Promise.allSettled([this.pollPromise,this.flushPromise]);this.controller=null;
 }
 async poll(signal){
  while(!signal.aborted){
   try{
    const updates=await this.api.call('getUpdates',{offset:Number(this.db.meta('offset',0)),timeout:25,allowed_updates:['message','callback_query']},signal);
    if(signal.aborted)return;
    this.error=null;
    for(const update of updates){
     if(signal.aborted)return;
     if(!Number.isSafeInteger(update.update_id)||update.update_id<Number(this.db.meta('offset',0)))continue;
     if(update.callback_query?.data?.startsWith('d:')){
      const result=await this.deleteNotification(update.callback_query,signal);
      await this.api.call('answerCallbackQuery',{callback_query_id:update.callback_query.id,...result},signal).catch(()=>{});
      this.db.setMeta('offset',update.update_id+1);continue;
     }
     if(update.callback_query?.data?.startsWith('queue:')){
      const result=await this.queueNotification(update.callback_query,signal);
      await this.api.call('answerCallbackQuery',{callback_query_id:update.callback_query.id,...result},signal).catch(()=>{});
      this.db.setMeta('offset',update.update_id+1);continue;
     }
     if(update.callback_query)await this.api.call('answerCallbackQuery',{callback_query_id:update.callback_query.id},signal).catch(()=>{});
     const reply=await this.conversation.handle(update);
     if(reply&&!signal.aborted){
      try{await this.api.call('sendMessage',{chat_id:reply.chat,text:clip(reply.text),link_preview_options:{is_disabled:true}},signal);}
      catch(error){if(![400,403].includes(error.code))throw error;}
     }
     this.db.setMeta('offset',update.update_id+1);
    }
   }catch(error){
    if(signal.aborted)return;this.error=errors[error.code]??'Telegram bağlantısı kesildi; yeniden denenecek.';
    await delay(Math.max(5000,Math.min(300000,(error.retryAfter??5)*1000)),null,{signal}).catch(()=>{});
   }
  }
 }
 notification(callback,action){
  const message=callback.message,user=callback.from,deliveryId=callback.data?.match(new RegExp(`^${action}:([a-f0-9]{24})$`))?.[1];
  if(!deliveryId||message?.chat?.type!=='private'||!Number.isSafeInteger(message.chat.id)||!Number.isSafeInteger(message.message_id)||message.message_id<=0||!Number.isSafeInteger(user?.id)||user.is_bot)return null;
  const link=this.db.sender(message.chat.id,user.id),row=this.db.delivery(deliveryId);
  if(!link||!row||row.candidate_id!==link.candidate_id||row.message_id!==message.message_id)return null;
  return {link,row};
 }
 async updateNotification(row,signal){
  try{
   this.db.prioritizeEdit(row.id);
   // Finish any older in-flight edit before rendering the latest persisted state.
   // The timer and callback share one flush, so an old response cannot overwrite it.
   if(this.flushPromise)await this.flushPromise.catch(()=>{});
   this.db.prioritizeEdit(row.id);
   if(!signal?.aborted)await this.flush(signal);
  }catch{if(!signal?.aborted)this.error='Telegram mesajı güncellenemedi; yeniden denenecek.';}
 }
 async queueNotification(callback,signal){
  const notification=this.notification(callback,'queue');
  if(!notification||notification.row.status!=='sent'||notification.row.data.kind!=='new_job')return {text:'Bu ilan bu bağlantı üzerinden sıraya alınamıyor.',show_alert:true};
  const {row,link}=notification,candidate=link.candidate_id;
  try{
   if(!this.queueApplication)throw Error('Sıraya alma kullanılamıyor. AutoJev’i yeniden başlat.');
   const job=this.store.job(candidate,row.data.jobId),state=applicationQueueState(this.store,candidate,job);
   if(state.state!=='available'){
    this.db.refreshJobMessages(candidate,job.id);await this.updateNotification(row,signal);
    return {text:state.message,show_alert:state.state==='unavailable'};
   }
   // The desktop handler persists the queue request before awaiting agent startup.
   // Refresh that state now; starting the browser/agent must not delay the card.
   const application=this.queueApplication(candidate,job.id);
   this.db.refreshJobMessages(candidate,job.id);this.changed(candidate);
   const [outcome]=await Promise.allSettled([application,this.updateNotification(row,signal)]);
   if(outcome.status==='rejected')throw outcome.reason;
   const result=outcome.value;
   this.db.refreshJobMessages(candidate,job.id);this.changed(candidate);
   await this.updateNotification(row,signal);
   return {text:clip(result?.message||'İlan başvuru sırasına alındı.',200)};
  }catch(error){return {text:clip('Sıraya alınamadı: '+error.message,200),show_alert:true};}
 }
 async deleteNotification(callback,signal){
  const notification=this.notification(callback,'d'),denied={text:'Bu mesaj bu bağlantı üzerinden silinemiyor.',show_alert:true};
  if(!notification||!deletable(notification.row.data))return denied;
  const {row,link}=notification,message=callback.message;
  if(row.status==='deleted')return {text:'Mesaj zaten silindi.'};
  if(row.status!=='sent')return denied;
  let withdrawn=false;
  if(jobCard(row.data)){
   try{
    const job=this.store.job(link.candidate_id,row.data.jobId);
    if(job.manualOutcome!=='withdrawn'){
     if(!this.withdrawApplication)throw Error('AutoJev’i yeniden başlat.');
     // Use the desktop action so an active application is stopped before withdrawal.
     await this.withdrawApplication(link.candidate_id,job.id);
    }
    withdrawn=true;this.db.refreshJobMessages(link.candidate_id,job.id);this.changed(link.candidate_id);
   }catch{return {text:'Vazgeçildi olarak kaydedilemedi; mesaj silinmedi. AutoJev’den kontrol edip yeniden dene.',show_alert:true};}
  }
  const prefix=withdrawn?'Vazgeçildi olarak kaydedildi. ':'';
  if(Number.isFinite(message.date)&&message.date>0&&this.now()-message.date*1000>=48*60*60*1000)return {text:prefix+'Telegram botları 48 saatten eski mesajları silemez. Mesaja basılı tutup Telegram’dan silebilirsin.',show_alert:true};
  try{
   await this.api.call('deleteMessage',{chat_id:link.chat_id,message_id:row.message_id},signal);
   // Keep the delivery receipt so collecting events or retrying cannot send it again.
   this.db.deleted(row.id);return {text:withdrawn?'Mesaj silindi; başvurudan vazgeçildi.':'Mesaj silindi.'};
  }catch(error){
   return {text:prefix+([400,403].includes(error.code)?'Mesaj silinemedi. Telegram’da mesaja basılı tutup silebilirsin.':'Mesaj silinemedi. Biraz sonra Sil düğmesine yeniden bas.'),show_alert:true};
  }
 }
 delivery(row,link,{edit=false}={}){
  const data=row.data;
  if(data.kind==='new_job'){
   if(!edit&&link.data.newJobs===false&&!data.backfill)return null;
   if(!edit&&this.db.jobSent(link.candidate_id,this.config.bot?.id??this.db.meta('bot'),data.jobId))return null;
   let job;try{job=this.store.job(link.candidate_id,data.jobId);}catch{return null;}
   if(!edit&&data.backfill&&applicationCompleted(job))return null;
   const score=job.rank?.status==='scored'&&Number.isFinite(job.rank.score)?`🎯 <b>Uygunluk puanı: ${job.rank.score}/100</b>`:job.rank?.status==='unavailable'?'⚠️ <i>Puan hesaplanamadı</i>':'⚪ <i>Henüz puanlanmadı</i>';
   const queue=this.queueApplication?applicationQueueState(this.store,link.candidate_id,job):null,buttons=[[{text:'İlanı aç',style:'primary',url:job.url}]];
   if(queue?.state==='available')buttons.push([{text:queue.actionLabel,style:'success',callback_data:`queue:${row.id}`}]);
   const status=queue?.state==='queued'?(queue.verificationOnly?'🔵 Öncelikli doğrulama sırasında':'🔵 Başvuru sırasında · Öncelikli'):queue?.state==='active'&&['found','blocked','uncertain'].includes(job.status)?`🟣 ${queue.message}`:jobStatus(job);
   return {text:`<b>${html(status)}</b>\n\n${jobHeading(job)}\n\n${score}`,parse_mode:'HTML',reply_markup:{inline_keyboard:buttons}};
  }
  if(data.kind==='submission'){
   if(!link.data.notifications)return null;
   let job;try{job=this.store.job(link.candidate_id,data.jobId);}catch{return null;}
   const title=data.event==='existing_submission_recorded'?'ℹ️ Bu ilana daha önce başvurulmuş':data.event==='candidate_submission_recorded'?'✅ Başvurun, bildirimin üzerine gönderildi olarak kaydedildi':'✅ Başvurun gönderildi';
   return {text:`<b>${html(title)}</b>\n\n${jobHeading(job)}`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'İlanı aç',style:'primary',url:job.url}]]}};
  }
  if(data.questionId){
   const q=this.db.question(link.candidate_id,data.questionId);
   if(!q||q.answer!==null||q.resolution){
    if(!edit)return null;
    const answered=q?.answer!=null,title=answered?'✅ Yanıtlandı':'⚪ Soru kapandı';
    const question=q?`<b>${html(this.conversation.jobTitle(link,q))}</b>\n\n${html(clip(q.question,1800))}`:'';
    const result=answered?`<b>Yanıtın:</b>\n${html(clip(q.answer,1400))}`:'Bu soru artık yanıt beklemiyor.';
    return {text:`<b>${title}</b>\n\n${question}\n\n${result}`,parse_mode:'HTML',reply_markup:{inline_keyboard:[]}};
   }
   if(!link.data.questions&&!edit)return null;
   if(data.kind==='question'||!data.promptId)return {text:clip(`${this.conversation.jobTitle(link,q)}\n\n${q.question}`,3900),reply_markup:{inline_keyboard:[[{text:'Yanıtla',callback_data:`q:${q.id}`}]]}};
  }
  if(data.promptId&&link.data.dialog?.promptId!==data.promptId)return null;
  return {text:data.text,...(data.reply_markup?{reply_markup:data.reply_markup}:{})};
 }
 flush(signal){
  if(this.flushPromise)return this.flushPromise;
  this.flushPromise=this.flushPending(signal).finally(()=>{this.flushPromise=null;});
  return this.flushPromise;
 }
 async flushPending(signal){
  this.db.collect();
  if(this.queueApplication)this.db.collectPins();
  if(Number(this.db.meta('sendAfter',0))>this.now())return;
  if(!await this.flushEdits(signal,{urgent:true}))return;
  if(!await this.flushPins(signal))return;
  if(!await this.flushEdits(signal))return;
  for(const row of this.db.pending()){
   if(signal?.aborted)return;
   const link=this.db.link(row.candidate_id);if(!link)continue;
   if((this.nextChatSend.get(link.chat_id)??0)>this.now())continue;
   const delivery=this.delivery(row,link);if(!delivery){this.db.skipped(row.id);continue;}
   const body=withDeleteButton(row,delivery);
   try{
    const result=await this.api.call('sendMessage',{chat_id:link.chat_id,...body,link_preview_options:{is_disabled:true}},signal);
    this.db.sent(row.id,result.message_id,this.config.bot?.id??this.db.meta('bot'),body);
    this.nextChatSend.set(link.chat_id,this.now()+1100);
   }catch(error){
    if(signal?.aborted)return;
    this.db.fail(row,error);
    if(error.code===429)this.db.setMeta('sendAfter',this.now()+Math.max(1,error.retryAfter??5)*1000);
    if([0,401,409,429].includes(error.code)){this.error=error.message;break;}
   }
  }
 }
 async flushPins(signal){
  for(const pending of this.db.pendingPins()){
   if(signal?.aborted)return false;
   const row=this.db.delivery(pending.id),link=row&&this.db.link(row.candidate_id);
   if(!link||row.status!=='sent'||(this.nextChatSend.get(link.chat_id)??0)>this.now())continue;
   try{
    await this.api.call(pending.wanted?'pinChatMessage':'unpinChatMessage',{chat_id:link.chat_id,message_id:row.message_id,...(pending.wanted?{disable_notification:true}:{})},signal);
    this.db.pinned(row.id);this.nextChatSend.set(link.chat_id,this.now()+1100);
   }catch(error){
    if(signal?.aborted)return false;
    this.db.failPin(pending,error);this.nextChatSend.set(link.chat_id,this.now()+1100);
    if(error.code===429)this.db.setMeta('sendAfter',this.now()+Math.max(1,error.retryAfter??5)*1000);
    if([0,401,409,429].includes(error.code)){this.error=error.message;return false;}
   }
  }
  return true;
 }
 async flushEdits(signal,options){
  for(const pending of this.db.pendingEdits(options)){
   if(signal?.aborted)return false;
   // A deletion or unlink may happen while another API request is in flight.
   const row=this.db.delivery(pending.id),link=row&&this.db.link(row.candidate_id);
   if(!link||row.status!=='sent')continue;
   const delivery=this.delivery(row,link,{edit:true});
   if(!delivery){this.db.edited(row.id,null);continue;}
   const body=withDeleteButton(row,delivery);
   if(JSON.stringify(body)===pending.rendered_body){this.db.edited(row.id,body);continue;}
   if((this.nextChatSend.get(link.chat_id)??0)>this.now())continue;
   try{
    await this.api.call('editMessageText',{chat_id:link.chat_id,message_id:row.message_id,...body,link_preview_options:{is_disabled:true}},signal);
    this.db.edited(row.id,body);this.nextChatSend.set(link.chat_id,this.now()+1100);
   }catch(error){
    if(signal?.aborted)return false;
    this.nextChatSend.set(link.chat_id,this.now()+1100);
    if(error.editResult==='unchanged'){this.db.edited(row.id,body);continue;}
    if(error.editResult==='missing'){this.db.deleted(row.id);continue;}
    this.db.failEdit(pending,error);
    if(error.code===429)this.db.setMeta('sendAfter',this.now()+Math.max(1,error.retryAfter??5)*1000);
    if([0,401,409,429].includes(error.code)){this.error=error.message;return false;}
   }
  }
  return true;
 }
}
