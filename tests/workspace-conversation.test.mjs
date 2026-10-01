import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {automationWorkflow,automationPrompt} from '../app/automation-worker.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {pendingRecordQuestion} from '../app/record-operations.mjs';
import {webWorkspaceView} from '../app/workspace-view.mjs';
import {automationAttention} from '../app/automation-attention.mjs';
import {CONVERSATION_WORKER,isConversation,conversationWaiting,interviewBusy} from '../app/workspace-conversation.mjs';
import {automationProgress} from '../app/automation-progress.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{launch,message}={}){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core),started=[],closed=[],sent=[];
 const a=db.create('housing',{title:'Ev takibi',goal:'Uygun evleri bul',criteria:{location:'Berlin',budget:'1500',requirements:'2 oda'},sources:['https://one.test/homes','https://two.test/homes','https://three.test/homes']});
 core.workspaces.workers.add(a.id);db.review(a.id);
 db.put({...db.get(a.id),sourceState:Object.fromEntries(a.sources.map(url=>[url,{trial:{status:'passed'}}]))});
 const runtime=new WebTasks(db,{concurrency:2,launch:async(run,...rest)=>{started.push(run);if(launch)await launch(run,...rest);return {close:async()=>{closed.push(run.id);},message:async text=>{sent.push({runId:run.id,text});await message?.(text);}};}});
 t.after(async()=>{await runtime.close();core.close();});
 return {core,db,id:a.id,runtime,started,closed,sent};
}

test('workspace chat uses its own session and leaves both occupied workers and their queue intact',async t=>{
 const {core,db,id,runtime,closed}=fixture(t);db.enable(id);await runtime.tick();await settle();
 const before=runtime.slots(id).map(s=>s.run),queue=core.workspaces.tasks.list(id);assert.equal(before.length,2);
 const run=await runtime.message(id,'Bulduğun evleri karşılaştır.');
 assert.equal(run.workerId,CONVERSATION_WORKER);assert.equal(runtime.slots(id).length,3);assert.equal(runtime.capacityUsed,2);
 assert.equal(db.get(id).status,'enabled');assert.deepEqual(closed,[]);
 for(const task of queue)assert.deepEqual(core.workspaces.tasks.get(id,task.id),task);
 for(const scan of before)assert.equal(db.run(scan.id).status,'running');
 const count=db.messages(id).length;await assert.rejects(runtime.message(id,'İkinci mesaj'),/yanıtını hazırlıyor/);assert.equal(db.messages(id).length,count);
 await runtime.stopWorker(id,CONVERSATION_WORKER);
 assert.deepEqual(closed,[run.id]);assert.equal(db.get(id).status,'enabled');assert.equal(runtime.slots(id).length,2);
 assert.equal(core.workspaces.workers.list(id).length,2,'Chat does not consume a configurable worker slot');
});

test('conversation questions do not block sources, records or the next worker assignment',async t=>{
 const {db,id,runtime,closed,sent}=fixture(t);db.enable(id);await runtime.tick();await settle();
 const scans=runtime.slots(id).map(s=>s.run),chat=await runtime.message(id,'Başka bir semti konuşalım.');
 const question=db.askQuestion(id,{text:'Hangi semt?'},{runId:chat.id});assert.equal(question.conversation,true);
 assert.equal(pendingRecordQuestion(db.get(id),{id:'some-record',sourceUrl:scans[0].sourceUrl}),undefined);
 assert.equal(automationTaskContext(db,id,scans[0]).questions.length,0);
 await runtime.finish(id,'completed','İlk tarama tamamlandı.',scans[0].workerId);await runtime.tick();await settle();
 assert.equal(runtime.slots(id).filter(s=>!isConversation(s.run)).length,2,'Freed worker takes the third source while chat waits for an answer');
 const stillRunning=runtime.slots(id).filter(s=>!isConversation(s.run)).map(s=>s.run.id);
 await runtime.answer(id,question.id,'Mitte');
 const resumed=runtime.slots(id).find(s=>isConversation(s.run)).run;assert.equal(resumed.id,chat.id);
 assert.match(sent.at(-1).text,/Mitte/);assert.ok(!closed.includes(chat.id));
 for(const runId of stillRunning){assert.equal(db.run(runId).status,'running');assert.ok(!closed.includes(runId));}
 assert.equal(db.get(id).status,'enabled');
});

test('chat waits in the same live session after replies and only closes when the user closes it',async t=>{
 const {db,id,runtime,started,closed,sent}=fixture(t);db.enable(id);await runtime.tick();await settle();
 const scanIds=runtime.slots(id).map(s=>s.run.id),chat=await runtime.message(id,'Sonuçları konuşalım.');
 const flow=automationWorkflow({db,run:chat,signal:new AbortController().signal,browser:{},report:(...args)=>runtime.report(...args),changed:()=>{}});
 await flow.call(id,chat.id,'get_automation_context',{});
 await flow.call(id,chat.id,'reply_to_user',{message:'Mevcut sonuçları inceledim.'});
 const result=await flow.call(id,chat.id,'finish_automation_run',{status:'completed',summary:'İlk yanıt hazır.'});
 assert.equal(result.conversationOpen,true);assert.equal(result.awaitingMessage,true);
 await new Promise(resolve=>setTimeout(resolve,200));
 assert.equal(db.run(chat.id).status,'running');assert.equal(conversationWaiting(db.run(chat.id)),true);assert.deepEqual(closed,[]);
 let snapshot={...db.snapshot(id),activeRuns:runtime.slots(id).map(s=>s.run)};
 assert.equal(interviewBusy(snapshot),false);assert.equal(automationProgress(snapshot).title,'Kaynaklar taranıyor');
 assert.equal(webWorkspaceView(snapshot,{sessions:new Map()}).workers.find(w=>w.conversation).presentation.status,'Mesaj bekliyor');
 const next=await runtime.message(id,'Sen mi puanladın?');
 assert.equal(next.id,chat.id);assert.equal(started.length,3);assert.equal(sent.at(-1).text,'Sen mi puanladın?');
 assert.equal(conversationWaiting(db.run(chat.id)),false);
 await assert.rejects(runtime.message(id,'Aynı anda ikinci mesaj'),/yanıtını hazırlıyor/);
 await flow.call(id,chat.id,'finish_automation_run',{status:'completed',summary:'İkinci yanıt hazır.'});
 assert.equal(db.run(chat.id).lastResult,'completed');
 await runtime.stopWorker(id,CONVERSATION_WORKER);
 assert.deepEqual(closed,[chat.id]);assert.deepEqual(runtime.slots(id).map(s=>s.run.id),scanIds);
});

test('conversation context excludes old messages, full templates, old questions and table rows',async t=>{
 const {db,id,runtime}=fixture(t);
 for(let i=0;i<30;i++)db.message(id,'assistant','Eski worker raporu '+('x'.repeat(1000)));
 db.askQuestion(id,{text:'Eski kurulum sorusu'});
 const chat=await runtime.message(id,'Sen mi puanladın?'),context=automationTaskContext(db,id,chat);
 assert.deepEqual(context.messages.map(m=>m.text),['Sen mi puanladın?']);
 assert.deepEqual(context.questions,[]);assert.equal(context.template.guidance,undefined);assert.equal(context.template.defaultSources,undefined);
 assert.equal(context.results,undefined);assert.equal(context.previousRuns,undefined);
 assert.equal(context.automation.criteria.location,'Berlin');assert.equal(context.conversation.persistent,true);
 assert.ok(JSON.stringify(context).length<5000);
});

test('profile changes refresh context once and a failed follow-up delivery leaves the chat open for retry',async t=>{
 let fail=false;const {db,id,runtime,sent,closed}=fixture(t,{message:async()=>{if(fail)throw Error('Delivery failed');}});
 const chat=await runtime.message(id,'Konuşalım.'),flow=automationWorkflow({db,run:chat,signal:new AbortController().signal,browser:{},report:(...args)=>runtime.report(...args),changed:()=>{}});
 await flow.call(id,chat.id,'get_automation_context',{});runtime.report(id,chat.id,'completed','Hazır.');
 db.save(id,{mode:'auto'});db.review(id);
 await runtime.message(id,'Yetkim ne?');assert.match(sent.at(-1).text,/permissions changed/);
 await flow.call(id,chat.id,'get_automation_context',{});runtime.report(id,chat.id,'completed','Yanıtlandı.');
 fail=true;await assert.rejects(runtime.message(id,'Devam'),/Delivery failed/);
 assert.equal(conversationWaiting(db.run(chat.id)),true);assert.deepEqual(closed,[]);
 fail=false;await runtime.message(id,'Tekrar');assert.equal(sent.at(-1).text,'Tekrar');
});

test('provider idle leaves chat open even without a finish call and another message reuses it',async t=>{
 const {id,db,runtime,closed,started}=fixture(t),chat=await runtime.message(id,'Merhaba');
 runtime.event(id,{event:'state',state:'Working'},chat.id);runtime.event(id,{event:'state',state:'Idle'},chat.id);
 assert.equal(conversationWaiting(db.run(chat.id)),true);assert.deepEqual(closed,[]);
 assert.equal(automationProgress({...db.snapshot(id),activeRuns:[db.run(chat.id)]}).title,'Sohbet açık');
 const view=webWorkspaceView({...db.snapshot(id),activeRun:db.run(chat.id),activeRuns:[db.run(chat.id)]},{sessions:new Map()});
 assert.equal(view.activity.running,false);assert.equal(view.workers.find(w=>w.id==='main').presentation.status,'Kapalı');
 await runtime.message(id,'Devam edelim');assert.equal(started.length,1);assert.equal(conversationWaiting(db.run(chat.id)),false);
});

test('profile suggestions are persisted as drafts without changing active criteria, revision, authority or queues',async t=>{
 const {core,db,id,runtime}=fixture(t);db.enable(id);await runtime.tick();await settle();
 const scan=runtime.slots(id)[0].run,chat=await runtime.message(id,'Bütçeyi 1700 olarak öner.');
 const before=db.get(id),queue=core.workspaces.tasks.list(id);
 const flow=automationWorkflow({db,run:chat,signal:new AbortController().signal,browser:{},changed:()=>{}});
 const proposal={title:before.title,goal:before.goal,criteria:Object.entries({...before.criteria,budget:'1700'}).map(([key,value])=>({key,value})),sources:before.sources,instructions:before.instructions,facts:before.facts};
 const result=await flow.call(id,chat.id,'save_automation_plan',proposal);
 assert.equal(result.draft,true);assert.equal(result.applied,false);const after=db.get(id);
 for(const key of ['criteria','sources','revision','reviewedRevision','mode','status','sourceState'])assert.deepEqual(after[key],before[key],key);
 assert.deepEqual(core.workspaces.tasks.list(id),queue);
 assert.equal(automationTaskContext(db,id,scan).automation.criteria.budget,'1500');
 assert.equal(automationTaskContext(db,id,chat).automation.criteria.budget,'1700');
 assert.equal(automationTaskContext(db,id,chat).conversation.profileChanges,'draft');
 await flow.call(id,chat.id,'reply_to_user',{message:'1700 EUR bütçeyi taslak olarak kaydettim.'});
 assert.equal(db.messages(id).at(-1).conversation,true);
 await runtime.pause(id);db.save(id,after.planDraft.plan);db.review(id);
 assert.equal(db.get(id).criteria.budget,'1700');assert.equal(db.get(id).planDraft,undefined);
 assert.match(automationPrompt(chat),/independent workspace conversation/);
});

test('a failed conversation launch does not stop work and a retry keeps its own session',async t=>{
 let fail=true;const {db,id,runtime,closed}=fixture(t,{launch:async run=>{if(isConversation(run)&&fail)throw Error('Chat provider failed');}});
 db.enable(id);await runtime.tick();await settle();const scans=runtime.slots(id).map(s=>s.run.id);
 await assert.rejects(runtime.message(id,'Sonuçları özetle.'),/Chat provider failed/);
 assert.equal(db.get(id).status,'enabled');assert.equal(runtime.slots(id).length,2);assert.deepEqual(closed,[]);
 assert.ok(automationAttention({...db.snapshot(id),activeRuns:runtime.slots(id).map(s=>s.run)}).some(issue=>issue.kind==='conversation'),'Conversation failure is visible even while other workers run');
 fail=false;const run=await runtime.message(id,'Tekrar dene.');assert.equal(run.workerId,CONVERSATION_WORKER);
 for(const runId of scans)assert.equal(db.run(runId).status,'running');
 const view=webWorkspaceView({...db.snapshot(id),activeRuns:runtime.slots(id).map(s=>s.run),activeRun:runtime.slots(id)[0].run},{sessions:new Map()});
 assert.equal(view.workers.find(w=>w.id===CONVERSATION_WORKER).conversation,true);assert.equal(view.capabilities.concurrentConversation,true);
});

test('tracking can start while an independent conversation is already running',async t=>{
 const {db,id,runtime}=fixture(t);const chat=await runtime.message(id,'Planı konuşalım.');
 assert.equal(chat.workerId,CONVERSATION_WORKER);db.enable(id);await runtime.tick();await settle();
 assert.equal(runtime.slots(id).length,3);assert.equal(db.run(chat.id).status,'running');
});

test('an explicit workspace restart restores the conversation and source scheduling together',async t=>{
 const {db,id,runtime}=fixture(t);db.enable(id);await runtime.tick();await settle();await runtime.message(id,'Sonuçları konuşalım.');
 await runtime.restart(id);await settle();
 assert.equal(db.get(id).status,'enabled');assert.equal(runtime.slots(id).filter(s=>!isConversation(s.run)).length,2);
 assert.equal(runtime.slots(id).filter(s=>isConversation(s.run)).length,1);
});

test('conversation browser research keeps a distinct tab even when it visits a running source',async()=>{
 const calls=[],browser={prepare:()=>({ready:true}),call:async(id,name,args,session,options)=>{calls.push({name,options});return {content:[{type:'text',text:JSON.stringify({tabId:'chat-tab',url:args.url??'https://one.test/homes'})}]};}};
 const scoped=automationBrowser(browser,{mode:'jev',isolatedResearch:true,readTabKey:'read:conversation',sourceUrls:['https://one.test/homes']});
 await scoped.call('workspace','browser_navigate',{url:'https://one.test/homes'},'chat');
 assert.ok(calls.length>0);for(const call of calls){assert.equal(call.options.automationTabKey,'read:conversation');assert.equal(call.options.automationSourceUrl,undefined);}
});
