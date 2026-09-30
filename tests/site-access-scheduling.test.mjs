import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
const source='https://homes.example/list',other='https://other.example/list';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 let now=Date.now();const store=new Store(':memory:'),db=new AutomationStore(store,{now:()=>now}),launches=[];
 const runtime=new WebTasks(db,{now:()=>now,launch:async run=>{launches.push(run);return {close:async()=>{}};}});
 t.after(async()=>{await runtime.close();store.close();});
 const create=()=>{
  const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[source,other]});db.review(a.id);
  const run=db.begin(a.id,'trial');for(const url of a.sources)db.observe(a.id,run.id,url,'Listings');db.finish(a.id,run.id,'completed','Ready');return a.id;
 };
 return {db,runtime,launches,create,now:()=>now,setNow:value=>{now=value;}};
}
test('all workspaces defer the blocked site while another site runs; sources resume when due',async t=>{
 const f=fixture(t),one=f.create(),two=f.create();f.db.siteAccess.block(source,'ip_block');
 await f.runtime.runSource(one,source);await f.runtime.runSource(two,source);await settle();assert.equal(f.launches.length,0);
 for(const id of [one,two])assert.ok(f.db.sources(id).find(s=>s.url===source).siteWait.waiting);
 await f.runtime.runSource(one,other);await settle();assert.deepEqual(f.launches.map(r=>r.sourceUrl),[other]);
 f.setNow(f.db.siteAccess.status(source).retryAt);await f.runtime.tick();await settle();assert.ok(f.launches.some(r=>r.automationId===two&&r.sourceUrl===source));
});
test('a blocked source retains its checkpoint and resumes automatically after shared recovery',async t=>{
 const f=fixture(t),id=f.create();f.db.enable(id);
 const scan={complete:false,pendingUrls:[source+'?page=7'],reason:'Continue page 7',evidenceUrl:source};
 f.db.put({...f.db.get(id),sourceState:{[source]:{siteBlocked:true,blocked:true,nextRunAt:null,scan},[other]:{nextRunAt:f.now()+100000000}}});
 f.db.siteAccess.block(source,'ip_block');await f.runtime.tick();assert.equal(f.launches.length,0);
 f.setNow(f.db.siteAccess.status(source).retryAt);f.db.siteAccess.complete(source,f.db.siteAccess.begin(source),{status:200});
 await f.runtime.tick();await settle();assert.equal(f.launches.length,1);assert.equal(f.launches[0].sourceUrl,source);
 assert.deepEqual(f.db.get(id).sourceState[source].scan,scan);
});
test('trial wait is recorded without a fake page read, retries at the gate deadline, and pause cancels it',async t=>{
 const f=fixture(t),id=f.create(),run=await f.runtime.start(id,'trial');f.db.siteAccess.block(source,'ip_block');
 const wait=f.db.siteAccess.status(source),calls=[];
 const flow=automationWorkflow({db:f.db,run,signal:new AbortController().signal,browser:{async call(_id,name){calls.push(name);return {siteWait:wait,pageContext:{url:source},content:[{type:'text',text:'Page URL: '+source+'\n'+wait.message}]};}},report:(...args)=>f.runtime.report(...args)});
 await flow.call(id,run.id,'browser_open',{url:source});assert.deepEqual(calls,['browser_navigate']);assert.equal(f.db.run(run.id).siteWait.retryAt,wait.retryAt);
 await assert.rejects(flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'Done'}),/ortak bekleme/);
 await flow.call(id,run.id,'finish_automation_run',{status:'blocked',summary:wait.message});
 assert.equal(f.db.get(id).retryPlan[run.id].at,wait.retryAt);
 await f.runtime.finish(id,'blocked',wait.message);f.setNow(wait.retryAt-1);await f.runtime.tick();assert.equal(f.launches.length,1);
 f.setNow(wait.retryAt);await f.runtime.tick();await settle();assert.equal(f.launches.length,2);assert.equal(f.launches[1].kind,'trial');
 await f.runtime.pause(id);f.setNow(wait.retryAt+7200000);await f.runtime.tick();assert.equal(f.launches.length,2);
});
