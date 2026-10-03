import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {NotificationFixture} from './helpers/notifications.mjs';
import {Telegram} from '../app/telegram-accounts.mjs';

const FIRST='123456789:abcdefghijklmnopqrstuvwxyz_123456789',SECOND='987654321:abcdefghijklmnopqrstuvwxyz_987654321';
const input=company=>({url:`https://example.com/${company}`,company,role:'Engineer',location:'Remote',fit:'Match'});
async function fixture(t){
 const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-telegram-accounts-')),store=new NotificationFixture(path.join(data,'test.sqlite'));
 const p=store.createWorkspace({name:'Ada',preferences:'Remote'}),other=store.createWorkspace({name:'Grace',preferences:'Hybrid'}),calls=[],numbers=new Map(),failures=new Map(),answers=[];
 let now=1000000;
 const options={store,data,now:()=>now,encrypt:value=>Buffer.from('encrypted:'+value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString().slice(10),withdrawApplication:(id,jobId)=>store.setRecordState(id,jobId,'dismissed'),answer:async(id,q,values)=>{answers.push({id,q,values});return store.answerQuestion(id,q,values);},apiFactory:token=>{
  const botId=token.split(':')[0];return {async call(method,body={},signal){
   calls.push({botId,method,body});if(failures.has(botId+':'+method))throw failures.get(botId+':'+method);
   if(method==='getMe')return {id:Number(botId),username:'bot_'+botId,is_bot:true};
   if(method==='getWebhookInfo')return {url:''};
   if(method==='getUpdates')return new Promise(resolve=>signal.aborted?resolve([]):signal.addEventListener('abort',()=>resolve([]),{once:true}));
   if(method==='sendMessage'){const number=(numbers.get(botId)||0)+1;numbers.set(botId,number);return {message_id:number};}
   if(['editMessageText','deleteMessage','answerCallbackQuery'].includes(method))return true;
   throw Error('Unexpected '+method);
  }};
 }};
 const service=new Telegram(options),services=[service];
 const pair=(candidate=p.id,chat=11)=>{const token=new URL(service.pairing(candidate).url).searchParams.get('start');return service.worker(candidate).db.bind(token,chat,chat,'Same Telegram user');};
 const flush=async()=>{now+=2000;for(const worker of service.workers.values()){await worker.flushPromise;await worker.flush();}};
 const reopen=async()=>{await service.stop();const reopened=new Telegram(options);services.push(reopened);await reopened.load();return reopened;};
 t.after(async()=>{for(const item of services)await item.stop();store.close();await rm(data,{recursive:true,force:true});});
 return {service,store,p,other,data,options,calls,failures,answers,pair,flush,reopen,advance:ms=>{now+=ms;}};
}

test('two candidates keep distinct encrypted tokens, bot identities, queues and offsets across restart',async t=>{
 const {service,store,p,other,calls,pair,flush,reopen}=await fixture(t);
 await service.configure(p.id,{token:FIRST,enabled:true});assert.equal(service.status(other.id).configured,false);
 await service.configure(other.id,{token:SECOND,enabled:true});
 assert.equal(service.status(p.id).bot.username,'bot_123456789');assert.equal(service.status(other.id).bot.username,'bot_987654321');assert.equal(service.workers.size,2);
 const encoded=JSON.stringify(service.db.configs());for(const token of [FIRST,SECOND])assert.ok(!encoded.includes(token)&&!JSON.stringify(service.status(p.id)).includes(token));
 assert.ok(pair(p.id,11));assert.ok(pair(other.id,11));
 const own=store.addRecord(p.id,input('Ada-only')).job,foreign=store.addRecord(other.id,input('Grace-only')).job;await flush();
 const sends=calls.filter(call=>call.method==='sendMessage');assert.equal(sends.length,2);
 assert.deepEqual(sends.map(call=>[call.botId,call.body.chat_id,call.body.reply_markup.inline_keyboard[0][0].url]),[['123456789','11',own.url],['987654321','11',foreign.url]]);
 service.worker(p.id).db.setMeta('offset',51);service.worker(other.id).db.setMeta('offset',90);
 const restarted=await reopen();assert.equal(restarted.status(p.id).bot.id,123456789);assert.equal(restarted.status(other.id).bot.id,987654321);
 assert.equal(restarted.worker(p.id).db.meta('offset'),'51');assert.equal(restarted.worker(other.id).db.meta('offset'),'90');
 assert.equal(restarted.sendUnsentJobs(p.id).alreadySent,1);assert.equal(restarted.sendUnsentJobs(other.id).alreadySent,1);
 assert.equal(restarted.worker(p.id).db.jobSent(other.id,123456789,foreign.id),false);
});

test('a shared Telegram user cannot use pairing, answer or delete callbacks through the wrong bot',async t=>{
 const {service,store,p,other,calls,pair,flush,answers}=await fixture(t);
 await service.configure(p.id,{token:FIRST,enabled:true});await service.configure(other.id,{token:SECOND,enabled:true});
 const token=new URL(service.pairing(p.id).url).searchParams.get('start');assert.equal(service.worker(other.id).db.bind(token,11,11,'Wrong bot'),null);
 assert.ok(service.worker(p.id).db.bind(token,11,11,'Right bot'));assert.ok(pair(other.id,11));
 const job=store.addRecord(p.id,input('Original')).job;store.addRecord(other.id,input('Other')).job;await flush();
 const original=calls.find(call=>call.method==='sendMessage'&&call.botId==='123456789'),id=original.body.reply_markup.inline_keyboard.at(-1)[0].callback_data;
 const callback={id:'delete',from:{id:11},message:{chat:{id:11,type:'private'},message_id:1},data:id};
 assert.equal((await service.worker(other.id).deleteNotification(callback)).show_alert,true);assert.equal(calls.filter(call=>call.method==='deleteMessage').length,0);
 store.setRecordState(p.id,job.id,'completed');await flush();
 const edits=calls.filter(call=>call.method==='editMessageText');assert.equal(edits.length,1);assert.equal(edits[0].botId,'123456789');assert.equal(edits[0].body.message_id,1);
 const q=store.askQuestion(p.id,{question:'Private question'});
 await service.worker(other.id).conversation.handle({callback_query:{...callback,data:'q:'+q.id}});
 assert.equal(service.worker(other.id).db.link(other.id).data.dialog,null);assert.equal(answers.length,0);
 const before=store.job(p.id,job.id),completed=await service.worker(p.id).deleteNotification(callback);
 assert.equal(completed.text,'Mesaj silindi.');assert.deepEqual(store.job(p.id,job.id),before);
 const deleted=calls.filter(call=>call.method==='deleteMessage');assert.equal(deleted.length,1);assert.equal(deleted[0].botId,'123456789');assert.equal(deleted[0].body.message_id,1);
});

test('desktop question answers update only that candidate bot when both bots share a Telegram user',async t=>{
 const {service,store,p,other,calls,pair,flush}=await fixture(t);
 await service.configure(p.id,{token:FIRST,enabled:true});await service.configure(other.id,{token:SECOND,enabled:true});pair(p.id,11);pair(other.id,11);
 const q=store.askQuestion(p.id,{question:'Ada private question'}),foreign=store.askQuestion(other.id,{question:'Grace private question'});await flush();
 store.answerQuestion(p.id,q.id,'Ada private answer');await flush();
 const edits=calls.filter(call=>call.method==='editMessageText');assert.equal(edits.length,1);assert.equal(edits[0].botId,'123456789');assert.equal(edits[0].body.message_id,1);assert.match(edits[0].body.text,/Ada private answer/);
 assert.equal(store.questions(other.id).find(item=>item.id===foreign.id).answer,null);assert.equal(calls.filter(call=>call.method==='sendMessage').length,2);
});

test('changing a candidate bot clears only that pairing and preserves the other candidate and per-bot history',async t=>{
 const {service,store,p,other,pair,flush,calls}=await fixture(t);
 await service.configure(p.id,{token:FIRST,enabled:true});await service.configure(other.id,{token:SECOND,enabled:true});pair(p.id,11);pair(other.id,11);
 const job=store.addRecord(p.id,input('History')).job;await flush();
 const row=service.worker(p.id).db.pendingEdits();assert.equal(row.length,0);
 const oldOther=service.worker(other.id),savedOther=service.db.link(other.id);service.worker(other.id).db.message(other.id,'Other queue');
 await service.configure(p.id,{token:'555555555:abcdefghijklmnopqrstuvwxyz_555555555',enabled:true});
 assert.equal(service.status(p.id).candidate.connected,false);assert.equal(service.worker(other.id),oldOther);assert.deepEqual(service.db.link(other.id),savedOther);
 assert.ok(pair(p.id,11));assert.equal(service.sendUnsentJobs(p.id).queued,1);await flush();
 assert.ok(calls.some(call=>call.botId==='987654321'&&call.body.text==='Other queue'));
 await service.configure(p.id,{token:FIRST,enabled:true});assert.ok(pair(p.id,11));assert.equal(service.sendUnsentJobs(p.id).alreadySent,1);
 assert.equal(service.worker(p.id).db.jobSent(p.id,555555555,job.id),true);assert.equal(service.status(other.id).bot.id,987654321);
});

test('shared bots have one poller while enablement remains per candidate and token rotation preserves drafts',async t=>{
 const {service,store,p,other,pair,flush}=await fixture(t);
 await service.configure(p.id,{token:FIRST,enabled:true});await service.configure(other.id,{token:FIRST,enabled:true});assert.equal(service.workers.size,1);
 pair(p.id,11);pair(other.id,22);
 const q=store.askQuestion(p.id,{question:'Draft'}),worker=service.worker(p.id);
 await worker.conversation.handle({callback_query:{id:'q',from:{id:11},message:{chat:{id:11,type:'private'}},data:'q:'+q.id}});
 worker.db.setMeta('offset',71);const draft=worker.db.link(p.id).data.dialog;
 await service.configure(p.id,{token:'123456789:rotated_abcdefghijklmnopqrstuvwxyz',enabled:true});
 assert.equal(service.worker(p.id).db.meta('offset'),'71');assert.deepEqual(service.worker(p.id).db.link(p.id).data.dialog,draft);
 assert.equal(service.db.config(p.id).data.secret,service.db.config(other.id).data.secret);
 await service.configure(p.id,{enabled:false});assert.equal(service.status(p.id).running,false);assert.equal(service.status(other.id).running,true);
 assert.equal(service.worker(other.id).db.sender(11,11),null);assert.throws(()=>service.pairing(p.id),/kaydedip aç/);
 const a=store.addRecord(p.id,input('Disabled')).job,b=store.addRecord(other.id,input('Enabled')).job;await flush();
 assert.equal(service.worker(other.id).db.jobSent(p.id,123456789,a.id),false);assert.equal(service.worker(other.id).db.jobSent(other.id,123456789,b.id),true);
});

test('a bot rate limit does not stall another bot and invalid configuration leaves both saved accounts intact',async t=>{
 const {service,store,p,other,pair,flush,failures,calls}=await fixture(t);
 await service.configure(p.id,{token:FIRST,enabled:true});await service.configure(other.id,{token:SECOND,enabled:true});pair(p.id,11);pair(other.id,11);
 failures.set('123456789:sendMessage',Object.assign(Error('Rate limit'),{code:429,retryAfter:30}));
 store.addRecord(p.id,input('Limited'));store.addRecord(other.id,input('Independent'));await flush();
 assert.equal(service.status(p.id).candidate.pending,1);assert.equal(service.status(other.id).candidate.pending,0);
 assert.ok(Number(service.worker(p.id).db.meta('sendAfter'))>0);assert.equal(service.worker(other.id).db.meta('sendAfter',0),0);
 const configs=service.db.configs();failures.set('987654321:getMe',Object.assign(Error('Invalid token'),{code:401}));
 await assert.rejects(service.configure(other.id,{token:SECOND,enabled:true}),/Invalid token/);assert.deepEqual(service.db.configs(),configs);
 assert.ok(calls.some(call=>call.botId==='987654321'&&call.method==='sendMessage'));
 failures.delete('987654321:getMe');const original=service.apiFactory;
 service.apiFactory=token=>{const api=original(token),call=api.call;api.call=(method,...args)=>method==='getWebhookInfo'?Promise.resolve({url:'https://example.com/webhook'}):call(method,...args);return api;};
 await assert.rejects(service.configure(other.id,{token:SECOND,enabled:true}),/webhook/);assert.deepEqual(service.db.configs(),configs);
});

test('legacy global setup migrates linked candidates, original messages, drafts and offsets without assigning unrelated candidates',async t=>{
 const {service,store,p,other,data,options,reopen}=await fixture(t);
 const legacy={enabled:true,bot:{id:123456789,username:'bot_123456789'},secret:options.encrypt(FIRST)};
 service.db.setMeta('bot',123456789);service.db.setMeta('offset',123);service.db.setMeta('sendAfter',2000000);
 store.db.exec(`DROP TABLE telegram_links;CREATE TABLE telegram_links(candidate_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,chat_id TEXT UNIQUE NOT NULL,user_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL,cursor INTEGER NOT NULL);`);
 const draft=store.askQuestion(p.id,{question:'Existing draft question'});
 const dataJson={name:'Existing account',newJobs:true,notifications:true,questions:true,dialog:{questionId:draft.id,promptId:'existing'},linkedAt:100};
 store.db.prepare('INSERT INTO telegram_links VALUES(?,?,?,?,?)').run(p.id,'11','11',JSON.stringify(dataJson),15);
 const job=store.addRecord(p.id,input('Legacy')).job,row=service.db.enqueue(p.id,'new-job:'+job.id,{kind:'new_job',jobId:job.id});
 store.db.prepare("UPDATE telegram_outbox SET status='sent',message_id=77 WHERE id=?").run(row.id);
 await writeFile(path.join(data,'telegram.json'),JSON.stringify(legacy));
 const restarted=await reopen();assert.equal(restarted.status(p.id).bot.id,123456789);assert.equal(restarted.status(other.id).configured,false);
 assert.equal(restarted.worker(p.id).db.meta('offset'),'123');assert.equal(restarted.worker(p.id).db.meta('sendAfter'),'2000000');
 const {queueSignature,...migratedLink}=restarted.db.link(p.id).data;
 assert.deepEqual(migratedLink,dataJson);assert.equal(restarted.db.link(p.id).bot_id,'123456789');
 assert.equal(restarted.worker(p.id).db.delivery(row.id).message_id,77);assert.equal(restarted.sendUnsentJobs(p.id).alreadySent,1);
 await assert.rejects(access(path.join(data,'telegram.json')));assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('workspace removal deletes its encrypted configuration and stops only its own bot',async t=>{
 const {service,store,p,other,pair}=await fixture(t);
 await service.configure(p.id,{token:FIRST,enabled:true});await service.configure(other.id,{token:SECOND,enabled:true});pair(p.id,11);pair(other.id,11);
 await service.removeCandidate(p.id);store.removeWorkspace(p.id);
 assert.equal(service.db.config(p.id),null);assert.equal(service.workers.has('123456789'),false);assert.equal(service.status(other.id).running,true);
 assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('account service forwards score and resend options only to the selected candidate bot',async t=>{
 const {service,store,p,other,pair,flush,calls}=await fixture(t);
 await service.configure(p.id,{token:FIRST,enabled:true});await service.configure(other.id,{token:SECOND,enabled:true});pair(p.id,11);pair(other.id,11);
 for(const candidate of [p,other])service.preferences(candidate.id,{newJobs:false,notifications:false,questions:false});
 for(const [name,score,candidate] of [['High',80,p],['Boundary',70,p],['Foreign',99,other]]){const job=store.addRecord(candidate.id,input(name)).job;store.scoreRecord(candidate.id,job.id,score);}
 assert.equal(service.sendUnsentJobs(p.id,{minScore:70,resend:true}).queued,1);await flush();
 let sends=calls.filter(call=>call.method==='sendMessage');assert.equal(sends.length,1);assert.equal(sends[0].botId,'123456789');assert.match(sends[0].body.text,/High/);
 assert.equal(service.sendUnsentJobs(p.id,{minScore:70,resend:true}).queued,1);await flush();
 sends=calls.filter(call=>call.method==='sendMessage');assert.equal(sends.length,2);assert.equal(sends[1].botId,'123456789');
});
