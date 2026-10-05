import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {beginSourceScan,sourceScanScope,advanceSourceScan,validateScanCompletion,markKnownBoundary,markPageCap,FULL_SCAN_INTERVAL_MS,SCAN_OVERLAP_MS} from '../app/source-scan.mjs';
import {scanPageReport} from '../app/scan-page.mjs';

const source='https://listings.test/results',other='https://other.test/results';
const date='2026-09-25T12:00:00Z',snapshot={url:source,text:`Newest first\n${date}\n2026-09-24T12:00:00Z\nPage 1 of 20`};
const chronology={newestFirst:true,evidence:'Newest first',fromStart:true,pageComplete:true,allItemsDated:true,items:[{publishedAt:date,evidence:date}]};
const epoch=Date.parse('2026-09-30T12:00:00Z');

function fixture(t,file=':memory:'){
 const store=new WorkspaceDatabase(file);let now=epoch;const db=new AutomationStore(store,{now:()=>now});
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
 await call('browser_open',{url:source});
 db.reportPage(id,run.id,scanPageReport({url:source},{currentPage:1,totalPages:20,evidence:'Page 1 of 20'},epoch));
 const done={status:'completed',summary:'Done',scan:{complete:true,pendingUrls:[],reason:'Old items',evidenceUrl:source,completion:'cutoff'}};
 await assert.rejects(call('finish_automation_run',done),/Tarih sınırı/);
 await assert.rejects(call('finish_automation_run',{...done,scan:{...done.scan,completion:'end'}}),/Son sayfaya/);
 // Chronology is app-level checkpoint data, never an agent report.
 const args={pendingUrls:[],processedUrls:[source],reason:'Every card on this page was checked',chronology};
 const saved=db.saveScanProgress(id,run.id,args,{url:source,text:snapshot.text});assert.ok(saved.scanPlan.boundary);
 await call('browser_read',{});await assert.rejects(call('finish_automation_run',done),/Tarih sınırı/);
 assert.equal(db.sources(id)[0].scanState.active.boundary,null);
 await call('browser_read',{});db.saveScanProgress(id,run.id,args,{url:source,text:snapshot.text});
 await assert.rejects(call('finish_automation_run',{...done,goalReached:true}),/hedefinin bittiği/);
 await call('finish_automation_run',done);
 const state=db.sources(id)[0].scanState;assert.equal(state.lastSuccessfulStartAt,epoch+3600000);assert.equal(state.lastFullScanAt,epoch);assert.equal(state.active,null);
});

test('failed, interrupted and restarted workers preserve the exact cycle and cutoff in the database',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'source-scan-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.sqlite'),{store,db,id,start,finish,flow,setNow}=fixture(t,file);await finish(start());setNow(epoch+3600000);
 const run=start(),worker=flow(run);await worker.call(id,run.id,'browser_open',{url:source});
 db.saveScanProgress(id,run.id,{pendingUrls:[source+'?page=2'],reason:'Continue page two',chronology},{url:source,text:snapshot.text});
 const active=db.run(run.id).scanPlan;db.finish(id,run.id,'interrupted','App closed');store.close();
 const reopened=new WorkspaceDatabase(file),restored=new AutomationStore(reopened,{now:()=>epoch+5*86400000});t.after(()=>reopened.close());
 const task=reopened.workspaces.tasks.enqueue(id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source}),resumed=restored.begin(id,{kind:'run',taskId:task.id});
 assert.deepEqual(resumed.scanPlan,active);assert.deepEqual(resumed.scan.pendingUrls,[source+'?page=2']);
 assert.equal(restored.sources(id)[0].scanState.lastSuccessfulStartAt,epoch);
 assert.throws(()=>validateScanCompletion({...active,boundary:{url:source,runId:run.id}},{completion:'cutoff',evidenceUrl:source},null,resumed.id),/Tarih sınırı/);
 restored.finish(id,resumed.id,'failed','Access lost');assert.equal(restored.sources(id)[0].scanState.lastSuccessfulStartAt,epoch);
});

test('missing or relative dates, unreliable ordering and out-of-order cards force full coverage',()=>{
 const plan=beginSourceScan({scopeKey:'scope',lastSuccessfulStartAt:epoch,lastFullScanAt:epoch},'scope',epoch+1).active;
 for(const [change,reason] of [[undefined,'ordering_unverified'],[{...chronology,newestFirst:false},'ordering_unverified'],[{...chronology,allItemsDated:false},'dates_unverified'],[{...chronology,fromStart:false},'start_unverified'],[{...chronology,items:[{publishedAt:'Yesterday',evidence:'Yesterday'}]},'dates_unverified'],[{...chronology,items:[{publishedAt:'2026-09-24T12:00:00Z',evidence:'2026-09-24T12:00:00Z'},{publishedAt:date,evidence:date}]},'ordering_changed']]){
  const next=advanceSourceScan(plan,{chronology:change,pendingUrls:[],reason:'Progress'},{...snapshot,text:snapshot.text+'\nYesterday'},'run',epoch);
  assert.equal(next.mode,'full');assert.equal(next.reason,reason);assert.equal(next.boundary,null);
 }
 const incomplete=advanceSourceScan(plan,{chronology:{...chronology,pageComplete:false},pendingUrls:[],reason:'Still processing'},snapshot,'run',epoch);assert.equal(incomplete.boundary,null);
 const pending=advanceSourceScan(plan,{chronology,pendingUrls:[source+'/detail'],reason:'Details remain'},snapshot,'run',epoch);assert.equal(pending.boundary,null);
 const overlapDate='2026-09-29';const overlap=advanceSourceScan(plan,{chronology:{...chronology,items:[{publishedAt:overlapDate,evidence:overlapDate}]},pendingUrls:[],reason:'Date only'},{url:source,text:'Newest first '+overlapDate},'run',epoch);assert.equal(overlap.boundary,null,'Include the entire day, allowing for site timezone');
 const unverified=advanceSourceScan(plan,{chronology:{...chronology,evidence:'Unmatched ordering'},pendingUrls:[source+'/detail'],reason:'Progress'},snapshot,'run',epoch);
 assert.equal(unverified.mode,'incremental');assert.equal(unverified.boundary,null);assert.deepEqual(unverified.checkpoint.pendingUrls,[source+'/detail']);
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
 const {db,id,start,finish}=fixture(t);const scan=start();db.record(id,scan.id,{url:source+'/item',title:'Match',summary:'Observed',assessment:{score:70}});await finish(scan);
 const state=db.sources(id)[0].scanState,record=db.results(id)[0],action=start(source,record.id);
 assert.equal(action.scanPlan,undefined);db.finish(id,action.id,'completed','Application handled');assert.deepEqual(db.sources(id)[0].scanState,state);
 const stopped=start();await finish(stopped,'user_stop');assert.equal(db.sources(id)[0].scanState.lastSuccessfulStartAt,state.lastSuccessfulStartAt);
});

test('known identity lookup includes older saved results; the queue checkpoint follows the current page',async t=>{
 const {db,id,start,flow}=fixture(t),run=start(),worker=flow(run);
 for(let i=0;i<110;i++)db.record(id,run.id,{url:source+'/item/'+i,title:'Match '+i,summary:'Observed',assessment:{score:70}});
 let context=await worker.call(id,run.id,'get_automation_context',{});
 if(context.context){let fragment=context,text=fragment.text;while(fragment.context.nextOffset!==null){fragment=await worker.call(id,run.id,'read_automation_context_part',{contextId:fragment.context.id,offset:fragment.context.nextOffset});text+=fragment.text;}context=JSON.parse(text);}
 assert.equal(context.results.length,0);assert.ok(!context.results.some(r=>r.url===source+'/item/0'));
 const [known,unknown]=db.knownResults(id,run.id,[source+'/item/0',source+'/missing']);assert.equal(known.known,true);assert.equal(unknown.known,false);
 await worker.call(id,run.id,'browser_open',{url:source});await worker.call(id,run.id,'browser_open',{url:source+'?page=2'});
 const saved=db.saveScanProgress(id,run.id,{pendingUrls:[],reason:'Current page'},{url:source+'?page=2',text:''});
 assert.equal(saved.scanPlan.checkpoint.url,source+'?page=2');
});

test('a recipe ordered newest-first keeps the incremental plan and ends at a known-listing boundary',()=>{
 const scopeKey='scope',start=1_700_000_000_000,saved={scopeKey,lastSuccessfulStartAt:start,lastFullScanAt:start,lastSuccessfulAt:start+1000};
 const plan=beginSourceScan(saved,scopeKey,start+3600_000,{ordering:'newest_first'}).active;
 assert.equal(plan.mode,'incremental');assert.equal(plan.ordering,'recipe');
 assert.equal(beginSourceScan(saved,scopeKey,start+3600_000,{ordering:null}).active.ordering,undefined,'without the recipe flag nothing changes');
 assert.equal(beginSourceScan(saved,scopeKey,start+FULL_SCAN_INTERVAL_MS+1,{ordering:'newest_first'}).active.ordering,undefined,'the periodic full scan still covers the board');
 const page={url:'https://board.test/jobs?page=2',text:''};
 const advanced=advanceSourceScan(plan,{pendingUrls:[],reason:'known page'},page,'run-1',start+3700_000);
 assert.equal(advanced.mode,'incremental','missing chronology no longer downgrades a recipe-ordered plan');
 const fullPlan={...advanced,mode:'full'};assert.equal(markKnownBoundary(fullPlan,page.url,'run-1',1),fullPlan,'a full scan never gets a known boundary');
 const bounded=markKnownBoundary(advanced,page.url,'run-1',start+3700_001);
 assert.deepEqual(bounded.boundary,{url:page.url,runId:'run-1',known:true,at:start+3700_001});
 assert.equal(validateScanCompletion(bounded,{complete:true,pendingUrls:[],completion:'cutoff',evidenceUrl:'https://board.test/anywhere'},null,'run-1'),'cutoff');
 assert.throws(()=>validateScanCompletion(bounded,{complete:true,pendingUrls:[],completion:'cutoff',evidenceUrl:page.url},null,'run-2'),/doğrulanmadı/);
 assert.throws(()=>validateScanCompletion({...bounded,checkpoint:{...bounded.checkpoint,pendingUrls:['https://board.test/view/1']}},{complete:true,pendingUrls:[],completion:'cutoff',evidenceUrl:page.url},null,'run-1'),/bekleyen/);
});

test('a resumed scan takes the page cap of the current recipe',()=>{
 const started=beginSourceScan(null,'scope',1000,{pageCap:25});assert.equal(started.active.pageCap,25);
 const capped={...started,active:markPageCap(started.active,'https://board.test/p25','run-1',1100)};
 const resumed=beginSourceScan(capped,'scope',2000,{pageCap:10});
 assert.equal(resumed.active.pageCap,10);assert.equal(resumed.active.boundary,null,'an old cap boundary no longer applies');
 assert.equal(resumed.active.id,started.active.id);assert.equal(resumed.active.startedAt,1000);
 assert.equal(beginSourceScan(resumed,'scope',3000,{pageCap:10}),resumed,'an unchanged cap keeps the plan');
 assert.equal('pageCap' in beginSourceScan(resumed,'scope',3000,{pageCap:null}).active,false,'a newest-first recipe drops the cap');
});

test('a recipe without a known ordering caps every search at its first pages',()=>{
 const scopeKey='scope',start=1_700_000_000_000;
 const plan=beginSourceScan(null,scopeKey,start,{pageCap:10}).active;
 assert.equal(plan.mode,'full');assert.equal(plan.pageCap,10);
 assert.equal(beginSourceScan(null,scopeKey,start,{pageCap:null}).active.pageCap,undefined);
 const page={url:'https://board.test/jobs?page=10',text:''};
 assert.equal(markPageCap({...plan,pageCap:undefined},page.url,'run-1',1).boundary,null,'no cap, no boundary');
 const capped=markPageCap(plan,page.url,'run-1',start+1);
 assert.deepEqual(capped.boundary,{url:page.url,runId:'run-1',pageCap:true,at:start+1});
 const advanced=advanceSourceScan(capped,{pendingUrls:[],reason:'reviewed'},page,'run-1',start+2);
 assert.equal(advanced.boundary.pageCap,true,'queue updates keep the cap boundary');
 assert.equal(advanceSourceScan({...capped,mode:'incremental',cutoffAt:start-1},{pendingUrls:[],reason:'reviewed'},page,'run-1',start+2).boundary.pageCap,true,'the full-coverage fallback keeps it too');
 const progress={url:page.url,currentPage:10,totalPages:48};
 assert.equal(validateScanCompletion(advanced,{complete:true,pendingUrls:[],completion:'end',evidenceUrl:page.url},progress,'run-1'),'end');
 assert.throws(()=>validateScanCompletion(plan,{complete:true,pendingUrls:[],completion:'end',evidenceUrl:page.url},progress,'run-1'),/Son sayfaya/,'without the boundary the board must be covered');
 assert.throws(()=>validateScanCompletion(advanced,{complete:true,pendingUrls:[],completion:'end',evidenceUrl:page.url},progress,'run-2'),/doğrulanmadı/);
 assert.throws(()=>validateScanCompletion({...advanced,checkpoint:{...advanced.checkpoint,pendingUrls:['https://board.test/view/1']}},{complete:true,pendingUrls:[],completion:'end',evidenceUrl:page.url},progress,'run-1'),/bekleyen/);
});
