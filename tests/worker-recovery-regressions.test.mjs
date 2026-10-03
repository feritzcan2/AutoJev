import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {scanIssue} from '../app/scan-issues.mjs';
import {enqueueRecordOperation} from '../app/record-operations.mjs';

const source='https://example.test/homes';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store);
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'1500',requirements:'Two rooms'},sources:[source]});
 db.review(a.id);const trial=db.begin(a.id,'trial');db.observe(a.id,trial.id,source,'Observed listings');db.finish(a.id,trial.id,'completed','Checked');
 const second=store.workspaces.workers.add(a.id),seed=db.begin(a.id,'run');
 const items=[1,2,3].map(n=>db.record(a.id,seed.id,{url:source+'/'+n,title:'Home '+n,summary:'Observed listing'}));db.finish(a.id,seed.id,'completed','Saved');
 db.save(a.id,{mode:'observe'});
 const launches=[],closing=new Map(),options={launch:async run=>{launches.push(run);return {close:async()=>closing.get(run.recordId)?.()};}};
 const runtime=new WebTasks(db,options),runtimes=[runtime];
 t.after(async()=>{closing.clear();for(const r of runtimes)await r.close();store.close();});
 return {store,db,id:a.id,second,items,launches,closing,runtime,reopen(){const r=new WebTasks(db,options);runtimes.push(r);return r;}};
}

test('workspace stop cancels queued submissions before waiting for slow workers',async t=>{
 const f=fixture(t),{runtime,id}=f;
 for(const item of f.items)await runtime.runRecord(id,item.id,'execute',{direct:true});
 await settle();assert.equal(f.launches.length,2);
 let release;f.closing.set(f.items[0].id,()=>new Promise(resolve=>{release=resolve;}));
 const stopping=runtime.pause(id);
 try{
  await settle();await runtime.tick();await settle();
  assert.equal(f.launches.length,2,'A freed worker cannot start the queued submission during stop');
  assert.equal(runtime.queue.list(id).find(task=>task.recordId===f.items[2].id).state,'cancelled');
 }finally{release();await stopping;}
 assert.equal(runtime.slots(id).length,0);assert.equal(f.db.get(id).status,'paused');
 // A new explicit request after stopping remains supported.
 f.closing.clear();await runtime.runRecord(id,f.items[2].id,'prepare');await settle();assert.equal(f.launches.length,3);
});

test('a tick already in progress cannot launch a source after workspace stop',async t=>{
 const f=fixture(t);f.db.enable(f.id);
 await Promise.all([f.runtime.tick(),f.runtime.pause(f.id)]);await settle();
 assert.equal(f.runtime.slots(f.id).length,0);assert.equal(f.launches.length,0);
});

test('stop waits for every closure after one fails and concurrent starts cannot bypass it',async t=>{
 const f=fixture(t),{runtime,id}=f;
 for(const item of f.items)await runtime.runRecord(id,item.id,'execute',{direct:true});await settle();
 let release;f.closing.set(f.items[0].id,async()=>{throw Error('Close failed');});
 f.closing.set(f.items[1].id,()=>new Promise(resolve=>{release=resolve;}));
 const stopping=runtime.pause(id),rejected=assert.rejects(stopping,/Close failed/);
 assert.equal(runtime.pause(id),stopping,'Repeated stops share the same closure');
 try{
  await settle();assert.equal(runtime.pausing.has(id),true);
  await assert.rejects(runtime.runRecord(id,f.items[2].id,'execute',{direct:true}),/durduruluyor/);
  await assert.rejects(runtime.start(id,'interview'),/durduruluyor/);
  await assert.rejects(runtime.runOnce(id),/durduruluyor/);
  await runtime.tick();assert.equal(f.launches.length,2);
 }finally{release();await rejected;}
 assert.equal(f.db.get(id).status,'blocked');assert.equal(runtime.slots(id).length,1);
 assert.equal(runtime.queue.list(id).find(task=>task.recordId===f.items[2].id).state,'cancelled');
 f.closing.clear();await runtime.pause(id);assert.equal(runtime.slots(id).length,0);
});

test('technical finish preserves the pending queue and processed URLs through retry',async t=>{
 const f=fixture(t),{db,id,runtime}=f;await runtime.runOnce(id);await settle();const run=f.launches[0];
 db.saveScanProgress(id,run.id,{pendingUrls:[source+'/broken'],processedUrls:[source+'/seen',source+'/done'],reason:'Scan in progress'});
 scanIssue(db,id,run.id,{url:source+'/broken',kind:'render_pending',verified:true,evidence:'Still rendering'});
 const before=db.run(run.id).scan.work;
 const flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:{},report:(...args)=>runtime.report(...args)});
 // The app marks the stop technical from its own verified issue.
 await flow.call(id,run.id,'finish_automation_run',{status:'blocked',summary:'Still rendering'});
 assert.equal(db.run(run.id).stop.kind,'technical');
 await runtime.finish(id);
 assert.deepEqual(db.run(run.id).scan.work,before);
 assert.deepEqual(runtime.queue.get(id,run.taskId).scan.work,before);
 assert.deepEqual(db.get(id).sourceState[source].scan.work,before);
 runtime.now=()=>Date.now()+60000;await runtime.tick();await settle();const resumed=f.launches.at(-1);
 assert.notEqual(resumed.id,run.id);assert.deepEqual(resumed.scan.work,before);
 db.saveScanProgress(id,resumed.id,{pendingUrls:[source+'/seen'],reason:'Same page observed again'});
 assert.deepEqual(db.scanQueue(id,resumed.id).pendingUrls,[source+'/broken']);
});

async function waitingForm(f){
 const {runtime,db,id}=f;
 await runtime.runRecord(id,f.items[0].id,'prepare');await runtime.runRecord(id,f.items[1].id,'prepare');await settle();
 const run=f.launches.find(r=>r.recordId===f.items[1].id);assert.equal(run.workerId,f.second.id);
 db.observe(id,run.id,source+'/form','Partially filled form');
 const question=db.askQuestion(id,{recordId:f.items[1].id,text:'Move-in date?'},{runId:run.id});
 runtime.report(id,run.id,'blocked','Waiting for date');await runtime.finish(id,'blocked','Waiting for date',run.workerId);
 await runtime.finish(id,'interrupted','Other task ended','main');
 return {run,question};
}

test('form answers resume on any free worker because Jev tabs are shared by the workspace',async t=>{
 const f=fixture(t),{question}=await waitingForm(f);
 await f.runtime.answer(f.id,question.id,'2026-11-01');await settle();
 const resumed=f.launches.at(-1);assert.equal(resumed.recordId,f.items[1].id);
 assert.equal(resumed.workerId,'main');
});

