import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {TelegramBot} from '../app/telegram.mjs';
import {rankInput} from './rank-fixture.mjs';

function fixture(t){
 const store=new Store(':memory:'),p=store.saveProfile({name:'Ada',preferences:'Remote',authorization:'prepare'}),other=store.saveProfile({name:'Grace',preferences:'Remote',authorization:'prepare'});
 let now=1000000;const active=new Map(),launches=[],queued=[],calls=[];
 const campaigns=new Campaigns(store,{now:()=>now,active:id=>active.get(id),changed:()=>{},launch:async(id,prompt)=>{launches.push({id,prompt});active.set(id,{candidateId:id,sessionId:'session-'+id,state:'Idle'});},send:async()=>{},stop:async id=>active.delete(id)});
 const makeBot=(candidate,botId)=>{
  const bot=new TelegramBot({store,botId,now:()=>now,answer:(id,q,value)=>store.answer(id,q,value),queueApplication:(id,jobId)=>{queued.push({id,jobId});return campaigns.queueAndStartApplication(id,jobId);}});
  bot.config={enabled:true,bot:{id:botId,username:'bot_'+botId}};bot.db.saveConfig(candidate.id,{...bot.config,secret:'encrypted'});
  let messages=0;bot.api={async call(method,body){calls.push({botId,method,body});if(method==='sendMessage')return {message_id:++messages};return true;}};
  bot.db.bind(bot.db.pair(candidate.id).token,11,11,'Account');return bot;
 };
 const bot=makeBot(p,123456789),foreign=makeBot(other,987654321);
 const add=(candidate=p,company='Queue')=>store.addJob(candidate.id,{url:'https://example.com/'+company,company,role:'Engineer',location:'Remote',fit:'Relevant'}).job;
 const flush=async()=>{now+=2000;await bot.flush();await foreign.flush();};
 const card=job=>{
  const own=job.candidateId===p.id?bot:foreign;
  return own.db.delivery(store.db.prepare('SELECT id FROM telegram_outbox WHERE candidate_id=? AND event_key=?').get(job.candidateId,'new-job:'+job.id).id);
 };
 t.after(async()=>{await bot.stop();await foreign.stop();store.close();});
 return {store,p,other,bot,foreign,campaigns,launches,queued,calls,add,flush,card};
}
const callback=row=>({id:'queue-click',from:{id:11},message:{chat:{id:11,type:'private'},message_id:row.message_id},data:'queue:'+row.id});
const hasQueue=body=>body.reply_markup.inline_keyboard.flat().some(button=>button.callback_data?.startsWith('queue:'));

test('a low score can be explicitly queued once from its Telegram card with job-specific submission permission',async t=>{
 const {store,p,bot,launches,queued,calls,add,flush,card}=fixture(t),job=add();store.rankJob(p.id,job.id,rankInput(store,p.id,5));await flush();
 const original=calls.find(call=>call.method==='sendMessage').body,row=card(job);assert.ok(hasQueue(original));
 const results=await Promise.all([bot.queueNotification(callback(row)),bot.queueNotification(callback(row))]);
 assert.match(results[0].text,/sıraya alındı/);assert.equal(queued.length,1);assert.equal(launches.length,1);
 assert.equal(store.campaign(p.id).task.jobId,job.id);assert.equal(store.campaign(p.id).task.kind,'application');
 assert.equal(store.profile(p.id).authorization,'prepare');assert.ok(store.job(p.id,job.id).manualApplication);assert.match(launches[0].prompt,/user explicitly authorized submission/);
 await flush();const edit=calls.filter(call=>call.method==='editMessageText').at(-1).body;
 assert.equal(edit.message_id,row.message_id);assert.equal(hasQueue(edit),false);
 assert.deepEqual(edit.reply_markup.inline_keyboard[0],original.reply_markup.inline_keyboard[0]);assert.deepEqual(edit.reply_markup.inline_keyboard.at(-1),original.reply_markup.inline_keyboard.at(-1));
 assert.equal(calls.filter(call=>call.method==='sendMessage').length,1);
});

test('unranked jobs go directly to application and duplicate Telegram clicks do not add requests',async t=>{
 const {store,p,bot,queued,add,flush,card}=fixture(t),job=add();await flush();const row=card(job);
 await bot.queueNotification(callback(row));assert.equal(store.campaign(p.id).task.kind,'application');assert.ok(store.job(p.id,job.id).manualApplication);
 await bot.queueNotification(callback(row));assert.equal(queued.length,1);
 assert.equal(hasQueue(bot.delivery(row,bot.db.link(p.id),{edit:true})),false);
});

test('blocked jobs preserve unanswered questions and campaign-only queue changes update the card',async t=>{
 const {store,p,bot,campaigns,queued,calls,add,flush,card}=fixture(t),job=add();store.rankJob(p.id,job.id,rankInput(store,p.id,80));
 store.saveJob({...store.job(p.id,job.id),status:'blocked'},'job_updated');
 const q=store.ask(p.id,{jobId:job.id,question:'Start date?'});await flush();const row=card(job);
 campaigns.queueApplication(p.id,job.id);await flush();
 const edit=calls.filter(call=>call.method==='editMessageText').at(-1).body;assert.match(edit.text,/Başvuru sırasında/);assert.equal(hasQueue(edit),false);
 assert.match((await bot.queueNotification(callback(row))).text,/zaten başvuru sırasında/);assert.equal(queued.length,0);assert.equal(store.questions(p.id).find(item=>item.id===q.id).answer,null);
 const c=store.campaign(p.id);delete c.pendingRetries[job.id];store.saveCampaign(p.id,c);await flush();assert.equal(hasQueue(calls.filter(call=>call.method==='editMessageText').at(-1).body),true);
});

test('queue callbacks enforce sender, bot, candidate, private chat, exact message and retained card',async t=>{
 const {store,p,bot,foreign,queued,add,flush,card}=fixture(t),job=add();await flush();const row=card(job),valid=callback(row);
 const invalid=[{...valid,from:{id:22}},{...valid,from:{id:11,is_bot:true}},{...valid,message:{...valid.message,chat:{id:11,type:'group'}}},{...valid,message:{...valid.message,message_id:row.message_id+1}},{...valid,data:'queue:bad'}];
 for(const attempt of invalid)assert.equal((await bot.queueNotification(attempt)).show_alert,true);
 assert.equal((await foreign.queueNotification(valid)).show_alert,true);assert.equal(queued.length,0);
 const q=store.ask(p.id,{question:'Private'}),question=bot.db.enqueue(p.id,'question:'+q.id,{kind:'question',questionId:q.id});bot.db.sent(question.id,99);
 assert.equal((await bot.queueNotification(callback(bot.db.delivery(question.id)))).show_alert,true);
 bot.db.deleted(row.id);assert.equal((await bot.queueNotification(valid)).show_alert,true);bot.unlink(p.id);
 assert.equal((await bot.queueNotification(valid)).show_alert,true);assert.equal(queued.length,0);
});

test('stale buttons preserve completed and duplicate submission guards',async t=>{
 const {store,p,bot,queued,add,flush,card}=fixture(t),job=add();await flush();const row=card(job);
 const mutations=[
  {...job,status:'submitted'}, {...job,status:'already_submitted'}, {...job,status:'skipped'},
  {...job,followupStopped:{at:'today'}}
 ];
 for(const saved of mutations){store.saveJob(saved,'job_updated');assert.equal((await bot.queueNotification(callback(row))).show_alert,true);assert.equal(hasQueue(bot.delivery(row,bot.db.link(p.id),{edit:true})),false);}
 store.saveJob(job,'job_updated');
 const previous=store.addJob(p.id,{...job,url:'https://example.com/imported',location:'Unknown'}).job;store.saveJob({...previous,status:'submitted',proof:{text:'Imported confirmation'}},'submission_recorded');
 assert.ok(store.job(p.id,job.id).duplicateApplication);assert.equal((await bot.queueNotification(callback(row))).show_alert,true);assert.equal(queued.length,0);
});

test('existing cards gain queue controls and automatically eligible jobs can be given explicit priority',async t=>{
 const {store,p,bot,queued,calls,add,flush,card}=fixture(t),job=add();await flush();const row=card(job);
 const link=bot.db.link(p.id);delete link.data.queueSignature;bot.db.saveLink(link);
 const old=bot.delivery(row,link,{edit:true});old.reply_markup.inline_keyboard=old.reply_markup.inline_keyboard.filter(buttons=>!buttons.some(button=>button.callback_data?.startsWith('queue:')));bot.db.edited(row.id,old);
 await flush();assert.ok(hasQueue(calls.filter(call=>call.method==='editMessageText').at(-1).body));
 store.rankJob(p.id,job.id,rankInput(store,p.id,80));await flush();const edited=calls.filter(call=>call.method==='editMessageText').at(-1).body;
 assert.equal(hasQueue(edited),true);
 await bot.queueNotification(callback(row));assert.equal(queued.length,1);assert.ok(store.campaign(p.id).task.manualRequestId);
});

test('polling routes queue clicks once, reports the result and durably advances the update offset',async t=>{
 const {bot,store,p,queued,calls,add,flush,card}=fixture(t),job=add();await flush();const row=card(job),controller=new AbortController(),api=bot.api.call;let polls=0;
 bot.api.call=async(method,body)=>{
  if(method==='getUpdates'){if(++polls===1)return [{update_id:10,callback_query:callback(row)},{update_id:10,callback_query:callback(row)}];controller.abort();return [];}
  return api(method,body);
 };
 await bot.poll(controller.signal);assert.equal(queued.length,1);assert.equal(bot.db.meta('offset'),'11');
 assert.equal(calls.filter(call=>call.method==='answerCallbackQuery').length,1);assert.ok(store.campaign(p.id).pendingRetries[job.id]);
});

test('uncertain Telegram cards offer priority verification and stale apply buttons dispatch only a verify task',async t=>{
 const {store,p,bot,queued,launches,calls,add,flush,card}=fixture(t),job=add();await flush();const row=card(job);
 store.saveJob({...job,status:'uncertain',sessionId:'old'},'job_updated');await flush();
 const edited=calls.filter(x=>x.method==='editMessageText').at(-1).body;
 assert.equal(edited.reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.startsWith('queue:')).text,'Öncelikli doğrula');
 const result=await bot.queueNotification(callback(row));assert.match(result.text,/doğrulama sırasına alındı/);
 assert.equal(store.campaign(p.id).task.kind,'verify');assert.equal(store.campaign(p.id).task.verificationOnly,true);
 assert.equal(store.taskContext(p.id).applicationAuthorization.mode,'verify');assert.match(launches[0].prompt,/WITHOUT resubmitting/);
 assert.equal(store.job(p.id,job.id).status,'uncertain');await bot.queueNotification(callback(row));assert.equal(queued.length,1);
 await flush();assert.equal(hasQueue(calls.filter(x=>x.method==='editMessageText').at(-1).body),false);
});
