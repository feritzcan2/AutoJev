import {unknownScorecard} from './helpers/scorecard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationAttention} from '../app/automation-attention.mjs';
import {scanCheckpoint} from '../app/automation-scan.mjs';
import {automationCells} from '../app/automation-templates.mjs';

const source='https://vendor.example/',detail='https://boards.example/employer/123';
function fixture(t){
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store);
 const a=db.create('job-search',{goal:'Find jobs',criteria:{preferences:'Berlin backend',ranking:'Backend and location fit, 0–100'},sources:[source]});
 db.review(a.id);db.skipTrial(a.id);db.enable(a.id);
 const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const run=db.begin(a.id,{kind:'run',taskId:task.id});
 const flow=automationWorkflow({root:process.cwd(),db,run,signal:{aborted:false},browser:{call:async()=>({content:[{type:'text',text:`Page URL: ${source}\nObserved job ${detail}\n${'x'.repeat(20000)}`}]})},report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
 return {store,db,id:a.id,run,call:(name,args)=>flow.call(a.id,run.id,name,args)};
}

test('browser observations checkpoint and resume employer URLs',async t=>{
 const f=fixture(t);
 const output=await f.call('browser_open',{url:source});
 assert.ok(output.snapshot.nextOffset);assert.equal(output.url,source);
 const page=await f.call('browser_read_part',{snapshotId:output.snapshot.id,offset:output.snapshot.nextOffset});assert.ok(page.content[0].text.length);
 const progress=f.db.saveScanProgress(f.id,f.run.id,{pendingUrls:[detail],reason:'Inspect this detail then page two',cursor:'page=1'},{url:source,text:''});
 assert.deepEqual(progress.queue.pendingUrls,[detail]);assert.equal(progress.scanProgress.pendingUrls.length,1);assert.equal(progress.scanPlan.checkpoint.cursor,'page=1');
 assert.equal(f.db.run(f.run.id).browserSteps,1);
 assert.ok(f.db.run(f.run.id).observedLinks.includes(detail));
 const recorded=f.db.record(f.id,f.run.id,{key:detail,url:detail,title:'Engineer',summary:'Observed job',assessment:{status:'scored',scorecard:unknownScorecard(),score:80,summary:'Fits criteria',evidenceUrl:source,evidence:'Observed job from browser',strengths:['Backend'],gaps:[],uncertainties:[]}});
 assert.equal(recorded.sourceUrl,source);
 const reported='https://boards.example/reported';
 f.db.saveScanProgress(f.id,f.run.id,{pendingUrls:[reported],reason:'Additional URL found by Jev',cursor:'page=1'});
 let context=await f.call('get_automation_context',{});
 if(context.context){
  let text='';
  for(;;){text+=context.text;if(context.context.nextOffset===null)break;context=await f.call('read_automation_context_part',{contextId:context.context.id,offset:context.context.nextOffset});}
  context=JSON.parse(text);
 }
 assert.ok(context.sourceExamples.some(r=>r.url===detail));
 f.db.finish(f.id,f.run.id,'interrupted','Test interruption');
 const task=f.store.workspaces.tasks.enqueue(f.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const resumed=f.db.begin(f.id,{kind:'run',taskId:task.id});
 assert.deepEqual(resumed.scan.pendingUrls,[detail,reported]);assert.equal(resumed.scanPlan.checkpoint.cursor,'page=1');
});

test('unfinished coverage cannot escape validation by switching completed to failed or blocked',async t=>{
 const f=fixture(t);
 for(const status of ['failed','blocked']){
  await assert.rejects(f.call('finish_automation_run',{status,summary:'Only first query/page scanned'}),/stop.kind/);
  await assert.rejects(f.call('finish_automation_run',{status,summary:'No access barrier; pages remain',stop:{kind:'incomplete',evidence:'Page 1 of 8'}}),/aynı görevde/);
  assert.equal(f.db.run(f.run.id).status,'running');assert.notEqual(f.db.sources(f.id)[0].blocked,true);
 }
 await f.call('browser_open',{url:source});
 await f.call('finish_automation_run',{status:'blocked',summary:'Site access denied',stop:{kind:'access',evidence:'Access denied on the actual results page'}});
 assert.equal(f.db.sources(f.id)[0].blocked,true);assert.equal(f.db.sources(f.id)[0].blocker.stop.kind,'access');
 assert.equal(automationAttention({...f.db.snapshot(f.id),activeRuns:[]})[0].retry,'source');
});

test('technical failures retain their reason when run history is not in the snapshot',async t=>{
 const f=fixture(t);
 await assert.rejects(f.call('finish_automation_run',{status:'failed',summary:'Browser disconnected',stop:{kind:'technical',evidence:'Connection closed after reconnect'}}),/Doğrulanmış/);
 // App-generated failures remain visible; an agent cannot invent technical proof.
 f.db.finish(f.id,f.run.id,'failed','Browser disconnected');
 const issue=automationAttention({...f.db.snapshot(f.id),runs:[],activeRuns:[]})[0];
 assert.equal(issue.kind,'technical');assert.equal(issue.retry,'source');
});

test('checkpoints permit observed cross-host discovery but never invented or another run’s URLs',()=>{
 const run={kind:'run',sourceUrl:source,navigation:[{url:source}],observedLinks:[detail]},input={complete:false,pendingUrls:[detail],reason:'Read employer listing',evidenceUrl:source};
 assert.deepEqual(scanCheckpoint(run,input),input);
 assert.throws(()=>scanCheckpoint({...run,observedLinks:[]},input),/gözlenen/);
});

test('table feedback identifies app-owned cells and lists usable keys',t=>{
 const f=fixture(t),table=f.db.get(f.id).table;
 assert.deepEqual(automationCells([{key:'source',value:'LinkedIn'},{key:'title',value:'Ignored'},{key:'company',value:'Employer'}],table),{company:'Employer'});
 assert.deepEqual(automationCells([{key:'company',value:'Employer'},{key:'score',value:'72'}],table),{company:'Employer',score:'72'});
});
