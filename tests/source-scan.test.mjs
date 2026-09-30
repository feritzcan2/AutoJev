import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {beginSourceScan,sourceScanScope,advanceSourceScan,validateScanCompletion,FULL_SCAN_INTERVAL_MS,SCAN_OVERLAP_MS} from '../app/source-scan.mjs';
import {validate} from '../app/tool-schema.mjs';

const source='https://listings.test/results',other='https://other.test/results';
const date='2026-09-25T12:00:00Z',snapshot={url:source,text:`Newest first\n${date}\n2026-09-24T12:00:00Z\nPage 1 of 20`};
const chronology={newestFirst:true,evidence:'Newest first',fromStart:true,pageComplete:true,allItemsDated:true,items:[{publishedAt:date,evidence:date}]};
const epoch=Date.parse('2026-09-30T12:00:00Z');

function fixture(t,file=':memory:'){
 const store=new Store(file);let now=epoch;const db=new AutomationStore(store,{now:()=>now});
 t.after(()=>{try{store.close();}catch{}});
 const a=db.create('custom',{goal:'Find matching listings',criteria:Object.fromEntries(db.template('custom').fields.filter(f=>f.required).map(f=>[f.id,'Test criteria'])),sources:[source,other]});
 db.review(a.id);const trial=db.begin(a.id,'trial');for(const url of a.sources)db.observe(a.id,trial.id,url,'Listings');db.finish(a.id,trial.id,'completed','Read');db.enable(a.id);
 const start=(url=source,recordId)=>{const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:url,sources:[url],recordId,lockKey:'source:'+url});return db.begin(a.id,{kind:'run',taskId:task.id});};
 const flow=run=>{let url=source;return automationWorkflow({db,run,signal:{aborted:false},browser:{async call(id,name,args){if(name==='browser_navigate')url=args.url;return {content:[{type:'text',text:'Page URL: '+url+'\n'+JSON.stringify({text:snapshot.text,links:[{url:source+'?page=2'}]})}]};}},report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});};
 const finish=async(run,completion='end')=>{const worker=flow(run);await worker.call(a.id,run.id,'browser_open',{url:source});await worker.call(a.id,run.id,'finish_automation_run',{status:'completed',summary:'Coverage complete',scan:{complete:true,pendingUrls:[],reason:'All required listings checked',evidenceUrl:source,completion}});};
 return {store,db,id:a.id,start,flow,finish,setNow:value=>{now=value;}};
}

test('first scan covers all pages, subsequent scan uses start watermark with overlap, periodic scan is full',async t=>{
 const {db,id,start,finish,setNow}=fixture(t);
 const first=start();assert.equal(first.scanPlan.mode,'full');assert.equal(first.scanPlan.cutoffAt,null);
 setNow(epoch+3600000);await finish(first);
 const state=db.sources(id)[0].scanState;assert.equal(state.lastSuccessfulStartAt,epoch);assert.equal(state.lastFullScanAt,epoch+3600000);
 setNow(epoch+7200000);const next=start();assert.equal(next.scanPlan.mode,'incremental');assert.equal(next.scanPlan.cutoffAt,epoch-SCAN_OVERLAP_MS);
 db.finish(id,next.id,'blocked','Login required');assert.equal(db.sources(id)[0].scanState.lastSuccessfulStartAt,epoch);
 const completed={...state,active:null};assert.equal(beginSourceScan(completed,state.scopeKey,state.lastFullScanAt+FULL_SCAN_INTERVAL_MS).active.mode,'full');
 assert.equal(db.sources(id)[1].scanState,undefined);
});

test('incremental finish needs current full-page chronology, not known results or a claimed cutoff',async t=>{
 const {db,id,start,finish,flow,setNow}=fixture(t);await finish(start());setNow(epoch+3600000);
 const run=start(),worker=flow(run),call=(name,args)=>worker.call(id,run.id,name,args);
 const observed=await call('browser_open',{url:source});
 await call('report_scan_page',{snapshotId:observed.snapshot.id,currentPage:1,totalPages:20,evidence:'Page 1 of 20'});
 const done={status:'completed',summary:'Done',scan:{complete:true,pendingUrls:[],reason:'Old items',evidenceUrl:source,completion:'cutoff'}};
 await assert.rejects(call('finish_automation_run',done),/Tarih sınırı/);
 await assert.rejects(call('finish_automation_run',{...done,scan:{...done.scan,completion:'end'}}),/Son sayfaya/);
 const args={snapshotId:observed.snapshot.id,pendingUrls:[],reason:'Every card on this page was checked',chronology};
 validate(worker.tools.find(t=>t.name==='save_scan_progress').inputSchema,args);
 const saved=await call('save_scan_progress',args);assert.ok(saved.scanPlan.boundary);
 await call('browser_read',{});await assert.rejects(call('finish_automation_run',done),/Tarih sınırı/);
 assert.equal(db.sources(id)[0].scanState.active.boundary,null);
 const refreshed=await call('browser_read',{});await call('save_scan_progress',{...args,snapshotId:refreshed.snapshot.id});
 await assert.rejects(call('finish_automation_run',{...done,goalReached:true}),/hedefinin bittiği/);
 await call('finish_automation_run',done);
 const state=db.sources(id)[0].scanState;assert.equal(state.lastSuccessfulStartAt,epoch+3600000);assert.equal(state.lastFullScanAt,epoch);assert.equal(state.active,null);
});

test('failed, interrupted and restarted workers preserve the exact cycle and cutoff in the database',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'source-scan-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.sqlite'),{store,db,id,start,finish,flow,setNow}=fixture(t,file);await finish(start());setNow(epoch+3600000);
 const run=start(),worker=flow(run),observed=await worker.call(id,run.id,'browser_open',{url:source});
 await worker.call(id,run.id,'save_scan_progress',{snapshotId:observed.snapshot.id,pendingUrls:[source+'?page=2'],reason:'Continue page two',chronology});
 const active=db.run(run.id).scanPlan;db.finish(id,run.id,'interrupted','App closed');store.close();
 const reopened=new Store(file),restored=new AutomationStore(reopened,{now:()=>epoch+5*86400000});t.after(()=>reopened.close());
 const task=reopened.workspaces.tasks.enqueue(id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source}),resumed=restored.begin(id,{kind:'run',taskId:task.id});
 assert.deepEqual(resumed.scanPlan,active);assert.deepEqual(resumed.scan.pendingUrls,[source+'?page=2']);
 assert.equal(restored.sources(id)[0].scanState.lastSuccessfulStartAt,epoch);
 assert.throws(()=>validateScanCompletion({...active,boundary:{url:source,runId:run.id}},{completion:'cutoff',evidenceUrl:source},null,resumed.id),/Tarih sınırı/);
 restored.finish(id,resumed.id,'failed','Access lost');assert.equal(restored.sources(id)[0].scanState.lastSuccessfulStartAt,epoch);
});

test('missing or relative dates, unreliable ordering and out-of-order cards force full coverage',()=>{
 const plan=beginSourceScan({scopeKey:'scope',lastSuccessfulStartAt:epoch,lastFullScanAt:epoch},'scope',epoch+1).active;
 for(const [change,reason] of [[undefined,'ordering_unverified'],[{...chronology,newestFirst:false},'ordering_unverified'],[{...chronology,allItemsDated:false},'dates_unverified'],[{...chronology,fromStart:false},'start_unverified'],[{...chronology,items:[{publishedAt:date,evidence:'Yesterday'}]},'dates_unverified'],[{...chronology,items:[{publishedAt:'2026-09-24T12:00:00Z',evidence:'2026-09-24T12:00:00Z'},{publishedAt:date,evidence:date}]},'ordering_changed']]){
  const next=advanceSourceScan(plan,{chronology:change,pendingUrls:[],reason:'Progress'},{...snapshot,text:snapshot.text+'\nYesterday'},'run',epoch);
  assert.equal(next.mode,'full');assert.equal(next.reason,reason);assert.equal(next.boundary,null);
 }
 const incomplete=advanceSourceScan(plan,{chronology:{...chronology,pageComplete:false},pendingUrls:[],reason:'Still processing'},snapshot,'run',epoch);assert.equal(incomplete.boundary,null);
 const pending=advanceSourceScan(plan,{chronology,pendingUrls:[source+'/detail'],reason:'Details remain'},snapshot,'run',epoch);assert.equal(pending.boundary,null);
 const overlapDate='2026-09-29';const overlap=advanceSourceScan(plan,{chronology:{...chronology,items:[{publishedAt:overlapDate,evidence:overlapDate}]},pendingUrls:[],reason:'Date only'},{url:source,text:'Newest first '+overlapDate},'run',epoch);assert.equal(overlap.boundary,null,'Include the entire day, allowing for site timezone');
 assert.throws(()=>advanceSourceScan(plan,{chronology:{...chronology,evidence:'Invented ordering'},pendingUrls:[],reason:'Progress'},snapshot,'run',epoch),/gözleminde/);
});

test('source criteria invalidate only that source; schedule changes preserve history',async t=>{
 const {db,id,start,finish}=fixture(t);await finish(start());const before=db.sources(id)[0].scanState;
 db.saveSource(id,source,{intervalMinutes:60});assert.deepEqual(db.sources(id)[0].scanState,before);
 db.saveSource(id,source,{query:'Different city'});assert.equal(db.sources(id)[0].scanState,undefined);
 const next=start();assert.equal(next.scanPlan.mode,'full');assert.notEqual(next.scanPlan.scopeKey,before.scopeKey);
 db.finish(id,next.id,'interrupted','Stop');
 const a=db.get(id);assert.notEqual(sourceScanScope(a,source),sourceScanScope({...a,criteria:{different:'criteria'}},source));
 assert.equal(sourceScanScope(a,source),sourceScanScope({...a,intervalMinutes:100,agentSettings:{provider:'other'}},source));
});

test('record actions and user stopping conditions do not advance source coverage',async t=>{
 const {db,id,start,finish}=fixture(t);const scan=start();db.record(id,scan.id,{url:source+'/item',title:'Match',summary:'Observed'});await finish(scan);
 const state=db.sources(id)[0].scanState,record=db.results(id)[0],action=start(source,record.id);
 assert.equal(action.scanPlan,undefined);db.finish(id,action.id,'completed','Application handled');assert.deepEqual(db.sources(id)[0].scanState,state);
 const stopped=start();await finish(stopped,'user_stop');assert.equal(db.sources(id)[0].scanState.lastSuccessfulStartAt,state.lastSuccessfulStartAt);
});

test('known identity lookup includes older saved results outside the context sample and rejects foreign snapshots',async t=>{
 const {db,id,start,flow}=fixture(t),run=start(),worker=flow(run);
 for(let i=0;i<110;i++)db.record(id,run.id,{url:source+'/item/'+i,title:'Match '+i,summary:'Observed'});
 const context=await worker.call(id,run.id,'get_automation_context',{});assert.equal(context.results.length,100);assert.ok(!context.results.some(r=>r.url===source+'/item/0'));
 const [known,unknown]=await worker.call(id,run.id,'lookup_scan_results',{keys:[source+'/item/0',source+'/missing']});assert.equal(known.known,true);assert.equal(unknown.known,false);
 const observed=await worker.call(id,run.id,'browser_open',{url:source});await worker.call(id,run.id,'browser_open',{url:source+'?page=2'});
 await assert.rejects(worker.call(id,run.id,'save_scan_progress',{snapshotId:observed.snapshot.id,pendingUrls:[],reason:'Stale'}),/eski/);
});
