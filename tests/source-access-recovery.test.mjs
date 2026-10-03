import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationAttention} from '../app/automation-attention.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {finishSourceAccess} from '../app/source-access-recovery.mjs';

const source='https://source.example/list',other='https://other.example/list';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{cleanup=async()=>({closed:['source-tab']})}={}){
 let now=Date.now();const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store,{now:()=>now}),launches=[],cleanups=[];
 const runtime=new WebTasks(db,{now:()=>now,launch:async run=>{launches.push(run);return {close:async()=>{}};},onRunFinished:async(id,run,options)=>{
  if(!options.sourceAccessReset)return;
  cleanups.push({id,run,options});return cleanup(id,run,options);
 }});
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[source,other],browserMode:'jev'});
 db.put({...db.get(a.id),browserMode:'jev'});db.review(a.id);const trial=db.begin(a.id,'trial');for(const url of a.sources)db.observe(a.id,trial.id,url,'Listings');db.finish(a.id,trial.id,'completed','Ready');db.enable(a.id);
 runtime.sourceState(a.id,other,{nextRunAt:now+86400000});
 t.after(async()=>{await runtime.close();await Promise.allSettled(runtime.sourceAccess.pending.values());store.close();});
 const start=async()=>{await runtime.runSource(a.id,source);await settle();return launches.at(-1);};
 const block=async()=>{
  const run=await start(),pending=source+'/detail';
  db.observe(a.id,run.id,source,'Listings',[pending],{url:source,tabId:'source-tab'});
  db.saveScanProgress(a.id,run.id,{pendingUrls:[pending],reason:'Pending detail'},{url:source,text:'Listings'});
  const helper=db.jevTasks.create(a.id,run.taskId,{operation:'collect_details'}),evidence=db.jevTasks.evidence(helper,{url:pending,text:'RAM ONLY BODY'}),wait=db.siteAccess.block(source,'verification');
  helper.items=[{url:pending,error:'access_barrier',blockedSite:wait.site,retryAt:wait.retryAt},{url:other+'/collected',evidenceId:evidence.id,collected:true,reviewed:true}];helper.blockedSites={[wait.site]:{siteWait:wait,retryAt:wait.retryAt}};helper.issue={reason:'access_barrier',siteWait:wait};helper.status='needs_agent';db.jevTasks.save(helper);
  db.jevTasks.deferDetail(a.id,run.taskId,pending,helper.items[0]);
  db.putRun({...db.run(run.id),siteWait:wait,stop:{kind:'access',evidence:wait.message},conversation:{provider:'opencode',nativeId:'original-source'},resumeContext:{url:source,tabId:'source-tab'}});
  runtime.report(a.id,run.id,'blocked',wait.message);await runtime.finish(a.id,'blocked',wait.message);
  return {run:db.run(run.id),pending,helper,evidence,wait};
 };
 return {id:a.id,db,store,runtime,launches,cleanups,start,block,now:()=>now,setNow:value=>{now=value;},issue:()=>automationAttention(db.snapshot(a.id)).find(i=>i.id===source)};
}

test('the primary source gate releases the worker despite empty searches and reachable external detail URLs',async t=>{
 const f=fixture(t),run=await f.start(),pending=[source+'/one',other+'/one'];
 f.db.observe(f.id,run.id,source,'Listings',pending);f.db.saveScanProgress(f.id,run.id,{pendingUrls:pending,reason:'Details'},{url:source,text:'Listings'});
 let calls=0;
 const flow=automationWorkflow({db:f.db,run,signal:new AbortController().signal,browser:{evaluateJev:()=>{throw Error('No model call needed');},call:async(_id,_name,args)=>{
  calls++;const wait=f.db.siteAccess.block(args.url,'verification'),page={url:args.url,status:'site_wait',siteWait:wait,text:wait.message};
  return {jevPage:page,siteWait:wait,pageContext:{url:page.url,tabId:'source-tab'},content:[{type:'text',text:'Page URL: '+page.url+'\n'+JSON.stringify(page)}]};
 }},report:(...args)=>f.runtime.report(...args)});
 const result=await flow.call(f.id,run.id,'browser_jev_run',{operation:'collect_details'});
 assert.equal(calls,1);assert.equal(result.parent.stop,true);assert.equal(f.db.run(run.id).status,'blocked');
 await f.runtime.finish(f.id,'blocked','Access wait');f.runtime.sourceState(f.id,other,{nextRunAt:f.now()});await f.runtime.tick();await settle();
 assert.equal(f.launches.at(-1).sourceUrl,other);assert.equal(f.db.get(f.id).sourceState[source].accessRecovery.state,'waiting');
});

test('a reply resumes the same durable task, tab, queue and RAM on a free worker without interrupting another source',async t=>{
 const f=fixture(t),blocked=await f.block();f.runtime.sourceState(f.id,other,{nextRunAt:f.now()});await f.runtime.tick();await settle();
 const otherRun=f.launches.at(-1);assert.equal(otherRun.sourceUrl,other);f.setNow(f.now()+2*60000);
 assert.equal(f.issue().kind,'site_access');assert.equal(f.issue().accessRetryAt,blocked.wait.retryAt);
 await f.runtime.sourceAccess.resume(f.id,source,blocked.run.id,'Captcha çözüldü, devam.');
 assert.equal(f.launches.length,2,'Busy worker must keep its current assignment');assert.equal(f.db.run(otherRun.id).status,'running');
 assert.equal(f.db.siteAccess.status(source),null);assert.equal(f.db.jevTasks.detailWait(f.id,blocked.run.taskId,blocked.pending),null);
 const retained=f.db.jevTasks.get(f.id,blocked.run.taskId,blocked.helper.id);assert.equal(retained.items[0].error,undefined);assert.equal(retained.items[1].reviewed,true);
 assert.equal(f.db.jevTasks.fullEvidence(f.id,blocked.run.taskId,blocked.evidence.id).text,'RAM ONLY BODY');
 // Passing the deadline after a response must not expire the queued resume.
 f.setNow(blocked.wait.retryAt+1);const worker=f.store.workspaces.workers.add(f.id);
 await f.runtime.tick();await settle();const resumed=f.launches.at(-1);
 assert.equal(resumed.workerId,worker.id);assert.equal(resumed.taskId,blocked.run.taskId);assert.equal(resumed.sourceUrl,source);
 assert.deepEqual(resumed.scan.pendingUrls,[blocked.pending]);assert.equal(resumed.continuation.runId,blocked.run.id);assert.equal(resumed.continuation.resumeConversation,true);assert.equal(resumed.continuation.browserContext.tabId,'source-tab');
 assert.equal(automationTaskContext(f.db,f.id,resumed).sourceRecovery.response,'Captcha çözüldü, devam.');assert.equal(f.cleanups.length,0);
});

test('the deadline resumes the same task, retained tab, queue and RAM automatically',async t=>{
 const f=fixture(t),blocked=await f.block();assert.equal(blocked.wait.retryAt,f.now()+5*60000);
 f.setNow(blocked.wait.retryAt-1);await f.runtime.tick();await settle();assert.equal(f.launches.length,1);
 f.setNow(blocked.wait.retryAt);await f.runtime.tick();await settle();
 const resumed=f.launches.at(-1);assert.equal(f.launches.length,2);assert.equal(resumed.taskId,blocked.run.taskId);
 assert.equal(resumed.continuation.reason,'site_access_retry');assert.equal(resumed.continuation.browserContext.tabId,'source-tab');
 assert.equal(resumed.scanPlan.id,blocked.run.scanPlan.id);assert.deepEqual(resumed.scan.pendingUrls,[blocked.pending]);
 assert.equal(f.cleanups.length,0);assert.equal(f.db.jevTasks.fullEvidence(f.id,resumed.taskId,blocked.evidence.id).text,'RAM ONLY BODY');
 assert.equal(f.db.jevTasks.detailWait(f.id,resumed.taskId,blocked.pending),null);
 assert.equal(f.db.siteAccess.status(source).attempts,1,'Only a verified page probe may clear the gate');
 assert.match(automationTaskContext(f.db,f.id,resumed).sourceRecovery.instructions,/scheduled access wait expired/);
 await assert.rejects(f.runtime.sourceAccess.resume(f.id,source,blocked.run.id),/devam ettirilemiyor/);
});

test('closing the intervention closes its tabs now and starts fresh only at the existing retry time',async t=>{
 const f=fixture(t),blocked=await f.block(),issue=f.issue();
 await f.runtime.dismissAttention(f.id,issue.id,issue.dismissKey);assert.equal(f.cleanups.length,1);assert.equal(f.issue(),undefined);assert.equal(f.launches.length,1);
 await f.runtime.tick();assert.equal(f.launches.length,1);assert.equal(f.db.get(f.id).sourceState[source].nextRunAt,blocked.wait.retryAt);
 await assert.rejects(f.runtime.sourceAccess.resume(f.id,source,blocked.run.id),/devam ettirilemiyor/);
 f.setNow(blocked.wait.retryAt);await f.runtime.tick();await settle();assert.equal(f.launches.at(-1).freshSource,true);assert.equal(f.cleanups.length,1);
});

test('failed explicit tab cleanup remains pending without interrupting other sources',async t=>{
 let ready=false;const f=fixture(t,{cleanup:async()=>ready?{closed:['source-tab']}:{deferred:true}}),blocked=await f.block();
 await assert.rejects(f.runtime.sourceAccess.reset(f.id,source,blocked.run.id,{dismissed:true}),/kapatılamadı/);
 assert.equal(f.launches.length,1);assert.match(f.issue().cleanupError,/kapatılamadı/);
 await f.runtime.tick();await settle();assert.equal(f.cleanups.length,1);
 ready=true;f.setNow(f.now()+5000);await f.runtime.tick();await settle();assert.equal(f.launches.length,1);
 f.setNow(blocked.wait.retryAt);await f.runtime.tick();await settle();assert.equal(f.launches.length,2);
});

test('due turns never accumulate or interrupt an active search with several idle workers',async t=>{
 const f=fixture(t),run=await f.start();for(let n=0;n<2;n++)f.store.workspaces.workers.add(f.id);
 for(let n=0;n<5;n++){f.setNow(f.now()+86400000);f.runtime.sourceState(f.id,other,{nextRunAt:f.now()+86400000});await f.runtime.tick();await settle();}
 assert.equal(f.launches.length,1);assert.equal(f.db.run(run.id).status,'running');
 assert.equal(f.store.workspaces.tasks.list(f.id).filter(t=>t.sourceUrl===source).length,1);
});

test('a source question answer follows its incident and a stale reply cannot clear a newer host block',async t=>{
 const f=fixture(t),blocked=await f.block();
 const a=f.db.get(f.id);f.db.put({...a,questions:[{id:'access-question',text:'Captcha?',runId:blocked.run.id,taskId:blocked.run.taskId,sourceUrl:source,createdAt:f.now(),answer:null}]});
 await f.runtime.answer(f.id,'access-question','Çözdüm');assert.equal(f.launches.at(-1).continuation.reason,'site_access_response');
 const wait=f.db.siteAccess.block(source,'verification');f.db.siteAccess.save({...f.db.siteAccess.row(source),blockedAt:wait.blockedAt+1});
 assert.throws(()=>f.db.siteAccess.acknowledge([wait]),/yeni bir erişim/);assert.ok(f.db.siteAccess.status(source));
});

test('pausing an answered source waiting for a worker does not strand it on later enable',async t=>{
 const f=fixture(t),blocked=await f.block();f.runtime.sourceState(f.id,other,{nextRunAt:f.now()});await f.runtime.tick();await settle();
 await f.runtime.sourceAccess.resume(f.id,source,blocked.run.id);assert.equal(f.launches.length,2);
 await f.runtime.pause(f.id);await f.runtime.runSource(f.id,source);await settle();
 assert.equal(f.launches.at(-1).sourceUrl,source);assert.equal(f.launches.at(-1).taskId,blocked.run.taskId);assert.equal(f.launches.at(-1).continuation.reason,'site_access_response');
});


test('a scan retries after five and ten minutes, stops on the third incident, and resumes only by user action',async t=>{
 const f=fixture(t),blocked=await f.block();
 for(const attempt of [2,3]){
  const due=f.db.siteAccess.status(source).retryAt;f.setNow(due);await f.runtime.tick();await settle();
  const run=f.launches.at(-1);assert.equal(run.taskId,blocked.run.taskId);
  const token=f.db.siteAccess.begin(source);f.db.siteAccess.complete(source,token,{status:200});
  const wait=f.db.siteAccess.block(source+'?page='+attempt,'rate_limit');assert.equal(wait.attempts,attempt);
  f.db.putRun({...f.db.run(run.id),siteWait:wait,stop:{kind:'access',evidence:wait.message}});
  f.runtime.report(f.id,run.id,'blocked',wait.message);await f.runtime.finish(f.id,'blocked',wait.message);
  assert.equal(wait.retryAt,attempt===2?f.now()+10*60000:null);
 }
 assert.equal(f.launches.length,3);assert.equal(f.issue().accessExhausted,true);assert.equal(f.issue().accessRetryAt,null);
 f.setNow(f.now()+86400000);await f.runtime.tick();await settle();assert.equal(f.launches.filter(r=>r.sourceUrl===source).length,3);
 f.runtime.sourceState(f.id,other,{nextRunAt:f.now()});await f.runtime.tick();await settle();assert.equal(f.launches.at(-1).sourceUrl,other);
 await f.runtime.sourceAccess.resume(f.id,source,f.issue().runId);assert.equal(f.db.siteAccess.status(source),null);
 f.store.workspaces.workers.add(f.id);await f.runtime.tick();await settle();assert.equal(f.launches.at(-1).taskId,blocked.run.taskId);
});

test('pause and source disable cancel automatic access resumption until enabled again',async t=>{
 for(const pause of [true,false]){
  const f=fixture(t),blocked=await f.block();
  if(pause)await f.runtime.pause(f.id);else await f.runtime.saveSource(f.id,source,{enabled:false});
  f.setNow(blocked.wait.retryAt);await f.runtime.tick();await settle();assert.equal(f.launches.length,1);
  if(pause)await f.runtime.runSource(f.id,source);else await f.runtime.saveSource(f.id,source,{enabled:true});
  await f.runtime.tick();await settle();assert.equal(f.launches.length,2);assert.equal(f.launches.at(-1).taskId,blocked.run.taskId);
 }
});

test('stopping a source cancels its pending access continuation and releases only its RAM',async t=>{
 const f=fixture(t),blocked=await f.block();
 await f.runtime.stopSource(f.id,source);f.setNow(blocked.wait.retryAt);await f.runtime.tick();await settle();
 assert.equal(f.launches.length,1);assert.equal(f.store.workspaces.tasks.get(f.id,blocked.run.taskId).state,'cancelled');
 assert.equal(f.db.get(f.id).sourceState[source].accessRecovery,null);assert.deepEqual(f.db.jevTasks.list(f.id,blocked.run.taskId),[]);
});

test('closing a stopped intervention never restarts it; explicit source retry starts a new budget',async t=>{
 const f=fixture(t),blocked=await f.block();
 f.db.siteAccess.save({...f.db.siteAccess.row(source),attempts:3,retryAt:null});
 const a=f.db.get(f.id),state=a.sourceState[source];f.db.put({...a,sourceState:{...a.sourceState,[source]:{...state,accessRecovery:{...state.accessRecovery,retryAt:null}}}});
 const issue=f.issue();await f.runtime.dismissAttention(f.id,issue.id,issue.dismissKey);
 f.setNow(f.now()+3600000);await f.runtime.tick();await settle();assert.equal(f.launches.length,1);assert.equal(f.issue(),undefined);
 await f.runtime.runSource(f.id,source);await settle();assert.equal(f.launches.length,2);assert.equal(f.db.siteAccess.status(source),null);
 assert.equal(f.db.siteAccess.block(source,'rate_limit').attempts,1);
});


test('successful scan completion retires its recovered access budget, including a fresh task after dismissal',async t=>{
 const f=fixture(t),blocked=await f.block(),issue=f.issue();
 await f.runtime.dismissAttention(f.id,issue.id,issue.dismissKey);f.setNow(blocked.wait.retryAt);await f.runtime.tick();await settle();
 const run=f.launches.at(-1);assert.notEqual(run.taskId,blocked.run.taskId);
 f.db.siteAccess.complete(source,f.db.siteAccess.begin(source),{status:200});assert.equal(f.db.siteAccess.row(source).attempts,1);
 finishSourceAccess(f.db,{...run,status:'completed'});assert.equal(f.db.siteAccess.row(source),null);
});
