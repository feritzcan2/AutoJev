import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationRunHistory} from '../app/automation-continuation.mjs';
import {selectResume} from '../app/resume.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';

const settings={provider:'codex',model:'selected',reasoning:'high',permission:'bypassPermissions',network:null,agentProfileDigest:'profile-v1'};
const settle=()=>new Promise(r=>setImmediate(r));
function fixture(t){
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),a=db.create('custom',{goal:'Find',criteria:Object.fromEntries(db.template('custom').fields.filter(f=>f.required).map(f=>[f.id,'Known'])),sources:['https://example.test']});
 db.review(a.id);const trial=db.begin(a.id,'trial');for(const url of a.sources)db.observe(a.id,trial.id,url,'Observed source');db.finish(a.id,trial.id,'completed','Source checked');
 const seed=db.begin(a.id,'run'),item=db.record(a.id,seed.id,{key:'one',url:'https://example.test/one',title:'One',summary:'Facts'});
 db.finish(a.id,seed.id,'completed','Saved');const launches=[];
 const runtime=new WebTasks(db,{launch:async run=>{launches.push(run);return {close:async()=>{}};}});
 t.after(async()=>{await runtime.close();store.close();});
 const history=run=>automationRunHistory(db,run,store.workspaces.history(a.id,run.workerId)).forProfile('web-run');
 return {store,db,a,item,runtime,launches,history};
}

for(const early of [false,true])test(`answers resume the asking conversation after other worker history changes (early=${early})`,async t=>{
 const f=fixture(t),{db,a,item,runtime}=f;
 await runtime.runRecord(a.id,item.id,'prepare');await settle();const origin=f.launches.at(-1);
 f.history(origin).saveConversation(a.id,'codex','asking-thread',settings);
 db.putRun({...db.run(origin.id),resumeContext:{tabId:'form',url:'https://ats.test/apply'}});
 const q=db.askQuestion(a.id,{text:'Missing fact?',recordId:item.id},{runId:origin.id});
 assert.equal(q.runId,origin.id);
 if(early)await runtime.answer(a.id,q.id,'Answer');
 runtime.report(a.id,origin.id,'blocked','Waiting');await runtime.finish(a.id,'blocked','Waiting',origin.workerId);
 f.store.workspaces.history(a.id,origin.workerId).forProfile('web-run').saveConversation(a.id,'codex','unrelated-thread',settings);
 if(!early)await runtime.answer(a.id,q.id,'Answer');else await runtime.tick();
 await settle();const resumed=f.launches.at(-1);
 assert.notEqual(resumed.id,origin.id);assert.equal(resumed.continuation.runId,origin.id);
 assert.equal(resumed.continuation.browserContext.tabId,'form');
 assert.equal(selectResume(f.history(resumed),a.id,settings),'asking-thread');
 assert.equal(selectResume(f.history(resumed),a.id,{...settings,model:'changed'}),undefined);
 assert.equal(selectResume(f.history(resumed),a.id,{...settings,provider:'claude'}),undefined);
 assert.equal(selectResume(f.history(resumed),a.id,{...settings,reasoning:'low'}),undefined);
 assert.equal(selectResume(f.history(resumed),a.id,{...settings,agentProfileDigest:'changed'}),undefined);
 const otherWorker=automationRunHistory(db,resumed,f.store.workspaces.history(a.id,'another-worker')).forProfile('web-run');
 assert.equal(selectResume(otherWorker,a.id,settings),'asking-thread');
 f.history(resumed).forgetConversation(a.id,'codex','asking-thread');
 assert.equal(selectResume(f.history(resumed),a.id,settings),undefined,'Rejected/rotated history must never fall back to an unrelated worker thread');
});

test('record tab tools are available but tab closure stays source-only',async t=>{
 const f=fixture(t);f.db.put({...f.db.get(f.a.id),browserMode:'jev'});
 await f.runtime.runRecord(f.a.id,f.item.id,'prepare');await settle();const run=f.launches.at(-1);
 const flow=automationWorkflow({db:f.db,run,signal:{aborted:false},browser:{call:async()=>({tabs:[{tabId:'assigned'}]})},report:()=>{}});
 const names=flow.tools.map(t=>t.name);
 assert.ok(names.includes('browser_jev_tabs'));assert.ok(names.includes('browser_jev_use_tab'));assert.ok(!names.includes('browser_jev_close_tab'));
 assert.equal((await flow.call(f.a.id,run.id,'browser_jev_tabs',{})).tabs[0].tabId,'assigned');
});

test('setup answers use their original conversation and consume it only once',async t=>{
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),a=db.create('custom');t.after(()=>store.close());
 const first=db.begin(a.id,'interview'),base=store.workspaces.history(a.id);
 automationRunHistory(db,first,base).forProfile('web-interview').saveConversation(a.id,'codex','setup-thread',settings);
 const q=db.askQuestion(a.id,{text:'What do you need?'},{runId:first.id});db.finish(a.id,first.id,'blocked','Waiting');db.answerQuestion(a.id,q.id,'A home');
 const next=db.begin(a.id,'interview');assert.equal(next.continuation.runId,first.id);
 assert.equal(selectResume(automationRunHistory(db,next,base).forProfile('web-interview'),a.id,settings),'setup-thread');
 db.finish(a.id,next.id,'blocked','Done');assert.equal(db.begin(a.id,'interview').continuation,undefined);
});

test('a failed source retry and later scans resume the source conversation instead of unrelated worker history',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.a.id);await settle();const first=f.launches.at(-1);
 f.history(first).saveConversation(f.a.id,'codex','source-thread',settings);
 f.db.putRun({...f.db.run(first.id),resumeContext:{tabId:'results-page',url:first.sourceUrl}});
 await f.runtime.finish(f.a.id,'interrupted','Agent oturumu kesildi.',first.workerId);
 f.store.workspaces.history(f.a.id,first.workerId).forProfile('web-run').saveConversation(f.a.id,'codex','different-task',settings);
 await f.runtime.tick();await settle();const next=f.launches.at(-1);
 assert.notEqual(next.id,first.id);assert.equal(next.taskId,first.taskId);assert.equal(next.continuation.reason,'task_retry');assert.equal(next.continuation.runId,first.id);
 assert.equal(selectResume(f.history(next),f.a.id,settings),'source-thread');assert.equal(next.continuation.browserContext.tabId,'results-page');
 f.history(next).saveConversation(f.a.id,'codex','source-thread',settings);
 await f.runtime.finish(f.a.id,'completed','Done',next.workerId);
 await f.runtime.runSource(f.a.id,first.sourceUrl);await settle();const scan=f.launches.at(-1);
 assert.equal(scan.continuation.reason,'source_scan');assert.equal(scan.continuation.runId,next.id);assert.equal(selectResume(f.history(scan),f.a.id,settings),'source-thread');
});

test('shutdown recovery resumes record preparation but never execution after an uncertain send',async t=>{
 const f=fixture(t);await f.runtime.runRecord(f.a.id,f.item.id,'prepare');await settle();const first=f.launches.at(-1);
 f.history(first).saveConversation(f.a.id,'codex','record-thread',settings);
 await f.runtime.finish(f.a.id,'interrupted','Uygulama kapatıldı.',first.workerId);
 const task=f.store.workspaces.tasks.get(f.a.id,first.taskId);f.store.workspaces.tasks.put({...task,state:'pending',workerId:null});
 await f.runtime.tick();await settle();const next=f.launches.at(-1);
 assert.equal(selectResume(f.history(next),f.a.id,settings),'record-thread');
 await f.runtime.finish(f.a.id,'interrupted','Uygulama kapatıldı.',next.workerId);
 const saved=f.store.workspaces.tasks.get(f.a.id,next.taskId);f.store.workspaces.tasks.put({...saved,state:'pending',workerId:null,recordOperation:'verify',operation:'record-verify',capability:'browser.observe'});
 f.db.putResult({...f.db.result(f.a.id,f.item.id),status:'uncertain'});
 const verify=f.db.begin(f.a.id,{kind:'run',taskId:saved.id});assert.equal(verify.continuation,undefined);f.db.finish(f.a.id,verify.id,'blocked','Still uncertain');
});

for(const stop of ['technical','manual'])test(`runSource resumes the source conversation after a ${stop} stop creates a new queue task`,async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.a.id);await settle();const first=f.launches.at(-1);
 f.history(first).saveConversation(f.a.id,'codex','source-thread',settings);
 if(stop==='manual')await f.runtime.stopSource(f.a.id,first.sourceUrl);
 else await f.runtime.finish(f.a.id,'interrupted','Geçici tarama sorunu.',first.workerId);
 assert.equal(f.runtime.slots(f.a.id).length,0);
 if(stop==='manual'){await f.runtime.tick();assert.equal(f.launches.length,1,'A stop must still prevent automatic relaunch');}
 f.store.workspaces.history(f.a.id,first.workerId).forProfile('web-run').saveConversation(f.a.id,'codex','different-task',settings);
 await f.runtime.runSource(f.a.id,first.sourceUrl);await settle();const next=f.launches.at(-1);
 assert.notEqual(next.taskId,first.taskId);assert.equal(next.continuation.reason,'source_retry');
 assert.equal(next.continuation.runId,first.id);assert.equal(selectResume(f.history(next),f.a.id,settings),'source-thread');
});
