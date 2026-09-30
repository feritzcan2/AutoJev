import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),definition=db.template('job-search');
 const a=db.create('job-search',{goal:'Find jobs',criteria:Object.fromEntries(definition.fields.filter(f=>f.required).map(f=>[f.id,'Known'])),sources:['https://example.test/jobs']});db.review(a.id);db.skipTrial(a.id);
 const seed=db.begin(a.id,'run'),item=db.record(a.id,seed.id,{key:'job',url:'https://example.test/job',title:'Job',summary:'Observed'});db.finish(a.id,seed.id,'completed','Saved');
 const launches=[],runtimes=[];let ready=true;
 const create=()=>{const runtime=new WebTasks(db,{browserReady:()=>ready,launch:async run=>{launches.push(run);return {close:async()=>{}};}});runtimes.push(runtime);return runtime;};
 const runtime=create();t.after(async()=>{for(const runtime of runtimes)await runtime.close();store.close();});
 return {db,id:a.id,item,runtime,create,launches,setReady:value=>{ready=value;}};
}
test('shutdown preparation waits for Chrome then resumes exactly once with original authorization',async t=>{
 const f=await fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();await f.runtime.close();f.setReady(false);
 const next=f.create(),pending=next.queue.list(f.id,{states:['pending']});assert.equal(pending.length,1);assert.equal(pending[0].request.manual,true);
 await next.tick();assert.equal(f.launches.length,1);assert.equal(next.queue.get(f.id,pending[0].id).state,'pending');
 f.setReady(true);await next.tick();await settle();assert.equal(f.launches.length,2);assert.equal(f.launches[1].recordId,f.item.id);assert.equal(f.launches[1].recordOperation,'prepare');await next.tick();assert.equal(f.launches.length,2);
});
test('user-stopped tasks stay stopped after restart',async t=>{
 const f=await fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();await f.runtime.stopWorker(f.id,'main');await f.runtime.close();
 const next=f.create();await next.tick();assert.equal(next.queue.list(f.id,{states:['pending']}).length,0);assert.equal(f.launches.length,1);
});
test('a shutdown after reserving submission recovers verification, never submission',async t=>{
 const f=await fixture(t);await f.runtime.runRecord(f.id,f.item.id,'execute',{direct:true});await settle();const run=f.launches[0];
 f.db.record(f.id,run.id,{key:f.item.key,url:f.item.url,title:'Job',summary:'Observed',proposal:'Approved details'});f.db.reserve(f.id,run.id,f.item.id);await f.runtime.close();assert.equal(f.db.result(f.id,f.item.id).status,'uncertain');
 const next=f.create();await next.tick();await settle();assert.equal(f.launches.at(-1).recordOperation,'verify');assert.throws(()=>f.db.reserve(f.id,f.launches.at(-1).id,f.item.id));
});
test('unanswered questions keep recovered preparation pending',async t=>{
 const f=await fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();f.db.askQuestion(f.id,{recordId:f.item.id,text:'Missing fact?'});await f.runtime.close();
 const next=f.create();await next.tick();assert.equal(next.queue.list(f.id,{states:['pending']}).length,1);assert.equal(f.launches.length,1);
});
