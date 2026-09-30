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
 const a=db.create('job-search',{goal:'Find jobs',criteria:{preferences:'Berlin backend'},sources:[source]});
 db.review(a.id);db.skipTrial(a.id);db.enable(a.id);
 const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const run=db.begin(a.id,{kind:'run',taskId:task.id});
 const flow=automationWorkflow({root:process.cwd(),db,run,signal:{aborted:false},browser:{call:async()=>({content:[{type:'text',text:`Page URL: ${source}\nLogin required`}]})},report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
 return {store,db,id:a.id,run,call:(name,args)=>flow.call(a.id,run.id,name,args)};
}

test('configured CLI observations checkpoint and resume employer URLs without opening a browser',async t=>{
 const f=fixture(t),a=f.db.get(f.id);
 // Run a local read-only fixture through the real execFile integration.
 f.db.put({...a,sourceSettings:{[source]:{searchMethod:'tool',customTool:{command:process.execPath,args:['-e',`process.stdout.write(JSON.stringify({url:${JSON.stringify(detail)},text:'x'.repeat(20000)}))`]},fallback:'none'}}});
 const output=await f.call('run_workspace_source_tool',{args:[]});
 assert.ok(output.snapshot.nextOffset);assert.equal(output.url,source);
 const page=await f.call('browser_read_part',{snapshotId:output.snapshot.id,offset:output.snapshot.nextOffset});assert.ok(page.content[0].text.length);
 const progress=await f.call('save_scan_progress',{snapshotId:output.snapshot.id,pendingUrls:[detail],reason:'Inspect this detail then page two',cursor:'"args":[]'});
 assert.deepEqual(progress.scanProgress.pendingUrls,[detail]);assert.equal(progress.scanPlan.checkpoint.cursor,'"args":[]');
 assert.equal(f.db.run(f.run.id).browserSteps,0);
 assert.ok(f.db.run(f.run.id).observedLinks.includes(detail));
 const recorded=f.db.record(f.id,f.run.id,{key:detail,url:detail,title:'Engineer',summary:'Observed job'});
 assert.equal(recorded.sourceUrl,source);
 await assert.rejects(f.call('save_scan_progress',{snapshotId:output.snapshot.id,pendingUrls:['https://boards.example/invented'],reason:'Guess'}),/gözlenen/);
 const context=await f.call('get_automation_context',{});
 assert.ok(context.sourceExamples.some(r=>r.url===detail));
 f.db.finish(f.id,f.run.id,'interrupted','Test interruption');
 const task=f.store.workspaces.tasks.enqueue(f.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const resumed=f.db.begin(f.id,{kind:'run',taskId:task.id});
 assert.deepEqual(resumed.scan.pendingUrls,[detail]);assert.equal(resumed.scanPlan.checkpoint.cursor,'"args":[]');
});

test('unfinished coverage cannot escape validation by switching completed to failed or blocked',async t=>{
 const f=fixture(t);
 for(const status of ['failed','blocked']){
  await assert.rejects(f.call('finish_automation_run',{status,summary:'Only first query/page scanned'}),/stop.kind/);
  await assert.rejects(f.call('finish_automation_run',{status,summary:'No access barrier; pages remain',stop:{kind:'incomplete',evidence:'Page 1 of 8'}}),/aynı görevde/);
  assert.equal(f.db.run(f.run.id).status,'running');assert.notEqual(f.db.sources(f.id)[0].blocked,true);
 }
 await f.call('browser_open',{url:source});
 await f.call('finish_automation_run',{status:'blocked',summary:'User login needed',stop:{kind:'access',evidence:'Login required on the actual results page'}});
 assert.equal(f.db.sources(f.id)[0].blocked,true);assert.equal(f.db.sources(f.id)[0].blocker.stop.kind,'access');
 assert.equal(automationAttention({...f.db.snapshot(f.id),activeRuns:[]})[0].retry,'source');
});

test('technical failures retain their reason when run history is not in the snapshot',async t=>{
 const f=fixture(t);
 await f.call('finish_automation_run',{status:'failed',summary:'Browser disconnected',stop:{kind:'technical',evidence:'Connection closed after reconnect'}});
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
 assert.throws(()=>automationCells([{key:'source',value:'LinkedIn'}],table),/source ve title.*company, location, score/);
 assert.deepEqual(automationCells([{key:'company',value:'Employer'},{key:'score',value:'72'}],table),{company:'Employer',score:'72'});
});
