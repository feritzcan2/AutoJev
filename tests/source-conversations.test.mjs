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
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {rememberSourceAccess} from '../app/source-access-recovery.mjs';

const sources=['https://a.example/list','https://b.example/list'];
async function fixture(t,provider='codex'){
 const data=await mkdtemp(path.join(tmpdir(),'loop-source-conversations-')),file=path.join(data,'state.sqlite');
 let now=Date.now(),store=new WorkspaceDatabase(file),db=new AutomationStore(store,{now:()=>now}),rejectResume=false;
 const settings={provider,model:'default',reasoning:'default',permission:'default',network:null,contextRestartTokens:70000};
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
 const start=async(url=sources[0],worker='main',taskId=null)=>{
  const queue=store.workspaces.tasks;
  const task=taskId?queue.put({...queue.get(a.id,taskId),state:'pending',workerId:null}):queue.enqueue(a.id,{operation:'scan',sourceUrl:url,sources:[url],lockKey:'source:'+url});
  const run=db.begin(a.id,{kind:'run',taskId:task.id},worker);
  const handle=await launchAutomationWorker({root:process.cwd(),data,db,run,automation:db.get(a.id),signal:{aborted:false},browser:{},report:()=>{},onEvent:()=>{},agents,mcp});
  return {run:db.run(run.id),handle,launch:launches.at(-1)};
 };
 const finish=async(turn,status='completed')=>{
  if(status==='completed')db.putRun({...db.run(turn.run.id),scan:{complete:true,pendingUrls:[],completion:'end',reason:'All results checked',evidenceUrl:turn.run.sourceUrl}});
  db.finish(a.id,turn.run.id,status,'Observed outcome');await turn.handle.close();
 };
 return {get db(){return db;},get store(){return store;},id:a.id,second,agents,launches,start,finish,
  rejectResume:()=>{rejectResume=true;},advance:ms=>{now+=ms;},
  reopen:()=>{store.close();store=new WorkspaceDatabase(file);db=new AutomationStore(store,{now:()=>now});}
 };
}

for(const provider of ['claude','codex','opencode'])for(const restart of [false,true])test(`${provider}: access response resumes ten-minute-old source history across app restarts (${restart})`,async t=>{
 const f=await fixture(t,provider),first=await f.start(),wait=f.db.siteAccess.block(sources[0],'verification');
 f.db.putRun({...f.db.run(first.run.id),siteWait:wait,resumeContext:{url:sources[0],tabId:'retained-source'}});
 await f.finish(first,'blocked');rememberSourceAccess(f.db,f.db.run(first.run.id));f.advance(10*60000);
 if(restart)f.reopen();
 const a=f.db.get(f.id),state=a.sourceState[sources[0]];
 f.db.siteAccess.acknowledge([wait]);f.db.put({...a,sourceState:{...a.sourceState,[sources[0]]:{...state,accessRecovery:{...state.accessRecovery,state:'answered',response:'Verification solved'}}}});
 const resumed=await f.start(sources[0],f.second,first.run.taskId);
 assert.equal(resumed.run.continuation.browserContext.tabId,'retained-source');assert.equal(resumed.run.continuation.reason,'site_access_response');
 assert.equal(resumed.launch.resumeId,first.run.conversation.nativeId);
 assert.equal(resumed.launch.prompt.includes('The app restarted.'),restart);
 assert.equal(automationTaskContext(f.db,f.id,resumed.run).sourceRecovery.response,'Verification solved');await f.finish(resumed,'interrupted');
});

for(const provider of ['claude','codex','opencode'])test(`${provider}: completed source scans start fresh across workers and app reopening, preserving incremental coverage`,async t=>{
 const f=await fixture(t,provider),first=await f.start();assert.equal(first.launch.resumeId,undefined);await f.finish(first);
 const other=await f.start(sources[1]);assert.equal(other.launch.resumeId,undefined);await f.finish(other);
 // The source can fall outside the UI's 30-run history window.
 for(let i=0;i<35;i++)f.db.putRun({id:'interview-'+i,automationId:f.id,kind:'interview',status:'completed',startedAt:Date.now()});
 f.reopen();assert.ok(!f.db.runs(f.id).some(r=>r.id===first.run.id));
 const next=await f.start(sources[0],f.second);
 assert.equal(next.launch.resumeId,undefined);assert.equal(next.run.continuation,undefined);
 assert.notEqual(next.run.taskId,first.run.taskId);assert.notEqual(next.run.scanPlan.id,first.run.scanPlan.id);
 assert.equal(next.run.scanPlan.mode,'incremental');assert.equal(next.run.scanPlan.cutoffAt,first.run.scanPlan.startedAt-SCAN_OVERLAP_MS);
 assert.equal(next.run.scan,undefined);
 assert.match(next.launch.prompt,/current workspace criteria and assigned source query/);
 assert.doesNotMatch(next.launch.prompt,/reuse useful site navigation knowledge from its conversation/);
 assert.match(next.launch.prompt,/saved records are authoritative/);assert.match(next.launch.prompt,/historical context, not current evidence/);
 assert.doesNotMatch(next.launch.prompt,/user answered your saved question/);
 await f.finish(next);
 const otherNext=await f.start(sources[1],f.second);assert.equal(otherNext.launch.resumeId,undefined);await f.finish(otherNext);
});

test('schedule changes preserve coverage; each completed scan and changed criteria start fresh',async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first);
 const other=await f.start(sources[1]);await f.finish(other);
 f.db.saveSource(f.id,sources[0],{intervalMinutes:90});
 const scheduled=await f.start();assert.equal(scheduled.launch.resumeId,undefined);assert.equal(scheduled.run.scanPlan.mode,'incremental');await f.finish(scheduled);
 f.db.saveSource(f.id,sources[0],{query:'Different location'});
 const changed=await f.start();assert.equal(changed.run.continuation,undefined);assert.equal(changed.launch.resumeId,undefined);assert.equal(changed.run.scanPlan.mode,'full');await f.finish(changed);
 const unchanged=await f.start(sources[1]);assert.equal(unchanged.launch.resumeId,undefined);await f.finish(unchanged);
 f.db.save(f.id,{goal:'Different workspace criteria'});f.db.review(f.id);
 const revised=await f.start(sources[1]);assert.equal(revised.launch.resumeId,undefined);await f.finish(revised);
});

test('changed launch settings start fresh and short retries reuse the compatible replacement',async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first,'interrupted');
 for(const change of [{model:'another-model'},{reasoning:'high'},{permission:'bypassPermissions'},{network:true},{provider:'claude'}]){
  f.db.save(f.id,{agentSettings:{...f.db.get(f.id).agentSettings,...change}});
  const changed=await f.start();assert.equal(changed.launch.resumeId,undefined);const nativeId=f.db.run(changed.run.id).conversation.nativeId;await f.finish(changed,'interrupted');
  const next=await f.start();assert.equal(next.launch.resumeId,nativeId);await f.finish(next,'interrupted');
 }
});

for(const provider of ['claude','codex'])test(`${provider}: context rotation clears the latest source conversation without reviving older runs`,async t=>{
 const f=await fixture(t,provider),first=await f.start();await f.finish(first,'interrupted');
 const next=await f.start();assert.equal(next.launch.resumeId,'native-1');await f.finish(next,'interrupted');
 const limited=await f.start(sources[0],f.second);assert.equal(limited.launch.resumeId,'native-1');
 f.agents.sessions.get(workerKey(f.id,f.second)).contextUsage={tokens:12000,peakTokens:80000};await f.finish(limited,'interrupted');
 assert.equal(f.db.run(limited.run.id).conversation,null);
 assert.equal(f.db.run(first.run.id).conversation,null,'Late answers must not revive an older reference to retired history');
 const fresh=await f.start();assert.equal(fresh.run.continuation,undefined);assert.equal(fresh.launch.resumeId,undefined);assert.equal(fresh.run.scanPlan.id,first.run.scanPlan.id);await f.finish(fresh);
});

test('a rejected source resume starts fresh and saves the replacement for the following short retry',async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first,'interrupted');f.rejectResume();
 const recovered=await f.start();assert.deepEqual(f.launches.map(l=>l.resumeId),[undefined,'native-1',undefined]);
 assert.equal(f.db.run(first.run.id).conversation,null);await f.finish(recovered,'interrupted');
 const next=await f.start();assert.equal(next.launch.resumeId,'native-3');await f.finish(next,'interrupted');
});

for(const provider of ['claude','codex','opencode'])for(const status of ['interrupted','partial','blocked','failed'])test(`${provider}: app reopening resumes unfinished source conversation after ${status}`,async t=>{
 const f=await fixture(t,provider),first=await f.start(),tab={tabId:'retained',url:sources[0]};
 const scan={complete:false,pendingUrls:[sources[0]],reason:'Saved progress',evidenceUrl:sources[0]};
 f.db.putRun({...f.db.run(first.run.id),resumeContext:tab,scan});await f.finish(first,status);
 const other=await f.start(sources[1]);await f.finish(other);f.reopen();
 const next=await f.start(sources[0],f.second);
 assert.notEqual(next.run.taskId,first.run.taskId);assert.equal(next.launch.resumeId,first.run.conversation.nativeId);
 assert.equal(next.run.continuation.runId,first.run.id);assert.equal(next.run.continuation.reason,'source_retry');assert.equal(next.run.continuation.resumeConversation,true);assert.equal(next.run.protocolReset,undefined);
 assert.deepEqual(next.run.continuation.browserContext,tab);assert.deepEqual(next.run.scanPlan,first.run.scanPlan);
 assert.deepEqual(next.run.scan.pendingUrls,scan.pendingUrls);
 assert.match(next.launch.prompt,/The app restarted/);assert.match(next.launch.prompt,/Resume the same source conversation/);
 assert.match(next.launch.prompt,/Earlier Jev task IDs, evidence IDs, snapshots and browser control handles have expired/);
 assert.match(next.launch.prompt,/read pages again before relying on their content/);
 assert.doesNotMatch(next.launch.prompt,/fresh conversation|previous source scan completed|user answered your saved question/);
 await f.finish(next);
});

test('manual source stop preserves the conversation for a later explicit start',async t=>{
 const f=await fixture(t,'opencode'),first=await f.start();
 f.db.putRun({...f.db.run(first.run.id),stopRequested:true});await f.finish(first,'interrupted');
 const next=await f.start();assert.equal(next.launch.resumeId,'native-1');assert.equal(next.run.stopRequested,undefined);await f.finish(next);
});

test('source continuation follows insertion order when the clock moves backwards',async t=>{
 const f=await fixture(t,'opencode'),first=await f.start();await f.finish(first,'interrupted');
 f.db.putRun({...f.db.run(first.run.id),startedAt:Date.now()+3600000});
 f.rejectResume();const replaced=await f.start();assert.equal(f.db.run(replaced.run.id).conversation.nativeId,'native-3');await f.finish(replaced,'interrupted');
 const next=await f.start();assert.equal(next.run.continuation.runId,replaced.run.id);assert.equal(next.launch.resumeId,'native-3');await f.finish(next);
});

test('a cleared latest source identity never revives a saved task continuation',async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first);
 const next=await f.start();await f.finish(next,'interrupted');
 f.db.putRun({...f.db.run(next.run.id),conversation:null});
 const queue=f.store.workspaces.tasks;queue.put({...queue.get(f.id,next.run.taskId),state:'pending',workerId:null});
 const run=f.db.begin(f.id,{kind:'run',taskId:next.run.taskId});assert.equal(run.continuation,undefined);
 f.db.finish(f.id,run.id,'interrupted','Test done');
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

for(const provider of ['claude','codex','opencode'])for(const delay of [5*60000,24*60*60000])test(`${provider}: same queued task resumes history regardless of interruption duration (${delay} ms)`,async t=>{
 const f=await fixture(t,provider),first=await f.start();
 // Both a long scan and a long interruption preserve the unfinished cycle.
 f.advance(60*60*1000);await f.finish(first,'interrupted');f.advance(delay);
 const other=await f.start(sources[1]);await f.finish(other);
 const next=await f.start(sources[0],f.second,first.run.taskId);
 assert.equal(next.run.taskId,first.run.taskId);assert.equal(next.run.scanPlan.id,first.run.scanPlan.id);
 assert.equal(next.run.continuation.reason,'task_retry');assert.equal(next.run.continuation.resumeConversation,true);
 assert.equal(next.launch.resumeId,first.run.conversation.nativeId);
 assert.match(next.launch.prompt,/same unfinished task and conversation/);assert.doesNotMatch(next.launch.prompt,/The app restarted|fresh conversation/);
 await f.finish(next);
});

test('an answer after app reopening resumes the source conversation with searches, exact checkpoint and results intact',async t=>{
 const f=await fixture(t,'opencode'),first=await f.start(),url=sources[0],nextUrl=url+'?page=8',detail=url+'/remaining';
 const text='Page 7 of 8. Next page uses cursor EXACT+cursor/7=. Search by the visible Search control.';
 f.db.observe(f.id,first.run.id,url,text,[nextUrl,detail],{tabId:'retained'});
 f.db.reportPage(f.id,first.run.id,{url,currentPage:7,totalPages:8,evidence:'Page 7 of 8',at:f.db.now()});
 f.db.saveScanProgress(f.id,first.run.id,{pendingUrls:[nextUrl,detail],processedUrls:[url],reason:'Read remaining details and page 8',cursor:'EXACT+cursor/7='},{url,text});
 const item=f.db.record(f.id,first.run.id,{url:url+'/saved',title:'Already checked',summary:'Verified listing'});
 const question=f.db.askQuestion(f.id,{text:'Which category next?'},{runId:first.run.id});
 const saved=f.db.run(first.run.id);
 await f.finish(first,'blocked');f.advance(24*60*60000);f.reopen();
 f.db.answerQuestion(f.id,question.id,'Use the saved target category');
 const next=await f.start(sources[0],f.second);
 assert.equal(next.launch.resumeId,first.run.conversation.nativeId);assert.equal(next.run.continuation.resumeConversation,true);
 assert.deepEqual(next.run.scan,saved.scan);assert.deepEqual(next.run.scanPlan,saved.scanPlan);assert.deepEqual(next.run.pageProgress,saved.pageProgress);
 assert.deepEqual(f.db.scanQueue(f.id,next.run.id,{}).pendingUrls,[nextUrl,detail]);
 assert.equal(next.run.scanPlan.checkpoint.cursor,'EXACT+cursor/7=');
 assert.equal(next.run.continuation.browserContext.tabId,'retained');assert.deepEqual(next.run.continuation.questionIds,[question.id]);
 assert.equal(f.db.get(f.id).questions.find(q=>q.id===question.id).continuationRunId,next.run.id);
 assert.equal(f.db.result(f.id,item.id).id,item.id);
 const context=automationTaskContext(f.db,f.id,next.run);
 assert.equal(context.questions.find(q=>q.id===question.id).answer,'Use the saved target category');
 assert.match(next.launch.prompt,/The app restarted/);assert.match(next.launch.prompt,/do not repeat completed searches/);
 // Subsequent interruptions keep using this same conversation.
 const nativeId=f.db.run(next.run.id).conversation.nativeId;
 await f.finish(next,'interrupted');const retry=await f.start(sources[0],'main',next.run.taskId);
 assert.equal(retry.launch.resumeId,nativeId);await f.finish(retry,'interrupted');
});

for(const finishedAt of [null,'unknown','future'])test(`source continuity depends on the unfinished cycle, not interruption timestamps (${finishedAt})`,async t=>{
 const f=await fixture(t),first=await f.start();await f.finish(first,'interrupted');
 f.db.putRun({...f.db.run(first.run.id),finishedAt:finishedAt==='future'?f.db.now()+1:finishedAt});
 const next=await f.start();assert.equal(next.launch.resumeId,first.run.conversation.nativeId);assert.equal(next.run.continuation.resumeConversation,true);await f.finish(next);
});

for(const provider of ['claude','codex','opencode'])for(const crash of [false,true])test(`${provider}: app restart resumes the unfinished task conversation on another worker (crash=${crash})`,async t=>{
 const f=await fixture(t,provider),first=await f.start();
 f.db.persistScan(f.id,{...f.db.run(first.run.id),scan:{complete:false,pendingUrls:[sources[0]+'?page=8'],reason:'Saved before crash',evidenceUrl:sources[0]}});
 if(crash)await first.handle.close();else await f.finish(first,'interrupted');
 f.advance(24*60*60000);f.reopen();f.db.recover();
 assert.equal(Boolean(f.db.run(first.run.id).recoveredAfterCrash),crash);
 const next=await f.start(sources[0],f.second,first.run.taskId);
 assert.equal(next.launch.resumeId,first.run.conversation.nativeId);assert.equal(next.run.continuation.resumeConversation,true);
 assert.match(next.launch.prompt,/The app restarted/);assert.match(next.launch.prompt,/same unfinished task and conversation/);
 assert.deepEqual(next.run.scan.pendingUrls,[sources[0]+'?page=8']);await f.finish(next,'interrupted');
});

for(const provider of ['claude','codex','opencode'])test(`${provider}: a record answer after restart resumes the asking conversation and preserves its form`,async t=>{
 const f=await fixture(t,provider),source=await f.start();
 const item=f.db.record(f.id,source.run.id,{url:sources[0]+'/one',title:'Observed item',summary:'Saved facts'});await f.finish(source);
 const queueRecord=()=>f.store.workspaces.tasks.enqueue(f.id,{operation:'record-prepare',recordOperation:'prepare',recordId:item.id,sourceUrl:sources[0],lockKey:'record:'+item.id,request:{manual:true,revision:f.db.get(f.id).revision}});
 const first=await f.start(sources[0],'main',queueRecord().id),tab={tabId:'retained-form',url:'https://forms.example/apply?id=one#details'};
 f.db.putRun({...f.db.run(first.run.id),resumeContext:tab});
 const question=f.db.askQuestion(f.id,{text:'Which date?',recordId:item.id},{runId:first.run.id});await f.finish(first,'blocked');
 const other=await f.start(sources[1]);await f.finish(other);
 f.advance(24*60*60000);f.reopen();f.db.answerQuestion(f.id,question.id,'2026-11-01');
 const next=await f.start(sources[0],f.second,queueRecord().id);
 assert.equal(next.launch.resumeId,first.run.conversation.nativeId);assert.equal(next.run.continuation.runId,first.run.id);
 assert.equal(next.run.continuation.browserContext.tabId,tab.tabId);assert.equal(next.run.recordOperation,'prepare');
 assert.match(next.launch.prompt,/The app restarted/);assert.match(next.launch.prompt,/Preserve entered form values/);
 assert.match(next.launch.prompt,/The user answered your saved question/);
 assert.equal(automationTaskContext(f.db,f.id,next.run).questions.find(q=>q.id===question.id).answer,'2026-11-01');await f.finish(next,'interrupted');
});

test('answering a question from a completed scan does not revive its conversation',async t=>{
 const f=await fixture(t),first=await f.start();
 const question=f.db.askQuestion(f.id,{text:'A preference for the next scan?'},{runId:first.run.id});
 await f.finish(first);f.db.answerQuestion(f.id,question.id,'Saved preference');
 const next=await f.start();assert.equal(next.launch.resumeId,undefined);assert.equal(next.run.continuation.resumeConversation,false);
 assert.notEqual(next.run.scanPlan.id,first.run.scanPlan.id);assert.equal(next.run.scanPlan.mode,'incremental');
 assert.deepEqual(next.run.continuation.questionIds,[question.id]);await f.finish(next);
});
