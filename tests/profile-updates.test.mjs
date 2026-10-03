import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {queueProfileUpdate} from '../app/profile-updates.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{close=async()=>{}}={}){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core),closed=[],started=[];
 const a=db.create('housing',{goal:'Uygun evleri bul',criteria:{location:'Berlin',budget:'1500',requirements:'2 oda'},sources:['https://one.test/homes','https://two.test/homes','https://three.test/homes']});
 core.workspaces.workers.add(a.id);db.review(a.id);
 db.put({...db.get(a.id),sourceState:Object.fromEntries(a.sources.map(url=>[url,{trial:{status:'passed'}}]))});
 const runtime=new WebTasks(db,{concurrency:2,launch:async run=>{started.push(run);return {close:async()=>{await close(run);closed.push(run.id);},message:async()=>{}};}});
 t.after(async()=>{await runtime.close();core.close();});
 return {core,db,id:a.id,runtime,started,closed};
}

test('saving stops active workers before applying new criteria, restarts tracking and keeps the same busy setup session',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(t,{close:run=>run.kind==='interview'?undefined:gate}),{db,id,runtime}=f;
 db.enable(id);await runtime.tick();await settle();
 const scans=runtime.slots(id).map(slot=>slot.run),chat=await runtime.message(id,'Bütçeyi değiştir.');
 db.putRun({...db.run(chat.id),conversation:{provider:'codex',nativeId:'same-native-session'}});
 const before=db.get(id),oldTasks=f.core.workspaces.tasks.list(id).filter(task=>task.operation!=='interview');
 db.saveConversationPlan(id,chat.id,{criteria:{...before.criteria,budget:'1700'}});
 const saving=runtime.saveProfile(id,db.get(id).planDraft.plan,{expectedRevision:before.revision});
 await settle();
 assert.equal(db.get(id).criteria.budget,'1500','Old criteria stay active until all workers close');
 assert.equal(db.get(id).profileUpdate.plan.criteria.budget,'1700');
 assert.equal(automationTaskContext(db,id,scans[0]).automation.criteria.budget,'1500');
 assert.equal(automationTaskContext(db,id,chat).automation.criteria.budget,'1700');
 await runtime.tick();assert.equal(f.started.length,3,'No old task is dispatched during the switch');
 await assert.rejects(runtime.saveProfile(id,{goal:'Concurrent update'}),/güncelleniyor/);
 release();assert.deepEqual(await saving,{saved:true,applied:true});await settle();
 const after=db.get(id),next=runtime.slots(id).filter(slot=>slot.run.kind!=='interview');
 assert.equal(after.criteria.budget,'1700');assert.equal(after.revision,before.revision+1);assert.equal(after.reviewedRevision,after.revision);
 assert.equal(after.status,'enabled');assert.equal(after.profileUpdate,undefined);assert.equal(after.planDraft,undefined);
 assert.equal(next.length,2);assert.ok(next.every(slot=>slot.run.revision===after.revision&&!scans.some(run=>run.id===slot.run.id)));
 for(const task of oldTasks)assert.equal(f.core.workspaces.tasks.get(id,task.id).state,'cancelled');
 assert.equal(runtime.slots(id).find(slot=>slot.run.kind==='interview').run.id,chat.id);
 assert.equal(db.run(chat.id).conversation.nativeId,'same-native-session');assert.ok(!f.closed.includes(chat.id));
});

test('saving while only setup is busy applies immediately and does not start paused tracking',async t=>{
 const {db,id,runtime,closed}=fixture(t);db.pause(id);const chat=await runtime.message(id,'Yeni kriter.');
 const settings=db.get(id).agentSettings;await runtime.saveProfile(id,{criteria:{...db.get(id).criteria,budget:'1800'}});
 assert.equal(db.get(id).criteria.budget,'1800');assert.equal(db.get(id).status,'paused');assert.deepEqual(db.get(id).agentSettings,settings);
 assert.deepEqual(runtime.slots(id).map(slot=>slot.run.id),[chat.id]);assert.deepEqual(closed,[]);
});

test('saving an unchanged reviewed profile leaves running workers, revision and later drafts intact',async t=>{
 const {db,id,runtime,closed}=fixture(t);db.enable(id);await runtime.tick();await settle();
 const chat=await runtime.message(id,'Yeni bütçe öner.');
 const before=db.get(id),runs=runtime.slots(id).map(slot=>slot.run.id);
 db.saveConversationPlan(id,chat.id,{criteria:{...before.criteria,budget:'1700'}});
 const draft=db.get(id).planDraft;
 // Form controls include empty optional fields and need not use the stored key order.
 await runtime.saveProfile(id,{goal:` ${before.goal} `,criteria:{introduction:'',requirements:'2 oda',budget:'1500',location:'Berlin'}},{expectedRevision:before.revision});
 assert.deepEqual(closed,[]);assert.deepEqual(runtime.slots(id).map(slot=>slot.run.id),runs);
 assert.equal(db.get(id).revision,before.revision);assert.equal(db.get(id).updatedAt,before.updatedAt);
 assert.equal(db.get(id).profileUpdate,undefined);assert.deepEqual(db.get(id).planDraft,draft);
});

test('saving an unchanged initial profile still reviews it',async t=>{
 const {db,id,runtime}=fixture(t);db.put({...db.get(id),reviewedRevision:null,status:'draft'});
 await runtime.saveProfile(id,{goal:db.get(id).goal});
 assert.equal(db.get(id).reviewedRevision,db.get(id).revision);assert.equal(db.get(id).status,'ready');
});

test('an agent repeating saved criteria without empty fields does not create a new draft',async t=>{
 const {db,id,runtime}=fixture(t);
 await runtime.saveProfile(id,{criteria:{...db.get(id).criteria,introduction:''},facts:'Synthetic candidate'});
 const chat=await runtime.message(id,'Profili kontrol et.');
 db.saveConversationPlan(id,chat.id,{criteria:{requirements:'2 oda',budget:'1500',location:'Berlin'}});
 assert.equal(db.get(id).planDraft,undefined);
 db.saveConversationPlan(id,chat.id,{criteria:{...db.get(id).criteria,budget:'1700'}});
 assert.equal(db.get(id).planDraft.plan.criteria.budget,'1700');
});

test('validation and stale revision rejection leave active workers and drafts untouched',async t=>{
 const {db,id,runtime,closed}=fixture(t);db.enable(id);await runtime.tick();await settle();
 const before=db.get(id);
 for(const [input,options,pattern] of [[{sources:[]},{},/Geçersiz profil/],[{mode:'invalid'},{},/yetkisi/],[{goal:'new'},{expectedRevision:0},/Profil değişti/],[{agentSettings:{}},{},/Geçersiz profil/]]){
  await assert.rejects(runtime.saveProfile(id,input,options),pattern);assert.deepEqual(db.get(id),before);
 }
 assert.deepEqual(closed,[]);assert.equal(runtime.slots(id).length,2);
});

test('failed worker stop retains the draft for explicit retry and never applies silently',async t=>{
 let fail=true;const {db,id,runtime}=fixture(t,{close:async run=>{if(fail&&run.kind!=='interview')throw Error('Provider close failed');}});
 db.enable(id);await runtime.tick();await settle();const before=db.get(id);
 await assert.rejects(runtime.saveProfile(id,{criteria:{...before.criteria,budget:'1900'}}),/Provider close failed/);
 assert.equal(db.get(id).criteria.budget,'1500');assert.match(db.get(id).profileUpdate.error,/Provider close failed/);
 await runtime.tick();assert.equal(db.get(id).criteria.budget,'1500');
 fail=false;await runtime.saveProfile(id,db.get(id).profileUpdate.plan);
 assert.equal(db.get(id).criteria.budget,'1900');assert.equal(db.get(id).profileUpdate,undefined);
});

test('a later agent proposal survives application of the profile already accepted by the user',async t=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const {db,id,runtime}=fixture(t,{close:run=>run.kind==='interview'?undefined:gate});
 db.enable(id);await runtime.tick();await settle();const chat=await runtime.message(id,'Profil değiştir.');
 const saving=runtime.saveProfile(id,{criteria:{...db.get(id).criteria,budget:'1700'}});await settle();
 db.saveConversationPlan(id,chat.id,{instructions:'Yeni önerilen işleyiş'});
 release();await saving;
 const a=db.get(id);assert.equal(a.criteria.budget,'1700');assert.equal(a.instructions,'');
 assert.equal(a.planDraft.plan.criteria.budget,'1700');assert.equal(a.planDraft.plan.instructions,'Yeni önerilen işleyiş');assert.equal(a.planDraft.baseRevision,a.revision);
});

test('an accepted profile survives app restart and is applied before recovered tasks launch',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'profile-save-')),file=path.join(dir,'state.sqlite');
 let core=new WorkspaceDatabase(file),db=new AutomationStore(core);
 const a=db.create('housing',{goal:'Ev bul',criteria:{location:'Berlin',budget:'1500',requirements:'2 oda'},sources:['https://one.test/homes']});
 db.review(a.id);db.enable(a.id);const task=core.workspaces.tasks.enqueue(a.id,{operation:'trial',sourceUrl:a.sources[0],sources:a.sources});db.begin(a.id,{kind:'trial',taskId:task.id});
 queueProfileUpdate(db,a.id,{criteria:{...a.criteria,budget:'2000'}});core.close();
 core=new WorkspaceDatabase(file);db=new AutomationStore(core);const launched=[];
 const runtime=new WebTasks(db,{launch:async run=>{launched.push({run,criteria:db.get(a.id).criteria});return {close:async()=>{}};}});
 t.after(async()=>{await runtime.close();core.close();await rm(dir,{recursive:true,force:true});});
 await runtime.tick();await settle();assert.equal(launched.length,1);assert.equal(launched[0].criteria.budget,'2000');assert.equal(launched[0].run.revision,a.revision+1);
 assert.equal(db.get(a.id).profileUpdate,undefined);
});
