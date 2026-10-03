import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationAttention} from '../app/automation-attention.mjs';

const urls=['https://homes.test/berlin','https://homes.test/hamburg'];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{workers=1}={}){
 const store=new WorkspaceDatabase(':memory:');let now=1790000000000;
 const db=new AutomationStore(store,{now:()=>now}),a=db.create('housing',{goal:'Find homes',criteria:{location:'Germany',budget:'2000',requirements:'Two rooms'},sources:urls});
 db.review(a.id);db.save(a.id,{mode:'auto'});
 for(let n=1;n<workers;n++)store.workspaces.workers.add(a.id);
 const launches=[],runtime=new WebTasks(db,{now:()=>now,launch:async run=>{launches.push(run);return {close:async()=>{}};}});
 t.after(async()=>{await runtime.close();store.close();});
 const finish=async(run,status='completed')=>{
  db.spendStep(a.id,run.id);db.observe(a.id,run.id,run.sourceUrl,'Actual rental listings');
  const flow=automationWorkflow({db,run,signal:{aborted:false},browser:{},report:(...args)=>runtime.report(...args)});
  await flow.call(a.id,run.id,'finish_automation_run',{status,summary:status==='completed'?'Source checked':'Site access denied'});
  await runtime.finish(a.id,status,'Source checked',run.workerId);
 };
 return {store,db,id:a.id,runtime,launches,finish,advance:()=>{now+=31*60000;}};
}

test('reviewed setup starts source trials without a workspace trial, then schedules normal scans',async t=>{
 const f=fixture(t);f.db.enable(f.id);await f.runtime.tick();await settle();
 const first=f.launches[0];assert.equal(first.kind,'trial');assert.equal(first.sourceUrl,urls[0]);assert.deepEqual(first.sources,[urls[0]]);
 assert.equal(f.db.get(f.id).status,'enabled');assert.equal(f.db.get(f.id).trial,null);
 assert.equal(f.db.sources(f.id)[0].trialRunning,true);assert.equal(first.scanPlan,undefined);
 const flow=automationWorkflow({db:f.db,run:first,signal:{aborted:false},browser:{},report:()=>{}});
 const context=await flow.call(f.id,first.id,'get_automation_context',{});
 assert.equal(context.automation.mode,'observe');assert.equal(context.assignedSource.url,urls[0]);assert.equal(context.assignedOperation,null);
 const sample=f.db.record(f.id,first.id,{url:urls[0]+'/one',title:'A home',summary:'Observed facts',proposal:'Sample draft'});
 assert.equal(sample.trial,true);assert.throws(()=>f.db.reserve(f.id,first.id,sample.id),/gözlem/);
 await f.finish(first);await f.runtime.tick();await settle();
 assert.equal(f.db.sources(f.id)[0].trial.status,'passed');assert.equal(f.db.sources(f.id)[0].scanState,undefined);
 const second=f.launches[1];assert.equal(second.kind,'trial');assert.equal(second.sourceUrl,urls[1]);
 await f.finish(second);await f.runtime.tick();assert.equal(f.launches.length,2);
 assert.equal(f.store.workspaces.tasks.list(f.id,{batchId:first.batchId}).length,1);
 f.advance();await f.runtime.tick();await settle();
 const scan=f.launches[2];assert.equal(scan.kind,'run');assert.equal(scan.sourceUrl,urls[0]);assert.equal(scan.scanPlan.mode,'full');
});

test('a blocked source trial does not block parallel trials or turn a same-origin source into passed',async t=>{
 const f=fixture(t,{workers:2});f.db.enable(f.id);await f.runtime.tick();await settle();
 assert.equal(f.launches.length,2);const [blocked,healthy]=f.launches;
 await f.finish(blocked,'blocked');assert.equal(f.db.get(f.id).status,'enabled');
 assert.equal(f.db.sources(f.id)[1].trial,undefined);assert.equal(f.db.run(healthy.id).status,'running');
 await f.finish(healthy);await f.runtime.tick();
 const [issue]=automationAttention(f.db.snapshot(f.id));assert.equal(issue.sourceUrl,urls[0]);assert.equal(issue.retry,'source');
 f.advance();await f.runtime.tick();await settle();assert.equal(f.launches.at(-1).kind,'run');assert.equal(f.launches.at(-1).sourceUrl,urls[1]);
 await f.runtime.runSource(f.id,urls[0]);await settle();assert.equal(f.launches.at(-1).kind,'trial');assert.equal(f.launches.at(-1).sourceUrl,urls[0]);
});

test('one-off source trial completes without scanning or activating other sources',async t=>{
 const f=fixture(t);await f.runtime.runSource(f.id,urls[1]);await settle();
 assert.equal(f.launches[0].kind,'trial');await f.finish(f.launches[0]);await f.runtime.tick();
 assert.equal(f.db.get(f.id).status,'paused');assert.equal(f.launches.length,1);assert.equal(f.db.sources(f.id)[0].trial,undefined);
 await f.runtime.runSource(f.id,urls[1]);await settle();assert.equal(f.launches[1].kind,'run');
});

test('adding a source preserves completed trials and only the new source needs its first trial',async t=>{
 const f=fixture(t);await f.runtime.runSource(f.id,urls[0]);await settle();await f.finish(f.launches[0]);await f.runtime.tick();
 const evidence=f.db.sources(f.id)[0].trial,newUrl='https://new.test/search';
 f.db.addSource(f.id,{url:newUrl});
 await f.runtime.saveProfile(f.id,{facts:'Updated facts'});
 assert.deepEqual(f.db.sources(f.id)[0].trial,evidence);assert.equal(f.db.sources(f.id)[2].trial,undefined);
 await f.runtime.runSource(f.id,newUrl);await settle();assert.equal(f.launches.at(-1).kind,'trial');assert.equal(f.launches.at(-1).sourceUrl,newUrl);
});

test('saving a profile during scans retains successful trial evidence and restarts scans without repeating trials',async t=>{
 const f=fixture(t,{workers:2});f.db.enable(f.id);await f.runtime.tick();await settle();
 const trials=[...f.launches];for(const run of trials)await f.finish(run);
 const evidence=f.db.sources(f.id).map(source=>source.trial),history=trials.map(run=>f.db.run(run.id));
 await f.runtime.tick();f.advance();await f.runtime.tick();await settle();
 assert.equal(f.runtime.slots(f.id).length,2);assert.ok(f.runtime.slots(f.id).every(slot=>slot.run.kind==='run'));
 const scanIds=f.runtime.slots(f.id).map(slot=>slot.run.id);
 await f.runtime.saveProfile(f.id,{criteria:{...f.db.get(f.id).criteria,budget:'2500'},instructions:'Use the updated budget.'});await settle();
 assert.deepEqual(f.db.sources(f.id).map(source=>source.trial),evidence,'Passed status, run IDs and original timestamps survive profile revisions');
 assert.deepEqual(trials.map(run=>f.db.run(run.id)),history,'Original trial runs stay unchanged');
 assert.equal(f.launches.filter(run=>run.kind==='trial').length,2);
 const scans=f.runtime.slots(f.id).map(slot=>slot.run);assert.equal(scans.length,2);
 assert.ok(scans.every(run=>run.kind==='run'&&!scanIds.includes(run.id)&&run.revision===f.db.get(f.id).revision));
 const reopened=new AutomationStore(f.store);assert.deepEqual(reopened.sources(f.id).map(source=>source.trial),evidence);
});

test('trial questions resume their source and leave another source running',async t=>{
 const f=fixture(t,{workers:2});f.db.enable(f.id);await f.runtime.tick();await settle();const [first,other]=f.launches;
 const q=f.db.askQuestion(f.id,{text:'Please log in'},{runId:first.id});assert.equal(q.sourceUrl,urls[0]);
 await f.finish(first,'blocked');await f.runtime.answer(f.id,q.id,'Logged in');await settle();
 const resumed=f.launches.at(-1);assert.equal(resumed.kind,'trial');assert.equal(resumed.sourceUrl,urls[0]);assert.equal(resumed.continuation.runId,first.id);
 assert.equal(f.db.run(other.id).status,'running');
});

test('stopping and restarting a trial preserves its source scope',async t=>{
 const f=fixture(t,{workers:2});await f.runtime.runSource(f.id,urls[1]);await settle();
 await f.runtime.restart(f.id);await settle();assert.equal(f.launches.at(-1).kind,'trial');assert.deepEqual(f.launches.at(-1).sources,[urls[1]]);
 assert.equal(f.db.get(f.id).status,'enabled');await f.runtime.stopSource(f.id,urls[1]);await f.runtime.tick();
 assert.equal(f.db.sources(f.id)[1].scanning,false);assert.notEqual(f.db.sources(f.id)[1].trial.status,'passed');assert.equal(f.db.get(f.id).status,'paused');
 await f.runtime.runSource(f.id,urls[1]);await settle();assert.equal(f.launches.at(-1).kind,'trial');
});

test('a trial requires fresh observation and its successful state survives reopening the store',async t=>{
 const f=fixture(t);await f.runtime.runSource(f.id,urls[0]);await settle();const run=f.launches[0];
 f.runtime.report(f.id,run.id,'completed','No evidence');await f.runtime.finish(f.id,'completed','No evidence',run.workerId);
 assert.equal(f.db.run(run.id).status,'failed');assert.equal(f.db.sources(f.id)[0].trial.status,'failed');
 await f.runtime.runSource(f.id,urls[0]);await settle();await f.finish(f.launches.at(-1));await f.runtime.tick();
 const reopened=new AutomationStore(f.store);assert.equal(reopened.sources(f.id)[0].trial.status,'passed');assert.equal(reopened.sources(f.id)[1].trial,undefined);
});

test('migration uses exact historical source coverage and never treats a legacy skip as evidence',t=>{
 const f=fixture(t);const run=f.db.begin(f.id,'trial');for(const url of urls)f.db.observe(f.id,run.id,url,'Actual listings');f.db.finish(f.id,run.id,'completed','Checked');
 const a=f.db.get(f.id);f.db.put({...a,sourceTrialsVersion:undefined,sourceState:{},sources:[...urls,'https://homes.test/new']});
 const migrated=new AutomationStore(f.store);assert.equal(migrated.sources(f.id)[0].trial.runId,run.id);assert.equal(migrated.sources(f.id)[1].trial.status,'passed');assert.equal(migrated.sources(f.id)[2].trial,undefined);
 migrated.put({...migrated.get(f.id),sourceTrialsVersion:undefined,sourceState:{},trial:{status:'skipped',revision:a.revision}});
 const skipped=new AutomationStore(f.store);assert.ok(skipped.sources(f.id).every(source=>!source.trial));
});

test('disabled sources wait for their own first turn and interrupted trials resume after app restart',async t=>{
 const f=fixture(t);f.db.saveSource(f.id,urls[1],{enabled:false});f.db.enable(f.id);await f.runtime.tick();await settle();
 const first=f.launches[0];await f.runtime.close();
 const launches=[],runtime=new WebTasks(f.db,{launch:async run=>{launches.push(run);return {close:async()=>{}};}});
 try{await runtime.tick();await settle();assert.equal(launches.length,1);assert.equal(launches[0].kind,'trial');assert.equal(launches[0].taskId,first.taskId);
 await runtime.saveSource(f.id,urls[1],{enabled:true});f.store.workspaces.workers.add(f.id);await runtime.tick();await settle();
 assert.equal(launches[1].kind,'trial');assert.equal(launches[1].sourceUrl,urls[1]);
 }finally{await runtime.close();}
});

test('legacy successful scans migrate only their assigned source, including after an old trial skip',t=>{
 const f=fixture(t);f.db.skipTrial(f.id);
 const task=f.store.workspaces.tasks.enqueue(f.id,{operation:'scan',sourceUrl:urls[0],sources:[urls[0]],lockKey:'source:'+urls[0]});
 const run=f.db.begin(f.id,{kind:'run',taskId:task.id});f.db.finish(f.id,run.id,'completed','Previously scanned');
 f.db.put({...f.db.get(f.id),sourceTrialsVersion:undefined,sourceState:{}});
 const migrated=new AutomationStore(f.store);assert.equal(migrated.sources(f.id)[0].trial.runId,run.id);assert.equal(migrated.sources(f.id)[1].trial,undefined);
});

test('trial evidence counts from a www redirect or a subdomain of the source, not from another site',async t=>{
 const f=fixture(t);const source='https://www.homes.test/berlin';
 f.db.save(f.id,{sources:[source]});f.db.review(f.id);await f.runtime.runSource(f.id,source);await settle();
 const other=f.launches.at(-1);f.db.spendStep(f.id,other.id);f.db.observe(f.id,other.id,'https://elsewhere.test/jobs','Listings');
 f.runtime.report(f.id,other.id,'completed','Done');await f.runtime.finish(f.id,'completed','Done',other.workerId);
 assert.equal(f.db.run(other.id).status,'failed');
 await f.runtime.runSource(f.id,source);await settle();
 const run=f.launches.at(-1);f.db.spendStep(f.id,run.id);f.db.observe(f.id,run.id,'https://homes.test/berlin','Not found page');f.db.observe(f.id,run.id,'https://jobs.homes.test/list','Actual listings');
 f.runtime.report(f.id,run.id,'completed','Board read');await f.runtime.finish(f.id,'completed','Board read',run.workerId);
 assert.equal(f.db.run(run.id).status,'completed');assert.equal(f.db.sources(f.id)[0].trial.status,'passed');
});
