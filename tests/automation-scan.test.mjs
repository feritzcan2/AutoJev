import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {observedLinks,scanCheckpoint} from '../app/automation-scan.mjs';
import {scanPageReport,scanPageLabel} from '../app/scan-page.mjs';
import {webWorkspaceView} from '../app/workspace-view.mjs';
import {validate} from '../app/tool-schema.mjs';
const source='https://homes.test/results',second=source+'?page=2',third=source+'?page=3';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,template='housing'){
 const store=new Store(':memory:'),db=new AutomationStore(store),a=db.create(template,{goal:'Find all matching results',criteria:Object.fromEntries(db.template(template).fields.filter(f=>f.required).map(f=>[f.id,'Test criteria'])),sources:[source]});
 db.review(a.id);const trial=db.begin(a.id,'trial');db.observe(a.id,trial.id,source,'Results');db.finish(a.id,trial.id,'completed','Read');
 const launches=[],runtime=new WebTasks(db,{launch:async run=>{launches.push(run);return {close:async()=>{}};}});t.after(async()=>{await runtime.close();store.close();});
 const workflow=run=>{let current;return automationWorkflow({db,run,signal:new AbortController().signal,browser:{async call(id,name,args){if(name==='browser_navigate')current=args.url;const page=[source,second,third].indexOf(current)+1,links=page&&page<3?[{text:'Next page',url:[source,second,third][page]}]:[];return {content:[{type:'text',text:'Page URL: '+current+'\n'+JSON.stringify({url:current,text:page?`Results. Page ${page} of 3`:'Detail',links})}]};}},report:(id,runId,status,summary,goal)=>runtime.report(id,runId,status,summary,goal)});};
 return {store,db,id:a.id,runtime,launches,workflow};
}
async function reportPage(flow,id,run,page){const observed=await flow.call(id,run.id,'browser_open',{url:[source,second,third][page-1]});return flow.call(id,run.id,'report_scan_page',{snapshotId:observed.snapshot.id,currentPage:page,totalPages:3,evidence:`Page ${page} of 3`});}

test('template-free custom automations enforce source coverage too',async t=>{
 const {id,runtime,launches,workflow}=fixture(t,'custom');await runtime.runOnce(id);await settle();
 const run=launches[0];await reportPage(workflow(run),id,run,1);
 await assert.rejects(workflow(run).call(id,run.id,'finish_automation_run',{status:'completed',summary:'First page checked'}),/Tarama kapsamı gerekli/);
});

test('source coverage is required and partial work cannot voluntarily rotate agents',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();const run=launches[0],flow=workflow(run);
 await reportPage(flow,id,run,1);
 for(let n=0;n<2;n++)db.record(id,run.id,{url:'https://homes.test/listing/'+n,title:'Result',summary:'Observed'});
 await assert.rejects(flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'Two found'}),/Tarama kapsamı gerekli/);
 await assert.rejects(flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'Done',scan:{complete:true,pendingUrls:[second],reason:'Page two remains',evidenceUrl:source}}),/Bekleyen/);
 await assert.rejects(flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'Stop here',scan:{complete:false,pendingUrls:[second],reason:'More remain',evidenceUrl:source}}),/Süre veya adım sınırı yok/);
 assert.equal(db.run(run.id).status,'running');assert.equal(launches.length,1);
});

test('one agent processes every page without a timer or browser step cap, including old profiles',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);
 db.db.prepare("UPDATE automations SET data=json_set(data,'$.timeoutMinutes',0.00001,'$.maxBrowserSteps',1) WHERE id=?").run(id);
 await runtime.runOnce(id);await settle();const run=launches[0],flow=workflow(run);
 assert.equal(runtime.slots(id)[0].timer,undefined);
 db.putRun({...db.run(run.id),startedAt:Date.now()-86400000,browserSteps:9999});
 for(let page=1;page<=3;page++){await reportPage(flow,id,run,page);await runtime.tick();assert.equal(launches.length,1);assert.equal(db.sources(id)[0].pageProgress.currentPage,page);}
 const context=await flow.call(id,run.id,'get_automation_context',{});assert.equal(context.currentRun.budget,undefined);assert.equal(context.automation.timeoutMinutes,undefined);assert.equal(context.automation.maxBrowserSteps,undefined);
 assert.equal(db.run(run.id).browserSteps,10002);
 const finalPage=await flow.call(id,run.id,'browser_read',{});await flow.call(id,run.id,'save_scan_progress',{snapshotId:finalPage.snapshot.id,pendingUrls:[],processedUrls:[source,second,third],reason:'All three pages processed'});
 await flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'All pages processed',scan:{complete:true,pendingUrls:[],reason:'Final page and all relevant details processed',evidenceUrl:third}});
 await runtime.finish(id);await runtime.tick();assert.equal(db.get(id).status,'paused');assert.equal(db.sources(id)[0].scan.complete,true);
 await runtime.runSource(id,source);await settle();assert.equal(db.sources(id)[0].pageProgress,null);assert.equal(launches[1].pageProgress,undefined);
});

for(const template of ['housing','appointment','custom'])test(`${template}: page checkpoint is immediate and another worker resumes the same source task`,async t=>{
 const {store,db,id,runtime,launches,workflow}=fixture(t,template);await runtime.runOnce(id);await settle();const run=launches[0],flow=workflow(run);
 await reportPage(flow,id,run,2);await flow.call(id,run.id,'browser_open',{url:'https://homes.test/detail/one'});
 assert.deepEqual(db.get(id).sourceState[source].scan.pendingUrls,[second]);assert.equal(db.store.workspaces.tasks.get(id,run.taskId).scan.evidenceUrl,second);
 const snapshot=db.snapshot(id),view=webWorkspaceView({...snapshot,activeRun:run,activeRuns:[run]},{sessions:new Map()});
 assert.equal(view.workers[0].presentation.pageProgress.currentPage,2,'worker UI reads persisted progress, not stale runtime slot data');
 await runtime.stopWorker(id,'main');assert.equal(db.sources(id)[0].blocked,false);assert.equal(db.store.workspaces.tasks.get(id,run.taskId).state,'pending');
 const worker=store.workspaces.workers.add(id);await runtime.tick();await settle();const next=launches[1];assert.equal(next.workerId,worker.id);assert.equal(next.taskId,run.taskId);
 const context=await workflow(next).call(id,next.id,'get_automation_context',{});assert.deepEqual(context.scanProgress.pendingUrls,[second]);assert.equal(context.currentRun.pageProgress.currentPage,2);
});

test('an unclean app exit recovers the last page without marking the source blocked',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();const run=launches[0];await reportPage(workflow(run),id,run,2);
 runtime.active.clear();runtime.closed=true;
 const nextRuns=[],recovered=new WebTasks(db,{launch:async next=>{nextRuns.push(next);return {close:async()=>{}};}});
 try{await recovered.tick();await settle();assert.equal(nextRuns.length,1);assert.equal(nextRuns[0].taskId,run.taskId);assert.deepEqual(nextRuns[0].scan.pendingUrls,[second]);assert.equal(db.sources(id)[0].blocked,false);}finally{await recovered.close();}
});

test('user pause saves progress without restarting until explicitly resumed',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();const run=launches[0];await reportPage(workflow(run),id,run,2);
 await runtime.pause(id);await runtime.tick();assert.equal(launches.length,1);assert.equal(db.get(id).status,'paused');
 await runtime.runSource(id,source);await settle();assert.deepEqual(launches[1].scan.pendingUrls,[second]);assert.equal(launches[1].pageProgress.currentPage,2);
});

test('page reports require current owned snapshots and do not fabricate missing totals',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();const run=launches[0],flow=workflow(run),observed=await flow.call(id,run.id,'browser_open',{url:source}),base={snapshotId:observed.snapshot.id,currentPage:1,totalPages:3,evidence:'Page 1 of 3'};
 const schema=flow.tools.find(t=>t.name==='report_scan_page').inputSchema;
 assert.doesNotThrow(()=>validate(schema,base));assert.doesNotThrow(()=>validate(schema,{snapshotId:base.snapshotId,currentPage:1,evidence:'Page 1'}));
 await assert.rejects(flow.call('foreign',run.id,'report_scan_page',base),/geçersiz/);
 await assert.rejects(flow.call(id,run.id,'report_scan_page',{...base,totalPages:71,evidence:'Page 1 of 71'}),/bulunamadı/);
 await flow.call(id,run.id,'browser_open',{url:second});await assert.rejects(flow.call(id,run.id,'report_scan_page',base),/gözlemi eski/);
 assert.equal(db.sources(id)[0].pageProgress,null);
 const progress=scanPageReport({url:second,text:'- navigation: Page 2 · Next'},{currentPage:2,totalPages:null,evidence:'Page 2'},1);
 assert.equal(scanPageLabel(progress),'2. sayfa');assert.equal(scanPageLabel({...progress,totalPages:71}),'Sayfa 2 / 71');assert.equal(scanPageLabel(null),'');
 assert.throws(()=>scanPageReport({url:second,text:'Page 2'},{currentPage:2,totalPages:1,evidence:'Page 2'},1),/Geçerli/);
});

test('numbered Jev titles save page progress when pagination controls are absent',async t=>{
 const {db,id,runtime,launches}=fixture(t);await runtime.runOnce(id);await settle();const run=launches[0],url=source+'?page=8',title='Mietwohnung in Berlin Seite 8 | example.test';
 const raw={url,title,text:'176 - 200 von 6.708 Mietwohnungen in Berlin',pagination:[],scrollTargets:[]};
 const flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:{async call(){return {content:[{type:'text',text:'Page URL: '+url+'\n'+JSON.stringify(raw)}]};}}});
 const observed=await flow.call(id,run.id,'browser_open',{url}),args={snapshotId:observed.snapshot.id,currentPage:8,evidence:title};
 await assert.rejects(flow.call(id,run.id,'report_scan_page',{...args,evidence:raw.text}),/İlan sayısı/);
 await assert.rejects(flow.call(id,run.id,'report_scan_page',{...args,evidence:url}),/bulunamadı/);
 await assert.rejects(flow.call(id,run.id,'report_scan_page',{...args,totalPages:269}),/Bildirilen sayfa/);
 await flow.call(id,run.id,'report_scan_page',args);
 const snapshot=db.snapshot(id),view=webWorkspaceView({...snapshot,activeRun:run,activeRuns:[run]},{sessions:new Map()});
 assert.equal(scanPageLabel(snapshot.sources[0].pageProgress),'8. sayfa');assert.equal(scanPageLabel(view.workers[0].presentation.pageProgress),'8. sayfa');
 assert.deepEqual(snapshot.sources[0].scan.pendingUrls,[url]);assert.equal(db.run(run.id).pageProgress.evidence,title);
});

test('a long source task remains visible after more than thirty other runs',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();const run=launches[0];await reportPage(workflow(run),id,run,2);
 for(let n=0;n<35;n++)db.putRun({...run,id:'other-'+n,status:'completed',sourceUrl:'https://other.test/',sources:['https://other.test/']});
 assert.ok(db.runs(id).some(r=>r.id===run.id));assert.equal(db.sources(id)[0].scanning,true);assert.equal(db.sources(id)[0].pageProgress.currentPage,2);
});

test('genuine source blockers still stop immediately and preserve the checkpoint',async t=>{
 const {db,id,runtime,launches,workflow}=fixture(t);await runtime.runOnce(id);await settle();const run=launches[0],flow=workflow(run);await reportPage(flow,id,run,2);
 await flow.call(id,run.id,'finish_automation_run',{status:'blocked',summary:'Login required',stop:{kind:'access',evidence:'Login form on results page'}});await runtime.finish(id);await runtime.tick();
 assert.equal(db.sources(id)[0].blocked,true);assert.deepEqual(db.sources(id)[0].scan.pendingUrls,[second]);assert.equal(launches.length,1);
});

test('scan evidence and continuation URLs must be observed, scoped and consistent',()=>{
 const run={kind:'run',sourceUrl:source,observedLinks:[second],navigation:[{url:source}]},base={complete:false,pendingUrls:[second],reason:'Next page',evidenceUrl:source};
 assert.deepEqual(scanCheckpoint(run,base),base);
 for(const pendingUrls of [[third],['https://other.test/page'],[]])assert.throws(()=>scanCheckpoint(run,{...base,pendingUrls}));
 assert.throws(()=>scanCheckpoint(run,{...base,evidenceUrl:second}),/bu turda/);assert.throws(()=>scanCheckpoint({...run,recordId:'one'},base),/kaynak görevine/);
 const response={content:[{type:'text',text:`Page URL: ${source}\n- link "Next":\n  - /url: /results?page=2`}]};assert.ok(observedLinks(response,source).includes(second));
});

test('legacy partial checkpoints remain recoverable after upgrade',async t=>{
 const {db,id,runtime}=fixture(t);db.enable(id);const queue=db.store.workspaces.tasks,task=queue.enqueue(id,{sourceUrl:source,sources:[source],batchId:'recovery',operation:'scan',lockKey:'source:'+source});
 const run=db.begin(id,{kind:'run',taskId:task.id}),scan={complete:false,pendingUrls:[second],reason:'Next page remains',evidenceUrl:source};
 db.putRun({...run,scan});db.finish(id,run.id,'partial','Continue',{release:false});runtime.policy.recover();
 const resumed=queue.get(id,task.id);assert.equal(resumed.state,'pending');assert.equal(resumed.workerId,null);assert.deepEqual(resumed.scan,scan);
});
