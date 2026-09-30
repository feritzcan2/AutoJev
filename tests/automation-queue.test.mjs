import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';

const sources=['https://a.example/list','https://b.example/list'];
const settle=()=>new Promise(r=>setImmediate(r));
function fixture(t,{mode='prepare',workers=1,templateId='job-search'}={}){
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),template=db.template(templateId);
 const a=db.create(template.id,{goal:'Find backend jobs',criteria:Object.fromEntries(template.fields.filter(f=>f.required).map(f=>[f.id,'Known criteria'])),sources});
 db.review(a.id);const trial=db.begin(a.id,'trial');for(const url of a.sources)db.observe(a.id,trial.id,url,'Observed source');db.finish(a.id,trial.id,'completed','Source checked');db.save(a.id,{mode});
 for(let i=1;i<workers;i++)store.workspaces.workers.add(a.id);
 const launches=[],closed=[];
 const options={launch:async run=>{launches.push(run);return {close:async()=>{closed.push(run.id);}};}};
 const runtime=new WebTasks(db,options);
 t.after(async()=>{await runtime.close();store.close();});
 const finish=async(run,status='completed')=>{runtime.report(a.id,run.id,status,'Observed outcome');await runtime.finish(a.id,status,'Observed outcome',run.workerId);};
 const flow=run=>automationWorkflow({db,run,signal:{aborted:false},browser:{},report:(...args)=>runtime.report(...args)});
 const record=(run,url,proposal)=>db.record(a.id,run.id,{url,title:'Backend',summary:'Verified facts',...(proposal?{proposal}:{})});
 return {store,db,id:a.id,runtime,launches,closed,finish,flow,record,options};
}

test('workspace restart keeps source permissions, disabled sources and the one-off scope',async t=>{
 const f=fixture(t,{mode:'auto',workers:2});
 f.db.saveSource(f.id,sources[0],{mode:'observe'});f.db.saveSource(f.id,sources[1],{enabled:false});
 for(const worker of f.runtime.workers.list(f.id))f.store.workspaces.history(f.id,worker.id).saveConversation(f.id,'codex','old-'+worker.id,{});
 await f.runtime.runOnce(f.id);await settle();const first=f.launches[0];
 f.db.putRun({...f.db.run(first.id),conversation:{provider:'codex',nativeId:'source-thread'}});
 f.db.observe(f.id,first.id,sources[0]+'?page=8','Page 8');f.db.reportPage(f.id,first.id,{url:sources[0]+'?page=8',currentPage:8,evidence:'Page 8',at:Date.now()});
 await f.runtime.restart(f.id);await settle();
 const run=f.launches.at(-1),flow=f.flow(run);let context=await flow.call(f.id,run.id,'get_automation_context',{});
 assert.equal(f.db.run(first.id).conversation,null);assert.equal(run.continuation,undefined);
 if(context.context){
  let page=context,text=page.text;
  while(page.context.nextOffset!==null){page=await flow.call(f.id,run.id,'read_automation_context_part',{contextId:page.context.id,offset:page.context.nextOffset});text+=page.text;}
  context=JSON.parse(text);
 }
 assert.equal(f.db.get(f.id).status,'enabled');assert.equal(f.db.get(f.id).once,true);assert.deepEqual(f.db.get(f.id).onceSources,[sources[0]]);
 assert.deepEqual(run.sources,[sources[0]]);assert.equal(run.sourceUrl,sources[0]);assert.equal(run.operation,'scan');assert.equal(run.pageProgress.currentPage,8);
 assert.equal(context.automation.mode,'observe');assert.equal(context.assignedOperation.effect,'read');
 const item=f.record(run,sources[0]+'/job');assert.throws(()=>f.record(run,item.url,'Submit application'),/yalnızca gözlem/);assert.throws(()=>f.db.reserve(f.id,run.id,item.id),/gönderim yapamaz/);
 assert.deepEqual(f.closed,[first.id]);assert.equal(f.runtime.slots(f.id).length,1);
 for(const worker of f.runtime.workers.list(f.id))assert.equal(f.store.workspaces.history(f.id,worker.id).conversation(f.id,'codex'),null);
 await f.finish(run);await f.runtime.tick();assert.equal(f.db.get(f.id).status,'paused');
});

test('restart preserves multiple workers and waits for every old provider to close',async t=>{
 const f=fixture(t,{mode:'observe',workers:2});f.db.enable(f.id);await f.runtime.tick();await settle();
 const previous=f.launches.slice();let release;
 f.runtime.slots(f.id)[0].worker.close=()=>new Promise(r=>{release=r;});
 const restarting=f.runtime.restart(f.id);await settle();await f.runtime.tick();assert.equal(f.launches.length,2);
 release();await restarting;await settle();
 assert.equal(f.launches.length,4);assert.equal(new Set(f.launches.slice(2).map(r=>r.sourceUrl)).size,2);assert.equal(f.db.get(f.id).status,'enabled');
 for(const run of previous)assert.equal(f.db.run(run.id).status,'interrupted');
});

test('restart close failure preserves history and cannot create replacement tasks',async t=>{
 const f=fixture(t,{mode:'observe'});await f.runtime.runSource(f.id,sources[0]);await settle();
 const history=f.store.workspaces.history(f.id);history.saveConversation(f.id,'codex','keep',{});
 const worker=f.runtime.slots(f.id)[0].worker,close=worker.close;worker.close=async()=>{throw Error('Still alive');};
 await assert.rejects(f.runtime.restart(f.id),/Still alive/);assert.equal(history.conversation(f.id,'codex'),'keep');assert.equal(f.launches.length,1);
 worker.close=close;
});

test('restart preserves an active interview instead of launching an unscoped production run',async t=>{
 const f=fixture(t);await f.runtime.setup(f.id);const first=f.launches[0];
 await f.runtime.restart(f.id);assert.equal(f.launches.at(-1).kind,'interview');assert.notEqual(f.launches.at(-1).id,first.id);
});

test('cancelled and interrupted automatic preparations resume after stop/start',async t=>{
 const f=fixture(t),seed=f.db.begin(f.id,'run');
 const items=Array.from({length:3},(_,i)=>f.record(seed,sources[0]+'/'+i));f.db.finish(f.id,seed.id,'completed','Seeded');
 f.db.enable(f.id);await f.runtime.tick();await settle();
 assert.equal(f.runtime.queue.list(f.id,{states:['pending']}).filter(t=>t.recordOperation==='prepare').length,2);
 await f.runtime.pause(f.id);
 assert.deepEqual(f.runtime.queue.list(f.id).filter(t=>t.recordOperation).map(t=>t.state),['interrupted','cancelled','cancelled']);
 const before=f.launches.length;await f.runtime.runOnce(f.id);await settle();
 for(let i=0;i<items.length;i++){
  const run=f.launches.at(-1);assert.equal(run.recordOperation,'prepare');
  f.record(run,f.db.result(f.id,run.recordId).url,'Verified proposal');await f.finish(run);await f.runtime.tick();await settle();
 }
 assert.deepEqual(new Set(f.launches.slice(before).filter(r=>r.recordOperation==='prepare').map(r=>r.recordId)),new Set(items.map(i=>i.id)));
});

test('closing the app does not permanently suppress an unfinished automatic preparation',async t=>{
 const f=fixture(t),seed=f.db.begin(f.id,'run'),item=f.record(seed,sources[0]+'/job');f.db.finish(f.id,seed.id,'completed','Seeded');
 f.db.enable(f.id);await f.runtime.tick();await settle();await f.runtime.close();
 const resumed=new WebTasks(f.db,f.options);
 try{await resumed.tick();await settle();assert.equal(f.launches.length,2);assert.equal(f.launches.at(-1).recordId,item.id);}finally{await resumed.close();}
});

for(const outcome of ['failed','blocked'])test(`unchanged ${outcome} preparation is not automatically retried`,async t=>{
 const f=fixture(t),seed=f.db.begin(f.id,'run');f.record(seed,sources[0]+'/job');f.db.finish(f.id,seed.id,'completed','Seeded');
 f.db.enable(f.id);await f.runtime.tick();await settle();await f.finish(f.launches[0],outcome);
 await f.runtime.pause(f.id);await f.runtime.runOnce(f.id);await settle();
 assert.equal(f.launches.filter(r=>r.recordOperation==='prepare').length,1);
});

test('restart after a reserved submission preserves uncertainty and never resubmits',async t=>{
 const f=fixture(t,{mode:'auto'}),seed=f.db.begin(f.id,'run'),item=f.record(seed,sources[0]+'/job');f.db.finish(f.id,seed.id,'completed','Seeded');
 await f.runtime.runRecord(f.id,item.id,'execute',{direct:true});await settle();const run=f.launches[0];
 f.record(run,item.url,'Verified submission');f.db.reserve(f.id,run.id,item.id);
 await f.runtime.restart(f.id);await f.runtime.tick();
 assert.equal(f.db.result(f.id,item.id).status,'uncertain');assert.equal(f.db.get(f.id).status,'enabled');assert.ok(f.launches.length>1);assert.ok(f.launches.slice(1).every(r=>!r.recordId));await assert.rejects(f.runtime.runRecord(f.id,item.id,'execute',{direct:true}),/yeniden gönderilemez/);
});

for(const answerBeforeFinish of [false,true])test(`a source answer resumes only its source and preserves unrelated record work (early: ${answerBeforeFinish})`,async t=>{
 const f=fixture(t,{workers:2,mode:'auto'});await f.runtime.runOnce(f.id);await settle();
 const a=f.launches.find(r=>r.sourceUrl===sources[0]),b=f.launches.find(r=>r.sourceUrl===sources[1]);
 const item=f.record(b,sources[1]+'/job'),pending=await f.runtime.runRecord(f.id,item.id,'execute',{direct:true});assert.equal(pending.state,'pending');
 const question=await f.flow(a).call(f.id,a.id,'ask_workspace_question',{text:'A kaynağının zorunlu kategorisi?'});assert.equal(question.sourceUrl,sources[0]);
 await f.finish(b);await f.runtime.tick();await settle();
 const other=f.launches.at(-1);assert.equal(other.recordId,item.id);assert.equal(f.runtime.queue.get(f.id,pending.id).state,'running');
 f.record(other,item.url,'Verified proposal');assert.equal(f.db.reserve(f.id,other.id,item.id).reserved,true);
 if(!answerBeforeFinish)await f.finish(a,'blocked');
 await f.runtime.answer(f.id,question.id,'Backend');
 if(answerBeforeFinish){assert.equal(f.db.run(a.id).status,'running');await f.finish(a,'blocked');await f.runtime.tick();}
 await settle();const resumed=f.launches.at(-1);
 assert.equal(resumed.sourceUrl,sources[0]);assert.equal(resumed.recordId,null);assert.notEqual(resumed.id,a.id);
 assert.equal(f.db.run(other.id).status,'running');assert.equal(f.db.get(f.id).status,'enabled');assert.equal(f.launches.some(r=>r.kind==='interview'),false);
});

test('source questions preserve pending work until answered and keep a one-off scan resumable',async t=>{
 const f=fixture(t);await f.runtime.runSource(f.id,sources[0]);await settle();const scan=f.launches[0],item=f.record(scan,sources[0]+'/job');
 const pending=await f.runtime.runRecord(f.id,item.id,'prepare');
 const question=await f.flow(scan).call(f.id,scan.id,'ask_workspace_question',{text:'A kaynağındaki filtre?'});
 await f.finish(scan,'blocked');await f.runtime.tick();await settle();
 assert.equal(f.runtime.queue.get(f.id,pending.id).state,'pending');assert.equal(f.launches.length,1);assert.equal(f.db.get(f.id).status,'enabled');
 await f.runtime.answer(f.id,question.id,'Backend');await settle();
 assert.equal(f.runtime.queue.get(f.id,pending.id).state,'running');assert.equal(f.launches.at(-1).recordId,item.id);
});

test('equal questions from different sources keep separate identities and legacy scope survives reads',async t=>{
 const f=fixture(t,{workers:2});await f.runtime.runOnce(f.id);await settle();const [a,b]=f.launches;
 const ask=run=>f.flow(run).call(f.id,run.id,'ask_workspace_question',{text:'Hangi kategori?'});
 const first=await ask(a),second=await ask(b);assert.notEqual(first.id,second.id);assert.equal((await ask(a)).id,first.id);
 const raw=JSON.parse(f.db.db.prepare('SELECT data FROM automations WHERE id=?').get(f.id).data);for(const question of raw.questions)delete question.sourceUrl;
 f.db.db.prepare('UPDATE automations SET data=? WHERE id=?').run(JSON.stringify(raw),f.id);
 assert.deepEqual(f.db.get(f.id).questions.map(q=>q.sourceUrl),[a.sourceUrl,b.sourceUrl]);
 const global=f.db.askQuestion(f.id,{text:'General authorization?'});assert.equal(global.sourceUrl,null);
 const item=f.record(b,sources[1]+'/job');await assert.rejects(f.runtime.runRecord(f.id,item.id,'prepare'),/soruları yanıtla/);
});

test('a pending question defers execution but changed approval still cancels it after the answer',async t=>{
 const f=fixture(t,{mode:'observe'}),seed=f.db.begin(f.id,'run'),item=f.record(seed,sources[0]+'/job','Reviewed proposal');f.db.finish(f.id,seed.id,'completed','Seeded');
 await f.runtime.runSource(f.id,sources[0]);await settle();const scan=f.launches.at(-1);
 const task=await f.runtime.runRecord(f.id,item.id,'execute',{digest:item.digest});
 const question=f.db.askQuestion(f.id,{recordId:item.id,text:'Required date?'});
 await f.finish(scan);await f.runtime.tick();assert.equal(f.runtime.queue.get(f.id,task.id).state,'pending');
 f.db.putResult({...item,proposal:'Different proposal',digest:'changed'});f.db.answerQuestion(f.id,question.id,'Tomorrow');
 await f.runtime.tick();assert.equal(f.runtime.queue.get(f.id,task.id).state,'cancelled');assert.equal(f.launches.filter(r=>r.recordOperation==='execute').length,0);
});

test('answering a source question after an explicit stop does not restart its scan',async t=>{
 const f=fixture(t);await f.runtime.runSource(f.id,sources[0]);await settle();const scan=f.launches[0];
 const question=await f.flow(scan).call(f.id,scan.id,'ask_workspace_question',{text:'Required category?'});
 await f.runtime.stopSource(f.id,sources[0]);await f.runtime.answer(f.id,question.id,'Backend');await f.runtime.tick();
 assert.equal(f.launches.length,1);assert.equal(f.runtime.queue.get(f.id,scan.taskId).state,'cancelled');
});

for(const templateId of ['job-search','housing'])for(const shutdown of [false,true])test(`${templateId}: uncertain record leaves source scanning enabled (shutdown: ${shutdown})`,async t=>{
 const f=fixture(t,{mode:'observe',workers:2,templateId});
 const seed=f.db.begin(f.id,'run'),item=f.record(seed,sources[1]+'/application','Verified submission');f.db.finish(f.id,seed.id,'completed','Saved');
 f.db.saveSource(f.id,sources[1],{enabled:false});f.db.enable(f.id);
 await f.runtime.runRecord(f.id,item.id,'execute',{direct:true});await settle();
 const execution=f.launches.find(r=>r.recordId===item.id),scan=f.launches.find(r=>r.sourceUrl===sources[0]&&!r.recordId);
 assert.ok(execution);assert.ok(scan);f.db.reserve(f.id,execution.id,item.id);
 const page=sources[0]+'?page=6';f.db.observe(f.id,scan.id,page,'Page 6');f.db.reportPage(f.id,scan.id,{url:page,currentPage:6,evidence:'Page 6',at:Date.now()});
 f.db.putRun({...f.db.run(scan.id),conversation:{provider:'codex',nativeId:'keep-source-thread'}});
 let resumed;
 try{
  if(shutdown){
   await f.runtime.close();resumed=new WebTasks(f.db,f.options);await resumed.tick();await settle();
   const next=f.launches.filter(r=>r.sourceUrl===sources[0]&&!r.recordId).at(-1);
   assert.notEqual(next.id,scan.id);assert.equal(next.pageProgress.currentPage,6);assert.equal(next.continuation.runId,scan.id);
   const verification=f.launches.find(r=>r.recordId===item.id&&r.id!==execution.id);assert.equal(verification.recordOperation,'verify');
  }else{
   await f.finish(execution,'blocked');await f.runtime.tick();await settle();
   assert.equal(f.db.run(scan.id).status,'running');assert.equal(f.db.run(scan.id).pageProgress.currentPage,6);
  }
  assert.equal(f.db.get(f.id).status,'enabled');assert.equal(f.db.result(f.id,item.id).status,'uncertain');
  assert.equal(f.launches.filter(r=>r.recordId===item.id&&r.recordOperation==='execute').length,1);
  assert.equal(f.db.sources(f.id).find(s=>s.url===sources[1]).enabled,false);
  await assert.rejects((resumed??f.runtime).runRecord(f.id,item.id,'execute',{direct:true}),/yeniden gönderilemez/);
 }finally{await resumed?.close();}
});
