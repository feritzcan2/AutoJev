import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
const source='https://homes.example/list',other='https://other.example/list';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 let now=Date.now();const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store,{now:()=>now}),launches=[];
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
test('Jev stops a source at its first shared barrier, preserves pending work and schedules recovery',async t=>{
 const f=fixture(t),id=f.create();f.db.put({...f.db.get(id),browserMode:'jev'});f.db.enable(id);
 const task=f.db.store.workspaces.tasks.enqueue(id,{operation:'scan',capability:'browser.observe',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const run=await f.runtime.start(id,{kind:'run',taskId:task.id}),pending=Array.from({length:30},(_,n)=>'https://de.homes.example/list/'+n);
 f.db.observe(id,run.id,source,'Observed listings',pending);f.db.saveScanProgress(id,run.id,{pendingUrls:pending,reason:'Read details'},{url:source,text:'Observed listings'});
 let calls=0,evaluations=0;
 const flow=automationWorkflow({db:f.db,run,signal:new AbortController().signal,browser:{
  evaluateJev(){evaluations++;throw Error('No model call should occur');},
  async call(_id,name,args){calls++;const wait=f.db.siteAccess.block(args.url,'verification');
   const page={url:args.url,status:'site_wait',siteWait:wait,text:wait.message};
   return {jevPage:page,siteWait:wait,pageContext:{url:page.url,tabId:'owned'},content:[{type:'text',text:'Page URL: '+page.url+'\n'+JSON.stringify(page)}]};
  }
 },report:(...args)=>f.runtime.report(...args)});
 const result=await flow.call(id,run.id,'browser_jev_run',{operation:'collect_details'});
 assert.equal(result.issue.reason,'access_barrier');assert.equal(result.parent.stop,true);assert.equal(calls,1);assert.equal(evaluations,0);
 const stopped=f.db.run(run.id);assert.equal(stopped.status,'blocked');assert.equal(stopped.stop.kind,'access');assert.deepEqual(stopped.scan.pendingUrls,pending);
 assert.equal(f.db.results(id).length,0);assert.equal(f.db.get(id).sourceState[source].siteBlocked,true);
 await assert.rejects(flow.call(id,run.id,'browser_jev_run',{operation:'collect_details'}));assert.equal(calls,1);
 await f.runtime.finish(id,'blocked',stopped.summary);
 const wait=f.db.sources(id).find(s=>s.url===source).siteWait;assert.equal(wait.site,'de.homes.example');
 assert.equal(f.db.siteAccess.status(source),null,'The wait is bound to the source, not a fabricated apex-host barrier');
 assert.equal(f.db.schedulingSources(id).find(s=>s.url===other).siteWait,null);
 await f.runtime.runSource(id,source);assert.equal(f.launches.filter(r=>r.sourceUrl===source).length,1);
 await settle();assert.equal(f.launches.at(-1).sourceUrl,other);
 await f.runtime.finish(id,'blocked','Synthetic other-source stop');
 f.setNow(wait.retryAt);await f.runtime.tick();await settle();await f.runtime.tick();await settle();
 assert.ok(f.launches.some(r=>r.id!==run.id&&r.sourceUrl===source));
 assert.equal(f.db.get(id).sourceState[source].scan,null);
 assert.equal(f.launches.at(-1).freshSource,true);
});

test('an external barrier preserves reachable work beyond the first queue page and cannot stop the source early',async t=>{
 const f=fixture(t),id=f.create();f.db.put({...f.db.get(id),browserMode:'jev'});f.db.enable(id);
 const task=f.db.store.workspaces.tasks.enqueue(id,{operation:'scan',capability:'browser.observe',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const run=await f.runtime.start(id,{kind:'run',taskId:task.id}),blocked=Array.from({length:100},(_,i)=>'https://external.example/role/'+i),good='https://reachable.example/role',calls=[];
 f.db.observe(id,run.id,source,'Observed queue',[...blocked,good]);
 for(const pendingUrls of [blocked,[good]])f.db.saveScanProgress(id,run.id,{pendingUrls,reason:'Read details'},{url:source,text:'Observed queue'});
 const flow=automationWorkflow({db:f.db,run,signal:new AbortController().signal,browser:{
  evaluateJev:async()=>({answers:{fit:{choice:'possible',confidence:1,probabilities:{possible:1,mismatch:0,uncertain:0,incomplete:0,results:0}}}}),
  async call(_id,name,args){
   calls.push(args.url);const wait=args.url===good?null:f.db.siteAccess.block(args.url,'verification');
   const page=wait?{url:args.url,status:'site_wait',text:wait.message,siteWait:wait}:{url:good,title:'A role',text:'Complete detail'};
   return {jevPage:page,...(wait?{siteWait:wait}:{}),pageContext:{url:page.url,tabId:'owned'},content:[{type:'text',text:'Page URL: '+page.url+'\n'+JSON.stringify(page)}]};
  }
 },report:(...args)=>f.runtime.report(...args)});
 const call=(name,args)=>flow.call(id,run.id,name,args);
 const first=await call('browser_jev_run',{operation:'collect_details'});
 assert.equal(first.issue.reason,'access_barrier');assert.equal(first.parent,undefined);assert.deepEqual(calls,[blocked[0]]);
 assert.equal(f.db.run(run.id).status,'running');assert.equal(f.db.run(run.id).siteWait,undefined);assert.ok(!f.db.get(id).sourceState[source]?.siteBlocked);
 const stop={status:'blocked',summary:'External site unavailable',stop:{kind:'access',evidence:'Site verification is required'}};
 for(let i=0;i<4;i++)await assert.rejects(flow.guardToolCall('finish_automation_run',stop,()=>call('finish_automation_run',stop)),error=>error.code==='JEV_WORK_REMAINS');
 assert.equal(f.db.run(run.id).status,'running');assert.equal(f.db.store.workspaces.tasks.get(id,task.id).toolFailure,undefined);
 const next=await call('browser_jev_run',{operation:'collect_details'});
 assert.equal(next.batch.total,1);assert.deepEqual(calls,[blocked[0],good]);
 await call('browser_jev_run',{taskId:next.taskId,reviewedBatchId:next.batch.id,review:[{url:good,decision:'reject',reason:'Parent reviewed an unrelated role'}]});
 const final=await call('browser_jev_run',{operation:'collect_details'});
 assert.equal(final.issue.reason,'access_barrier');assert.equal(final.parent.stop,true);assert.equal(calls.length,2);
 assert.deepEqual(f.db.run(run.id).scan.pendingUrls,blocked);assert.equal(f.db.results(id).length,0);
});
