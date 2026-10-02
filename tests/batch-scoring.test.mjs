import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow,automationPrompt} from '../app/automation-worker.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {enqueueScoreBatch,recordTask} from '../app/record-operations.mjs';
import {workspaceHistory} from '../app/workspace-conversation.mjs';
import {jevDetailItems} from '../app/jev-tasks.mjs';
import {activeRecordOperations} from '../src/record-operation-status.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);
 const a=db.create('job-search',{goal:'Synthetic jobs',criteria:{preferences:'Remote',ranking:'Assess relevant experience'},sources:['https://example.test/jobs']});db.review(a.id);
 const seed=db.begin(a.id,'run'),items=Array.from({length:4},(_,i)=>db.record(a.id,seed.id,{url:`https://example.test/jobs/${i}`,title:'Role '+i,summary:'Synthetic detail'}));db.finish(a.id,seed.id,'completed','Saved');
 const launches=[],runtime=new WebTasks(db,{launch:async run=>{launches.push(run);return {close:async()=>{}};}}),ids=items.slice(0,3).map(r=>r.id);
 t.after(async()=>{await runtime.close();core.close();});
 const start=async()=>{const task=await runtime.runRecords(a.id,ids);await settle();const run=launches.at(-1);return {task,run,flow:automationWorkflow({db,run,signal:new AbortController().signal,browser:{},report:(...args)=>runtime.report(...args)})};};
 const finish=async(run,status='completed')=>{runtime.report(a.id,run.id,status,'Batch done');await runtime.finish(a.id,status,'Batch done',run.workerId);};
 return {core,db,id:a.id,items,ids,runtime,launches,start,finish};
}
test('selected rows launch one agent with the full assignment and distinct individual scores',async t=>{
 const f=fixture(t);const draft=f.db.putResult({...f.items[1],status:'prepared',proposal:'Keep this draft',digest:'draft',approvedDigest:'draft',evidence:'Prior evidence'});
 f.runtime.workers.add(f.id);f.runtime.workers.setEnabled(f.id,'main',false);
 const {task,run,flow}=await f.start(),context=automationTaskContext(f.db,f.id,run);
 assert.equal(f.launches.length,1);assert.deepEqual(task.recordIds,f.ids);assert.deepEqual(run.recordIds,f.ids);
 assert.equal(context.assignedRecord,null);assert.deepEqual(context.assignedRecords.map(r=>r.id),f.ids);assert.deepEqual(context.recordAuthorization.recordIds,f.ids);
 assert.match(automationPrompt(run),/batch scoring task/);assert.ok(flow.tools.find(tool=>tool.name==='record_automation_score').inputSchema.required.includes('itemId'));
 const snapshot=f.db.snapshot(f.id);
 assert.equal(new Set(snapshot.results.filter(r=>f.ids.includes(r.id)).map(r=>r.recordAction.task.id)).size,1);
 assert.deepEqual(activeRecordOperations({...snapshot,activeRuns:[run],workers:[{id:run.workerId,active:{sessionId:run.id},execution:{task:{id:run.id}}}]}),[{kind:'score',count:3,label:'puanlanıyor'}]);
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[0],score:81});
 assert.throws(()=>f.db.finish(f.id,run.id,'completed','Too soon'),/puanlama sonucunu/);
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[1],score:62});
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[2],score:null});await f.finish(run);
 assert.deepEqual(f.ids.map(id=>f.db.result(f.id,id).assessment.score),[81,62,null]);
 assert.equal(workspaceHistory(f.db,f.id,{kind:'runs',recordId:f.ids[2]}).entries[0].id,run.id);
 const saved=f.db.result(f.id,draft.id);for(const key of ['status','proposal','digest','approvedDigest','evidence'])assert.equal(saved[key],draft[key]);
});
test('batch retries are idempotent and every selected row is locked against overlapping requests',async t=>{
 const f=fixture(t),{task}=await f.start();
 const repeated=await f.runtime.runRecords(f.id,[...f.ids].reverse());assert.equal(repeated.id,task.id);assert.equal(f.launches.length,1);
 for(const id of f.ids){assert.equal(recordTask(f.db,f.id,id).id,task.id);await assert.rejects(f.runtime.runRecord(f.id,id,'prepare'),/başka bir görev/);assert.throws(()=>f.db.assertRecordIdle(f.id,id),/sırada/);}
 await assert.rejects(f.runtime.runRecords(f.id,[f.ids[2],f.items[3].id]),/başka bir görev/);
 const worker=f.runtime.workers.add(f.id),conflict=f.runtime.queue.enqueue(f.id,{operation:'custom',recordId:f.ids[2],lockKey:'custom'});
 assert.throws(()=>f.runtime.queue.claim(f.id,conflict.id,worker.id),/başka bir worker/);
});
for(const count of [1,3])test(`finishing ${count} scored records cannot complete the workspace or disable another source worker's recovery`,async t=>{
 const f=fixture(t);f.ids.splice(count);f.runtime.workers.add(f.id);f.db.enable(f.id);
 const source=f.db.get(f.id).sources[0],pending=source+'?page=4';
 const sourceTask=f.runtime.queue.enqueue(f.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const scan=await f.runtime.start(f.id,{kind:'run',taskId:sourceTask.id});
 f.db.observe(f.id,scan.id,pending,'Current results');
 f.db.saveScanProgress(f.id,scan.id,{pendingUrls:[pending],processedUrls:[],cursor:'page=4',reason:'More results remain'});
 const progress=structuredClone(f.db.run(scan.id).scan),messages=[];
 f.runtime.slot(f.id,scan.id).worker.message=async text=>messages.push(text);
 const {run,flow}=await f.start();assert.notEqual(run.workerId,scan.workerId);
 assert.equal(Object.hasOwn(flow.tools.find(t=>t.name==='finish_automation_run').inputSchema.properties,'goalReached'),false);
 for(const itemId of f.ids)await flow.call(f.id,run.id,'record_automation_score',{itemId,score:70});
 // An older provider session may still send the old field. Enforce the scope
 // in the task policy too, rather than relying only on the exposed schema.
 await flow.call(f.id,run.id,'finish_automation_run',{status:'completed',summary:'Assigned scores saved',goalReached:true});
 await f.runtime.finish(f.id,'completed','Assigned scores saved',run.workerId);
 assert.equal(f.db.run(run.id).status,'completed');assert.equal(f.db.get(f.id).status,'enabled');
 assert.equal(f.db.run(scan.id).status,'running');assert.deepEqual(f.db.run(scan.id).scan,progress);
 await f.runtime.unreported(f.runtime.slot(f.id,scan.id),'idle');
 assert.equal(messages.length,1);assert.equal(f.db.run(scan.id).status,'running');
 assert.match(messages[0],/Continue from the current page and saved checkpoint/);
});
test('invalid batches leave no partial work and singleton selections use the existing score flow',async t=>{
 const f=fixture(t),before=f.runtime.queue.list(f.id).length;
 f.db.putResult({...f.items[2],status:'completed'});
 for(const ids of [[],null,'invalid',[...f.ids],['missing',f.ids[0]],Array(101).fill(f.ids[0])])await assert.rejects(f.runtime.runRecords(f.id,ids));
 assert.equal(f.runtime.queue.list(f.id).length,before);assert.equal(f.launches.length,0);
 const task=await f.runtime.runRecords(f.id,[f.ids[0],f.ids[0]]);assert.equal(task.recordId,f.ids[0]);assert.equal(task.recordIds,undefined);
});
test('batch writes and questions require an assigned ID and reject stale profiles',async t=>{
 const f=fixture(t),{run,flow}=await f.start(),call=(name,args)=>flow.call(f.id,run.id,name,args);
 await assert.rejects(call('record_automation_score',{score:80}),/itemId/);
 await assert.rejects(call('record_automation_score',{itemId:f.items[3].id,score:80}),/atanmış/);
 await assert.rejects(call('ask_workspace_question',{text:'Which location?'}),/recordId/);
 await assert.rejects(call('ask_workspace_question',{recordId:f.items[3].id,text:'Which location?'}),/atanmış/);
 f.db.put({...f.db.get(f.id),revision:2});await assert.rejects(call('record_automation_score',{itemId:f.ids[1],score:80}),/Profil değişti/);
 assert.equal(f.db.result(f.id,f.ids[1]).assessment,undefined);
});
for(const early of [true,false])test(`a question on a non-primary batch row resumes only unfinished scoring (early answer: ${early})`,async t=>{
 const f=fixture(t),{run,flow}=await f.start();
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[0],score:90});
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[2],score:60});
 const q=await flow.call(f.id,run.id,'ask_workspace_question',{recordId:f.ids[1],text:'Which location do you prefer?'});
 assert.equal(q.recordId,f.ids[1]);assert.equal(automationTaskContext(f.db,f.id,run).questions[0].id,q.id);
 if(!early)await f.finish(run);
 await f.runtime.answer(f.id,q.id,'Remote');
 if(early){await f.finish(run);await f.runtime.tick();}
 await settle();const resumed=f.launches.at(-1);assert.notEqual(resumed.id,run.id);assert.equal(resumed.recordOperation,'score');assert.equal(resumed.recordId,f.ids[1]);assert.equal(resumed.recordIds,undefined);
 assert.equal(f.db.result(f.id,f.ids[0]).assessment.runId,run.id);
});
test('Jev accepts every selected listing as a batch and rejects unassigned URLs',t=>{
 const f=fixture(t),assignedRecords=f.items.slice(0,3);
 assert.deepEqual(jevDetailItems({},{assignedRecords}).map(r=>r.url),assignedRecords.map(r=>r.url));
 assert.equal(jevDetailItems({urls:[assignedRecords[2].url]},{assignedRecords})[0].title,assignedRecords[2].title);
 assert.throws(()=>jevDetailItems({urls:[f.items[3].url]},{assignedRecords}),/gözlen|atanmış/);
});
test('dismissing any batch row stops its shared worker and keeps already saved scores',async t=>{
 const f=fixture(t),{run,flow}=await f.start();await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[0],score:77});
 await f.runtime.dismissRecord(f.id,f.ids[1]);assert.equal(f.runtime.slots(f.id).length,0);assert.equal(f.db.result(f.id,f.ids[1]).status,'dismissed');assert.equal(f.db.result(f.id,f.ids[0]).assessment.score,77);
 for(const id of f.ids)assert.equal(recordTask(f.db,f.id,id),undefined);
});
test('pending batches revalidate every member before starting',async t=>{
 const f=fixture(t),task=enqueueScoreBatch(f.runtime,f.id,f.ids);f.db.putResult({...f.items[2],status:'dismissed'});
 await f.runtime.tick();await settle();assert.equal(f.launches.length,0);assert.equal(f.runtime.queue.get(f.id,task.id).state,'cancelled');
});

test('shutdown recovery preserves the batch assignment in a single resumed task',async t=>{
 const f=fixture(t),{task}=await f.start();await f.runtime.close();
 const launches=[],resumed=new WebTasks(f.db,{launch:async run=>{launches.push(run);return {close:async()=>{}};}});t.after(()=>resumed.close());
 await resumed.tick();await settle();assert.equal(launches.length,1);assert.equal(launches[0].taskId,task.id);assert.deepEqual(launches[0].recordIds,f.ids);
 await resumed.close();
});

test('idle scoring continues only missing records, excludes saved rows from failure and finalizes saved work',async t=>{
 const f=fixture(t),{run,flow,task}=await f.start(),slot=f.runtime.slot(f.id,run.id),messages=[];
 slot.worker.message=async message=>messages.push(message);
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[0],score:91});
 await f.runtime.unreported(slot,'idle');
 assert.equal(messages.length,1);assert.ok(!messages[0].includes(f.ids[0]));assert.ok(messages[0].includes(f.ids[1]));
 assert.equal(f.db.run(run.id).status,'running');assert.equal(f.runtime.queue.get(f.id,task.id).scoreRecovery.attempt,1);
 const snapshot=f.db.snapshot(f.id),saved=snapshot.results.find(r=>r.id===f.ids[0]);
 assert.equal(saved.recordAction.scoringComplete,true);assert.equal(saved.recordAction.task,null);assert.equal(saved.recordAction.lastTask,null);
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[1],score:null});
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[2],score:76});
 await f.runtime.unreported(slot,'idle');
 assert.equal(f.db.run(run.id).status,'completed');assert.equal(messages.length,1);assert.equal(f.runtime.slots(f.id).length,0);
});

test('three automatic continuations are bounded and completed rows retain their successful assessment',async t=>{
 const f=fixture(t),{run,flow,task}=await f.start(),slot=f.runtime.slot(f.id,run.id),messages=[];
 slot.worker.message=async message=>messages.push(message);
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[0],score:84});
 for(let i=0;i<4;i++)await f.runtime.unreported(slot,'idle');
 assert.equal(messages.length,3);assert.equal(f.db.run(run.id).status,'blocked');
 assert.match(f.db.run(run.id).summary,/2 kayıt kaldı/);assert.match(f.db.run(run.id).summary,/3 otomatik/);
 assert.equal(f.runtime.queue.get(f.id,task.id).scoreRecovery.attempt,3);
 const rows=f.db.snapshot(f.id).results;
 assert.equal(rows.find(r=>r.id===f.ids[0]).recordAction.lastTask,null);assert.equal(rows.find(r=>r.id===f.ids[0]).recordAction.retryOperation,null);
 assert.equal(rows.find(r=>r.id===f.ids[1]).recordAction.lastTask.state,'blocked');
});

test('unexpected provider exit resumes the same scoring task after delay, skipping scores from prior runs',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-02T12:00:00Z')});
 const f=fixture(t),{run,flow,task}=await f.start();
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[0],score:88});
 await f.runtime.unreported(f.runtime.slot(f.id,run.id),'exit');
 assert.equal(f.runtime.queue.get(f.id,task.id).state,'pending');
 await f.runtime.tick();assert.equal(f.launches.length,1);
 t.mock.timers.tick(5000);await f.runtime.tick();await settle();
 const resumed=f.launches.at(-1);assert.notEqual(resumed.id,run.id);assert.equal(resumed.taskId,task.id);
 const context=automationTaskContext(f.db,f.id,resumed);assert.equal(context.assignedRecords[0].scoredInThisTask,true);assert.equal(context.assignedRecords[1].scoredInThisTask,false);
 assert.throws(()=>f.db.finish(f.id,resumed.id,'completed','Too soon'),/puanlama sonucunu/);
 const workflow=automationWorkflow({db:f.db,run:resumed,signal:new AbortController().signal,browser:{}});
 for(const itemId of f.ids.slice(1))await workflow.call(f.id,resumed.id,'record_automation_score',{itemId,score:70});
 await f.runtime.unreported(f.runtime.slot(f.id,resumed.id),'idle');assert.equal(f.db.run(resumed.id).status,'completed');
 assert.equal(f.db.result(f.id,f.ids[0]).assessment.runId,run.id);
});

for(const stop of ['toolFailure','stopRequested','profileChanged'])test(`automatic scoring continuation respects ${stop}`,async t=>{
 const f=fixture(t),{run,task}=await f.start(),slot=f.runtime.slot(f.id,run.id),messages=[];
 slot.worker.message=async message=>messages.push(message);
 if(stop==='profileChanged')f.db.put({...f.db.get(f.id),revision:run.revision+1});
 else f.runtime.queue.put({...f.runtime.queue.get(f.id,task.id),[stop]:true});
 await f.runtime.unreported(slot,'idle');assert.equal(messages.length,0);assert.notEqual(f.runtime.queue.get(f.id,task.id).state,'pending');
});

test('pending record questions wait for the user while other batch records can finish',async t=>{
 const f=fixture(t),{run,flow}=await f.start(),slot=f.runtime.slot(f.id,run.id),messages=[];slot.worker.message=async message=>messages.push(message);
 await flow.call(f.id,run.id,'ask_workspace_question',{recordId:f.ids[0],text:'Which language level?'});
 await f.runtime.unreported(slot,'idle');assert.ok(!messages[0].includes(f.ids[0]));
 for(const itemId of f.ids.slice(1))await flow.call(f.id,run.id,'record_automation_score',{itemId,score:75});
 await f.runtime.unreported(slot,'idle');assert.equal(f.db.run(run.id).status,'completed');assert.match(f.db.run(run.id).summary,/1 kayıt yanıt bekliyor/);
});

test('duplicate idle notifications cannot send concurrent continuations',async t=>{
 const f=fixture(t),{run}=await f.start(),slot=f.runtime.slot(f.id,run.id);let release,count=0;
 slot.worker.message=()=>{count++;return new Promise(resolve=>{release=resolve;});};
 const first=f.runtime.unreported(slot,'idle');await f.runtime.unreported(slot,'idle');assert.equal(count,1);release();await first;
});

test('restart repairs only the old unreported scoring failure and preserves saved records',async t=>{
 const f=fixture(t),{run,task,flow}=await f.start();
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[0],score:83});
 await f.runtime.finish(f.id,'failed','Agent sonuç bildirmeden durdu. Agent ekranını kontrol et.',run.workerId);await f.runtime.close();
 const resumed=new WebTasks(f.db,{launch:async()=>({close:async()=>{}})});t.after(()=>resumed.close());
 assert.equal(resumed.queue.get(f.id,task.id).state,'pending');
 await resumed.tick();await settle();const active=resumed.slots(f.id)[0].run;
 assert.equal(active.taskId,task.id);assert.equal(automationTaskContext(f.db,f.id,active).assignedRecords[0].scoredInThisTask,true);
 assert.equal(f.db.result(f.id,f.ids[0]).assessment.runId,run.id);await resumed.close();
});

test('continuation count survives restart, and scores from an unrelated task do not satisfy completion',async t=>{
 const f=fixture(t),{run,flow,task}=await f.start(),slot=f.runtime.slot(f.id,run.id);slot.worker.message=async()=>{};
 await flow.call(f.id,run.id,'record_automation_score',{itemId:f.ids[0],score:85});
 await f.runtime.unreported(slot,'idle');await f.runtime.close();
 const resumed=new WebTasks(f.db,{launch:async()=>({close:async()=>{},message:async()=>{}})});t.after(()=>resumed.close());
 await resumed.tick();await settle();const active=resumed.slots(f.id)[0].run;
 assert.equal(resumed.queue.get(f.id,task.id).scoreRecovery.attempt,1);
 const copied=f.db.result(f.id,f.ids[0]);f.db.putResult({...f.items[3],assessment:copied.assessment});
 // The unrelated record is not assigned to this scoring task.
 const {recordScoredInTask}=await import('../app/record-task-scope.mjs');assert.equal(recordScoredInTask(f.db,active,f.db.result(f.id,f.items[3].id)),false);
 for(let i=0;i<3;i++)await resumed.unreported(resumed.slot(f.id,active.id),'idle');
 assert.equal(f.db.run(active.id).status,'blocked');assert.equal(resumed.queue.get(f.id,task.id).scoreRecovery.attempt,3);await resumed.close();
});

test('provider exit during a continuation delivery is recovered after the delivery settles',async t=>{
 const f=fixture(t),{run,task}=await f.start(),slot=f.runtime.slot(f.id,run.id);let release;
 slot.worker.message=()=>new Promise(resolve=>{release=resolve;});
 const idle=f.runtime.unreported(slot,'idle');await f.runtime.unreported(slot,'exit');release();await idle;await settle();
 assert.equal(f.runtime.queue.get(f.id,task.id).state,'pending');assert.equal(f.runtime.queue.get(f.id,task.id).scoreRecovery.attempt,2);
});
