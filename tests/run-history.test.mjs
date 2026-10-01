import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';

const sources=['https://first.test/search','https://second.test/search'];
function fixture(t){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);t.after(()=>core.close());
 const workspace=db.create('custom',{goal:'Find listings',criteria:Object.fromEntries(db.template('custom').fields.filter(f=>f.required).map(f=>[f.id,'Test'])),sources});db.review(workspace.id);
 const id=workspace.id;
 const start=(sourceUrl=sources[0],recordId)=>{const task=core.workspaces.tasks.enqueue(id,{operation:recordId?'prepare':'scan',sourceUrl,sources:[sourceUrl],recordId,lockKey:recordId?'record:'+recordId:'source:'+sourceUrl});return db.begin(id,{kind:'run',taskId:task.id});};
 const save=(run,key)=>db.record(id,run.id,{url:`https://first.test/listing/${key}`,title:`Listing ${key}`,summary:'Observed listing'});
 const count=run=>db.snapshot(id).runs.find(row=>row.id===run.id).foundCount;
 return {core,db,id,start,save,count};
}

test('history counts new records live and preserves their discovery run through rescans and record work',t=>{
 const {db,id,start,save,count}=fixture(t),first=start();assert.equal(count(first),0);
 const item=save(first,'one');save(first,'one');save(first,'two');assert.equal(count(first),2);
 db.finish(id,first.id,'completed','Found two');
 const second=start();save(second,'one');save(second,'three');assert.equal(count(first),2);assert.equal(count(second),1);
 db.finish(id,second.id,'interrupted','Stopped');assert.equal(count(second),1);
 const operation=start(sources[0],item.id);save(operation,'one');
 assert.equal(count(operation),0);assert.equal(count(first),2);assert.equal(count(second),1);
 assert.equal(db.result(id,item.id).discoveredRunId,first.id);
 assert.equal(db.sources(id)[0].lastFound,1);
});

test('trial samples count only when promoted to production and sources keep separate counts',t=>{
 const {db,id,start,save,count}=fixture(t),trial=db.begin(id,'trial');save(trial,'sample');
 assert.equal(count(trial),0);db.finish(id,trial.id,'interrupted','Sample saved');
 const first=start();save(first,'sample');assert.equal(count(first),1);assert.equal(count(trial),0);
 db.finish(id,first.id,'completed','Promoted sample');
 const second=start(sources[1]);save(second,'sample');save(second,'another');
 assert.equal(count(second),1);assert.equal(count(first),1);
 db.finish(id,second.id,'completed','Other source');
 const empty=start();db.finish(id,empty.id,'completed','Nothing new');assert.equal(count(empty),0);
});

test('history includes legacy records beyond the recent-results limit and excludes other workspaces and samples',t=>{
 const {core,db,id,start,save,count}=fixture(t),first=start();
 core.workspaces.tasks.atomic(()=>{
  for(let n=0;n<503;n++)db.putResult({automationId:id,key:`https://first.test/listing/${n}`,url:`https://first.test/listing/${n}`,title:`Listing ${n}`,summary:'Legacy record',status:'found',trial:false,runId:first.id,cells:{}});
  db.putResult({automationId:id,key:'sample',url:'https://first.test/sample',title:'Sample',status:'found',trial:true,runId:first.id,cells:{}});
  const other=db.create('custom');db.putResult({automationId:other.id,key:'foreign',url:'https://first.test/foreign',title:'Foreign record',status:'found',trial:false,runId:first.id,cells:{}});
 });
 const snapshot=db.snapshot(id);assert.equal(snapshot.results.length,500);assert.equal(count(first),503);
 db.finish(id,first.id,'completed','Legacy scan');
 const next=start();save(next,'0');assert.equal(count(first),503);assert.equal(count(next),0);
});

test('sources retain the last finished source outcome outside recent history while a new scan is running',t=>{
 const {db,id,start,save}=fixture(t),first=start(),item=save(first,'one');db.finish(id,first.id,'completed','Source succeeded');
 const second=start(sources[1]);db.finish(id,second.id,'failed','Source failed');
 for(let n=0;n<32;n++)db.putRun({id:`record-work-${n}`,automationId:id,kind:'run',sourceUrl:sources[0],recordId:item.id,status:'failed',summary:'Record work failed'});
 // A legacy run covering several sources cannot be attributed to its first URL.
 db.putRun({id:'unscoped-work',automationId:id,kind:'run',sources,status:'blocked',summary:'Multiple sources'});
 const active=start();assert.equal(db.runs(id).some(run=>run.id===first.id),false);
 const [one,two]=db.sources(id);assert.equal(one.scanning,true);assert.equal(one.lastRun.id,first.id);assert.equal(one.lastRun.status,'completed');assert.equal(one.lastRun.summary,'Source succeeded');
 assert.equal(two.lastRun.id,second.id);assert.equal(two.lastRun.status,'failed');
 db.finish(id,active.id,'interrupted','Stopped latest scan');assert.equal(db.sources(id)[0].lastRun.status,'interrupted');
});
