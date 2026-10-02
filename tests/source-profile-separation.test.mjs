import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {automationProgress} from '../app/automation-progress.mjs';
import {prepareAutomationChat} from '../src/automation-chat.js';

const first='https://one.test/homes',second='https://two.test/homes',third='https://three.test/homes';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{fresh=false,close=async()=>{}}={}){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);
 const a=db.create('housing',{goal:'Ev bul',criteria:{location:'Berlin',budget:'1500',requirements:'2 oda'},sources:fresh?[]:[first,second]});
 if(!fresh)db.review(a.id);
 const runtime=new WebTasks(db,{launch:async run=>({close:()=>close(run),message:async()=>{}})});
 t.after(async()=>{await runtime.close();core.close();});
 return {core,db,runtime,id:a.id};
}

test('adding a source keeps the reviewed profile, running scan and scan memory',async t=>{
 const {db,runtime,id}=fixture(t);db.enable(id);await runtime.tick();await settle();
 const run=runtime.slots(id)[0].run;
 runtime.sourceState(id,first,{trial:{status:'passed'},scan:{complete:false,pendingUrls:[first+'/next']}});
 const before=db.get(id);
 db.addSource(id,{url:third,name:'Third',query:'Berlin',mode:'observe',intervalMinutes:60});
 const after=db.get(id);
 for(const key of ['revision','reviewedRevision','status','criteria','sourceState'])assert.deepEqual(after[key],before[key],key);
 assert.equal(db.run(run.id).status,'running');
 assert.equal(db.sources(id).find(source=>source.url===third).trial,undefined);
 assert.deepEqual(after.sources,[first,second,third]);
});

test('removing an idle source only cancels its queued tasks and rejects removal of a busy source',async t=>{
 const {core,db,runtime,id}=fixture(t);db.enable(id);await runtime.tick();await settle();
 const run=runtime.slots(id)[0].run,before=db.get(id);
 const removedTask=core.workspaces.tasks.enqueue(id,{operation:'trial',sourceUrl:second,sources:[second]});
 assert.throws(()=>db.removeSource(id,first),/çalışan görevini/);assert.deepEqual(db.get(id),before);
 db.removeSource(id,second);
 assert.equal(core.workspaces.tasks.get(id,removedTask.id).state,'cancelled');
 assert.equal(db.run(run.id).status,'running');
 assert.equal(db.get(id).reviewedRevision,before.reviewedRevision);
 assert.deepEqual(db.get(id).sourceState[first],before.sourceState[first]);
});

for(const sourcesFirst of [true,false])test(`profile and source proposals apply independently, sources first: ${sourcesFirst}`,async t=>{
 const {db,runtime,id}=fixture(t),chat=await runtime.message(id,'Bütçeyi ve kaynakları değiştir.');
 const before=db.get(id);
 db.saveConversationPlan(id,chat.id,{criteria:{...before.criteria,budget:'1700'},sources:[first,third]});
 const draft=db.get(id);assert.equal(draft.planDraft.plan.sources,undefined);
 const saveProfile=()=>runtime.saveProfile(id,db.get(id).planDraft.plan,{expectedRevision:before.revision});
 const saveSources=()=>db.resolveSourceDraft(id,db.get(id).sourceDraft.id,true);
 if(sourcesFirst){
  saveSources();assert.equal(db.get(id).criteria.budget,'1500');assert.equal(db.get(id).planDraft.plan.criteria.budget,'1700');
  await saveProfile();
 }else{
  await saveProfile();assert.deepEqual(db.get(id).sources,[first,second]);assert.deepEqual(db.get(id).sourceDraft.sources,[first,third]);
  saveSources();
 }
 const after=db.get(id);assert.equal(after.criteria.budget,'1700');assert.deepEqual(after.sources,[first,third]);
 assert.equal(after.planDraft,undefined);assert.equal(after.sourceDraft,undefined);assert.equal(after.reviewedRevision,after.revision);
 assert.equal(runtime.slots(id)[0].run.id,chat.id);
});

test('source-only suggestions appear in conversation context without becoming a profile draft',async t=>{
 const {db,runtime,id}=fixture(t),chat=await runtime.message(id,'Kaynak öner.');
 db.saveConversationPlan(id,chat.id,{sources:[first,third]});
 assert.equal(db.get(id).planDraft,undefined);assert.deepEqual(db.get(id).sources,[first,second]);
 const context=automationTaskContext(db,id,chat,{section:'profile'});
 assert.deepEqual(context.automation.sources,[first,third]);assert.equal(context.sourceDraftPending,true);assert.equal(context.draftPending,false);
 const draftId=db.get(id).sourceDraft.id;db.resolveSourceDraft(id,draftId,false);
 assert.equal(db.get(id).sourceDraft,undefined);assert.deepEqual(db.get(id).sources,[first,second]);
});

test('manual source changes preserve profile drafts and newer source choices, stale proposals are rejected',async t=>{
 const {db,runtime,id}=fixture(t),chat=await runtime.message(id,'Değişiklik öner.');
 db.saveConversationPlan(id,chat.id,{instructions:'Yeni işleyiş',sources:[first,third]});
 const draft=db.get(id).sourceDraft;
 db.addSource(id,{url:'https://manual.test/homes'});
 assert.equal(db.get(id).planDraft.plan.instructions,'Yeni işleyiş');
 assert.throws(()=>db.resolveSourceDraft(id,draft.id,true),/önerileri değişti/);
 db.resolveSourceDraft(id,db.get(id).sourceDraft.id,true);
 assert.deepEqual(db.get(id).sources,[first,third,'https://manual.test/homes']);
 assert.equal(db.get(id).instructions,'');
});

test('legacy combined drafts are split without applying their source list',async t=>{
 const {db,runtime,id}=fixture(t),a=db.get(id);
 db.put({...a,planDraft:{baseRevision:a.revision,runId:'legacy',updatedAt:10,plan:{title:a.title,goal:a.goal,criteria:{...a.criteria,budget:'1800'},instructions:a.instructions,facts:a.facts,sources:[third]}}});
 const migrated=db.get(id);assert.equal(migrated.planDraft.plan.sources,undefined);assert.deepEqual(migrated.sourceDraft.sources,[third]);
 await runtime.saveProfile(id,migrated.planDraft.plan);
 assert.deepEqual(db.get(id).sources,a.sources);assert.deepEqual(db.get(id).sourceDraft.sources,[third]);
});

test('initial setup can save a profile before accepting source suggestions',async t=>{
 const {db,runtime,id}=fixture(t,{fresh:true}),chat=await runtime.message(id,'Kaynak bul.');
 db.saveConversationPlan(id,chat.id,{sources:[first]});
 assert.deepEqual(db.get(id).sources,[]);
 await runtime.saveProfile(id,{goal:'Ev bul'});
 assert.equal(automationProgress(db.snapshot(id)).primary.id,'sources');
 const revision=db.get(id).revision;db.resolveSourceDraft(id,db.get(id).sourceDraft.id,true);
 assert.equal(db.get(id).reviewedRevision,revision);assert.deepEqual(db.get(id).sources,[first]);
 assert.equal(db.get(id).sourceState[first],undefined);
});

test('sending a profile form to chat does not introduce an empty source list',()=>{
 const draft={title:'Test',goal:'Ev bul',criteria:{}};
 assert.deepEqual(prepareAutomationChat('Düzenle',draft),{message:'Düzenle',draft});
});

test('source changes made while a profile is applying survive the queued profile',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const {db,runtime,id}=fixture(t,{close:run=>run.kind==='interview'?undefined:gate});
 db.enable(id);await runtime.tick();await settle();
 const saving=runtime.saveProfile(id,{instructions:'Yeni işleyiş'});await settle();
 try{db.addSource(id,{url:third});assert.equal(db.get(id).profileUpdate.plan.sources,undefined);}finally{release();}
 await saving;
 assert.deepEqual(db.get(id).sources,[first,second,third]);assert.equal(db.get(id).instructions,'Yeni işleyiş');
});

test('legacy queued profiles retain source changes as a separate proposal',async t=>{
 const {db,runtime,id}=fixture(t),a=db.get(id);
 db.put({...a,profileUpdate:{baseRevision:a.revision,savedAt:20,plan:{title:a.title,goal:a.goal,criteria:a.criteria,instructions:'Yeni işleyiş',facts:'',mode:a.mode,sources:[third]}}});
 await runtime.tick();
 assert.deepEqual(db.get(id).sources,a.sources);assert.deepEqual(db.get(id).sourceDraft.sources,[third]);assert.equal(db.get(id).instructions,'Yeni işleyiş');
});

test('a reported source stays protected until its provider session finishes closing',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const {db,runtime,id}=fixture(t,{close:()=>gate});db.enable(id);await runtime.tick();await settle();
 const run=runtime.slots(id)[0].run;
 runtime.report(id,run.id,'blocked','Giriş gerekiyor');
 const closing=runtime.finish(id,'blocked','Giriş gerekiyor',run.workerId);await settle();
 try{assert.notEqual(db.run(run.id).status,'running');assert.throws(()=>db.removeSource(id,first),/çalışan görevini/);}finally{release();}
 await closing;db.removeSource(id,first);assert.deepEqual(db.get(id).sources,[second]);
});
