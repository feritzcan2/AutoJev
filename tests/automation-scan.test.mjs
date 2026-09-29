import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {observedLinks,scanCheckpoint,scanBudget} from '../app/automation-scan.mjs';
const source='https://homes.test/results',second=source+'?page=2',third=source+'?page=3';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const store=new Store(':memory:'),db=new AutomationStore(store),a=db.create('housing',{goal:'Find all matching homes',criteria:{location:'Berlin',budget:'2000',requirements:'At least 2 rooms'},sources:[source]});
 db.review(a.id);const trial=db.begin(a.id,'trial');db.observe(a.id,trial.id,source,'Results');db.finish(a.id,trial.id,'completed','Read');
 const launches=[],runtime=new WebTasks(db,{launch:async run=>{launches.push(run);return {close:async()=>{}};}});t.after(async()=>{await runtime.close();store.close();});
 const workflow=run=>{let current;return automationWorkflow({db,run,signal:new AbortController().signal,browser:{async call(id,name,args){if(name==='browser_navigate')current=args.url;const links=current===source?[{text:'Next page',url:second}]:current===second?[{text:'Next page',url:third}]:[];return {content:[{type:'text',text:'Page URL: '+current+'\n'+JSON.stringify({url:current,text:'Listing results',links})}]};}},report:(id,runId,status,summary,goal)=>runtime.report(id,runId,status,summary,goal)});};
 return {db,id:a.id,runtime,launches,workflow};
}

test('a source cannot finish after two records without reporting scan coverage',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();const run=launches[0],flow=workflow(run);
 await flow.call(id,run.id,'browser_open',{url:source});
 for(let n=0;n<2;n++)db.record(id,run.id,{url:'https://homes.test/listing/'+n,title:'Home',summary:'Observed'});
 await assert.rejects(flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'Two homes found'}),/Tarama kapsamı gerekli/);
 await assert.rejects(flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'Done',scan:{complete:true,pendingUrls:[second],reason:'Page two remains',evidenceUrl:source}}),/Bekleyen/);
 assert.equal(db.run(run.id).status,'running');assert.equal(db.resultCounts(id).resultCount,2);
});

test('partial scans resume the same task and one-off scheduling ends only after the final page',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();
 const pages=[source,second,third];
 for(let n=0;n<3;n++){
  const run=launches[n],flow=workflow(run),pendingUrls=n<2?[pages[n+1]]:[];
  if(n){const context=await flow.call(id,run.id,'get_automation_context',{});assert.deepEqual(context.scanProgress.pendingUrls,[pages[n]]);assert.equal(context.currentRun.observedLinks,undefined);assert.equal(run.taskId,launches[0].taskId);}
  await flow.call(id,run.id,'browser_open',{url:pages[n]});
  if(n<2)db.putRun({...db.run(run.id),browserSteps:db.get(id).maxBrowserSteps});
  const reported=await flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:n<2?'More pages remain':'Final page processed',scan:{complete:n===2,pendingUrls,reason:n<2?'Observed next page link':'Final results page; all candidates processed',evidenceUrl:pages[n]}});
  assert.equal(reported.status,n<2?'partial':'completed');await runtime.tick();assert.equal(launches.length,n+1,'lease stays held until provider closes');
  await runtime.finish(id);await runtime.tick();await settle();
  assert.equal(db.get(id).status,n<2?'enabled':'paused');
 }
 assert.equal(launches.length,3);assert.equal(db.sources(id)[0].scan.complete,true);assert.equal(db.store.workspaces.tasks.get(id,launches[0].taskId).state,'completed');
});

test('partial scan cursors survive a stop and restart without starting again at page one',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();let run=launches[0],flow=workflow(run);
 await flow.call(id,run.id,'browser_open',{url:source});db.putRun({...db.run(run.id),browserSteps:db.get(id).maxBrowserSteps});await flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'Continue page two',scan:{complete:false,pendingUrls:[second],reason:'Next page remains',evidenceUrl:source}});
 await runtime.pause(id);assert.equal(db.get(id).status,'paused');await runtime.runSource(id,source);await settle();run=launches[1];flow=workflow(run);assert.deepEqual(run.scan.pendingUrls,[second]);
 await flow.call(id,run.id,'browser_open',{url:second});await assert.rejects(flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'No progress',scan:{complete:false,pendingUrls:[second],reason:'Still remaining',evidenceUrl:second}}),/ilerlemedi/);
});

test('scan evidence and continuation URLs must be observed, scoped and consistent',()=>{
 const run={kind:'run',sourceUrl:source,observedLinks:[second],navigation:[{url:source}]},base={complete:false,pendingUrls:[second],reason:'Next page',evidenceUrl:source};
 assert.deepEqual(scanCheckpoint(run,base),base);
 for(const pendingUrls of [[third],['https://other.test/page'],[]])assert.throws(()=>scanCheckpoint(run,{...base,pendingUrls}));
 assert.throws(()=>scanCheckpoint(run,{...base,evidenceUrl:second}),/bu turda/);assert.throws(()=>scanCheckpoint({...run,recordId:'one'},base),/kaynak görevine/);
 const response={content:[{type:'text',text:`Page URL: ${source}\n- link "Next":\n  - /url: /results?page=2`}]};assert.ok(observedLinks(response,source).includes(second));
});

test('reported partial coverage is recovered as pending after provider process exit',async t=>{
 const {db,id,runtime}=fixture(t);db.enable(id);const queue=db.store.workspaces.tasks,task=queue.enqueue(id,{sourceUrl:source,sources:[source],batchId:'recovery',operation:'scan',lockKey:'source:'+source});
 const run=db.begin(id,{kind:'run',taskId:task.id}),scan={complete:false,pendingUrls:[second],reason:'Next page remains',evidenceUrl:source};
 db.putRun({...run,scan});db.finish(id,run.id,'partial','Continue',{release:false});runtime.policy.recover();
 const resumed=queue.get(id,task.id);assert.equal(resumed.state,'pending');assert.equal(resumed.workerId,null);assert.deepEqual(resumed.scan,scan);
});


test('early partial finish leaves the same run active and reports real remaining budget',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();const run=launches[0],flow=workflow(run);
 await flow.call(id,run.id,'browser_open',{url:source});await flow.call(id,run.id,'browser_read',{});
 const input={status:'completed',summary:'Budget exhausted',scan:{complete:false,pendingUrls:[second],reason:'Budget exhausted',evidenceUrl:source}};
 await assert.rejects(flow.call(id,run.id,'finish_automation_run',input),/78 tarayıcı adımı/);
 await runtime.tick();assert.equal(launches.length,1);assert.equal(db.run(run.id).status,'running');assert.equal(db.run(run.id).scan,undefined);
 const context=await flow.call(id,run.id,'get_automation_context',{});assert.equal(context.currentRun.budget.remainingSteps,78);assert.equal(context.currentRun.budget.canYield,false);
 // Coverage can finish immediately, and a real blocker need not burn a budget.
 await flow.call(id,run.id,'finish_automation_run',{status:'blocked',summary:'Login required'});assert.equal(db.run(run.id).status,'blocked');
});

test('scan yield budget uses actual steps or the final time reserve',()=>{
 const plan={maxBrowserSteps:80,timeoutMinutes:10},run={startedAt:1000,browserSteps:2};
 assert.deepEqual(scanBudget(run,plan,27000),{remainingSteps:78,remainingSeconds:574,canYield:false});
 assert.equal(scanBudget(run,plan,541000).canYield,true);
 assert.equal(scanBudget({...run,browserSteps:80},plan,27000).canYield,true);
 assert.equal(scanBudget(run,{...plan,timeoutMinutes:1},27000).canYield,false);
});
