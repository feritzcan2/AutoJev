import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {registerWorkspaceSupport} from '../app/workspace-support-services.mjs';
import {TelegramBot} from '../app/telegram.mjs';
import {enqueueRecordOperation} from '../app/record-operations.mjs';
import {OUTCOME_FIELD} from '../app/question-forms.mjs';

const source='https://example.test/list';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,template='job-search',{sourceUrl=false}={}){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core),definition=db.template(template);
 const a=db.create(template,{goal:'Track suitable records',criteria:Object.fromEntries(definition.fields.filter(f=>f.required).map(f=>[f.id,'Known'])),sources:[source]});
 db.review(a.id);const trial=db.begin(a.id,'trial');for(const url of a.sources)db.observe(a.id,trial.id,url,'Observed source');db.finish(a.id,trial.id,'completed','Source checked');db.save(a.id,{mode:'observe'});
 const seed=db.begin(a.id,'run');let item=db.record(a.id,seed.id,{url:source+'/1',title:'Synthetic record',summary:'Observed facts',proposal:'Verified form answers'});
 if(sourceUrl)item=db.putResult({...item,sourceUrl:source});db.finish(a.id,seed.id,'completed','Prepared');db.pause(a.id);
 db.put({...db.get(a.id),sourceSettings:{[source]:{enabled:false}},sourceState:{[source]:{blocked:true,lastResult:'Access barrier',nextRunAt:null}}});
 const launches=[],runtime=new WebTasks(db,{launch:async run=>{launches.push(run);return {close:async()=>{}};}}),data=await mkdtemp(path.join(tmpdir(),'loop-record-lifecycle-'));
 const services=await registerWorkspaceSupport({root:process.cwd(),data,db,runtime,agents:{ensure(){}},profiles:{register(){}},mcp:{},scheduler:{register(){}},handle(){},emit(){},isQuitting:()=>false});
 let now=Date.now();const calls=[],bot=new TelegramBot({store:services.store,botId:123,queueApplication:services.telegram.queueApplication,withdrawApplication:services.telegram.withdrawApplication,now:()=>now});
 bot.config={enabled:true,bot:{id:123}};bot.api={call:async(method,body)=>{calls.push({method,body});return method==='sendMessage'?{message_id:calls.length+100}:true;}};
 bot.db.saveConfig(a.id,{...bot.config,secret:'synthetic'});const link=bot.db.bind(bot.db.pair(a.id).token,11,11,'Test');
 const row=bot.db.enqueue(a.id,'new-job:'+item.id,{kind:'new_job',jobId:item.id}),body=bot.delivery(row,link);
 bot.db.sent(row.id,1,123,body);const card=bot.db.delivery(row.id);
 const callback=data=>({id:'click',from:{id:11},message:{chat:{id:11,type:'private'},message_id:1},data});
 const button=()=>bot.delivery(card,bot.db.link(a.id),{edit:true}).reply_markup.inline_keyboard.flat().find(b=>b.callback_data?.startsWith('queue:'));
 t.after(async()=>{await bot.stop();await services.close();await runtime.close();core.close();await rm(data,{recursive:true,force:true});});
 return {core,db,id:a.id,item,runtime,services,launches,bot,card,body,button,callback,calls,advance:()=>{now+=2000;}};
}

for(const template of ['job-search','housing','appointment','custom'])for(const sourceUrl of [false,true])test(`${template}: Telegram executes only its record with a disabled source (source URL: ${sourceUrl})`,async t=>{
 const f=await fixture(t,template,{sourceUrl}),before=f.db.get(f.id),button=f.button();
 assert.ok(Buffer.byteLength(button.callback_data)<=64);
 const result=await f.bot.queueNotification(f.callback(button.callback_data));await settle();
 assert.match(result.text,/işlem sırasına/);assert.equal(f.launches.length,1);
 assert.equal(f.launches[0].recordId,f.item.id);assert.equal(f.launches[0].recordOperation,'execute');assert.equal(f.launches[0].request.direct,true);
 assert.equal(f.db.get(f.id).status,'paused');assert.equal(f.db.get(f.id).mode,'observe');assert.deepEqual(f.db.get(f.id).sourceState,before.sourceState);
 await f.bot.queueNotification(f.callback(button.callback_data));assert.equal(f.launches.length,1);
});

test('pending Telegram work is durable, shown as queued and pinned before a worker is available',async t=>{
 const f=await fixture(t);f.runtime.concurrency=0;
 await f.bot.queueNotification(f.callback(f.button().callback_data));
 assert.equal(f.services.store.queueState(f.id,f.item).state,'queued');assert.equal(f.launches.length,0);
 assert.equal(f.core.workspaces.tasks.list(f.id,{states:['pending']}).length,1);
 f.advance();await f.bot.flush();
 assert.ok(f.calls.some(call=>call.method==='pinChatMessage'&&call.body.message_id===1));
 assert.equal(f.button(),undefined);assert.match(f.bot.delivery(f.card,f.bot.db.link(f.id),{edit:true}).text,/görev zaten sırada/);
});

test('old or changed Telegram buttons refresh without granting new authority',async t=>{
 const f=await fixture(t),old=f.button().callback_data;
 f.db.putResult({...f.item,proposal:'Different commitment',digest:'different'});
 for(const data of [old,'queue:'+f.card.id])assert.equal((await f.bot.queueNotification(f.callback(data))).show_alert,true);
 assert.equal(f.launches.length,0);assert.equal(f.db.result(f.id,f.item.id).approvedDigest,null);
 assert.notEqual(f.button().callback_data,old);
});

test('Telegram dispatches uncertain records only to verification and respects disabled template operations',async t=>{
 const f=await fixture(t);f.db.putResult({...f.item,status:'uncertain'});f.db.put({...f.db.get(f.id),reviewedRevision:null,trial:null,endAt:1});
 const result=await f.bot.queueNotification(f.callback(f.button().callback_data));await settle();
 assert.match(result.text,/doğrulama sırasına/);assert.equal(f.launches[0].recordOperation,'verify');
 assert.throws(()=>f.db.reserve(f.id,f.launches[0].id,f.item.id));
 await f.runtime.pause(f.id);
 const saved=f.db.saveTemplate({...f.db.template('custom'),recordOperations:false}),other=f.db.create(saved.id);
 const record=f.db.putResult({...f.item,id:undefined,automationId:other.id,status:'uncertain'});
 assert.equal(f.services.store.queueState(other.id,record).state,'unavailable');
});

test('Telegram dismissal stops its worker, resolves its questions and renders resolved forms',async t=>{
 const f=await fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');const run=f.launches[0];
 const q=f.db.askQuestion(f.id,{recordId:f.item.id,text:'Missing fact?'},{runId:run.id});
 const reply=await f.bot.deleteNotification(f.callback('d:'+f.card.id));
 assert.match(reply.text,/kayıt elendi/);assert.equal(f.runtime.slots(f.id).length,0);assert.equal(f.db.result(f.id,f.item.id).status,'dismissed');
 assert.equal(f.bot.db.question(f.id,q.id).resolution,'record_dismissed');
 assert.equal(f.core.workspaces.tasks.list(f.id,{states:['pending','running','reported','paused']}).length,0);
});

test('an old Telegram delete button preserves a user-confirmed application and its answers',async t=>{
 const f=await fixture(t);f.db.putResult({...f.item,status:'uncertain'});
 const question=f.db.askQuestion(f.id,{recordId:f.item.id,text:'Bu başvuru gönderildi mi?',outcome:true,fields:[OUTCOME_FIELD]});
 f.db.answerQuestion(f.id,question.id,{[OUTCOME_FIELD.id]:'Gönderildi'});
 const before=f.db.result(f.id,f.item.id),questions=f.db.get(f.id).questions,tasks=f.core.workspaces.tasks.list(f.id);
 assert.equal(before.status,'completed');assert.equal(before.evidence,'Kullanıcı başvurunun gönderildiğini onayladı.');
 const completed=f.bot.delivery({...f.card,data:{kind:'submission',jobId:f.item.id}},f.bot.db.link(f.id));assert.match(completed.text,/✅ İş arama · Başvuruldu/);
 // Click the original listing card before Telegram has received its status edit.
 const result=await f.bot.deleteNotification(f.callback('d:'+f.card.id));assert.equal(result.text,'Mesaj silindi.');
 assert.equal(f.bot.db.delivery(f.card.id).status,'deleted');assert.deepEqual(f.db.result(f.id,f.item.id),before);
 assert.deepEqual(f.db.get(f.id).questions,questions);assert.deepEqual(f.core.workspaces.tasks.list(f.id),tasks);assert.equal(f.launches.length,0);
 assert.deepEqual(f.calls,[{method:'deleteMessage',body:{chat_id:'11',message_id:1}}]);
});

for(const template of ['housing','appointment','custom'])test(`${template}: Telegram uses template columns and status labels`,async t=>{
 const f=await fixture(t,template);f.core.workspaces.configureTable(f.id,{title:'My records',columns:[{key:'source',label:'Portal',type:'text'},{key:'title',label:'Seçenek',type:'text'}]});
 const card=f.bot.delivery(f.card,f.bot.db.link(f.id),{edit:true});assert.match(card.text,/Seçenek/);assert.doesNotMatch(card.text,/Başvuru|Şirket|Henüz puanlanmadı/);
 f.db.putResult({...f.item,status:'completed'});
 const completed=f.bot.delivery({...f.card,data:{kind:'submission',jobId:f.item.id}},f.bot.db.link(f.id));
 assert.match(completed.text,new RegExp(f.db.template(template).title));assert.match(completed.text,/Tamamlandı/);assert.doesNotMatch(completed.text,/Başvurun gönderildi/);
 const before=f.db.result(f.id,f.item.id);assert.equal((await f.bot.deleteNotification(f.callback('d:'+f.card.id))).text,'Mesaj silindi.');assert.deepEqual(f.db.result(f.id,f.item.id),before);
});

test('record creation rolls back with its event and a retry emits exactly one finding',async t=>{
 const f=await fixture(t),run=f.db.begin(f.id,'run'),input={url:source+'/new',title:'New',summary:'Observed'};
 f.core.db.exec("CREATE TEMP TRIGGER fail_event BEFORE INSERT ON workspace_events BEGIN SELECT RAISE(ABORT,'event failed'); END");
 assert.throws(()=>f.db.record(f.id,run.id,input),/event failed/);assert.equal(f.db.results(f.id).length,1);
 f.core.db.exec('DROP TRIGGER fail_event');const result=f.db.record(f.id,run.id,input);
 assert.equal(f.core.db.prepare("SELECT count(*) AS n FROM workspace_events WHERE kind='job_found' AND json_extract(data,'$.id')=?").get(result.id).n,1);
});

for(const fail of ['run','event'])test(`outcome persistence rolls back the record, run and notification if ${fail} fails`,async t=>{
 const f=await fixture(t);await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:f.item.digest});const run=f.launches[0];
 f.db.reserve(f.id,run.id,f.item.id);f.db.observe(f.id,run.id,f.item.url,'Confirmed');
 const before=f.db.result(f.id,f.item.id),table=fail==='run'?'automation_runs':'workspace_events';
 f.core.db.exec(`CREATE TEMP TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'write failed'); END`);
 const resolve=()=>f.db.resolve(f.id,run.id,f.item.id,{status:'completed',url:f.item.url,evidence:'Confirmed'});
 assert.throws(resolve,/write failed/);assert.deepEqual(f.db.result(f.id,f.item.id),before);assert.equal(f.db.run(run.id).actionId,f.item.id);
 assert.equal(f.core.db.prepare("SELECT count(*) AS n FROM workspace_events WHERE kind='submission_recorded'").get().n,0);
 f.core.db.exec('DROP TRIGGER fail_write');resolve();assert.equal(f.db.run(run.id).actionId,null);
 assert.equal(f.core.db.prepare("SELECT count(*) AS n FROM workspace_events WHERE kind='submission_recorded'").get().n,1);
});

test('a failed queue transaction never wakes a worker or publishes a UI change',async t=>{
 const f=await fixture(t);f.runtime.workers.setEnabled(f.id,'main',false);let changed=0;f.runtime.changed=()=>changed++;
 f.core.db.exec("CREATE TEMP TRIGGER fail_queue_event BEFORE INSERT ON workspace_events BEGIN SELECT RAISE(ABORT,'queue failed'); END");
 assert.throws(()=>enqueueRecordOperation(f.runtime,f.id,f.item.id,'execute',{manual:true,direct:true}),/queue failed/);
 assert.equal(f.runtime.workers.get(f.id,'main').enabled,false);assert.equal(changed,0);assert.equal(f.core.workspaces.tasks.list(f.id,{states:['pending']}).length,0);
});
