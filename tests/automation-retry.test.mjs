import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationAttention} from '../app/automation-attention.mjs';
const source='https://homes.example/list',other='https://other.example/list',twoHours=7200000;
function fixture(t){
 let now=Date.now();const clock=()=>now,store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store,{now:clock});
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[source,other]});db.review(a.id);
 const trial=db.begin(a.id,'trial');for(const url of [source,other])db.observe(a.id,trial.id,url,'Listings');db.finish(a.id,trial.id,'completed','Ready');db.enable(a.id);
 db.put({...db.get(a.id),sourceState:{[source]:{blocked:true,lastStatus:'blocked',lastResult:'CAPTCHA',nextRunAt:null},[other]:{nextRunAt:now+10*twoHours}}});
 const launches=[],options={now:clock,launch:async run=>{launches.push(run);return {close:async()=>{}};}},runtimes=[];
 const runtime=()=>{const r=new WebTasks(db,options);runtimes.push(r);return r;};
 t.after(async()=>{for(const r of runtimes)await r.close();store.close();});
 return {db,id:a.id,launches,runtime,setNow:value=>{now=value;},now:clock};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('source retry waits two hours, survives runtime restart and runs only once',async t=>{
 const f=fixture(t),r=f.runtime(),{at}=r.retryLater(f.id,source);assert.equal(at,f.now()+twoHours);
 assert.equal(automationAttention(f.db.snapshot(f.id))[0].retryAt,at);
 await r.tick();assert.equal(f.launches.length,0);await r.close();const resumed=f.runtime();
 f.setNow(at-1);await resumed.tick();assert.equal(f.launches.length,0);
 f.setNow(at);await resumed.tick();await settle();assert.equal(f.launches.length,1);assert.equal(f.launches[0].sourceUrl,source);
 assert.equal(f.db.get(f.id).retryPlan[source],undefined);await resumed.tick();assert.equal(f.launches.length,1);
 await resumed.finish(f.id,'blocked','CAPTCHA remains');await resumed.tick();f.setNow(at+twoHours);await resumed.tick();assert.equal(f.launches.length,1);
});
test('a persisted retry still executes after closing and reopening the database',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'loop-retry-')),file=path.join(directory,'db.sqlite');
 let now=Date.now(),store=new WorkspaceDatabase(file),db=new AutomationStore(store,{now:()=>now}),runtime;
 t.after(async()=>{await runtime?.close();store.close();await rm(directory,{recursive:true,force:true});});
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[source]});db.review(a.id);
 const trial=db.begin(a.id,'trial');db.observe(a.id,trial.id,source,'Listings');db.finish(a.id,trial.id,'completed','Ready');
 db.put({...db.get(a.id),status:'paused',sourceState:{[source]:{blocked:true,lastResult:'CAPTCHA'}}});
 const launches=[],options={now:()=>now,launch:async run=>{launches.push(run);return {close:async()=>{}};}};
 runtime=new WebTasks(db,options);const {at}=runtime.retryLater(a.id,source);await runtime.close();store.close();
 store=new WorkspaceDatabase(file);db=new AutomationStore(store,{now:()=>now});runtime=new WebTasks(db,options);
 assert.equal(db.get(a.id).retryPlan[source].at,at);now=at+1000;await runtime.tick();await settle();
 assert.equal(launches.length,1);assert.equal(launches[0].sourceUrl,source);assert.equal(db.get(a.id).retryPlan[source],undefined);
});
test('another source keeps working while retry is deferred; cancellation prevents the deferred start',async t=>{
 const f=fixture(t),r=f.runtime(),helper=await r.add(f.id);await r.runSource(f.id,other);await settle();const running=r.slots(f.id)[0];
 const {at}=r.retryLater(f.id,source);assert.equal(r.slots(f.id)[0].run.id,running.run.id);
 r.retryLater(f.id,source,true);f.setNow(at);await r.tick();assert.equal(f.launches.length,1);assert.equal(f.db.get(f.id).retryPlan[source],undefined);
});
test('paused source retry enables only that source when due and explicit stop cancels scheduled work',async t=>{
 const f=fixture(t),r=f.runtime();await r.pause(f.id);const {at}=r.retryLater(f.id,source);
 assert.equal(f.db.get(f.id).status,'paused');f.setNow(at);await r.tick();await settle();
 assert.equal(f.launches.length,1);assert.equal(f.launches[0].sourceUrl,source);assert.deepEqual(f.db.get(f.id).onceSources,[source]);
 await r.finish(f.id,'blocked','Still blocked');await r.tick();r.retryLater(f.id,source);await r.pause(f.id);
 f.setNow(at+twoHours);await r.tick();assert.equal(f.launches.length,1);assert.deepEqual(f.db.get(f.id).retryPlan,{});
});
test('failed trials can be deferred; a manual trial consumes the old plan',async t=>{
 const f=fixture(t),r=f.runtime();await r.pause(f.id);f.db.put({...f.db.get(f.id),sourceState:{}});
 let trial=await r.start(f.id,'trial');await r.finish(f.id,'blocked','Verification needed');
 const {at}=r.retryLater(f.id,trial.id);await r.tick();assert.equal(f.launches.length,1);
 f.setNow(at);await r.tick();await settle();assert.equal(f.launches.length,2);assert.equal(f.launches[1].kind,'trial');
 trial=f.launches[1];await r.finish(f.id,'blocked','Still needed');r.retryLater(f.id,trial.id);
 await r.start(f.id,'trial');assert.deepEqual(f.db.get(f.id).retryPlan,{});
});
test('a changed plan or disabled source cancels stale retries and uncertain actions cannot be deferred',async t=>{
 const f=fixture(t),r=f.runtime(),{at}=r.retryLater(f.id,source);await r.saveSource(f.id,source,{enabled:false});
 f.setNow(at);await r.tick();assert.equal(f.launches.length,0);assert.equal(f.db.get(f.id).retryPlan[source],undefined);
 await r.pause(f.id);f.db.put({...f.db.get(f.id),sourceSettings:{},sourceState:{[source]:{blocked:true,blocker:{recordId:'uncertain'}}}});
 assert.throws(()=>r.retryLater(f.id,source),/planlanamaz/);
 f.db.put({...f.db.get(f.id),sourceState:{[source]:{blocked:true}}});r.retryLater(f.id,source);
 f.db.save(f.id,{goal:'A new search'});await r.tick();assert.equal(f.db.get(f.id).retryPlan[source],undefined);
});
