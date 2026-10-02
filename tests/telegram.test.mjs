import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {NotificationFixture} from './helpers/notifications.mjs';
import {TelegramBot as Telegram,TelegramApi} from '../app/telegram.mjs';

const TOKEN='123456789:abcdefghijklmnopqrstuvwxyz_123456789';
const message=(text,chat=11,reply=null)=>({message:{message_id:500,chat:{id:chat,type:'private'},from:{id:chat,first_name:'Ada'},text,...(reply?{reply_to_message:{message_id:reply}}:{})}});
const callback=(data,chat=11)=>({callback_query:{id:'callback',from:{id:chat},message:{chat:{id:chat,type:'private'}},data}});
async function fixture(t){
 const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-telegram-')),file=path.join(data,'test.sqlite');
 let now=1000000;const store=new NotificationFixture(file),p=store.createWorkspace({name:'Ada',preferences:'Remote'}),other=store.createWorkspace({name:'Grace',preferences:'Hybrid'}),calls=[],answers=[];
 const api={async call(method,body){calls.push({method,body});if(method==='getMe')return {id:123456789,username:'jobloop_test_bot',is_bot:true};if(method==='getWebhookInfo')return {url:''};if(method==='sendMessage')return {message_id:calls.length};if(['deleteMessage','editMessageText','answerCallbackQuery'].includes(method))return true;throw Error('Unexpected '+method);}};
 const options={store,data,botId:123456789,now:()=>now,encrypt:value=>Buffer.from('encrypted:'+value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString().slice(10),apiFactory:()=>api,withdrawApplication:(id,jobId)=>store.setRecordState(id,jobId,'dismissed'),answer:async(id,q,values)=>{answers.push({id,q,values});return store.answerQuestion(id,q,values);}};
 const bot=new Telegram(options);bot.api=api;bot.token=TOKEN;bot.config={enabled:true,bot:{id:123456789,username:'jobloop_test_bot'}};for(const candidate of [p,other])bot.db.saveConfig(candidate.id,{enabled:true,bot:bot.config.bot,secret:options.encrypt(TOKEN)});
 const pair=(id=p.id,chat=11)=>{const token=new URL(bot.pairing(id).url).searchParams.get('start');return bot.db.bind(token,chat,chat,'Ada Telegram');};
 const flush=async()=>{now+=2000;await bot.flush();};
 const drain=async()=>{for(let i=0;i<40&&bot.db.pending().length;i++)await flush();};
 const action=(value,chat=11)=>{const link=bot.db.sender(chat,chat);return bot.conversation.handle(callback(`a:${link.data.dialog.promptId}:${value}`,chat));};
 const reply=async(text,chat=11)=>{await drain();const prompt=bot.db.sender(chat,chat).data.dialog.promptId;const rows=store.db.prepare('SELECT message_id,data FROM telegram_outbox WHERE candidate_id=?').all(bot.db.sender(chat,chat).candidate_id);const row=rows.find(row=>JSON.parse(row.data).promptId===prompt);assert.ok(row?.message_id);return bot.conversation.handle(message(text,chat,row.message_id));};
 t.after(async()=>{await bot.stop();store.close();await rm(data,{recursive:true,force:true});});
 return {store,p,other,bot,api,options,data,file,calls,answers,pair,flush,drain,action,reply,advance:ms=>{now+=ms;}};
}

test('pairing is private, expires, is one-use and cannot replace a linked candidate',async t=>{
 const {bot,p,other,advance}=await fixture(t);
 const first=bot.db.pair(p.id);assert.ok(first.token.length<=64);
 assert.equal(bot.db.bind('bad',11,11,'Bad'),null);
 const group=message('/start '+first.token);group.message.chat.type='group';await bot.conversation.handle(group);assert.equal(bot.db.link(p.id),null);
 await bot.conversation.handle(message('/start '+first.token));assert.equal(bot.db.link(p.id).user_id,'11');
 assert.equal(bot.db.bind(first.token,12,12,'Other'),null);assert.throws(()=>bot.db.pair(p.id),/zaten bağlı/);
 const second=bot.db.pair(other.id);assert.equal(bot.db.bind(second.token,11,11,'Same'),null);
 advance(10*60*1000);assert.equal(bot.db.bind(second.token,12,12,'Late'),null);
 assert.equal(bot.db.sender(11,12),null);
});

test('submission and question events enqueue once; prior submissions are not backfilled',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);
 const job=store.addRecord(p.id,{url:'https://example.com/job',company:'Acme',role:'Engineer',fit:'Match',location:'Remote'}).job;
 store.saveRecord({...job,status:'submitted'},'submission_recorded');pair();await flush();assert.equal(calls.length,0);
 const q=store.askQuestion(p.id,{question:'Başlangıç tarihi?'});await flush();assert.match(calls.at(-1).body.text,/Başlangıç/);
 bot.db.collect();assert.equal(store.db.prepare("SELECT count(*) AS n FROM telegram_outbox WHERE event_key=?").get('question:'+q.id).n,1);
 store.saveRecord({...job,status:'submitted'},'candidate_submission_recorded');await flush();assert.match(calls.at(-1).body.text,/Tamamlandı/);
 store.saveRecord({...job,status:'submitted'},'submission_recorded');await flush();assert.equal(calls.filter(c=>c.method==='sendMessage').length,2);
});

test('pending questions are sent at pairing; no foreign candidate or group can answer them',async t=>{
 const {bot,store,p,other}=await fixture(t),q=store.askQuestion(p.id,{question:'Secret candidate question'}),foreign=store.askQuestion(other.id,{question:'Other question'});
 const token=bot.db.pair(p.id).token;await bot.conversation.handle(message('/start '+token));
 assert.ok(store.db.prepare('SELECT 1 FROM telegram_outbox WHERE event_key=?').get('question:'+q.id));
 await bot.conversation.handle(callback('q:'+foreign.id));assert.equal(bot.db.link(p.id).data.dialog,null);
 await bot.conversation.handle(callback('q:'+q.id,99));assert.equal(bot.db.link(p.id).data.dialog,null);
 const group=callback('q:'+q.id);group.callback_query.message.chat.type='group';await bot.conversation.handle(group);assert.equal(bot.db.link(p.id).data.dialog,null);
});

test('typed forms preserve false, zero, exact options and only submit after review',async t=>{
 const {bot,store,p,pair,action,reply,answers}=await fixture(t);pair();
 const fields=[{id:'permit',label:'İzin?',type:'boolean'},{id:'salary',label:'Maaş',type:'number'},{id:'mode',label:'Çalışma',type:'select',options:['Remote','Hybrid']},{id:'days',label:'Günler',type:'multiselect',options:['Pzt','Sal']},{id:'date',label:'Tarih',type:'date'},{id:'note',label:'Not',type:'text',required:false}];
 const q=store.askQuestion(p.id,{question:'Başvuru bilgileri',fields});await bot.conversation.handle(callback('q:'+q.id));
 const stale=bot.db.link(p.id).data.dialog.promptId;
 await action('false');await bot.conversation.handle(callback(`a:${stale}:true`));assert.equal(bot.db.link(p.id).data.dialog.values.permit,false);
 await reply('not a number');assert.equal(bot.db.link(p.id).data.dialog.index,1);
 await reply('0');await action('1');await action('0');await action('1');await action('0');await action('done');
 await reply('2026-02-30');assert.equal(bot.db.link(p.id).data.dialog.index,4);await reply('2026-10-01');await action('skip');
 assert.equal(answers.length,0);const confirmation=bot.db.link(p.id).data.dialog.promptId;await action('save');
 assert.deepEqual(answers[0].values,{permit:false,salary:0,mode:'Hybrid',days:['Sal'],date:'2026-10-01'});
 await bot.conversation.handle(callback(`a:${confirmation}:save`));assert.equal(answers.length,1);assert.equal(bot.db.link(p.id).data.dialog,null);
});

test('free text must reply to the current prompt; drafts survive reopening the service',async t=>{
 const {bot,store,p,pair,options,reply,answers}=await fixture(t);pair();const q=store.askQuestion(p.id,{question:'Ne zaman başlayabilirsin?'});
 await bot.conversation.handle(callback('q:'+q.id));await bot.conversation.handle(message('Unrelated'));assert.deepEqual(bot.db.link(p.id).data.dialog.values,{});
 await reply('Ekim ayında');const prompt=bot.db.link(p.id).data.dialog.promptId;
 const restarted=new Telegram(options);await restarted.conversation.handle(callback(`a:${prompt}:save`));assert.equal(answers[0].values,'Ekim ayında');
});

test('desktop answers and changed questions invalidate Telegram drafts',async t=>{
 const {bot,store,p,pair,action,answers}=await fixture(t);pair();const q=store.askQuestion(p.id,{question:'İzin?',fields:[{id:'permit',label:'İzin?',type:'boolean'}]});
 await bot.conversation.handle(callback('q:'+q.id));await action('true');store.answerQuestion(p.id,q.id,{permit:false});await action('save');assert.equal(answers.length,0);assert.equal(bot.db.link(p.id).data.dialog,null);
 const q2=store.askQuestion(p.id,{question:'Old'});await bot.conversation.handle(callback('q:'+q2.id));store.changeQuestion(p.id,q2.id,'New');
 await bot.conversation.handle(message('Answer'));assert.equal(bot.db.link(p.id).data.dialog,null);
});

test('desktop answers edit the original question card with the saved answer and remove answer buttons',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);pair();
 const q=store.askQuestion(p.id,{question:'İzin & tercih?',fields:[{id:'permit',label:'Çalışma izni',type:'boolean'},{id:'note',label:'Not',type:'text'}]});await flush();
 const card=calls[0].body,row=bot.db.delivery(card.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2));
 store.answerQuestion(p.id,q.id,{permit:false,note:'Remote <Berlin> & hybrid'});await flush();
 const edit=calls.at(-1);assert.equal(edit.method,'editMessageText');assert.equal(edit.body.message_id,row.message_id);assert.equal(edit.body.chat_id,'11');
 assert.equal(edit.body.parse_mode,'HTML');assert.match(edit.body.text,/✅ Yanıtlandı/);assert.match(edit.body.text,/Çalışma izni: Hayır/);assert.match(edit.body.text,/Remote &lt;Berlin&gt; &amp; hybrid/);
 assert.ok(edit.body.reply_markup.inline_keyboard.flat().every(button=>!button.callback_data?.startsWith('q:')&&!button.callback_data?.startsWith('a:')));
 assert.equal(calls.filter(call=>call.method==='sendMessage').length,1);const count=calls.length;await flush();assert.equal(calls.length,count);
});

test('desktop answers update repeated question cards and sent form prompts, clear drafts and suppress unsent prompts',async t=>{
 const {bot,store,p,pair,flush,drain,calls,answers}=await fixture(t);pair();const q=store.askQuestion(p.id,{question:'Çalışma iznin var mı?',fields:[{id:'permit',label:'Çalışma izni',type:'boolean'}]});await flush();
 await bot.conversation.handle(message('/sorular'));await flush();await bot.conversation.handle(callback('q:'+q.id));await flush();
 const originalMessages=calls.filter(call=>call.method==='sendMessage'),dialog=bot.db.link(p.id).data.dialog;
 const originalIds=store.db.prepare("SELECT message_id FROM telegram_outbox WHERE candidate_id=? AND status='sent' AND json_extract(data,'$.questionId')=?").all(p.id,q.id).map(row=>row.message_id);
 // A second unsent prompt must not be delivered after the desktop answer.
 bot.db.message(p.id,'Old pending prompt',{questionId:q.id,promptId:dialog.promptId,reply_markup:{force_reply:true}});
 store.answerQuestion(p.id,q.id,{permit:false});await flush();await drain();await flush();await flush();
 assert.equal(bot.db.link(p.id).data.dialog,null);assert.equal(calls.filter(call=>call.method==='sendMessage').length,originalMessages.length);
 const edits=calls.filter(call=>call.method==='editMessageText');assert.equal(edits.length,3);
 for(const edit of edits){assert.match(edit.body.text,/✅ Yanıtlandı/);assert.match(edit.body.text,/Çalışma izni: Hayır/);assert.ok(edit.body.reply_markup.inline_keyboard.flat().every(button=>!button.callback_data?.match(/^[qa]:/)));}
 assert.deepEqual(new Set(edits.map(edit=>edit.body.message_id)),new Set(originalIds));
 await bot.conversation.handle(callback(`a:${dialog.promptId}:save`));assert.equal(answers.length,0);assert.equal(store.questions(p.id).find(item=>item.id===q.id).answerValues.permit,false);
});

test('free text answers update the question card without trying to edit Telegram ForceReply prompts',async t=>{
 const {bot,store,p,pair,flush,calls,options}=await fixture(t);pair();const q=store.askQuestion(p.id,{question:'Konum tercihin?'});await flush();
 const row=bot.db.delivery(calls[0].body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2));
 await bot.conversation.handle(callback('q:'+q.id));await flush();assert.equal(calls.at(-1).body.reply_markup.force_reply,true);
 store.answerQuestion(p.id,q.id,'Berlin');await flush();assert.equal(bot.db.link(p.id).data.dialog,null);
 const restarted=new Telegram(options);restarted.api=bot.api;restarted.config={...bot.config};await restarted.flush();
 const edits=calls.filter(call=>call.method==='editMessageText');assert.equal(edits.length,1);assert.equal(edits[0].body.message_id,row.message_id);assert.match(edits[0].body.text,/Berlin/);
 assert.equal(bot.status(p.id).candidate.failed,0);assert.equal(calls.filter(call=>call.method==='sendMessage').length,2);
});

test('answered questions are never initially delivered; closed application questions update existing cards',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);pair();
 const unsent=store.askQuestion(p.id,{question:'Already answered'});store.answerQuestion(p.id,unsent.id,'Done');await flush();assert.equal(calls.length,0);
 const job=store.addRecord(p.id,{url:'https://example.com/closed-question',company:'Closed',role:'Engineer',location:'Remote',fit:'Match'}).job;
 const q=store.askQuestion(p.id,{jobId:job.id,question:'Application detail'});await flush();await flush();
 const card=calls.find(call=>call.body.reply_markup?.inline_keyboard.flat().some(button=>button.callback_data==='q:'+q.id));
 const row=bot.db.delivery(card.body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2));
 store.setRecordState(p.id,job.id,'dismissed');await flush();
 assert.equal(calls.at(-1).method,'editMessageText');assert.equal(calls.at(-1).body.message_id,row.message_id);assert.match(calls.at(-1).body.text,/bu kaydı eledi/);
 assert.ok(!calls.at(-1).body.reply_markup.inline_keyboard.flat().some(button=>button.callback_data?.startsWith('q:')));
});

test('upgrade updates already answered question cards even after their events were collected and preserves deletion',async t=>{
 const {bot,store,p,pair,flush,calls,options}=await fixture(t);pair();
 const q=store.askQuestion(p.id,{question:'Saved before upgrade'}),removed=store.askQuestion(p.id,{question:'Deleted before upgrade'});await flush();await flush();
 const rows=calls.filter(call=>call.method==='sendMessage').map(call=>bot.db.delivery(call.body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2)));
 const kept=rows.find(row=>row.data.questionId===q.id),deleted=rows.find(row=>row.data.questionId===removed.id);await bot.deleteNotification(deleteCallback(deleted));
 store.answerQuestion(p.id,q.id,'Previously answered');bot.db.collect();const cursor=bot.db.link(p.id).cursor;
 store.db.exec('DELETE FROM telegram_job_messages; DROP INDEX telegram_question_message_updates; ALTER TABLE telegram_job_messages DROP COLUMN question_id');
 const restarted=new Telegram(options);restarted.api=bot.api;restarted.config={...bot.config};await restarted.flush();
 const edits=calls.filter(call=>call.method==='editMessageText');assert.equal(edits.length,1);assert.equal(edits[0].body.message_id,kept.message_id);assert.match(edits[0].body.text,/Previously answered/);
 assert.equal(restarted.db.link(p.id).cursor,cursor);assert.equal(restarted.db.delivery(deleted.id).status,'deleted');assert.equal(calls.filter(call=>call.method==='sendMessage').length,2);
});

test('answer edits take priority over a backlog of job updates and retain retry state across restart',async t=>{
 const {bot,store,p,pair,flush,calls,api,options,advance}=await fixture(t);pair();
 const jobs=Array.from({length:21},(_,i)=>store.addRecord(p.id,{url:'https://example.com/answer-priority/'+i,company:'Priority '+i,role:'Engineer',location:'Remote',fit:'Match'}).job);
 const q=store.askQuestion(p.id,{question:'Answer first'});for(let i=0;i<22;i++)await flush();
 const card=calls.find(call=>call.body.reply_markup?.inline_keyboard.flat().some(button=>button.callback_data==='q:'+q.id)),row=bot.db.delivery(card.body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2));
 for(const job of jobs)store.saveRecord({...job,status:'prepared'},'job_updated');store.answerQuestion(p.id,q.id,'Saved answer');
 const original=api.call;let attempts=0;api.call=async(method,body)=>{if(method==='editMessageText'){attempts++;assert.equal(body.message_id,row.message_id);throw Object.assign(Error('Limited'),{code:429,retryAfter:30});}return original(method,body);};
 await flush();assert.equal(attempts,1);const restarted=new Telegram(options);restarted.api=api;restarted.config={...bot.config};
 advance(29000);await restarted.flush();assert.equal(attempts,1);api.call=original;advance(1001);await restarted.flush();
 const edit=calls.at(-1);assert.equal(edit.method,'editMessageText');assert.equal(edit.body.message_id,row.message_id);assert.match(edit.body.text,/Saved answer/);assert.equal(calls.filter(call=>call.method==='sendMessage').length,22);
});

test('preferences suppress queued notifications, unlink invalidates callbacks and deletion cascades',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);pair();const q=store.askQuestion(p.id,{question:'Private'});bot.db.collect();
 bot.preferences(p.id,{notifications:false,questions:false});await flush();assert.equal(calls.length,0);
 await bot.conversation.handle(callback('q:'+q.id));assert.equal(bot.db.link(p.id).data.dialog,null);
 bot.unlink(p.id);await bot.conversation.handle(callback('q:'+q.id));assert.equal(bot.db.link(p.id),null);
 pair();store.removeWorkspace(p.id);for(const table of ['telegram_links','telegram_pairs','telegram_outbox'])assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('delivery retry survives restart, respects Telegram retry_after and isolates blocked chats',async t=>{
 const {bot,store,p,other,pair,api,options,advance}=await fixture(t);pair();pair(other.id,22);
 const row=bot.db.message(p.id,'One');bot.db.message(other.id,'Two');let attempts=0;
 api.call=async()=>{attempts++;throw Object.assign(Error('Rate limit'),{code:429,retryAfter:30});};
 await bot.flush();assert.equal(attempts,1);assert.equal(bot.db.delivery(row.id).status,'pending');
 const restarted=new Telegram(options);restarted.api=api;await restarted.flush();assert.equal(attempts,1);
 advance(30001);api.call=async(method,body)=>{attempts++;if(body.chat_id==='11')throw Object.assign(Error('Blocked'),{code:403});return {message_id:101};};
 await restarted.flush();assert.equal(bot.db.delivery(row.id).status,'failed');assert.equal(bot.status(p.id).candidate.failed,1);
 assert.equal(store.db.prepare('SELECT status FROM telegram_outbox WHERE candidate_id=?').get(other.id).status,'sent');
 bot.retry(p.id);assert.equal(bot.db.delivery(row.id).status,'pending');
});

test('transport errors never disclose token-bearing URLs or remote descriptions',async()=>{
 const api=new TelegramApi(TOKEN,{fetcher:async url=>{throw Error(url);}});await assert.rejects(api.call('getMe'),error=>!error.message.includes(TOKEN));
 const response=new TelegramApi(TOKEN,{fetcher:async()=>({ok:false,status:401,json:async()=>({ok:false,error_code:401,description:TOKEN})})});
 await assert.rejects(response.call('getMe'),error=>error.code===401&&!error.message.includes(TOKEN));
});

test('polling acknowledges duplicate updates once and resumes from durable offset',async t=>{
 const {bot,api,p,pair,store}=await fixture(t);pair();const controller=new AbortController();let polls=0;
 api.call=async(method,body)=>{if(method==='getUpdates'){polls++;if(polls===1)return [{update_id:50,...message('/durum')},{update_id:50,...message('/durum')}];assert.equal(body.offset,51);controller.abort();return [];}return {};};
 await bot.poll(controller.signal);assert.equal(bot.db.meta('offset'),'51');assert.equal(store.db.prepare('SELECT count(*) AS n FROM telegram_outbox WHERE candidate_id=?').get(p.id).n,1);
});

test('empty optional-only forms remain editable instead of crashing',async t=>{
 const {bot,store,p,pair,action}=await fixture(t);pair();const q=store.askQuestion(p.id,{question:'Optional',fields:[{id:'note',label:'Not',type:'text',required:false}]});
 await bot.conversation.handle(callback('q:'+q.id));await action('skip');assert.equal(bot.db.link(p.id).data.dialog.index,0);
});

test('turning questions back on restores a suppressed unanswered notification',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);pair();store.askQuestion(p.id,{question:'Pending question'});bot.db.collect();
 bot.preferences(p.id,{notifications:true,questions:false});await flush();assert.equal(calls.length,0);
 bot.preferences(p.id,{notifications:true,questions:true});await flush();assert.equal(calls.length,1);assert.match(calls[0].body.text,/Pending question/);
});

test('an unlinked chat that blocks the bot does not stop updates for linked candidates',async t=>{
 const {bot,store,p,pair,api}=await fixture(t);pair();const controller=new AbortController();let polls=0;
 api.call=async(method,body)=>{
  if(method==='getUpdates'){if(++polls===1)return [{update_id:10,...message('/help',99)},{update_id:11,...message('/durum')}];assert.equal(body.offset,12);controller.abort();return [];}
  if(method==='sendMessage')throw Object.assign(Error('Blocked'),{code:403});
 };
 await bot.poll(controller.signal);assert.equal(bot.db.meta('offset'),'12');assert.equal(store.db.prepare('SELECT count(*) AS n FROM telegram_outbox WHERE candidate_id=?').get(p.id).n,1);
});

test('full consent help and long options are preserved across bounded messages',async t=>{
 const {bot,store,p,pair}=await fixture(t);pair();
 const help='H'.repeat(1900)+' CONSENT-END',options=['A'.repeat(185)+' OPTION-A-END','B'.repeat(185)+' OPTION-B-END'];
 const q=store.askQuestion(p.id,{question:'Consent',fields:[{id:'consent',label:'L'.repeat(1700),type:'select',options,help,consentScope:'other'}]});
 await bot.conversation.handle(callback('q:'+q.id));
 const messages=bot.db.pending().filter(row=>row.data.promptId).map(row=>row.data.text);const joined=messages.join('');
 for(const marker of ['CONSENT-END','OPTION-A-END','OPTION-B-END'])assert.ok(joined.includes(marker));assert.ok(messages.every(text=>text.length<=3500));
});

test('all new jobs notify their own candidate, including unranked and low scores on existing connections',async t=>{
 const {bot,store,p,other,pair,drain,calls}=await fixture(t);
 const input={url:'https://example.com/prior',company:'Prior',role:'Engineer',location:'Remote',fit:'Match'};
 store.addRecord(p.id,input);pair();pair(other.id,22);
 // Connections made before the new preference existed inherit the enabled default.
 const legacy=bot.db.link(p.id);delete legacy.data.newJobs;bot.db.saveLink(legacy);
 bot.preferences(p.id,{notifications:false,questions:false});assert.equal(bot.status(p.id).candidate.newJobs,true);
 const unranked=store.addRecord(p.id,{...input,url:'https://example.com/new',company:'New Company'}).job;
 const low=store.addRecord(p.id,{...input,url:'https://example.com/low',company:'Low Company'}).job;store.scoreRecord(p.id,low.id,5);
 const foreign=store.addRecord(other.id,{...input,url:'https://example.com/other',company:'Other Company'}).job;
 assert.equal(store.addRecord(p.id,{...input,url:unranked.url,company:unranked.company}).duplicate,true);
 await drain();await bot.flush(); // Collect the new events, then drain every paced delivery.
 await drain();
 const sent=calls.filter(call=>call.method==='sendMessage');assert.equal(sent.length,3);
 const own=sent.filter(call=>call.body.chat_id==='11');assert.equal(own.length,2);
 assert.ok(own.every(call=>call.body.text.startsWith('<b>İş arama · Bulundu</b>')));
 assert.ok(own.some(call=>call.body.text.includes('New Company')&&!call.body.text.includes('Uygunluk puanı')));
 assert.ok(own.some(call=>call.body.text.includes('Uygunluk puanı:</b> 5')));
 assert.deepEqual(own.map(call=>call.body.reply_markup.inline_keyboard[0][0].url).sort(),[unranked.url,low.url].sort());
 assert.equal(sent.find(call=>call.body.chat_id==='22').body.reply_markup.inline_keyboard[0][0].url,foreign.url);
 store.scoreRecord(p.id,unranked.id,80);await bot.flush();assert.equal(calls.filter(call=>call.method==='sendMessage').length,3);
});

test('new job preference suppresses queued cards independently and persists across restart',async t=>{
 const {bot,store,p,pair,flush,calls,options}=await fixture(t);pair();
 const input={url:'https://example.com/muted',company:'Muted',role:'Engineer',location:'Remote',fit:'Match'};
 store.addRecord(p.id,input);bot.db.collect();
 bot.preferences(p.id,{newJobs:false,notifications:true,questions:true});await flush();assert.equal(calls.length,0);
 const restarted=new Telegram(options);assert.equal(restarted.status(p.id).candidate.newJobs,false);
 store.addRecord(p.id,{...input,url:'https://example.com/still-muted',company:'Still Muted'});await flush();assert.equal(calls.length,0);
 assert.throws(()=>bot.preferences(p.id,{newJobs:'true',notifications:true,questions:true}),/Geçersiz/);
 bot.preferences(p.id,{newJobs:true,notifications:true,questions:true});
 store.addRecord(p.id,{...input,url:'https://example.com/enabled',company:'Enabled'});await flush();assert.equal(calls.length,1);assert.match(calls[0].body.text,/Enabled/);
});

test('automatic score threshold waits for ranking, isolates candidates and never revives deleted cards',async t=>{
 const {bot,store,p,other,pair,flush,calls,options,advance}=await fixture(t);
 const add=(name,score=null,candidate=p.id)=>{const job=store.addRecord(candidate,{url:'https://example.test/auto/'+name,company:name,role:'Engineer',location:'Remote'}).job;if(score!==null)store.scoreRecord(candidate,job.id,score);return job;};
 const historical=add('BeforePairing',90);pair();pair(other.id,22);
 bot.preferences(p.id,{newJobs:true,newJobsMinScore:65,notifications:false,questions:true});
 const unranked=add('Unranked'),boundary=add('Boundary',65),low=add('Low',40),high=add('High',66),foreign=add('OtherCandidate',5,other.id);
 store.askQuestion(p.id,{question:'Question still delivered',jobId:low.id});
 for(let i=0;i<8;i++)await flush();
 const sends=()=>calls.filter(c=>c.method==='sendMessage');assert.equal(sends().length,3);
 assert.ok(sends().some(c=>c.body.text.includes('Question still delivered')));
 assert.ok(sends().some(c=>c.body.chat_id==='11'&&c.body.text.includes('High')));
 assert.ok(sends().some(c=>c.body.chat_id==='22'&&c.body.text.includes('OtherCandidate')));
 assert.equal(bot.status(p.id).candidate.waitingScore,3);assert.equal(bot.status(p.id).candidate.pending,0);
 assert.equal(bot.status(other.id).candidate.newJobsMinScore,null);assert.equal(bot.db.jobSent(p.id,bot.config.bot.id,historical.id),false);
 const original=store.db.prepare("SELECT id FROM telegram_outbox WHERE candidate_id=? AND event_key=?").get(p.id,'new-job:'+high.id);
 bot.db.deleted(original.id);store.scoreRecord(p.id,high.id,95);store.scoreRecord(p.id,low.id,80);
 await flush();assert.equal(sends().length,4);assert.equal(bot.db.delivery(original.id).status,'deleted');
 const restarted=new Telegram(options);restarted.api=bot.api;restarted.config={...bot.config};
 assert.equal(restarted.status(p.id).candidate.newJobsMinScore,65);assert.equal(restarted.status(p.id).candidate.waitingScore,2);
 store.scoreRecord(p.id,unranked.id,66);advance(2000);await restarted.flush();
 assert.equal(sends().length,5);assert.equal(restarted.status(p.id).candidate.waitingScore,1);
 store.scoreRecord(p.id,unranked.id,90);advance(2000);await restarted.flush();assert.equal(sends().length,5);
 assert.equal(restarted.db.jobSent(p.id,bot.config.bot.id,boundary.id),false);assert.equal(restarted.db.jobSent(other.id,bot.config.bot.id,foreign.id),true);
});

test('automatic threshold changes recheck waiting cards and validate saved preferences without backfilling historical jobs',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);pair();
 const preferences={newJobs:true,newJobsMinScore:65,notifications:true,questions:false};bot.preferences(p.id,preferences);
 const job=store.addRecord(p.id,{url:'https://example.test/waiting',company:'Waiting',role:'Engineer',location:'Remote'}).job;store.scoreRecord(p.id,job.id,60);
 await flush();assert.equal(bot.status(p.id).candidate.waitingScore,1);
 const before=bot.db.link(p.id);
 for(const value of ['65',false,-1,101,NaN,Infinity])assert.throws(()=>bot.preferences(p.id,{...preferences,newJobsMinScore:value}),/minimum puan/);
 assert.deepEqual(bot.db.link(p.id),before);
 bot.preferences(p.id,{...preferences,newJobs:false});store.scoreRecord(p.id,job.id,80);await flush();assert.equal(calls.filter(c=>c.method==='sendMessage').length,0);
 bot.preferences(p.id,preferences);await flush();assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
 const unranked=store.addRecord(p.id,{url:'https://example.test/unranked',company:'No score',role:'Engineer',location:'Remote'}).job;
 await flush();assert.equal(bot.status(p.id).candidate.waitingScore,1);
 bot.preferences(p.id,{...preferences,newJobsMinScore:null});await flush();assert.equal(bot.status(p.id).candidate.waitingScore,0);
 assert.equal(bot.db.jobSent(p.id,bot.config.bot.id,unranked.id),true);assert.equal(calls.filter(c=>c.method==='sendMessage').length,2);
});

test('automatic score changes before delivery are respected and manual batches keep their own score filter',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);pair();
 bot.preferences(p.id,{newJobs:true,newJobsMinScore:65,notifications:false,questions:false});
 const job=store.addRecord(p.id,{url:'https://example.test/rechecked-score',company:'Score changes',role:'Engineer',location:'Remote'}).job;store.scoreRecord(p.id,job.id,80);
 bot.db.collect();store.scoreRecord(p.id,job.id,65);await flush();assert.equal(calls.filter(c=>c.method==='sendMessage').length,0);assert.equal(bot.status(p.id).candidate.waitingScore,1);
 bot.preferences(p.id,{newJobs:true,newJobsMinScore:90,notifications:false,questions:false});store.scoreRecord(p.id,job.id,80);await flush();assert.equal(bot.status(p.id).candidate.waitingScore,1);
 assert.equal(bot.sendUnsentJobs(p.id,{minScore:65,resend:true}).queued,1);await flush();
 assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);assert.equal(bot.status(p.id).candidate.waitingScore,0);
 assert.equal(bot.status(p.id).candidate.newJobsMinScore,90);
});

test('score waiting cards do not block retries or question delivery and old cards still update below the threshold',async t=>{
 const {bot,store,p,pair,flush,api,calls,advance}=await fixture(t);pair();
 bot.preferences(p.id,{newJobs:true,newJobsMinScore:65,notifications:false,questions:true});
 const job=store.addRecord(p.id,{url:'https://example.test/rate-limit-score',company:'Limited',role:'Engineer',location:'Remote'}).job;store.scoreRecord(p.id,job.id,80);
 const call=api.call;let limited=true;api.call=async(method,...args)=>{if(method==='sendMessage'&&limited){limited=false;throw Object.assign(Error('Rate limited'),{code:429,retryAfter:5});}return call(method,...args);};
 await flush();store.scoreRecord(p.id,job.id,60);advance(6000);await flush();assert.equal(bot.status(p.id).candidate.waitingScore,1);
 store.askQuestion(p.id,{question:'Still actionable',jobId:job.id});await flush();assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
 store.scoreRecord(p.id,job.id,70);await flush();assert.equal(calls.filter(c=>c.method==='sendMessage').length,2);
 store.scoreRecord(p.id,job.id,30);await flush();assert.equal(calls.filter(c=>c.method==='sendMessage').length,2);assert.ok(calls.some(c=>c.method==='editMessageText'&&c.body.text.includes('30')));
});

test('more than one event batch queues every new job and reopening does not enqueue duplicates',async t=>{
 const {bot,store,p,pair,options}=await fixture(t);pair();
 for(let index=0;index<205;index++)store.addRecord(p.id,{url:`https://example.com/jobs/${index}`,company:`Company ${index}`,role:'Engineer',location:'Remote',fit:'Match'});
 bot.db.collect();const restarted=new Telegram(options);restarted.db.collect();restarted.db.collect();
 const rows=store.db.prepare("SELECT data,status FROM telegram_outbox WHERE candidate_id=? AND event_key LIKE 'new-job:%'").all(p.id);
 assert.equal(rows.length,205);assert.equal(new Set(rows.map(row=>JSON.parse(row.data).jobId)).size,205);assert.ok(rows.every(row=>row.status==='pending'));
});

const deleteCallback=(row,chat=11)=>({...callback('d:'+row.id,chat).callback_query,message:{chat:{id:chat,type:'private'},message_id:row.message_id}});

test('delete button withdraws the application, resolves its questions and prevents repeat deliveries',async t=>{
 const {bot,store,p,pair,flush,calls,options}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/delete',company:'Keep company',role:'Engineer',location:'Remote',fit:'Match'}).job;
 await flush();const sent=calls.at(-1),button=sent.body.reply_markup.inline_keyboard.at(-1)[0];assert.equal(button.text,'🗑 Sil · Kaydı ele');assert.equal(button.style,'danger');
 const row=bot.db.delivery(button.callback_data.slice(2));assert.equal(row.status,'sent');
 const q=store.askQuestion(p.id,{jobId:job.id,question:'Application question'});
 assert.equal((await bot.deleteNotification(deleteCallback(row))).text,'Mesaj silindi; kayıt elendi.');
 assert.deepEqual(calls.at(-1),{method:'deleteMessage',body:{chat_id:'11',message_id:row.message_id}});
 assert.equal(bot.db.delivery(row.id).status,'deleted');const withdrawn=store.job(p.id,job.id);assert.equal(withdrawn.status,'skipped');
 assert.ok(store.questions(p.id).find(item=>item.id===q.id).answer);
 const restarted=new Telegram(options);restarted.api=bot.api;
 assert.equal((await restarted.deleteNotification(deleteCallback(row))).text,'Mesaj zaten silindi.');
 assert.deepEqual(store.job(p.id,job.id),withdrawn);
 bot.retry(p.id);store.event(p.id,'job_found',job);await flush();
 assert.equal(calls.filter(call=>call.method==='sendMessage').length,1);assert.equal(calls.filter(call=>call.method==='deleteMessage').length,1);
});

test('delete checks candidate, sender, private chat and exact message; form prompts cannot be deleted',async t=>{
 const {bot,store,p,other,pair,flush,calls}=await fixture(t);pair();pair(other.id,22);
 const job=store.addRecord(p.id,{url:'https://example.com/guard-delete',company:'Keep',role:'Engineer',location:'Remote',fit:'Match'}).job;await flush();const row=bot.db.delivery(calls[0].body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2));
 const cases=[deleteCallback(row,22),{...deleteCallback(row),from:{id:99}},{...deleteCallback(row),message:{chat:{id:11,type:'group'},message_id:row.message_id}},
  {...deleteCallback(row),message:{chat:{id:11,type:'private'},message_id:row.message_id+1}},{...deleteCallback(row),data:'d:bad'}];
 for(const attempt of cases)assert.equal((await bot.deleteNotification(attempt)).show_alert,true);
 const prompt=bot.db.message(p.id,'Current form',{questionId:'q',promptId:'active',reply_markup:{inline_keyboard:[]}});bot.db.sent(prompt.id,500);
 assert.equal((await bot.deleteNotification(deleteCallback(bot.db.delivery(prompt.id)))).show_alert,true);
 assert.equal(calls.filter(call=>call.method==='deleteMessage').length,0);
 assert.equal(store.job(p.id,job.id).manualOutcome,undefined);
 bot.unlink(p.id);assert.equal((await bot.deleteNotification(deleteCallback(row))).show_alert,true);
});

test('deleting a question card preserves the unanswered question and current answer draft',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);pair();const q=store.askQuestion(p.id,{question:'Still needed',fields:[{id:'permit',label:'İzin',type:'boolean'}]});await flush();
 const card=bot.db.delivery(calls[0].body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2));
 await bot.conversation.handle(callback('q:'+q.id));await flush();
 const prompt=calls.filter(call=>call.method==='sendMessage').at(-1);assert.ok(prompt.body.reply_markup.inline_keyboard.flat().every(button=>!button.callback_data.startsWith('d:')));
 const draft=bot.db.link(p.id).data.dialog;await bot.deleteNotification(deleteCallback(card));
 assert.deepEqual(bot.db.link(p.id).data.dialog,draft);assert.equal(store.questions(p.id).find(item=>item.id===q.id).answer,null);
 await bot.conversation.handle(message('/sorular'));await flush();
 assert.equal(calls.filter(call=>call.method==='sendMessage').at(-1).body.reply_markup.inline_keyboard[0][0].callback_data,'q:'+q.id);
});

test('expired and failed deletions show feedback and never mark a message as deleted',async t=>{
 const {bot,store,p,pair,flush,calls,api,advance}=await fixture(t);pair();store.askQuestion(p.id,{question:'Old card'});await flush();
 const row=bot.db.delivery(calls[0].body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2)),expired=deleteCallback(row);expired.message.date=1000;
 advance(48*60*60*1000);assert.match((await bot.deleteNotification(expired)).text,/48 saat/);assert.equal(calls.filter(call=>call.method==='deleteMessage').length,0);
 for(const code of [400,403,0,429]){
  api.call=async()=>{throw Object.assign(Error('Failure'),{code});};
  assert.equal((await bot.deleteNotification(deleteCallback(row))).show_alert,true);assert.equal(bot.db.delivery(row.id).status,'sent');
 }
});

test('a failed Telegram deletion keeps the withdrawal and updates the surviving card; retry is idempotent',async t=>{
 const {bot,store,p,pair,flush,calls,api,options}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/delete-retry',company:'Retry',role:'Engineer',location:'Remote',fit:'Match'}).job;await flush();
 const row=bot.db.delivery(calls[0].body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2)),original=api.call;let withdrawals=0;
 bot.withdrawApplication=(...args)=>{withdrawals++;return options.withdrawApplication(...args);};
 api.call=async(method,body)=>{if(method==='deleteMessage')throw Object.assign(Error('Network unavailable'),{code:0});return original(method,body);};
 const result=await bot.deleteNotification(deleteCallback(row));assert.equal(result.show_alert,true);assert.match(result.text,/Kayıt elendi..*Mesaj silinemedi/);
 assert.equal(store.job(p.id,job.id).status,'skipped');assert.equal(bot.db.delivery(row.id).status,'sent');await flush();
 assert.equal(calls.at(-1).method,'editMessageText');assert.equal(calls.at(-1).body.message_id,row.message_id);assert.match(calls.at(-1).body.text,/Atlandı/);
 api.call=original;await bot.deleteNotification(deleteCallback(row));assert.equal(withdrawals,1);assert.equal(bot.db.delivery(row.id).status,'deleted');
});

test('old job cards still withdraw the application when Telegram cannot delete them',async t=>{
 const {bot,store,p,pair,flush,calls,advance}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/delete-old',company:'Old',role:'Engineer',location:'Remote',fit:'Match'}).job;await flush();
 const row=bot.db.delivery(calls[0].body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2)),action=deleteCallback(row);action.message.date=1000;advance(48*60*60*1000);
 const result=await bot.deleteNotification(action);assert.match(result.text,/Kayıt elendi..*48 saat/);assert.equal(result.show_alert,true);
 assert.equal(store.job(p.id,job.id).status,'skipped');assert.equal(calls.filter(call=>call.method==='deleteMessage').length,0);
 await flush();assert.match(calls.at(-1).body.text,/Atlandı/);assert.equal(calls.at(-1).body.message_id,row.message_id);
});

test('a failed desktop withdrawal leaves both the job and Telegram message available for retry',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/delete-stop-failure',company:'Stop failure',role:'Engineer',location:'Remote',fit:'Match'}).job;await flush();
 const row=bot.db.delivery(calls[0].body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2));bot.withdrawApplication=async()=>{throw Error('Cannot stop active task');};
 const result=await bot.deleteNotification(deleteCallback(row));assert.equal(result.show_alert,true);assert.match(result.text,/elenemedi; mesaj silinmedi/);
 assert.equal(store.job(p.id,job.id).status,'found');assert.equal(bot.db.delivery(row.id).status,'sent');assert.equal(calls.filter(call=>call.method==='deleteMessage').length,0);
});

test('formatted cards escape listing text, emphasize titles and refresh the original message after scoring',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/formatted',company:'R&D <Labs>',role:'Engineer <a href="https://fake.test">click</a>',location:'Berlin > Remote',fit:'Match'}).job;await flush();
 const sent=calls[0].body,row=bot.db.delivery(sent.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2));
 assert.equal(sent.parse_mode,'HTML');assert.match(sent.text,/<b>Pozisyon:<\/b> Engineer &lt;a href="https:\/\/fake.test"&gt;click&lt;\/a&gt;/);
 assert.ok(sent.text.includes('<b>Şirket:</b> R&amp;D &lt;Labs&gt;\n<b>Konum:</b> Berlin &gt; Remote'));assert.doesNotMatch(sent.text,/Uygunluk puanı/);
 assert.equal(sent.reply_markup.inline_keyboard[0][0].style,'primary');assert.equal(sent.reply_markup.inline_keyboard.at(-1)[0].style,'danger');
 store.scoreRecord(p.id,job.id,62);await flush();
 const edit=calls.at(-1);assert.equal(edit.method,'editMessageText');assert.equal(edit.body.message_id,row.message_id);assert.equal(edit.body.parse_mode,'HTML');
 assert.match(edit.body.text,/<b>Uygunluk puanı:<\/b> 62/);assert.ok(!edit.body.text.includes('Henüz puanlanmadı'));assert.ok(!edit.body.text.includes('<a '));
 assert.equal(calls.filter(call=>call.method==='sendMessage').length,1);
 const link=bot.db.link(p.id);link.data.queueSignature='legacy-card-layout';bot.db.saveLink(link);
 store.db.prepare('UPDATE telegram_job_messages SET body=? WHERE delivery_id=?').run(JSON.stringify({...sent,text:'Legacy plain text',parse_mode:undefined}),row.id);await flush();
 assert.equal(calls.filter(call=>call.method==='editMessageText').length,2);assert.equal(calls.at(-1).body.message_id,row.message_id);assert.equal(calls.at(-1).body.parse_mode,'HTML');
});

test('polling routes deletion callbacks and reports the outcome without sending another message',async t=>{
 const {bot,store,p,pair,flush,calls,api}=await fixture(t);pair();store.askQuestion(p.id,{question:'Card'});await flush();
 const row=bot.db.delivery(calls[0].body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2)),original=api.call,controller=new AbortController();let polls=0;
 api.call=async(method,body)=>{if(method==='getUpdates'){if(++polls===1)return [{update_id:80,callback_query:deleteCallback(row)}];assert.equal(body.offset,81);controller.abort();return [];}return original(method,body);};
 await bot.poll(controller.signal);
 assert.equal(bot.db.delivery(row.id).status,'deleted');assert.equal(bot.db.meta('offset'),'81');
 assert.deepEqual(calls.at(-1),{method:'answerCallbackQuery',body:{callback_query_id:'callback',text:'Mesaj silindi.'}});assert.equal(calls.filter(call=>call.method==='sendMessage').length,1);
});

test('manual batch includes every incomplete job, skips completed and delivered cards, and is repeatable without duplicates',async t=>{
 const {bot,store,p,other,pair,drain,calls}=await fixture(t);
 const add=(company,status='found',candidate=p.id)=>{const job=store.addRecord(candidate,{url:`https://example.com/${company}`,company,role:'Engineer',location:'Remote',fit:'Match'}).job;return store.saveRecord({...job,status},'job_updated');};
 const incomplete=['found','working','prepared','submitting','blocked','uncertain','skipped'].map(status=>add(status,status));
 for(const status of ['submitted','already_submitted'])add(status,status);
 const manual=add('Manual');store.setRecordState(p.id,manual.id,'completed');
 const delivered=add('Delivered'),deleted=add('Deleted'),pending=add('Pending'),failed=add('Failed'),suppressed=add('Suppressed');add('OtherCandidate','found',other.id);
 pair();bot.preferences(p.id,{newJobs:false,notifications:false,questions:false});
 for(const job of [delivered,deleted,pending,failed,suppressed]){
  const row=bot.db.enqueue(p.id,'new-job:'+job.id,{kind:'new_job',jobId:job.id});
  if(job===delivered||job===deleted){bot.db.sent(row.id,123);if(job===deleted)bot.db.deleted(row.id);}
  if(job===failed)bot.db.fail(row,Object.assign(Error('Blocked'),{code:403}));
  if(job===suppressed)bot.db.skipped(row.id);
 }
 const before=store.jobs(p.id);
 assert.deepEqual(bot.sendUnsentJobs(p.id),{queued:9,alreadyQueued:1,alreadySent:2,completed:3,filtered:0});
 assert.deepEqual(bot.sendUnsentJobs(p.id),{queued:0,alreadyQueued:10,alreadySent:2,completed:3,filtered:0});
 assert.equal(bot.status(p.id).candidate.newJobs,false);await drain();
 const sent=calls.filter(call=>call.method==='sendMessage');assert.equal(sent.length,10);
 assert.ok(sent.every(call=>call.body.chat_id==='11'&&call.body.parse_mode==='HTML'));
 assert.deepEqual(new Set(sent.map(call=>call.body.reply_markup.inline_keyboard[0][0].url)),new Set([...incomplete,pending,failed,suppressed].map(job=>job.url)));
 assert.deepEqual(store.jobs(p.id),before);assert.equal(bot.sendUnsentJobs(p.id).queued,0);
});

test('backfill respects bot availability and skips applications completed before delivery',async t=>{
 const {bot,store,p,other,pair,flush,calls}=await fixture(t);
 assert.throws(()=>bot.sendUnsentJobs(p.id),/adayı Telegram/);pair();
 bot.preferences(p.id,{notifications:false,questions:true});
 const job=store.addRecord(p.id,{url:'https://example.com/finish-first',company:'Finish',role:'Engineer',location:'Remote',fit:'Match'}).job;
 bot.config.enabled=false;assert.throws(()=>bot.sendUnsentJobs(p.id),/botunu kaydedip aç/);bot.config.enabled=true;
 assert.throws(()=>bot.sendUnsentJobs(other.id),/adayı Telegram/);
 assert.equal(bot.sendUnsentJobs(p.id).queued,1);store.setRecordState(p.id,job.id,'completed');await flush();
 assert.equal(calls.length,0);assert.equal(bot.db.jobSent(p.id,bot.config.bot.id,job.id),false);
});

test('score-filtered resend includes deleted, delivered and completed jobs without changing records or original messages',async t=>{
 const {bot,store,p,other,pair,drain,calls}=await fixture(t);
 const add=(name,score,candidate=p.id)=>{const job=store.addRecord(candidate,{url:`https://example.com/resend/${name}`,company:name,role:'Engineer',location:'Remote'}).job;if(score!==null)store.scoreRecord(candidate,job.id,score);return job;};
 const deleted=add('Deleted',71),sent=add('Sent',85),completed=add('Completed',100),fresh=add('New',80);
 add('Boundary',70);add('Low',69);add('Unscored',null);add('Foreign',99,other.id);
 const hidden=add('Hidden',99);store.saveRecord({...store.job(p.id,hidden.id),hidden:true});
 store.setRecordState(p.id,completed.id,'completed');pair();bot.preferences(p.id,{newJobs:false,notifications:false,questions:false});
 const originals=[deleted,sent].map((job,i)=>{const row=bot.db.enqueue(p.id,'new-job:'+job.id,{kind:'new_job',jobId:job.id});bot.db.sent(row.id,900+i);if(i===0)bot.db.deleted(row.id);return bot.db.delivery(row.id);});
 const before=store.jobs(p.id),selection={minScore:70,resend:true};
 assert.deepEqual(bot.sendUnsentJobs(p.id,selection),{queued:4,alreadyQueued:0,alreadySent:0,completed:0,filtered:3});
 assert.equal(bot.sendUnsentJobs(p.id,selection).alreadyQueued,4);await drain();
 const messages=calls.filter(call=>call.method==='sendMessage');
 assert.deepEqual(new Set(messages.map(call=>call.body.reply_markup.inline_keyboard[0][0].url)),new Set([deleted,sent,completed,fresh].map(job=>job.url)));
 assert.equal(messages.length,4);assert.ok(messages.every(call=>call.body.chat_id==='11'));
 assert.deepEqual(store.jobs(p.id),before);for(const row of originals)assert.deepEqual(bot.db.delivery(row.id),row);
 assert.equal(bot.sendUnsentJobs(p.id,{minScore:70}).queued,0);
 assert.equal(bot.sendUnsentJobs(p.id,selection).queued,4);
});

test('batch score boundary is validated and rechecked after restart while resend preserves completion',async t=>{
 const {bot,store,p,pair,options,calls,advance}=await fixture(t);pair();bot.preferences(p.id,{newJobs:false,notifications:false,questions:false});
 const jobs=['Falls','Completes','BecomesUnscored'].map(name=>store.addRecord(p.id,{url:'https://example.com/recheck/'+name,company:name,role:'Engineer',location:'Remote'}).job);
 for(const job of jobs)store.scoreRecord(p.id,job.id,90);
 for(const input of [null,[],{minScore:'70'},{minScore:NaN},{minScore:Infinity},{minScore:-1},{minScore:101},{resend:'true'}])assert.throws(()=>bot.sendUnsentJobs(p.id,input),/Geçersiz|Minimum puan/);
 assert.equal(bot.db.pending().length,0);assert.equal(bot.sendUnsentJobs(p.id,{minScore:100,resend:true}).queued,0);
 assert.equal(bot.sendUnsentJobs(p.id,{minScore:70,resend:true}).queued,3);
 store.scoreRecord(p.id,jobs[0].id,70);store.setRecordState(p.id,jobs[1].id,'completed');store.scoreRecord(p.id,jobs[2].id,null);
 const restarted=new Telegram(options);restarted.api=bot.api;restarted.config={...bot.config};
 for(let i=0;i<5;i++){advance(2000);await restarted.flush();}
 const messages=calls.filter(call=>call.method==='sendMessage');assert.equal(messages.length,1);assert.equal(messages[0].body.reply_markup.inline_keyboard[0][0].url,jobs[1].url);
 assert.equal(restarted.db.pending().length,0);
 // An empty threshold includes unscored and boundary jobs again.
 assert.equal(restarted.sendUnsentJobs(p.id,{minScore:null,resend:true}).queued,3);
});

test('manual resend reuses an automatic pending card and unsent-only filtering still excludes completed applications',async t=>{
 const {bot,store,p,pair,drain,calls}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/pending',company:'Pending',role:'Engineer',location:'Remote'}).job;
 store.scoreRecord(p.id,job.id,80);bot.db.collect();assert.equal(bot.db.pending().length,1);
 assert.equal(bot.sendUnsentJobs(p.id,{minScore:70,resend:true}).alreadyQueued,1);assert.equal(bot.db.pending().length,1);
 bot.preferences(p.id,{newJobs:false,notifications:false,questions:false});await drain();assert.equal(calls.filter(call=>call.method==='sendMessage').length,1);
 const completed=store.addRecord(p.id,{url:'https://example.com/completed',company:'Completed',role:'Engineer',location:'Remote'}).job;
 store.scoreRecord(p.id,completed.id,99);store.setRecordState(p.id,completed.id,'completed');
 assert.equal(bot.sendUnsentJobs(p.id,{minScore:70}).completed,1);assert.equal(bot.db.pending().length,0);
});

test('resending a new job before its discovery event is collected creates only one card',async t=>{
 const {bot,store,p,pair,drain,calls}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/not-yet-collected',company:'New discovery',role:'Engineer',location:'Remote'}).job;store.scoreRecord(p.id,job.id,85);
 assert.equal(bot.sendUnsentJobs(p.id,{minScore:70,resend:true}).queued,1);
 bot.db.collect();assert.equal(bot.db.pending().length,1);await drain();assert.equal(calls.filter(call=>call.method==='sendMessage').length,1);
});

test('delivery history migrates old sent/deleted receipts and survives relinking',async t=>{
 const {bot,store,p,pair,options}=await fixture(t);pair();
 const jobs=['Sent','Deleted'].map(company=>store.addRecord(p.id,{url:'https://example.com/history/'+company,company,role:'Engineer',location:'Remote',fit:'Match'}).job);
 jobs.forEach((job,index)=>{const row=bot.db.enqueue(p.id,'new-job:'+job.id,{kind:'new_job',jobId:job.id});store.db.prepare('UPDATE telegram_outbox SET status=?,message_id=? WHERE id=?').run(index?'deleted':'sent',index+1,row.id);});
 const restarted=new Telegram(options);restarted.api=bot.api;restarted.config={...bot.config};
 assert.equal(restarted.sendUnsentJobs(p.id).alreadySent,2);
 restarted.unlink(p.id);pair();assert.equal(bot.sendUnsentJobs(p.id).queued,0);
 store.removeWorkspace(p.id);assert.equal(store.db.prepare('SELECT count(*) AS n FROM telegram_job_deliveries').get().n,0);assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('a batch of 500 jobs survives restart and sends each job in its own message',async t=>{
 const {bot,store,p,pair,options,calls,advance}=await fixture(t);
 for(let index=0;index<500;index++)store.addRecord(p.id,{url:`https://example.com/bulk/${index}`,company:`Bulk ${index}`,role:'Engineer',location:'Remote',fit:'Match'});
 pair();assert.equal(bot.sendUnsentJobs(p.id).queued,500);
 for(let i=0;i<30;i++){advance(2000);await bot.flush();}
 const restarted=new Telegram(options);restarted.api=bot.api;restarted.config={...bot.config};assert.equal(restarted.sendUnsentJobs(p.id).queued,0);
 for(let i=0;i<500&&restarted.db.pending().length;i++){advance(2000);await restarted.flush();}
 const messages=calls.filter(call=>call.method==='sendMessage');assert.equal(messages.length,500);
 assert.equal(new Set(messages.map(call=>call.body.reply_markup.inline_keyboard[0][0].url)).size,500);
 assert.equal(restarted.status(p.id).candidate.pending,0);assert.equal(restarted.sendUnsentJobs(p.id).alreadySent,500);
});

test('job cards show each application state in the same message and preserve both buttons',async t=>{
 const {bot,store,p,other,pair,flush,calls}=await fixture(t);pair();pair(other.id,22);bot.preferences(p.id,{notifications:false,questions:true});
 const job=store.addRecord(p.id,{url:'https://example.com/status',company:'Status',role:'Engineer',location:'Remote',fit:'Match'}).job;
 store.addRecord(other.id,{url:'https://example.com/foreign-status',company:'Foreign',role:'Engineer',location:'Remote',fit:'Match'});
 await flush();const original=calls.find(call=>call.body.chat_id==='11').body;
 const row=bot.db.delivery(original.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2));
 assert.match(original.text,/^<b>İş arama · Bulundu<\/b>/);
 const cases=[[{status:'prepared'},'Taslak hazır'],[{status:'executing'},'İşlem sürüyor'],[{status:'uncertain'},'Doğrulama bekliyor'],[{status:'completed'},'Tamamlandı'],[{status:'dismissed'},'Atlandı']];
 for(const [changes,label] of cases){
  store.saveRecord({...job,...changes},'job_updated');await flush();const edit=calls.at(-1);
  assert.equal(edit.method,'editMessageText');assert.equal(edit.body.chat_id,'11');assert.equal(edit.body.message_id,row.message_id);
  assert.ok(edit.body.text.includes(label),edit.body.text);assert.deepEqual(edit.body.reply_markup,original.reply_markup);
 }
 const count=calls.length;store.saveRecord({...store.job(p.id,job.id),note:'Only an internal note changed'},'application_checkpoint_saved');await flush();await flush();assert.equal(calls.length,count);
 assert.equal(calls.filter(call=>call.method==='sendMessage').length,2);assert.equal(bot.db.delivery(row.id).status,'sent');
});

test('updates coalesce, include ranking and catch changes made during the original send',async t=>{
 const {bot,store,p,pair,flush,calls,api}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/in-flight',company:'In flight',role:'Engineer',location:'Remote',fit:'Match'}).job;
 const original=api.call;api.call=async(method,body)=>{
  const result=await original(method,body);
  if(method==='sendMessage')store.saveRecord({...store.job(p.id,job.id),status:'prepared'},'job_updated');
  return result;
 };
 await flush();store.saveRecord({...store.job(p.id,job.id),status:'executing'},'job_updated');store.scoreRecord(p.id,job.id,80);await flush();
 assert.equal(calls.filter(call=>call.method==='sendMessage').length,1);assert.equal(calls.filter(call=>call.method==='editMessageText').length,1);
 assert.match(calls.at(-1).body.text,/İşlem sürüyor/);assert.match(calls.at(-1).body.text,/Uygunluk puanı:<\/b> 80/);
});

test('manually sent backlog cards stay current after completion even with new notifications disabled',async t=>{
 const {bot,store,p,pair,flush,calls}=await fixture(t);
 const job=store.addRecord(p.id,{url:'https://example.com/backlog-status',company:'Backlog',role:'Engineer',location:'Remote',fit:'Match'}).job;pair();
 bot.preferences(p.id,{newJobs:false,notifications:false,questions:false});bot.sendUnsentJobs(p.id);await flush();
 store.setRecordState(p.id,job.id,'completed');await flush();
 assert.equal(calls.length,2);assert.equal(calls[1].method,'editMessageText');assert.match(calls[1].body.text,/Tamamlandı/);
 assert.ok(!calls[1].body.text.includes('tamamlanmamış'));assert.equal(bot.sendUnsentJobs(p.id).queued,0);
});

test('status edit retry survives restart, respects global rate limits and renders the latest state',async t=>{
 const {bot,store,p,pair,flush,calls,api,options,advance}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/edit-retry',company:'Retry',role:'Engineer',location:'Remote',fit:'Match'}).job;await flush();
 const original=api.call;let attempts=0;
 api.call=async(method,body)=>{if(method==='editMessageText'){attempts++;throw Object.assign(Error('Rate limit'),{code:429,retryAfter:30});}return original(method,body);};
 store.saveRecord({...job,status:'prepared'},'job_updated');await flush();assert.equal(attempts,1);assert.equal(bot.status(p.id).candidate.pending,1);
 const restarted=new Telegram(options);restarted.api=api;restarted.config={...bot.config};
 store.saveRecord({...job,status:'executing'},'job_updated');restarted.db.message(p.id,'Queued during rate limit');
 advance(29000);await restarted.flush();assert.equal(attempts,1);assert.equal(calls.length,1);
 api.call=original;advance(1001);await restarted.flush();
 const edit=calls.at(-1);assert.equal(edit.method,'editMessageText');assert.match(edit.body.text,/İşlem sürüyor/);assert.equal(restarted.status(p.id).candidate.pending,1);
 advance(2000);await restarted.flush();assert.equal(calls.at(-1).body.text,'Queued during rate limit');assert.equal(restarted.status(p.id).candidate.pending,0);
 assert.equal(calls.filter(call=>call.method==='sendMessage'&&call.body.reply_markup).length,1);
});

test('old sent cards gain status on restart while deleted cards and unlinked candidates never reappear',async t=>{
 const {bot,store,p,pair,flush,calls,options}=await fixture(t);pair();
 const jobs=['Legacy','Deleted'].map(company=>store.addRecord(p.id,{url:'https://example.com/legacy/'+company,company,role:'Engineer',location:'Remote',fit:'Match'}).job);
 await flush();await flush();const rows=store.db.prepare("SELECT id FROM telegram_outbox WHERE candidate_id=? AND status='sent'").all(p.id).map(row=>bot.db.delivery(row.id));
 await bot.deleteNotification(deleteCallback(rows[1]));store.db.exec('DELETE FROM telegram_job_messages');
 const restarted=new Telegram(options);restarted.api=bot.api;restarted.config={...bot.config};await restarted.flush();
 assert.equal(calls.filter(call=>call.method==='editMessageText').length,1);assert.equal(calls.at(-1).body.message_id,rows[0].message_id);
 for(const job of jobs)store.saveRecord({...job,status:'prepared'},'job_updated');restarted.db.collect();
 restarted.unlink(p.id);pair(p.id,33);await flush();assert.equal(calls.filter(call=>call.method==='editMessageText').length,1);
 assert.equal(bot.sendUnsentJobs(p.id).queued,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM telegram_job_messages').get().n,0);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('unchanged edits succeed, missing messages stay deleted and failed edits never resend the card',async t=>{
 const {bot,store,p,pair,flush,calls,api,advance}=await fixture(t);pair();
 const job=store.addRecord(p.id,{url:'https://example.com/edit-errors',company:'Errors',role:'Engineer',location:'Remote',fit:'Match'}).job;await flush();
 const row=bot.db.delivery(calls[0].body.reply_markup.inline_keyboard.at(-1)[0].callback_data.slice(2)),original=api.call;let attempts=0;
 api.call=async()=>{attempts++;throw Object.assign(Error('Already updated'),{code:400,editResult:'unchanged'});};
 store.saveRecord({...job,status:'prepared'},'job_updated');await flush();await flush();assert.equal(attempts,1);assert.equal(bot.status(p.id).candidate.failed,0);
 api.call=async()=>{attempts++;throw Object.assign(Error('Blocked'),{code:403});};
 store.saveRecord({...job,status:'executing'},'job_updated');await flush();assert.equal(bot.status(p.id).candidate.failed,1);assert.equal(bot.db.delivery(row.id).status,'sent');
 store.saveRecord({...job,status:'blocked'},'job_updated');advance(60000);await flush();assert.equal(attempts,2);
 bot.retry(p.id);api.call=original;await flush();assert.equal(calls.at(-1).method,'editMessageText');assert.equal(bot.status(p.id).candidate.failed,0);
 api.call=async()=>{attempts++;throw Object.assign(Error('Missing'),{code:400,editResult:'missing'});};
 store.saveRecord({...job,status:'prepared'},'job_updated');await flush();assert.equal(bot.db.delivery(row.id).status,'deleted');
 bot.retry(p.id);store.saveRecord({...job,status:'executing'},'job_updated');await flush();assert.equal(attempts,3);assert.equal(bot.sendUnsentJobs(p.id).queued,0);
 assert.equal(calls.filter(call=>call.method==='sendMessage').length,1);
});

test('Telegram edit outcome classification keeps raw descriptions private and is method-specific',async()=>{
 for(const [description,expected] of [['Bad Request: message is not modified: '+TOKEN,'unchanged'],['Bad Request: message to edit not found','missing'],['Bad Request: message can\'t be edited',null]]){
  const api=new TelegramApi(TOKEN,{fetcher:async()=>({ok:false,status:400,json:async()=>({ok:false,error_code:400,description})})});
  await assert.rejects(api.call('editMessageText'),error=>error.editResult===expected&&!JSON.stringify(error).includes(TOKEN)&&!error.message.includes(description));
  await assert.rejects(api.call('sendMessage'),error=>error.editResult===null);
 }
});
