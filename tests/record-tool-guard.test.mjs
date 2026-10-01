import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {startToolServer} from '../app/tool-server.mjs';
import {automationAttention} from '../app/automation-attention.mjs';
import {recordOperationStatus} from '../src/record-operation-status.js';

const source='https://example.test/jobs',url=source+'/developer';
const assessment={status:'scored',score:82,summary:'Skills match the role.',evidenceUrl:url,evidence:'JavaScript developer, remote.',strengths:['JavaScript'],gaps:[],uncertainties:[]};
async function fixture(t){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);
 const a=db.create('job-search',{goal:'Find jobs',criteria:{preferences:'Remote JavaScript',ranking:'Skills 100%.'},sources:[source]});db.review(a.id);
 const seed=db.begin(a.id,'run'),item=db.record(a.id,seed.id,{url,title:'Developer',summary:'Saved listing',proposal:'Reviewed proposal'});db.finish(a.id,seed.id,'completed','Saved');db.approve(a.id,item.id);
 const entries=new Map(),reports=[];
 const server=await startToolServer({assertOwner:id=>db.get(id),resolve:grant=>entries.get(grant.sessionId).flow});
 let runtime;
 const rebuild=entry=>{
  const flow=automationWorkflow({db,run:entry.run,signal:entry.signal,browser:{call:async()=>{if(entry.page)return {content:[{type:'text',text:`Page URL: ${url}\n${entry.page}`}]};throw Error('Browser unavailable');}},report:(...args)=>{reports.push(args);return runtime.report(...args);}});
  const call=flow.call;flow.call=(...args)=>{entry.calls.push(args[2]);return call(...args);};entry.flow=flow;
 };
 const runtimeOptions={launch:async(run,_a,_onEvent,signal)=>{
  let closed;const entry={run,signal,calls:[],closed:new Promise(resolve=>{closed=resolve;})};rebuild(entry);entries.set(run.id,entry);
  entry.token=server.grant(a.id,run.id,run.workerId,entry.flow);
  return {close:async()=>{entry.didClose=true;server.revoke(entry.token);closed();}};
 }};
 runtime=new WebTasks(db,runtimeOptions);
 t.after(async()=>{await runtime.close();await server.close();core.close();});
 const start=async(record=item,kind='score',input={})=>{
  const task=await runtime.runRecord(a.id,record.id,kind,input);
  await new Promise(resolve=>setImmediate(resolve));
  return [...entries.values()].find(e=>e.run.taskId===task.id);
 };
 let rpcId=0;
 const call=async(entry,name,args={})=>{
  const response=await fetch(server.endpoint,{method:'POST',headers:{Authorization:'Bearer '+entry.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})});
  const body=await response.json();return {...body,httpStatus:response.status};
 };
 const score=(entry,patch={})=>call(entry,'record_automation_score',{itemId:entry.run.recordId,...assessment,...patch});
 const failures=entry=>Object.values(db.store.workspaces.tasks.get(a.id,entry.run.taskId).toolFailures??{});
 const restart=async()=>{await runtime.close();runtime=new WebTasks(db,runtimeOptions);return runtime;};
 return {core,db,id:a.id,item:db.result(a.id,item.id),runtime,entries,reports,rebuild,restart,start,call,score,failures};
}
const errorText=response=>response.result?.content?.map(c=>c.text).join('\n')??response.error;

test('the third repeated save error stops only its worker and persists a visible reason',async t=>{
 const f=await fixture(t),entry=await f.start();
 f.runtime.workers.add(f.id,{name:'Other worker'});
 const second=f.db.putResult({...f.item,id:'other-record',key:source+'/other',url:source+'/other',title:'Other developer'}),other=await f.start(second);
 for(let i=1;i<=2;i++){
  const response=await f.score(entry,{summary:'Updated explanation '+i});assert.equal(response.result.isError,true);assert.match(errorText(response),new RegExp(`${i}/3`));
  assert.equal((await f.call(entry,'get_automation_context')).result.isError,undefined);
 }
 const response=await f.score(entry,{evidenceUrl:'https://www.linkedin.com/jobs/view/4473093841'});
 assert.match(errorText(response),/Puanlama durduruldu.*3 kez/);
 assert.equal(f.db.run(entry.run.id).status,'blocked');assert.equal(f.reports.length,1);
 assert.equal(f.failures(entry)[0].count,3);
 assert.deepEqual(f.db.result(f.id,f.item.id),f.item,'An error must not replace an existing draft or approval');
 await entry.closed;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(entry.didClose,true);assert.equal(other.didClose,undefined);assert.equal(f.db.run(other.run.id).status,'running');
 await f.runtime.tick();assert.equal(f.entries.size,2,'No automatic retry of the blocked task');
 const snapshot=f.db.snapshot(f.id),row=snapshot.results.find(r=>r.id===f.item.id);
 assert.equal(recordOperationStatus(row).label,'İşlem engellendi');assert.match(row.recordAction.lastTask.summary,/gözlemle/);
 const issues=automationAttention({...snapshot,runs:[],activeRuns:[other.run]});
 assert.equal(issues.length,1);assert.equal(issues[0].kind,'repeated_tool_error');assert.equal(issues[0].recordId,f.item.id);assert.match(issues[0].message,/3 kez/);
 assert.equal(f.db.messages(f.id).filter(m=>m.recordId===f.item.id&&m.role==='system').length,1);
});

test('schema validation failures are counted before the tool body executes',async t=>{
 const f=await fixture(t),entry=await f.start();
 for(let i=0;i<3;i++)assert.equal((await f.score(entry,{score:'82'})).result.isError,true);
 assert.equal(entry.calls.filter(name=>name==='record_automation_score').length,0);
 assert.equal(f.db.run(entry.run.id).status,'blocked');assert.match(f.db.run(entry.run.id).toolFailure.message,/arguments.score/);
});

test('parallel requests cannot execute a fourth attempt',async t=>{
 const f=await fixture(t),entry=await f.start();
 const responses=await Promise.all(Array.from({length:6},()=>f.score(entry)));
 assert.equal(entry.calls.filter(name=>name==='record_automation_score').length,3);
 assert.equal(f.failures(entry)[0].count,3);assert.equal(f.reports.length,1);
 assert.ok(responses.every(r=>r.result?.isError||r.httpStatus===401));
});

test('only success of the failing operation clears its counters',async t=>{
 const f=await fixture(t),entry=await f.start();
 await f.score(entry);await f.score(entry);f.db.observe(f.id,entry.run.id,url,'Full detail');
 assert.equal((await f.score(entry)).result.isError,undefined);assert.deepEqual(f.failures(entry),[]);
 const response=await f.score(entry,{evidenceUrl:url+'/unobserved'});
 assert.match(errorText(response),/1\/3/);assert.equal(f.db.run(entry.run.id).status,'running');
});

test('distinct errors stay separate and rebuilding the workflow preserves counters',async t=>{
 const f=await fixture(t),entry=await f.start();
 await f.score(entry);await f.score(entry,{score:'82'});await f.score(entry,{score:'82'});
 f.rebuild(entry);
 assert.match(errorText(await f.score(entry)),/2\/3/);assert.equal(f.db.run(entry.run.id).status,'running');
 assert.match(errorText(await f.score(entry)),/3 kez/);assert.equal(f.db.run(entry.run.id).status,'blocked');
});

test('a manual retry starts a new task and clears the old warning',async t=>{
 const f=await fixture(t),entry=await f.start();
 for(let i=0;i<3;i++)await f.score(entry);
 await entry.closed;await new Promise(resolve=>setImmediate(resolve));
 const next=await f.start();assert.notEqual(next.run.taskId,entry.run.taskId);assert.deepEqual(f.failures(next),[]);
 assert.deepEqual(automationAttention(f.db.snapshot(f.id)),[]);
 f.db.observe(f.id,next.run.id,url,'Full detail');assert.equal((await f.score(next)).result.isError,undefined);
 assert.equal((await f.call(next,'finish_automation_run',{status:'completed',summary:'Scored'})).result.isError,undefined);
});

test('application restart resumes the same task with its existing failure count',async t=>{
 const f=await fixture(t),entry=await f.start();await f.score(entry);await f.score(entry);
 const runtime=await f.restart();await runtime.tick();await new Promise(resolve=>setImmediate(resolve));
 const next=[...f.entries.values()].at(-1);assert.notEqual(next.run.id,entry.run.id);assert.equal(next.run.taskId,entry.run.taskId);
 assert.match(errorText(await f.score(next)),/3 kez/);assert.equal(f.db.run(next.run.id).status,'blocked');
});

test('browser failures on different pages are distinct while same-listing URL aliases share a limit',async t=>{
 const f=await fixture(t),entry=await f.start();
 for(let i=0;i<2;i++)await f.call(entry,'browser_open',{url:'https://www.linkedin.com/jobs/view/4473093841'});
 assert.match(errorText(await f.call(entry,'browser_open',{url:'https://www.linkedin.com/jobs/view/4473093842'})),/1\/3/);
 const response=await f.call(entry,'browser_open',{url:'https://de.linkedin.com/jobs/view/job-title-4473093841/'});
 assert.match(errorText(response),/3 kez/);assert.equal(f.db.run(entry.run.id).status,'blocked');
});

test('an interrupted submission remains uncertain and offers verification after the error limit',async t=>{
 const f=await fixture(t),entry=await f.start(f.item,'execute',{direct:true});
 f.db.observe(f.id,entry.run.id,url,'Full listing');
 assert.equal((await f.call(entry,'reserve_automation_action',{itemId:f.item.id})).result.isError,undefined);
 for(let i=0;i<3;i++)await f.call(entry,'record_automation_outcome',{itemId:f.item.id,status:'completed',url:url+'/confirmation',evidence:'Unobserved confirmation'});
 await entry.closed;await new Promise(resolve=>setImmediate(resolve));
 const row=f.db.snapshot(f.id).results.find(r=>r.id===f.item.id);
 assert.equal(row.status,'uncertain');assert.equal(row.recordAction.retryOperation.kind,'verify');
 assert.equal(f.db.run(entry.run.id).status,'blocked');
});

test('rejected proof responses also stop after three attempts while preserving uncertainty',async t=>{
 const f=await fixture(t),item=f.db.putResult({...f.item,status:'uncertain'}),entry=await f.start(item,'verify');
 const quote=`${url} — Draft`;entry.page=quote;
 const data=response=>JSON.parse(response.result.content[0].text);
 let observed=data(await f.call(entry,'browser_read'));entry.page=`${url} — Submitted`;
 for(let i=0;i<3;i++){
  observed=data(await f.call(entry,'record_automation_outcome',{itemId:item.id,status:'not_submitted',url,evidence:quote,notSubmittedProof:{snapshotId:observed.snapshot.id,kind:'draft',quote,recordEvidence:url}}));
  assert.equal(observed.status,'evidence_rejected');assert.equal(observed.saved,false);
 }
 assert.match(observed.message,/Doğrulama durduruldu.*3 kez/);assert.equal(f.db.run(entry.run.id).status,'blocked');assert.equal(f.db.result(f.id,item.id).status,'uncertain');
});
