import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {AgentSessions} from '../app/agent-sessions.mjs';
import {launchAutomationWorker} from '../app/automation-worker.mjs';
import {workerKey} from '../app/worker-key.mjs';
import {SCAN_OVERLAP_MS} from '../app/source-scan.mjs';

const sources=['https://a.example/list','https://b.example/list'];
async function fixture(t,provider='codex'){
 const data=await mkdtemp(path.join(tmpdir(),'loop-source-conversations-')),file=path.join(data,'state.sqlite');
 let store=new WorkspaceDatabase(file),db=new AutomationStore(store),rejectResume=false;
 const settings={provider,model:'default',reasoning:'default',permission:'default',network:null,contextRestartPercent:70};
 const a=db.create('custom',{goal:'Find matching listings',criteria:Object.fromEntries(db.template('custom').fields.filter(f=>f.required).map(f=>[f.id,'Known'])),sources,agentSettings:settings});
 db.review(a.id);db.enable(a.id);const second=store.workspaces.workers.add(a.id).id;
 const launches=[],agents=new AgentSessions({root:process.cwd(),data,createEngine:(_binary,_directory,onEvent)=>({
  request:async(op,args)=>{if(op==='start'){
   launches.push(args);
   if(rejectResume&&args.resumeId){rejectResume=false;throw Error('conversation not found');}
   await onEvent({event:'identity',sessionId:args.sessionId,nativeId:args.resumeId??'native-'+launches.length});
  }return {};},close:async()=>{}
 })});
 const mcp={endpoint:'http://localhost/mcp',grant:()=> 'test-token',revoke:()=>{}};
 t.after(async()=>{await agents.close();store.close();await rm(data,{recursive:true,force:true});});
 const start=async(url=sources[0],worker='main')=>{
  const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:url,sources:[url],lockKey:'source:'+url});
  const run=db.begin(a.id,{kind:'run',taskId:task.id},worker);
  const handle=await launchAutomationWorker({root:process.cwd(),data,db,run,automation:db.get(a.id),signal:{aborted:false},browser:{},report:()=>{},onEvent:()=>{},agents,mcp});
  return {run,handle,launch:launches.at(-1)};
 };
 const finish=async(turn,status='completed')=>{
  if(status==='completed')db.putRun({...db.run(turn.run.id),scan:{complete:true,pendingUrls:[],completion:'end',reason:'All results checked',evidenceUrl:turn.run.sourceUrl}});
  db.finish(a.id,turn.run.id,status,'Observed outcome');await turn.handle.close();
 };
 return {get db(){return db;},get store(){return store;},id:a.id,second,agents,launches,start,finish,
  rejectResume:()=>{rejectResume=true;},
  reopen:()=>{store.close();store=new WorkspaceDatabase(file);db=new AutomationStore(store);}
 };
}

for(const provider of ['claude','codex'])test(`${provider}: source conversations survive completed cycles, worker changes and app reopening`,async t=>{
 const f=await fixture(t,provider),first=await f.start();assert.equal(first.launch.resumeId,undefined);await f.finish(first);
 const other=await f.start(sources[1]);assert.equal(other.launch.resumeId,undefined);await f.finish(other);
 // The source can fall outside the UI's 30-run history window.
 for(let i=0;i<35;i++)f.db.putRun({id:'interview-'+i,automationId:f.id,kind:'interview',status:'completed',startedAt:Date.now()});
 f.reopen();assert.ok(!f.db.runs(f.id).some(r=>r.id===first.run.id));
 const next=await f.start(sources[0],f.second);
 assert.equal(next.launch.resumeId,'native-1');assert.equal(next.run.continuation.reason,'source_scan');
 assert.notEqual(next.run.taskId,first.run.taskId);assert.notEqual(next.run.scanPlan.id,first.run.scanPlan.id);
 assert.equal(next.run.scanPlan.mode,'incremental');assert.equal(next.run.scanPlan.cutoffAt,first.run.scanPlan.startedAt-SCAN_OVERLAP_MS);
 assert.equal(next.run.scan,undefined);assert.equal(next.run.continuation.browserContext,undefined);
 assert.match(next.launch.prompt,/previous source scan completed/);assert.match(next.launch.prompt,/new scan turn/);
 assert.match(next.launch.prompt,/saved records are authoritative/);assert.match(next.launch.prompt,/historical context, not current evidence/);
 assert.doesNotMatch(next.launch.prompt,/user answered your saved question/);
 await f.finish(next);
 const otherNext=await f.start(sources[1],f.second);assert.equal(otherNext.launch.resumeId,'native-2');await f.finish(otherNext);
});

test('schedule changes retain conversations; source and workspace criteria changes start fresh',async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first);
 const other=await f.start(sources[1]);await f.finish(other);
 f.db.saveSource(f.id,sources[0],{intervalMinutes:90});
 const scheduled=await f.start();assert.equal(scheduled.launch.resumeId,'native-1');await f.finish(scheduled);
 f.db.saveSource(f.id,sources[0],{query:'Different location'});
 const changed=await f.start();assert.equal(changed.run.continuation,undefined);assert.equal(changed.launch.resumeId,undefined);assert.equal(changed.run.scanPlan.mode,'full');await f.finish(changed);
 const unchanged=await f.start(sources[1]);assert.equal(unchanged.launch.resumeId,'native-2');await f.finish(unchanged);
 f.db.save(f.id,{goal:'Different workspace criteria'});f.db.review(f.id);
 const revised=await f.start(sources[1]);assert.equal(revised.launch.resumeId,undefined);await f.finish(revised);
});

test('changed launch settings start fresh and subsequent compatible scans reuse the new conversation',async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first);
 for(const change of [{model:'another-model'},{reasoning:'high'},{permission:'bypassPermissions'},{network:true},{provider:'claude'}]){
  f.db.save(f.id,{agentSettings:{...f.db.get(f.id).agentSettings,...change}});
  const changed=await f.start();assert.equal(changed.launch.resumeId,undefined);const nativeId=f.db.run(changed.run.id).conversation.nativeId;await f.finish(changed);
  const next=await f.start();assert.equal(next.launch.resumeId,nativeId);await f.finish(next);
 }
});

for(const provider of ['claude','codex'])test(`${provider}: context rotation clears the latest source conversation without reviving older runs`,async t=>{
 const f=await fixture(t,provider),first=await f.start();await f.finish(first);
 const next=await f.start();assert.equal(next.launch.resumeId,'native-1');await f.finish(next);
 const limited=await f.start(sources[0],f.second);assert.equal(limited.launch.resumeId,'native-1');
 f.agents.sessions.get(workerKey(f.id,f.second)).contextUsage={percent:80,peakPercent:80};await f.finish(limited);
 assert.equal(f.db.run(limited.run.id).conversation,null);
 assert.equal(f.db.run(first.run.id).conversation,null,'Late answers must not revive an older reference to retired history');
 const fresh=await f.start();assert.equal(fresh.run.continuation,undefined);assert.equal(fresh.launch.resumeId,undefined);assert.equal(fresh.run.scanPlan.mode,'incremental');await f.finish(fresh);
});

test('a rejected source resume starts fresh and saves the replacement for the following scan',async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first);f.rejectResume();
 const recovered=await f.start();assert.deepEqual(f.launches.map(l=>l.resumeId),[undefined,'native-1',undefined]);
 assert.equal(f.db.run(first.run.id).conversation,null);await f.finish(recovered);
 const next=await f.start();assert.equal(next.launch.resumeId,'native-3');await f.finish(next);
});

test('a failed latest scan cannot fall back to an older completed conversation',async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first);
 const failed=await f.start();assert.equal(failed.launch.resumeId,'native-1');await f.finish(failed,'failed');
 const fresh=await f.start();assert.equal(fresh.launch.resumeId,undefined);await f.finish(fresh);
});

test('a latest scan with no saved conversation never falls back to an older source or worker conversation',async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first);
 const next=await f.start();await f.finish(next);f.db.putRun({...f.db.run(next.run.id),conversation:null});
 const fresh=await f.start();assert.equal(fresh.run.continuation,undefined);assert.equal(fresh.launch.resumeId,undefined);await f.finish(fresh);
});

test('an answer from an obsolete source scope cannot resume its conversation',async t=>{
 const f=await fixture(t),first=await f.start();
 const question=f.db.askQuestion(f.id,{text:'Which category?'},{runId:first.run.id});await f.finish(first,'blocked');
 f.db.saveSource(f.id,sources[0],{query:'A new category'});f.db.answerQuestion(f.id,question.id,'Saved answer');
 const next=await f.start();assert.equal(next.run.continuation,undefined);assert.equal(next.launch.resumeId,undefined);await f.finish(next);
});
