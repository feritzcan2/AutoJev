import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {unreportedSourceRun} from '../app/automation-recovery.mjs';

const source='https://listings.test/results',second=source+'?page=49',settle=()=>new Promise(r=>setImmediate(r));
function fixture(t){
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-09-30T12:00:00Z')});
 const store=new Store(':memory:'),db=new AutomationStore(store),a=db.create('custom',{goal:'Find every match',criteria:Object.fromEntries(db.template('custom').fields.filter(f=>f.required).map(f=>[f.id,'Test criteria'])),sources:[source]});
 db.review(a.id);const trial=db.begin(a.id,'trial');db.observe(a.id,trial.id,source,'Listings');db.finish(a.id,trial.id,'completed','Read');
 const launches=[];let state='Working',busy=false,close=async()=>{};
 const options={launch:async run=>{launches.push(run);return {close:()=>close(),state:()=>state,isBusy:()=>busy};}};
 const runtime=new WebTasks(db,options);t.after(async()=>{await runtime.close();store.close();});
 const event=(value,run=launches.at(-1))=>{state=value;runtime.event(a.id,{event:'state',state:value},run.id);};
 const checkpoint=run=>{db.observe(a.id,run.id,second,'Page 49 of 71');db.reportPage(a.id,run.id,{currentPage:49,totalPages:71,url:second,evidence:'Page 49 of 71',at:Date.now()});};
 return {db,store,id:a.id,runtime,launches,options,event,checkpoint,busy:value=>{busy=value;},state:value=>{state=value;},close:fn=>{close=fn;}};
}

test('Claude compaction cannot turn an intermediate idle into a failed source',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();const run=f.launches[0];f.checkpoint(run);f.event('Working');f.event('Idle');f.busy(true);
 t.mock.timers.tick(30000);await settle();assert.equal(f.db.run(run.id).status,'running');assert.equal(f.launches.length,1);
 // Working was consumed by the provider's compaction layer: the live state
 // still overrides the stale Idle remembered by TaskRuns.
 f.busy(false);f.state('Working');t.mock.timers.tick(10000);await settle();assert.equal(f.db.run(run.id).status,'running');
 f.event('Compacting');t.mock.timers.tick(20000);await settle();assert.equal(f.db.run(run.id).status,'running');
 f.event('AwaitingInput');t.mock.timers.tick(60000);await settle();assert.equal(f.db.run(run.id).status,'running');
});

test('unreported idle automatically hands the same task and checkpoint to another run after a short delay',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();const run=f.launches[0];f.checkpoint(run);const plan=f.db.run(run.id).scanPlan;
 f.event('Working');f.event('Idle');t.mock.timers.tick(10000);await settle();
 assert.equal(f.db.run(run.id).status,'interrupted');assert.equal(f.db.sources(f.id)[0].blocked,false);assert.equal(f.runtime.slots(f.id).length,0);
 const task=f.store.workspaces.tasks.get(f.id,run.taskId);assert.equal(task.state,'pending');assert.equal(task.recovery.attempt,1);
 await f.runtime.tick();assert.equal(f.launches.length,1);t.mock.timers.tick(5000);await f.runtime.tick();await settle();
 const resumed=f.launches[1];assert.equal(resumed.taskId,run.taskId);assert.deepEqual(resumed.scanPlan,plan);assert.deepEqual(resumed.scan.pendingUrls,[second]);assert.equal(resumed.pageProgress.currentPage,49);assert.equal(f.db.sources(f.id)[0].recovery,null);
 // Late events from the retired run cannot interrupt its successor.
 f.runtime.event(f.id,{event:'eof'},run.id);assert.equal(f.db.run(resumed.id).status,'running');
});

test('provider exit waits for old worker closure and repeated exits back off without losing progress',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();const run=f.launches[0];f.checkpoint(run);let closed;
 f.close(()=>new Promise(r=>{closed=r;}));f.runtime.event(f.id,{event:'eof'},run.id);await settle();
 t.mock.timers.tick(60000);await f.runtime.tick();assert.equal(f.launches.length,1,'Never run two owners while close is pending');
 closed();await settle();f.close(async()=>{});await f.runtime.tick();await settle();assert.equal(f.launches.length,2);
 f.runtime.event(f.id,{event:'engine_exit'},f.launches[1].id);await settle();
 const task=f.store.workspaces.tasks.get(f.id,run.taskId);assert.equal(task.recovery.attempt,2);assert.equal(task.retryAt,Date.now()+15000);assert.deepEqual(task.scan.pendingUrls,[second]);
 t.mock.timers.tick(14000);await f.runtime.tick();assert.equal(f.launches.length,2);
});

test('explicit blockers, completion, user stop and source disable do not become automatic retries',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();let run=f.launches[0];
 f.runtime.report(f.id,run.id,'blocked','CAPTCHA requires user');f.runtime.event(f.id,{event:'eof'},run.id);t.mock.timers.tick(150);await settle();
 t.mock.timers.tick(60000);await f.runtime.tick();assert.equal(f.launches.length,1);assert.equal(f.db.sources(f.id)[0].blocked,true);
 await f.runtime.runSource(f.id,source);await settle();run=f.launches.at(-1);f.event('Working');f.event('Idle');await f.runtime.pause(f.id);t.mock.timers.tick(60000);await f.runtime.tick();assert.equal(f.launches.length,2);
 await f.runtime.runSource(f.id,source);await settle();f.event('Working');f.event('Idle');t.mock.timers.tick(10000);await settle();await f.runtime.saveSource(f.id,source,{enabled:false});t.mock.timers.tick(60000);await f.runtime.tick();assert.equal(f.launches.length,3);
});

test('uncertain actions and record tasks are not replayed as source scans',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();const run=f.launches[0];
 f.db.putRun({...f.db.run(run.id),recordId:'application'});assert.equal(unreportedSourceRun(f.db,f.id,run.id,'exit',Date.now()),null);
 f.db.putRun({...f.db.run(run.id),recordId:null,actionId:'attempt'});assert.equal(unreportedSourceRun(f.db,f.id,run.id,'exit',Date.now()),null);
 f.db.putRun({...f.db.run(run.id),actionId:null});
});

test('a reported completion is never retried by a subsequent provider exit',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();const run=f.launches[0];
 f.runtime.report(f.id,run.id,'completed','All pages processed');f.runtime.event(f.id,{event:'eof'},run.id);t.mock.timers.tick(150);await settle();await f.runtime.tick();
 t.mock.timers.tick(60000);await f.runtime.tick();assert.equal(f.launches.length,1);assert.equal(f.db.run(run.id).status,'completed');assert.equal(f.store.workspaces.tasks.get(f.id,run.taskId).state,'completed');
});

test('a provider usage limit waits in the same session and clears without restarting completed page work',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();const run=f.launches[0];f.checkpoint(run);f.event('Working');
 const usageLimit={provider:'claude',resetLabel:'06:00 (Europe/Istanbul)',automaticResume:true};
 f.runtime.event(f.id,{event:'usage_limit',usageLimit},run.id);f.event('Idle');t.mock.timers.tick(7200000);await settle();await f.runtime.tick();
 assert.equal(f.launches.length,1);assert.equal(f.db.run(run.id).status,'running');assert.equal(f.db.run(run.id).pageProgress.currentPage,49);assert.deepEqual(f.db.run(run.id).usageLimit,usageLimit);
 f.runtime.event(f.id,{event:'usage_limit',usageLimit:null},run.id);f.event('Working');t.mock.timers.tick(60000);await settle();assert.equal(f.launches.length,1);assert.equal(f.db.run(run.id).usageLimit,null);
 f.runtime.event(f.id,{event:'usage_limit',usageLimit},run.id);f.runtime.event(f.id,{event:'eof'},run.id);await settle();t.mock.timers.tick(60000);await f.runtime.tick();
 assert.equal(f.launches.length,1,'A closed quota-limited provider must not enter automatic recovery');assert.equal(f.db.run(run.id).status,'blocked');assert.equal(f.db.run(run.id).usageLimit.automaticResume,false);
});

test('legacy unreported errors recover on restart; real access blockers and paused workspaces remain blocked',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();const run=f.launches[0];f.checkpoint(run);
 await f.runtime.finish(f.id,'failed','Agent sonuç bildirmeden durdu. Agent ekranını kontrol et.');assert.equal(f.db.sources(f.id)[0].blocked,true);
 const resumed=new WebTasks(f.db,f.options);t.after(()=>resumed.close());const task=f.store.workspaces.tasks.get(f.id,run.taskId);
 assert.equal(task.state,'pending');assert.equal(task.id,run.taskId);assert.equal(f.db.sources(f.id)[0].blocked,false);
 await resumed.tick();assert.equal(f.launches.length,1);t.mock.timers.tick(5000);await resumed.tick();await settle();assert.equal(f.launches.length,2);assert.equal(f.launches[1].pageProgress.currentPage,49);
 await resumed.finish(f.id,'blocked','CAPTCHA');resumed.policy.recover();assert.equal(f.db.sources(f.id)[0].blocked,true);
 f.db.pause(f.id);resumed.policy.recover();assert.equal(f.db.get(f.id).status,'paused');assert.equal(f.db.sources(f.id)[0].blocked,true);
 await resumed.runSource(f.id,source);await settle();await resumed.finish(f.id,'failed','Agent sonuç bildirmeden durdu. Agent ekranını kontrol et.');f.db.pause(f.id);
 resumed.policy.recover();assert.equal(f.db.sources(f.id)[0].blocked,true);
 f.db.enable(f.id);await resumed.tick();assert.equal(f.db.sources(f.id)[0].blocked,false,'Starting tracking also repairs an old unreported error');
});
