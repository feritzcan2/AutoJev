import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {BrowserSnapshot} from '../app/browser-snapshot.mjs';
import {readBrowserEvidence} from '../app/browser-evidence-read.mjs';
import {assessmentEvidence,assessmentListingText} from '../app/record-evidence.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';

function fixture(t){
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core);
 const a=db.create('job-search',{goal:'Jobs',criteria:{preferences:'Remote',ranking:'Skills'},sources:['https://example.test/jobs']});db.review(a.id);
 const seed=db.begin(a.id,'run'),record=db.record(a.id,seed.id,{url:'https://example.test/jobs/one',title:'One',summary:'Saved'});db.finish(a.id,seed.id,'completed','Saved');
 const run={automationId:a.id,id:'first',taskId:'task',recordId:record.id,observations:[]},snapshots=new BrowserSnapshot();
 snapshots.capture({url:record.url,content:[{type:'text',text:'Full listing: '+ 'Required skills. '.repeat(1000)}]});db.browserEvidence.save(run,snapshots.current);
 const page=snapshots.current;snapshots.invalidate();
 return {db,run,record,snapshots,page,read:(args,overrides={},method='read')=>readBrowserEvidence({db,run:{...run,...overrides},snapshots,method,args})};
}

test('same-task text survives a new run and stale ID recovery resets the offset',t=>{
 const f=fixture(t),before=JSON.stringify(f.run);
 const exact=f.read({snapshotId:f.page.id,offset:200},{id:'resumed'});
 assert.equal(exact.snapshot.offset,200);assert.equal(exact.historical,true);
 const rebound=f.read({snapshotId:'expired-before-upgrade',offset:99999},{id:'resumed'});
 assert.equal(rebound.snapshot.id,f.page.id);assert.equal(rebound.snapshot.offset,0);assert.equal(rebound.recovery.offsetReset,true);
 assert.equal(assessmentListingText(f.db,f.run.automationId,{...f.run,id:'resumed'},f.record.url),f.page.text);
 assert.ok(assessmentEvidence(f.db,f.run.automationId,f.run,f.record.url));
 assert.equal(JSON.stringify(f.run),before);assert.equal(f.snapshots.current,null);
 assert.throws(()=>f.snapshots.get(f.page.id),/gözlemi eski/,'Historical text cannot authorize browser actions');
});

test('recovery cannot read another task, workspace, search or record',t=>{
 const f=fixture(t);
 for(const patch of [{taskId:'other'},{automationId:'other'},{recordId:'other'},{scan:{work:{activeSearchId:'other'}}}])assert.throws(()=>f.read({snapshotId:f.page.id},patch),/gözlemi eski/);
 const other={...f.run,taskId:'other'};f.db.browserEvidence.save(other,{...f.page,id:'foreign'});
 assert.throws(()=>f.read({snapshotId:'foreign'}),/gözlemi eski/,'Do not silently rebind a known foreign ID');
 assert.equal(assessmentListingText(f.db,'other',f.run,f.record.url),'');
});

test('unknown IDs in source scans cannot guess a listing; known saved pages remain searchable',t=>{
 const f=fixture(t),sourceRun={...f.run,recordId:undefined};f.db.browserEvidence.save(sourceRun,{...f.page,id:'source-page'});
 assert.throws(()=>f.read({snapshotId:'unknown'},sourceRun),/gözlemi eski/);
 const search=f.read({snapshotId:'source-page',query:'Required'},sourceRun,'search');assert.equal(search.matches.length,5);assert.equal(search.historical,true);
});

test('real workflow capture persists full text and rebuilding reuses it without browser calls',async t=>{
 const f=fixture(t),run=f.db.begin(f.run.automationId,'run');let reads=0;
 const options={db:f.db,run,signal:new AbortController().signal,browser:{call:async()=>{reads++;return {content:[{type:'text',text:`Page URL: ${f.record.url}\n${f.page.text}`}]};}},report:()=>{}};
 const first=automationWorkflow(options),observed=await first.call(run.automationId,run.id,'browser_read',{});
 const resumed=automationWorkflow(options),read=await resumed.call(run.automationId,run.id,'browser_read_part',{snapshotId:observed.snapshot.id,offset:9000});
 assert.equal(read.snapshot.offset,9000);assert.equal(read.historical,true);assert.equal(reads,1);
 assert.ok(assessmentListingText(f.db,run.automationId,f.db.run(run.id),f.record.url).includes(f.page.text));
});

test('browser text exists only in this app instance and can be released per task',t=>{
 const f=fixture(t),next=new AutomationStore(f.db.store);
 assert.equal(next.browserEvidence.get(f.run,f.page.id),null);
 assert.equal(next.browserEvidence.latest(f.run,f.page.url),null);
 assert.deepEqual(f.db.db.prepare("SELECT name FROM sqlite_master WHERE name='automation_browser_evidence'").all(),[]);
 const other={...f.run,taskId:'other'};f.db.browserEvidence.save(other,{...f.page,id:'other-page'});
 f.db.browserEvidence.release(f.run.automationId,f.run.taskId);
 assert.equal(f.db.browserEvidence.get(f.run,f.page.id),null);assert.equal(f.db.browserEvidence.get(other,'other-page').text,f.page.text);
});
