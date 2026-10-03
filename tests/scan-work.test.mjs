import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {sourceStop} from '../app/automation-stop.mjs';
import {validate} from '../app/tool-schema.mjs';
import {hasUnblockedScanWork} from '../app/scan-work.mjs';

test('site waits retain reachable details and undiscovered searches across search scopes',()=>{
 const run={scan:{work:{activeSearchId:'one',searches:[{id:'one',status:'pending',pendingUrls:['https://blocked.test/role']},{id:'two',status:'pending',pendingUrls:[]}]}}};
 assert.equal(hasUnblockedScanWork(run,['blocked.test']),true);
 run.scan.work.searches[1].pendingUrls=['https://blocked.test/other'];assert.equal(hasUnblockedScanWork(run,['blocked.test']),false);
 run.scan.work.searches[1].pendingUrls.push('https://reachable.test/role');assert.equal(hasUnblockedScanWork(run,['blocked.test']),true);
 run.scan.work.searches[1].status='completed';assert.equal(hasUnblockedScanWork(run,['blocked.test']),false);
});

const source='https://example.test/search',p=n=>source+'?page='+n;
function fixture(t,template='custom'){
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),definition=db.template(template);
 t.after(()=>store.close());
 const a=db.create(template,{goal:'Find suitable records',criteria:Object.fromEntries(definition.fields.filter(f=>f.required).map(f=>[f.id,'Known criteria'])),sources:[source]});
 db.review(a.id);db.skipTrial(a.id);db.enable(a.id);
 const start=()=>{const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});return db.begin(a.id,{kind:'run',taskId:task.id});};
 const run=start();
 const observe=(url,links=[],text='Observed records')=>{db.observe(a.id,run.id,url,text,links);return {url,text};};
 const page=(n,total=8,url=p(n))=>{observe(url);return db.reportPage(a.id,run.id,{url,currentPage:n,totalPages:total,evidence:`${n} / ${total}`,at:db.now()});};
 const save=(input,snapshot)=>db.saveScanProgress(a.id,run.id,{pendingUrls:[],reason:'Verified work',...input},snapshot);
 return {store,db,id:a.id,run,start,observe,page,save};
}

for(const template of ['job-search','housing','custom'])test(`${template}: recovery visits cannot roll back the saved page or drop pending work`,t=>{
 const f=fixture(t,template);f.page(7);const snapshot=f.observe(p(7),[p(8)]);
 f.save({pendingUrls:[p(8)],processedUrls:[p(7)]},snapshot);
 const checkpoint=f.db.run(f.run.id).scanPlan.checkpoint;
 const recovery=f.page(1);
 assert.equal(recovery.revisiting,true);assert.equal(recovery.observedPage.currentPage,1);assert.equal(recovery.pageProgress.currentPage,7);
 assert.deepEqual(f.db.run(f.run.id).scan.pendingUrls,[p(8)]);assert.deepEqual(f.db.run(f.run.id).scanPlan.checkpoint,checkpoint);
 f.db.finish(f.id,f.run.id,'interrupted','Restart');const resumed=f.start();
 assert.deepEqual(resumed.scan.pendingUrls,[p(8)]);assert.equal(resumed.pageProgress.currentPage,7);assert.equal(resumed.scanPlan.id,f.run.scanPlan.id);
});

test('250 pending addresses survive additive batches, truncated reads, omission, technical recovery and restart',t=>{
 const f=fixture(t),urls=Array.from({length:250},(_,n)=>'https://example.test/record/'+n),snapshot=f.observe(source,urls);
 for(let i=0;i<urls.length;i+=100)f.save({pendingUrls:urls.slice(i,i+100)},snapshot);
 assert.equal(f.db.run(f.run.id).scan.pendingUrls.length,250);
 assert.equal(f.store.workspaces.tasks.get(f.id,f.run.taskId).scan.pendingUrls.length,250);
 assert.equal(f.db.sources(f.id)[0].scan.pendingUrls.length,250);
 f.save({pendingUrls:[]},snapshot);assert.equal(f.db.scanQueue(f.id,f.run.id,{}).total,250,'Omission cannot erase pending work');
 const all=[];let offset=0;
 do{const part=f.db.scanQueue(f.id,f.run.id,{offset});assert.ok(part.pendingUrls.length<=100);all.push(...part.pendingUrls);offset=part.nextOffset;}while(offset!==null);
 assert.deepEqual(all,urls);
 const ctx=automationTaskContext(f.db,f.id,f.db.run(f.run.id));
 assert.equal(ctx.scanProgress.pendingCount,250);assert.equal(ctx.scanProgress.pendingUrls.length,100);assert.equal(ctx.scanPlan.checkpoint.pendingUrls.length,100);
 f.save({processedUrls:urls.slice(0,100)},snapshot);
 assert.deepEqual(f.db.scanQueue(f.id,f.run.id,{}).pendingUrls,urls.slice(100,200));
 // A technical failure can append an address without throwing away the work ledger.
 const run=f.db.run(f.run.id);f.db.persistScan(f.id,{...run,scan:{...run.scan,pendingUrls:[...run.scan.pendingUrls,p(8)]}});
 f.db.finish(f.id,f.run.id,'interrupted','Network failure');const resumed=f.start();
 assert.equal(resumed.scan.pendingUrls.length,151);assert.equal(resumed.scan.work.searches[0].processedUrls.length,100);
 assert.equal(f.db.scanQueue(f.id,resumed.id,{offset:100}).pendingUrls.at(-1),p(8));
});

test('progress without a page preserves the queue while falling back from an unsupported cutoff',t=>{
 const f=fixture(t),run=f.db.run(f.run.id);
 f.db.putRun({...run,scanPlan:{...run.scanPlan,mode:'incremental',cutoffAt:f.db.now(),boundary:{url:source,runId:run.id}}});
 const saved=f.save({pendingUrls:[p(2)],chronology:{newestFirst:true,evidence:'Newest first',fromStart:true,pageComplete:true,allItemsDated:true,items:[{publishedAt:'2020-01-01',evidence:'2020-01-01'}]}});
 assert.deepEqual(saved.queue.pendingUrls,[p(2)]);assert.equal(saved.scanPlan.mode,'full');assert.equal(saved.scanPlan.boundary,null);
 assert.throws(()=>f.save({pendingUrls:['javascript:alert(1)']}),/HTTP/);
 assert.throws(()=>f.save({pendingUrls:[p(2)],processedUrls:[p(2)]}),/aynı anda/);
 assert.deepEqual(f.db.scanQueue(f.id,f.run.id).pendingUrls,[p(2)]);
});
