import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationProgress} from '../app/automation-progress.mjs';

const urls=['https://blocked.test/search','https://fast.test/search','https://slow.test/search'];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const store=new Store(':memory:');let now=1_790_000_000_000;const db=new AutomationStore(store,{now:()=>now});
 const a=db.create('housing',{title:'Evler',goal:'Uygun evleri bul',criteria:{location:'Berlin',budget:'2000',requirements:'2 oda'},sources:urls});db.review(a.id);const trial=db.begin(a.id,'trial');for(const url of urls)db.observe(a.id,trial.id,url,'Observed listings');db.finish(a.id,trial.id,'completed','Read all sources');
 const launches=[],runtime=new WebTasks(db,{now:()=>now,launch:async run=>{launches.push(run);return {close:async()=>{}};}});t.after(async()=>{await runtime.close();store.close();});
 const finish=async(run,status='completed')=>{runtime.report(a.id,run.id,status,status==='blocked'?'IP range blocked':'Observed');await runtime.finish(a.id,status,'Observed',run.workerId);};
 return {store,db,id:a.id,runtime,launches,finish,advance:minutes=>{now+=minutes*60000;}};
}

test('one worker continues other sources after an access block and honors separate intervals',async t=>{
 const {db,id,runtime,launches,finish,advance}=fixture(t);db.saveSource(id,urls[1],{intervalMinutes:1});db.saveSource(id,urls[2],{intervalMinutes:10});db.enable(id);
 await runtime.tick();await settle();await finish(launches[0],'blocked');await runtime.tick();await settle();assert.equal(launches[1].sourceUrl,urls[1]);
 await finish(launches[1]);await runtime.tick();await settle();assert.equal(launches[2].sourceUrl,urls[2]);await finish(launches[2]);await runtime.tick();
 assert.equal(db.get(id).status,'enabled');assert.equal(db.sources(id)[0].blocked,true);assert.equal(db.sources(id)[0].nextRunAt,null);
 advance(2);await runtime.tick();await settle();assert.equal(launches.length,4);assert.equal(launches[3].sourceUrl,urls[1]);assert.equal(launches.filter(r=>r.sourceUrl===urls[0]).length,1);
 await finish(launches[3]);await runtime.tick();await runtime.close();const recovered=new WebTasks(db,{launch:async()=>{throw Error('Should not launch');}});await recovered.close();assert.equal(db.sources(id)[0].blocked,true);
});

test('parallel workers retain their own source leases and disabling one source leaves the other running',async t=>{
 const {store,db,id,runtime,launches}=fixture(t);store.workspaces.workers.add(id);db.enable(id);await runtime.tick();await settle();assert.equal(launches.length,2);
 const other=launches[1];await runtime.saveSource(id,urls[0],{enabled:false});await settle();assert.equal(db.run(other.id).status,'running');assert.equal(db.sources(id)[0].enabled,false);
 assert.equal(launches.length,3);assert.equal(launches[2].sourceUrl,urls[2]);assert.equal(db.get(id).status,'enabled');
});

test('one-off scans finish every independent source without scheduling repeats',async t=>{
 const {db,id,runtime,launches,finish,advance}=fixture(t);await runtime.runOnce(id);await settle();await finish(launches[0],'blocked');
 for(let n=1;n<3;n++){await runtime.tick();await settle();await finish(launches[n]);}await runtime.tick();assert.equal(db.get(id).status,'paused');assert.equal(launches.length,3);
 advance(100);await runtime.tick();assert.equal(launches.length,3);await runtime.runSource(id,urls[1]);await settle();assert.equal(launches.length,4);assert.equal(launches[3].sourceUrl,urls[1]);await finish(launches[3]);await runtime.tick();assert.equal(db.get(id).status,'paused');
});

test('source scope and permission reach the agent, cannot exceed profile authority, and cannot be raised mid-run',async t=>{
 const {db,id,runtime,launches}=fixture(t);db.save(id,{mode:'auto'});db.saveSource(id,urls[0],{name:'First',query:'Only two-room apartments',mode:'observe'});db.enable(id);await runtime.tick();await settle();
 const run=launches[0],flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:{},report:()=>{}}),context=await flow.call(id,run.id,'get_automation_context',{});
 assert.equal(context.assignedSource.query,'Only two-room apartments');assert.equal(context.automation.mode,'observe');assert.deepEqual(context.automation.sources,[urls[0]]);
 const record=db.record(id,run.id,{url:'https://blocked.test/home',title:'Home',summary:'Observed',proposal:'Hello'});assert.equal(record.sourceUrl,urls[0]);assert.throws(()=>db.reserve(id,run.id,record.id),/gözlem/);
 assert.throws(()=>db.saveSource(id,urls[0],{mode:'auto'}),/durdur/);await runtime.pause(id);db.save(id,{mode:'observe'});assert.throws(()=>db.saveSource(id,urls[0],{mode:'auto'}),/aşamaz/);assert.throws(()=>db.saveSource(id,'https://other.test/',{enabled:true}),/ait/);
});

test('an uncertain external action still blocks the workspace',async t=>{
 const {db,id,runtime,launches}=fixture(t);db.save(id,{mode:'auto'});db.enable(id);await runtime.tick();await settle();const run=launches[0];
 const record=db.record(id,run.id,{url:'https://blocked.test/home',title:'Home',summary:'Observed',proposal:'Hello'});db.reserve(id,run.id,record.id);runtime.report(id,run.id,'blocked','Send not verified');await runtime.finish(id);await runtime.tick();
 assert.equal(db.get(id).status,'blocked');assert.equal(db.result(id,record.id).status,'uncertain');assert.equal(launches.length,1);
});

test('source blocking is visible without claiming the whole schedule stopped or promising retries',async t=>{
 const {db,id,runtime,launches,finish}=fixture(t);db.enable(id);await runtime.tick();await settle();await finish(launches[0],'blocked');const snapshot=db.snapshot(id),p=automationProgress(snapshot);
 assert.equal(p.title,'Diğer kaynakların takibi sürüyor');assert.match(p.next,/otomatik tekrar denenmez/);assert.equal(snapshot.sources[0].lastResult,'IP range blocked');
});
