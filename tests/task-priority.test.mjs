import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {enqueueRecordOperation} from '../app/record-operations.mjs';

const sources=['https://first.example/jobs','https://second.example/jobs'];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{concurrency=Infinity}={}){
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),launches=[];
 const runtime=new WebTasks(db,{concurrency,launch:async run=>{launches.push(run);return {close:async()=>{}};}});
 t.after(async()=>{await runtime.close();store.close();});
 const create=({trials=true}={})=>{
  const template=db.template('job-search'),a=db.create(template.id,{goal:'Find backend jobs',criteria:Object.fromEntries(template.fields.filter(f=>f.required).map(f=>[f.id,'Known criteria'])),sources});
  db.review(a.id);db.save(a.id,{mode:'observe'});
  if(trials){const trial=db.begin(a.id,'trial');for(const url of sources)db.observe(a.id,trial.id,url,'Observed jobs');db.finish(a.id,trial.id,'completed','Sources checked');}
  const seed=db.begin(a.id,'run'),items=[1,2,3].map(n=>db.record(a.id,seed.id,{url:sources[0]+'/'+n,title:'Backend '+n,summary:'Observed job'}));
  db.finish(a.id,seed.id,'completed','Saved');return {id:a.id,items};
 };
 const finish=async run=>{runtime.report(run.automationId,run.id,'blocked','Fixture finished');await runtime.finish(run.automationId,'blocked','Fixture finished',run.workerId);};
 return {store,db,runtime,launches,create,finish};
}

test('later user requests take the next worker before older queued sources and keep their own order',async t=>{
 const f=fixture(t),{id,items}=f.create();await f.runtime.runOnce(id);await settle();
 const scan=f.launches[0],olderSource=f.runtime.queue.list(id,{states:['pending']}).find(task=>task.sourceUrl===sources[1]);
 assert.ok(olderSource);
 const tasks=[];
 for(const [index,kind] of ['score','execute','prepare'].entries())tasks.push(await f.runtime.runRecord(id,items[index].id,kind,kind==='execute'?{direct:true}:{}));
 assert.ok(tasks.every(task=>task.state==='pending'));
 assert.equal(f.db.run(scan.id).status,'running');
 await f.finish(scan);
 for(const task of tasks){
  await f.runtime.tick();await settle();const run=f.launches.at(-1);
  assert.equal(run.taskId,task.id);assert.equal(f.runtime.queue.get(id,olderSource.id).state,'pending');
  await f.finish(run);
 }
 await f.runtime.tick();await settle();assert.equal(f.launches.at(-1).taskId,olderSource.id);
});

for(const kind of ['score','prepare','execute','verify'])test(`a running source trial leaves the next free worker for user ${kind}`,async t=>{
 const f=fixture(t),{id,items}=f.create({trials:false});
 await f.runtime.runOnce(id);await settle();const trial=f.launches[0];assert.equal(trial.kind,'trial');
 if(kind==='verify')f.db.putResult({...items[0],status:'uncertain'});
 const task=await f.runtime.runRecord(id,items[0].id,kind,kind==='execute'?{direct:true}:{});
 assert.equal(task.state,'pending');
 const worker=f.runtime.workers.add(id);await f.runtime.tick();await settle();
 assert.equal(f.launches.at(-1).taskId,task.id);assert.equal(f.launches.at(-1).workerId,worker.id);
 assert.equal(f.db.run(trial.id).status,'running');
 assert.equal(f.runtime.queue.list(id,{states:['pending']}).filter(task=>!task.recordId).length,1);
});

for(const background of ['source','record'])test(`user work wins shared capacity over an earlier workspace's ${background} tasks`,async t=>{
 const f=fixture(t,{concurrency:1}),user=f.create(),other=f.create();
 assert.equal(f.db.list()[0].id,other.id);
 if(background==='record')f.db.save(other.id,{mode:'prepare'});
 await f.runtime.runOnce(other.id);await settle();const scan=f.launches[0];
 if(background==='record')enqueueRecordOperation(f.runtime,other.id,other.items[0].id,'prepare',{manual:false});
 const task=await f.runtime.runRecord(user.id,user.items[0].id,'score');assert.equal(task.state,'pending');
 await f.finish(scan);await f.runtime.tick();await settle();
 assert.equal(f.launches.at(-1).taskId,task.id);assert.equal(f.runtime.capacityUsed,1);
 await f.finish(f.launches.at(-1));await f.runtime.tick();await settle();
 assert.equal(f.launches.at(-1).automationId,other.id);
 assert.equal(Boolean(f.launches.at(-1).recordId),background==='record');
});

test('promoting an automatic request keeps its task and puts it before older background work',async t=>{
 const f=fixture(t),{id,items}=f.create();f.db.save(id,{mode:'prepare'});
 // Keep the worker occupied while requests are created in a known order.
 const source=f.runtime.queue.enqueue(id,{operation:'scan',sourceUrl:sources[0],sources:[sources[0]],lockKey:'source:'+sources[0]});
 const scan=await f.runtime.start(id,{kind:'run',taskId:source.id});
 const automatic=enqueueRecordOperation(f.runtime,id,items[0].id,'prepare',{manual:false});
 const requested=enqueueRecordOperation(f.runtime,id,items[1].id,'prepare',{manual:false});
 const promoted=await f.runtime.runRecord(id,items[1].id,'prepare');assert.equal(promoted.id,requested.id);assert.equal(promoted.request.manual,true);
 await f.finish(scan);await f.runtime.tick();await settle();
 assert.equal(f.launches.at(-1).taskId,requested.id);assert.equal(f.runtime.queue.get(id,automatic.id).state,'pending');
});

test('a user request waiting for an answer does not prevent an eligible source from running',async t=>{
 const f=fixture(t),{id,items}=f.create();await f.runtime.runOnce(id);await settle();const scan=f.launches[0];
 const task=await f.runtime.runRecord(id,items[0].id,'score');f.db.askQuestion(id,{recordId:items[0].id,text:'Which experience should be scored?'});
 await f.finish(scan);await f.runtime.tick();await settle();
 assert.equal(f.runtime.queue.get(id,task.id).state,'pending');assert.equal(f.launches.at(-1).sourceUrl,sources[1]);assert.equal(f.launches.at(-1).recordId,null);
});
