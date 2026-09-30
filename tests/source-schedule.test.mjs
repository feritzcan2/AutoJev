import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {WorkerCampaigns} from '../app/worker-campaigns.mjs';
import {restartAgentFresh} from '../app/agent-restart.mjs';

const minute=60000;
test('bulk interval updates enabled and disabled sources only for the selected candidate',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const first=store.saveProfile({name:'First',preferences:'Remote'}),second=store.saveProfile({name:'Second',preferences:'Remote'});
 const original=store.sources(first.id),other=store.sources(second.id);
 const at=Date.parse('2026-09-28T13:25:00Z');
 for(const source of original)store.markSourceRun(first.id,source.id,{at,nextRunAt:at+source.intervalMinutes*minute,result:'Complete',found:2});
 const before=store.sources(first.id);
 assert.ok(before.some(source=>!source.enabled));
 const result=store.saveSourcesInterval(first.id,120);
 for(const source of result){
  const previous=before.find(item=>item.id===source.id);
  assert.equal(source.intervalMinutes,120);assert.equal(source.nextRunAt,at+120*minute);
  for(const key of ['enabled','applyMode','name','query','lastRunAt','lastResult','lastFound','resumeContext','scanProgress'])assert.deepEqual(source[key],previous[key]);
 }
 assert.deepEqual(store.sources(second.id),other);
 assert.deepEqual(store.sources(first.id),result);
});

test('bulk interval validates before changing any sources and rolls back failed saves',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const p=store.saveProfile({name:'Bulk validation',preferences:'Remote'}),before=store.sources(p.id);
 for(const value of [0,-1,1.5,10081,'invalid',null])assert.throws(()=>store.saveSourcesInterval(p.id,value),/1–10080/);
 assert.deepEqual(store.sources(p.id),before);
 const save=store.saveSource.bind(store);let count=0;
 store.saveSource=(...args)=>{if(++count===2)throw Error('Save failed');return save(...args);};
 assert.throws(()=>store.saveSourcesInterval(p.id,120),/Save failed/);
 assert.deepEqual(store.sources(p.id),before);
});

test('bulk interval preserves partial scan continuation and unscheduled new sources',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const p=store.saveProfile({name:'Partial scan',preferences:'Remote'}),[partial,fresh]=store.sources(p.id);
 const progress={page:2},at=Date.now(),nextRunAt=at+minute;
 store.db.prepare("UPDATE sources SET data=json_set(data,'$.lastStatus','partial','$.lastRunAt',?,'$.nextRunAt',?,'$.scanProgress',json(?)) WHERE id=?").run(at,nextRunAt,JSON.stringify(progress),partial.id);
 store.saveSourcesInterval(p.id,10080);
 assert.equal(store.source(p.id,partial.id).nextRunAt,nextRunAt);
 assert.deepEqual(store.source(p.id,partial.id).scanProgress,progress);
 assert.equal(store.source(p.id,fresh.id).nextRunAt,0);
});

function fixture(t){
 const store=new Store(':memory:');t.after(()=>store.close());
 const p=store.saveProfile({name:'Source schedule',preferences:'Berlin',authorization:'research'});
 store.setCv(p.id,'/tmp/CV.pdf');
 for(const source of store.sources(p.id))store.saveSource(p.id,{...source,enabled:source.kind==='stepstone',intervalMinutes:10000});
 const source=store.sources(p.id).find(s=>s.kind==='stepstone'),at=Date.parse('2026-09-28T13:25:00Z');
 const nextRunAt=at+10000*minute;
 store.markSourceRun(p.id,source.id,{at,nextRunAt,result:'Search complete',found:0});
 let now=at+49*minute;const sessions=new Map(),calls=[];
 const options={now:()=>now,changed:()=>{},active:(id,worker='main')=>sessions.get(worker),stop:async(id,worker='main')=>{sessions.delete(worker);},
  launch:async(id,prompt,job,worker='main')=>{calls.push(prompt);sessions.set(worker,{candidateId:id,sessionId:worker,state:'Idle'});},send:async prompt=>{calls.push(prompt);}};
 const campaigns=new Campaigns(store,options);
 return{store,p,source,at,nextRunAt,campaigns,options,calls,setTime:value=>{now=value;},current:()=>store.source(p.id,source.id)};
}

test('restart 49 minutes after a scan waits for the full 10000 minute interval',async t=>{
 const f=fixture(t);f.store.saveCampaign(f.p.id,{status:'running',target:100,intervalMinutes:30,task:null,attempts:{}});
 await restartAgentFresh({store:f.store,campaigns:f.campaigns,stop:f.options.stop},f.p.id);
 assert.equal(f.calls.length,0);assert.equal(f.current().nextRunAt,f.nextRunAt);
 assert.equal(f.store.campaign(f.p.id).nextSearchAt,f.nextRunAt);
 f.setTime(f.nextRunAt-1);await f.campaigns.tick();assert.equal(f.calls.length,0);
 f.setTime(f.nextRunAt);await f.campaigns.tick();assert.equal(f.calls.length,1);
 assert.equal(f.store.campaign(f.p.id).task.sourceId,f.source.id);
});

test('pause and resume preserve completed source schedules',async t=>{
 const f=fixture(t);await f.campaigns.start(f.p.id);await f.campaigns.pause(f.p.id);await f.campaigns.start(f.p.id);
 assert.equal(f.calls.length,0);assert.equal(f.current().nextRunAt,f.nextRunAt);
});

test('extending the interval postpones a due source from its last completed scan',async t=>{
 const f=fixture(t);
 f.store.saveSource(f.p.id,{...f.current(),intervalMinutes:5});
 f.store.saveCampaign(f.p.id,{status:'running',target:100,task:null,attempts:{}});
 await f.campaigns.saveSource(f.p.id,{...f.current(),intervalMinutes:10000});
 assert.equal(f.current().nextRunAt,f.nextRunAt);assert.equal(f.calls.length,0);
});

test('shortening the interval scans immediately only when the new interval has elapsed',async t=>{
 const f=fixture(t);await f.campaigns.start(f.p.id);
 await f.campaigns.saveSource(f.p.id,{...f.current(),intervalMinutes:60});
 assert.equal(f.current().nextRunAt,f.at+60*minute);assert.equal(f.calls.length,0);
 await f.campaigns.saveSource(f.p.id,{...f.current(),intervalMinutes:30});
 assert.equal(f.calls.length,1);assert.equal(f.store.campaign(f.p.id).task.sourceId,f.source.id);
});

test('reenabling a recently scanned source keeps its remaining wait',async t=>{
 const f=fixture(t);await f.campaigns.saveSource(f.p.id,{...f.current(),enabled:false});
 await f.campaigns.saveSource(f.p.id,{...f.current(),enabled:true});
 assert.equal(f.store.campaign(f.p.id).status,'running');assert.equal(f.current().nextRunAt,f.nextRunAt);assert.equal(f.calls.length,0);
});

test('a source settings form opened before scan completion cannot overwrite the new schedule',async t=>{
 const f=fixture(t),stale=f.current(),at=f.at+10000*minute,nextRunAt=at+10000*minute;
 f.store.markSourceRun(f.p.id,f.source.id,{at,nextRunAt,result:'Next search complete',found:0});
 f.store.saveSource(f.p.id,{...stale,applyMode:'find_only'});
 assert.equal(f.current().lastRunAt,at);assert.equal(f.current().nextRunAt,nextRunAt);
});

test('startup repairs a schedule cleared by older versions',async t=>{
 const f=fixture(t);
 f.store.db.prepare("UPDATE sources SET data=json_set(data,'$.nextRunAt',0) WHERE id=?").run(f.source.id);
 await f.campaigns.start(f.p.id);
 assert.equal(f.current().nextRunAt,f.nextRunAt);assert.equal(f.calls.length,0);
});

test('reopening the app repairs old schedules before an already running campaign ticks',async t=>{
 const f=fixture(t),dir=mkdtempSync(join(tmpdir(),'jobloop-source-schedule-')),file=join(dir,'db');
 let reopened;
 try{
  f.store.db.prepare("UPDATE sources SET data=json_set(data,'$.nextRunAt',0) WHERE id=?").run(f.source.id);
  f.store.saveCampaign(f.p.id,{status:'running',target:100,task:null,attempts:{}});
  f.store.db.prepare('VACUUM INTO ?').run(file);
  reopened=new Store(file);const campaigns=new Campaigns(reopened,f.options);
  await campaigns.tick();assert.equal(f.calls.length,0);
  assert.equal(reopened.source(f.p.id,f.source.id).nextRunAt,f.nextRunAt);
 }finally{reopened?.close();rmSync(dir,{recursive:true,force:true});}
});

test('newly enabled sources without a completed scan still run immediately',async t=>{
 const f=fixture(t),source=f.store.sources(f.p.id).find(s=>!s.enabled);
 await f.campaigns.saveSource(f.p.id,{...source,enabled:true});
 assert.equal(f.calls.length,1);assert.equal(f.store.campaign(f.p.id).task.sourceId,source.id);
 assert.equal(f.current().nextRunAt,f.nextRunAt);
});

test('starting and resuming multiple workers respects the shared source interval',async t=>{
 const f=fixture(t),pool=new WorkerCampaigns(f.store,f.options),worker=f.store.workerState.add(f.p.id);
 await pool.start(f.p.id);await pool.stopWorker(f.p.id,'main');await pool.startWorker(f.p.id,'main');
 await pool.stopWorker(f.p.id,worker.id);await pool.startWorker(f.p.id,worker.id);
 assert.equal(f.calls.length,0);assert.equal(f.current().nextRunAt,f.nextRunAt);
 f.setTime(f.nextRunAt);await pool.tick();assert.equal(f.calls.length,1);
 assert.equal(f.store.workerState.tasks(f.p.id).length,1);
});

test('an interrupted search still resumes the same task before the next scheduled scan',async t=>{
 const f=fixture(t),task={id:'unfinished',kind:'search',sourceId:f.source.id,createdAt:f.at,seenWorking:true};
 f.store.saveCampaign(f.p.id,{status:'paused',target:100,intervalMinutes:30,task,attempts:{}});
 await f.campaigns.start(f.p.id);
 assert.equal(f.calls.length,1);assert.equal(f.store.campaign(f.p.id).task.id,task.id);
 assert.match(f.calls[0],/SAME interrupted task/);assert.equal(f.current().nextRunAt,f.nextRunAt);
});
