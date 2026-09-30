import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {automationTemplate,reusableTemplate} from '../app/automation-templates.mjs';
import {dispatchRecordOperations} from '../app/record-operations.mjs';

const source='https://example.test/list',settle=()=>new Promise(r=>setImmediate(r));
function fixture(t,template='job-search',{onRunFinished}={}){
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),definition=db.template(template);
 const a=db.create(template,{goal:'Find a suitable result',criteria:Object.fromEntries(definition.fields.filter(f=>f.required).map(f=>[f.id,'Known criteria'])),sources:[source]});
 db.review(a.id);db.skipTrial(a.id);
 const seed=db.begin(a.id,'run'),item=db.record(a.id,seed.id,{key:source+'/1',url:source+'/1',title:'Result',summary:'Observed facts'});
 db.finish(a.id,seed.id,'completed','Saved');const launches=[];
 const runtime=new WebTasks(db,{onRunFinished,launch:async run=>{launches.push(run);return {close:async()=>{}};}});
 t.after(async()=>{await runtime.close();store.close();});
 const flow=run=>automationWorkflow({db,run,signal:{aborted:false},browser:{},report:(id,runId,status,summary)=>runtime.report(id,runId,status,summary)});
 const finish=async(run,status='completed')=>{runtime.report(a.id,run.id,status,'Done');await runtime.finish(a.id,status,'Done',run.workerId);};
 const prepare=async()=>{
  await runtime.runRecord(a.id,item.id,'prepare');await settle();const run=launches.at(-1);
  const saved=db.record(a.id,run.id,{key:item.key,url:item.url,title:item.title,summary:item.summary,proposal:'Exact answers and document: documents/cv.pdf'});
  await finish(run);return saved;
 };
 return {store,db,id:a.id,item,runtime,launches,flow,finish,prepare};
}

test('template labels, operation instructions and success criteria round-trip through export/import',()=>{
 for(const [id,label]of [['job-search','Başvur'],['housing','Mesaj gönder'],['appointment','Rezervasyon yap'],['custom','Uygula']]){
  const template=automationTemplate(id),copy=reusableTemplate(template);
  assert.equal(copy.recordOperations.execute.label,label);assert.equal(copy.recordOperations.prepare.effect,'prepare');assert.equal(copy.recordOperations.verify.effect,'read');
  assert.deepEqual(copy.recordOperations,template.recordOperations);assert.equal(template.workflow[0].effect,'read');
 }
 assert.equal(reusableTemplate({...automationTemplate('custom'),recordOperations:false}).recordOperations,false);
 assert.equal(reusableTemplate({...automationTemplate('custom'),recordOperations:{execute:false}}).recordOperations.execute,false);
 assert.throws(()=>reusableTemplate({...automationTemplate('custom'),recordOperations:{erase:{label:'Erase'}}}),/Bilinmeyen/);
});

for(const mode of ['observe','auto'])test(`large read-only result sets do not reload source history for each record (${mode})`,async t=>{
 const f=fixture(t,'housing');
 f.db.enable(f.id);f.db.put({...f.db.get(f.id),mode,sourceSettings:{[source]:{mode:'observe'}}});
 for(let i=0;i<1616;i++)f.db.putResult({...f.item,id:'large-'+i,key:source+'/large/'+i,url:source+'/large/'+i});
 let sourceReads=0,resultReads=0,taskReads=0;
 for(const [owner,key,count]of [[f.db,'sources',()=>sourceReads++],[f.db,'results',()=>resultReads++],[f.runtime.queue,'list',()=>taskReads++]]){
  const original=owner[key].bind(owner);owner[key]=(...args)=>{count();return original(...args);};
 }
 await dispatchRecordOperations(f.runtime,f.id);await settle();
 assert.equal(f.launches.length,0,'Read-only sources never queue preparation');
 assert.ok(sourceReads<=1,'Source UI history must not be reloaded for each result');
 assert.ok(resultReads<=1,'Read the results at most once per dispatch');
 assert.ok(taskReads<=3,'Read the queue a constant number of times');
});

test('manual preparation runs on a paused workspace with a blocked source and does not reset the source',async t=>{
 const f=fixture(t);f.db.put({...f.db.get(f.id),status:'paused',sourceState:{[source]:{blocked:true,lastResult:'CAPTCHA',nextRunAt:null}}});
 const before=f.db.get(f.id).sourceState;
 const prepared=await f.prepare();assert.equal(prepared.status,'prepared');assert.deepEqual(f.db.get(f.id).sourceState,before);assert.equal(f.db.get(f.id).status,'paused');
 assert.equal(f.launches[0].recordOperation,'prepare');assert.equal(f.launches[0].recordId,f.item.id);
 assert.equal(f.db.snapshot(f.id).results[0].recordAction.operation.label,'Başvur');
});

test('draft preparation keeps its tab; verified submission closes the completed task tab',async t=>{
 const calls=[],f=fixture(t,'job-search',{onRunFinished:(id,run,options)=>calls.push({run,options})});
 const prepared=await f.prepare();assert.equal(calls.at(-1).options.closeTabs,false);
 await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:prepared.digest});await settle();const run=f.launches.at(-1);
 f.db.reserve(f.id,run.id,f.item.id);f.db.observe(f.id,run.id,f.item.url,'Submitted');f.db.resolve(f.id,run.id,f.item.id,{status:'completed',evidence:'Submitted',url:f.item.url});
 await f.finish(run);assert.equal(calls.at(-1).run.id,run.id);assert.equal(calls.at(-1).options.closeTabs,true);
});

test('exact manual approval permits only the selected draft without changing observe permissions; duplicate submission is rejected',async t=>{
 const f=fixture(t),prepared=await f.prepare();
 await assert.rejects(f.runtime.runRecord(f.id,f.item.id,'execute',{digest:'stale'}),/Taslak değişti/);
 const task=await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:prepared.digest});await settle();
 assert.equal((await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:prepared.digest})).id,task.id);
 const run=f.launches.at(-1);assert.equal(f.db.get(f.id).mode,'observe');
 f.db.reserve(f.id,run.id,f.item.id);assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id));
 f.db.observe(f.id,run.id,f.item.url,'Application confirmation');f.db.resolve(f.id,run.id,f.item.id,{status:'completed',evidence:'Application confirmation',url:f.item.url});await f.finish(run);
 assert.equal(f.db.result(f.id,f.item.id).status,'completed');assert.equal(f.db.snapshot(f.id).results[0].recordAction.operation,null);
 await assert.rejects(f.runtime.runRecord(f.id,f.item.id,'execute',{digest:prepared.digest}),/yeniden gönderilemez/);
});

test('changed proposals invalidate queued consent, and editing during execution cannot reuse consent',async t=>{
 const f=fixture(t),prepared=await f.prepare();
 // Hold the only worker with a source task, then enqueue the reviewed draft.
 await f.runtime.runOnce(f.id);await settle();const scan=f.launches.at(-1);
 const task=await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:prepared.digest});assert.equal(task.state,'pending');
 f.db.putResult({...prepared,proposal:'Changed commitment',digest:'changed'});await f.finish(scan);await f.runtime.tick();
 assert.equal(f.store.workspaces.tasks.get(f.id,task.id).state,'cancelled');assert.equal(f.launches.filter(r=>r.recordOperation==='execute').length,0);
 await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:'changed'});await settle();const run=f.launches.at(-1);
 f.db.record(f.id,run.id,{key:f.item.key,url:f.item.url,title:f.item.title,summary:'New requirement',proposal:'Another changed proposal'});
 assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id),/onay/);await f.finish(run);
 assert.equal(f.db.result(f.id,f.item.id).status,'prepared');
});

test('an interrupted send becomes uncertain; verification is read-only and survives disabled schedules',async t=>{
 const f=fixture(t),prepared=await f.prepare();await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:prepared.digest});await settle();const run=f.launches.at(-1);
 f.db.reserve(f.id,run.id,f.item.id);await f.runtime.finish(f.id,'interrupted','Connection lost',run.workerId);
 assert.equal(f.db.result(f.id,f.item.id).status,'uncertain');assert.equal(f.db.snapshot(f.id).results[0].recordAction.operation.kind,'verify');
 f.db.put({...f.db.get(f.id),status:'paused',reviewedRevision:null,trial:null,endAt:1});
 await f.runtime.runRecord(f.id,f.item.id,'verify');await settle();const verify=f.launches.at(-1);
 assert.throws(()=>f.db.reserve(f.id,verify.id,f.item.id));
 f.db.observe(f.id,verify.id,f.item.url,'Already submitted');f.db.resolve(f.id,verify.id,f.item.id,{status:'completed',evidence:'Already submitted',url:f.item.url});await f.finish(verify);
 assert.equal(f.db.result(f.id,f.item.id).status,'completed');
});

test('record questions resume preparation without pausing other scans or starting setup',async t=>{
 const f=fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();const first=f.launches.at(-1),flow=f.flow(first);
 const q=await flow.call(f.id,first.id,'ask_workspace_question',{text:'Start date?',fields:[{id:'date',label:'Date',type:'date'}]});assert.equal(q.recordId,f.item.id);await f.finish(first);
 await f.runtime.answer(f.id,q.id,{date:'2026-10-01'});await settle();const next=f.launches.at(-1);
 assert.notEqual(next.id,first.id);assert.equal(next.recordOperation,'prepare');assert.equal(next.recordId,f.item.id);assert.equal(f.launches.some(r=>r.kind==='interview'),false);
});

test('dismissing a record closes only its questions and worker, and prevents late writes or retries',async t=>{
 const f=fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();const run=f.launches.at(-1);
 const other=f.db.putResult({...f.item,id:'other-record',key:'other-record',url:source+'/other'});
 const q=f.db.askQuestion(f.id,{recordId:f.item.id,text:'Missing information?'}),q2=f.db.askQuestion(f.id,{recordId:f.item.id,text:'Another question?'}),otherQ=f.db.askQuestion(f.id,{recordId:other.id,text:'Other record?'}),general=f.db.askQuestion(f.id,{text:'Workspace question?'});
 const otherTask=f.runtime.queue.enqueue(f.id,{recordId:other.id,operation:'prepare',lockKey:'record:'+other.id});
 const worker=f.runtime.workers.add(f.id);f.runtime.queue.claim(f.id,otherTask.id,worker.id);
 let release;f.runtime.slots(f.id)[0].worker.close=()=>new Promise(resolve=>{release=resolve;});
 const dismissing=f.runtime.dismissRecord(f.id,f.item.id);
 assert.equal(f.db.result(f.id,f.item.id).status,'dismissed');
 assert.throws(()=>f.db.askQuestion(f.id,{recordId:f.item.id,text:'Late question'}),/Elenen/);
 assert.equal(f.db.record(f.id,run.id,{key:f.item.key,url:f.item.url,title:'Late draft',summary:'Late',proposal:'Do not save'}).status,'dismissed');
 await assert.rejects(f.runtime.runRecord(f.id,f.item.id,'prepare'),/yeniden gönderilemez/);
 release();await dismissing;
 for(const id of [q.id,q2.id])assert.equal(f.db.get(f.id).questions.find(q=>q.id===id).resolution,'record_dismissed');
 for(const id of [otherQ.id,general.id])assert.equal(f.db.get(f.id).questions.find(q=>q.id===id).answer,null);
 assert.equal(f.runtime.queue.get(f.id,otherTask.id).state,'running');assert.equal(f.db.result(f.id,other.id).status,'found');assert.equal(f.runtime.slots(f.id).length,0);
 await assert.rejects(f.runtime.answer(f.id,q.id,'Late answer'),/zaten/);
});

test('dismissal cancels queued work and rejects foreign or already attempted records without mutations',async t=>{
 const f=fixture(t),queue=f.runtime.queue,task=queue.enqueue(f.id,{recordId:f.item.id,operation:'prepare',resumeRecordAfterAnswer:true});
 const other=f.db.create('custom');await assert.rejects(f.runtime.dismissRecord(other.id,f.item.id),/ait değil/);assert.equal(queue.get(f.id,task.id).state,'pending');
 for(const status of ['executing','completed','uncertain']){
  f.db.putResult({...f.item,status});await assert.rejects(f.runtime.dismissRecord(f.id,f.item.id),/geçmişi/);assert.equal(f.db.result(f.id,f.item.id).status,status);assert.equal(queue.get(f.id,task.id).state,'pending');
 }
 f.db.putResult(f.item);await f.runtime.dismissRecord(f.id,f.item.id);assert.equal(queue.get(f.id,task.id).state,'cancelled');assert.equal(queue.get(f.id,task.id).resumeRecordAfterAnswer,false);
 assert.equal(f.db.template('job-search').records.dismissLabel,'Başvuruyu ele');assert.equal(reusableTemplate(f.db.template('job-search')).records.dismissLabel,'Başvuruyu ele');assert.equal(f.db.template('housing').records.dismissLabel,'Kaydı ele');
});

test('working records and question dismissal remain available outside the latest 500 records',async t=>{
 const f=fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();
 const q=f.db.askQuestion(f.id,{recordId:f.item.id,text:'Old record details?'});
 for(let i=0;i<501;i++)f.db.putResult({...f.item,id:'recent-'+i,key:'recent-'+i});
 const snapshot=f.db.snapshot(f.id);assert.ok(snapshot.results.some(item=>item.id===f.item.id&&item.recordAction.task.state==='running'));assert.equal(snapshot.automation.questions.find(item=>item.id===q.id).canDismissRecord,true);
});

test('preparation and execution cannot claim success without their durable results',async t=>{
 const f=fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();const run=f.launches.at(-1);
 assert.throws(()=>f.db.finish(f.id,run.id,'completed','Done'),/taslağı/);
 assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id),/gönderim/);
 await f.finish(run,'blocked');const prepared=await f.prepare();
 await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:prepared.digest});await settle();assert.throws(()=>f.db.finish(f.id,f.launches.at(-1).id,'completed','Clicked'),/tamamlanmadı/);
});

test('automatic preparation is independent of source completion, and prepare mode waits for exact approval',async t=>{
 const f=fixture(t,'housing');f.db.enable(f.id);f.db.put({...f.db.get(f.id),sourceState:{[source]:{blocked:true,nextRunAt:null,lastResult:'Pagination unavailable'}}});
 await f.runtime.tick();await settle();const run=f.launches.at(-1);assert.equal(run.recordOperation,'prepare');
 f.db.record(f.id,run.id,{key:f.item.key,url:f.item.url,title:f.item.title,summary:'Facts',proposal:'Message'});await f.finish(run);await f.runtime.tick();
 assert.equal(f.launches.length,1);assert.equal(f.db.sources(f.id)[0].blocked,true);
 f.db.approve(f.id,f.item.id);await f.runtime.tick();await settle();assert.equal(f.launches.at(-1).recordOperation,'execute');
});

test('record tasks have an independent retained browser tab key across redirects',async()=>{
 const calls=[],browser={prepare:()=>({ready:true}),call:async(id,name,args,session,options)=>{calls.push({name,args,options});return {content:[{type:'text',text:JSON.stringify({tabId:'record-tab',url:args.url??'https://employer.test/apply'})}]};}};
 const adapter=automationBrowser(browser,{mode:'jev',recordId:'item',readTabKey:'record:item',sourceUrls:[source]});
 await adapter.call('workspace','browser_navigate',{url:source+'/1'},'run');await adapter.call('workspace','browser_navigate',{url:'https://employer.test/apply'},'run');
 for(const call of calls){assert.equal(call.options.automationTabKey,'record:item');assert.equal(call.options.automationSourceUrl,undefined);}
});

test('source observations preserve existing drafts and do not overwrite an active record operation',async t=>{
 const f=fixture(t),prepared=await f.prepare();f.store.workspaces.workers.add(f.id);await f.runtime.runOnce(f.id);await settle();const scan=f.launches.at(-1);
 const updated=f.db.record(f.id,scan.id,{key:f.item.key,url:f.item.url,title:f.item.title,summary:'Updated listing facts'});assert.equal(updated.proposal,prepared.proposal);assert.equal(updated.digest,prepared.digest);
 await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:prepared.digest});await settle();
 const repeat=f.db.record(f.id,scan.id,{key:f.item.key,url:f.item.url,title:f.item.title,summary:'Must not overwrite active operation'});assert.equal(repeat.duplicate,true);assert.equal(repeat.summary,'Updated listing facts');
});

for(const mode of ['observe','prepare','auto'])test(`manual consent remains exact in ${mode} mode and cannot bypass limits`,async t=>{
 const f=fixture(t),prepared=await f.prepare();f.db.put({...f.db.get(f.id),mode});
 await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:prepared.digest});await settle();const run=f.launches.at(-1);
 f.db.put({...f.db.get(f.id),maxActionsTotal:0});assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id),/Toplam/);
 f.db.put({...f.db.get(f.id),maxActionsTotal:null,maxActionsPerDay:0});assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id),/Günlük/);
 f.db.put({...f.db.get(f.id),maxActionsPerDay:10});
 f.db.record(f.id,run.id,{key:f.item.key,url:f.item.url,title:f.item.title,summary:'Changed requirement',proposal:'Changed document'});
 assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id),/yeniden onay/);await f.finish(run);
 f.db.put({...f.db.get(f.id),status:'enabled',sourceState:{[source]:{blocked:true,nextRunAt:null}}});await f.runtime.tick();await settle();
 assert.equal(f.launches.filter(r=>r.recordOperation==='execute').length,1);
});

test('an answer arriving before the asking worker closes schedules a fresh preparation',async t=>{
 const f=fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();const first=f.launches.at(-1);
 const q=await f.flow(first).call(f.id,first.id,'ask_workspace_question',{text:'When can you start?'});
 await f.runtime.answer(f.id,q.id,'Next month');assert.equal(f.launches.length,1);
 await f.finish(first);await f.runtime.tick();await settle();assert.equal(f.launches.length,2);assert.equal(f.launches.at(-1).recordOperation,'prepare');
});

test('document uploads require a reserved record and a listed file inside this workspace',async t=>{
 const {mkdtemp,writeFile,rm,symlink}=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const workspace=await mkdtemp(path.join(os.tmpdir(),'record-upload-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
 await writeFile(path.join(workspace,'cv.pdf'),'Fixture CV');await writeFile(path.join(workspace,'private.pdf'),'Unlisted');
 const f=fixture(t);await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();let run=f.launches.at(-1);
 const calls=[],browser={call:async(id,name,args)=>{calls.push({name,args});return {content:[{type:'text',text:'Page URL: '+f.item.url+'\nCV uploaded'}]};}};
 let flow=automationWorkflow({workspace,db:f.db,run,signal:{aborted:false},browser});
 await assert.rejects(flow.call(f.id,run.id,'browser_upload_document',{ref:'file',filePath:'cv.pdf'}),/rezervasyonu/);
 const draft=f.db.record(f.id,run.id,{url:f.item.url,title:f.item.title,summary:f.item.summary,proposal:'Upload cv.pdf'});await f.finish(run);
 await f.runtime.runRecord(f.id,f.item.id,'execute',{digest:draft.digest});await settle();run=f.launches.at(-1);flow=automationWorkflow({workspace,db:f.db,run,signal:{aborted:false},browser});
 await assert.rejects(flow.call(f.id,run.id,'browser_upload_document',{ref:'file',filePath:'cv.pdf'}),/rezervasyonu/);f.db.reserve(f.id,run.id,f.item.id);
 await assert.rejects(flow.call(f.id,run.id,'browser_upload_document',{ref:'file',filePath:'private.pdf'}),/taslakta yok/);
 await symlink(new URL(import.meta.url).pathname,path.join(workspace,'outside.pdf'));
 await assert.rejects(flow.call(f.id,run.id,'browser_upload_document',{ref:'file',filePath:'outside.pdf'}),/çalışma alanındaki/);
 await flow.call(f.id,run.id,'browser_upload_document',{ref:'file',filePath:'cv.pdf'});assert.equal(calls[0].name,'browser_file_upload');assert.equal(calls[0].args.paths[0],await import('node:fs/promises').then(m=>m.realpath(path.join(workspace,'cv.pdf'))));
});


test('Jev document upload uses the current record tab and observed upload ID',async()=>{
 const calls=[],browser={prepare:()=>({ready:true}),call:async(id,name,args)=>{calls.push({name,args});return {content:[{type:'text',text:JSON.stringify({tabId:'record-tab',url:'https://employer.test/apply'})}]};}};
 const adapter=automationBrowser(browser,{mode:'jev',recordId:'item',readTabKey:'record:item'});
 await adapter.call('workspace','browser_navigate',{url:'https://employer.test/apply'},'run');
 await adapter.call('workspace','browser_upload_document',{ref:'observed-upload',filePath:'/workspace/cv.pdf'},'run');
 assert.deepEqual(calls.at(-1),{name:'browser_jev_upload',args:{tabId:'record-tab',uploadId:'observed-upload',filePath:'/workspace/cv.pdf'}});
});

test('manual preparation takes the next free worker ahead of automatic pending work',async t=>{
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();const scan=f.launches.at(-1);f.db.put({...f.db.get(f.id),mode:'prepare'});
 const other=f.db.record(f.id,scan.id,{url:source+'/2',title:'Other',summary:'Other finding'});
 const {enqueueRecordOperation}=await import('../app/record-operations.mjs');
 enqueueRecordOperation(f.runtime,f.id,other.id,'prepare',{manual:false});
 const automatic=enqueueRecordOperation(f.runtime,f.id,f.item.id,'prepare',{manual:false});
 const manual=await f.runtime.runRecord(f.id,f.item.id,'prepare');assert.equal(manual.id,automatic.id);assert.equal(manual.request.manual,true);
 f.db.put({...f.db.get(f.id),status:'enabled'});await f.finish(scan);await f.runtime.tick();await settle();
 assert.equal(f.launches.at(-1).recordId,f.item.id);assert.equal(f.launches.at(-1).request.manual,true);
});

test('table projection exposes queued, running, answered and stopped record activity',async t=>{
 const {recordOperationStatus,recordActivityAt}=await import('../src/record-operation-status.js');
 const f=fixture(t);await f.runtime.runOnce(f.id);await settle();const scan=f.launches.at(-1);
 await f.runtime.runRecord(f.id,f.item.id,'prepare');let row=f.db.snapshot(f.id).results.find(r=>r.id===f.item.id);
 assert.equal(recordOperationStatus(row).label,'Hazırlama sırada');assert.equal(recordOperationStatus(row).active,true);assert.ok(recordActivityAt(row)>=row.updatedAt);
 await f.finish(scan);await f.runtime.tick();await settle();row=f.db.snapshot(f.id).results.find(r=>r.id===f.item.id);assert.equal(recordOperationStatus(row).label,'Hazırlanıyor');
 const q=f.db.askQuestion(f.id,{recordId:f.item.id,text:'Availability?'});row=f.db.snapshot(f.id).results.find(r=>r.id===f.item.id);assert.equal(recordOperationStatus(row).label,'Yanıt bekliyor');
 f.db.answerQuestion(f.id,q.id,'Next month');await f.finish(f.launches.at(-1),'blocked');row=f.db.snapshot(f.id).results.find(r=>r.id===f.item.id);assert.equal(recordOperationStatus(row).label,'İşlem engellendi');assert.equal(recordOperationStatus(row).active,false);
 assert.equal(recordOperationStatus({...row,status:'completed'}),null);
});

test('an explicit record request starts one disabled worker and keeps workspace permissions unchanged',async t=>{
 const f=fixture(t);const second=f.runtime.workers.add(f.id);for(const worker of f.runtime.workers.list(f.id))f.runtime.workers.setEnabled(f.id,worker.id,false);
 f.db.put({...f.db.get(f.id),status:'paused'});const before=f.db.get(f.id);
 await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();assert.equal(f.launches.length,1);assert.equal(f.launches[0].recordId,f.item.id);
 assert.equal(f.runtime.workers.get(f.id,'main').enabled,true);assert.equal(f.runtime.workers.get(f.id,second.id).enabled,false);
 assert.equal(f.db.get(f.id).status,before.status);assert.equal(f.db.get(f.id).mode,before.mode);
 await f.runtime.stopWorker(f.id,'main');await f.runtime.tick();assert.equal(f.runtime.workers.get(f.id,'main').enabled,false);assert.equal(f.launches.length,1);
 await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();assert.equal(f.launches.length,2);
});

test('repeating a queued request wakes a worker and more preparation work starts another existing worker',async t=>{
 const f=fixture(t);const {enqueueRecordOperation}=await import('../app/record-operations.mjs');
 f.runtime.workers.setEnabled(f.id,'main',false);
 await assert.rejects(f.runtime.runRecord(f.id,f.item.id,'execute',{digest:'invalid'}));assert.equal(f.runtime.workers.get(f.id,'main').enabled,false);
 const pending=enqueueRecordOperation(f.runtime,f.id,f.item.id,'prepare');f.runtime.workers.setEnabled(f.id,'main',false);
 await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();assert.equal(f.launches[0].taskId,pending.id);
 const extra=f.runtime.workers.add(f.id);f.runtime.workers.setEnabled(f.id,extra.id,false);
 const other=f.db.putResult({...f.item,id:'other-record',key:source+'/other',url:source+'/other'});
 const queued=await f.runtime.runRecord(f.id,other.id,'prepare');await settle();assert.equal(queued.state,'running');assert.equal(f.launches.length,2);assert.equal(f.runtime.workers.get(f.id,extra.id).enabled,true);
 await f.runtime.stopWorker(f.id,'main');await f.runtime.tick();assert.equal(f.launches.length,2);assert.equal(f.runtime.workers.get(f.id,'main').enabled,false);
});


test('preparation backlog uses all configured workers and leaves excess work queued',async t=>{
 const f=fixture(t);f.runtime.workers.add(f.id);f.runtime.workers.add(f.id);
 for(const worker of f.runtime.workers.list(f.id))f.runtime.workers.setEnabled(f.id,worker.id,false);
 const {enqueueRecordOperation}=await import('../app/record-operations.mjs');
 const records=[f.item,...Array.from({length:4},(_,n)=>f.db.putResult({...f.item,id:'parallel-'+n,key:source+'/parallel-'+n,url:source+'/parallel-'+n}))];
 // Batch requests before a scheduler tick, as happens when work survives a restart.
 for(const item of records)enqueueRecordOperation(f.runtime,f.id,item.id,'prepare');
 assert.equal(f.runtime.workers.list(f.id).filter(w=>w.enabled).length,3);
 await f.runtime.tick();await settle();assert.equal(f.launches.length,3);assert.equal(new Set(f.launches.map(r=>r.recordId)).size,3);
 assert.equal(f.runtime.queue.list(f.id,{states:['pending']}).filter(t=>t.recordOperation).length,2);
 await f.runtime.stopWorker(f.id,f.launches[0].workerId);await f.runtime.tick();assert.equal(f.launches.length,3);
 await f.finish(f.launches[1],'blocked');await f.runtime.tick();await settle();assert.equal(f.launches.length,4);
 assert.equal(f.runtime.workers.list(f.id).length,3);
});

test('record context does not replay another record login blocker from the same source',async t=>{
 const f=fixture(t);const old=f.db.begin(f.id,'run');f.db.putRun({...old,sourceUrl:source,recordId:'unrelated-record'});f.db.finish(f.id,old.id,'blocked','Another record required login');
 await f.runtime.runRecord(f.id,f.item.id,'prepare');await settle();const current=f.launches.at(-1);
 const context=await f.flow(current).call(f.id,current.id,'get_automation_context',{});
 assert.equal(context.previousRuns.some(r=>r.id===old.id),false);
});

for(const template of ['job-search','housing','appointment','custom'])test(`direct execution needs no prior preparation, preserves limits and records a verified outcome (${template})`,async t=>{
 const f=fixture(t,template),originalMode=f.db.get(f.id).mode;
 const initial=f.db.snapshot(f.id).results[0];assert.equal(initial.status,'found');assert.equal(initial.recordAction.directOperation.disabled,false);
 await assert.rejects(f.runtime.runRecord(f.id,f.item.id,'execute'),/taslağını/);
 const task=await f.runtime.runRecord(f.id,f.item.id,'execute',{direct:true});await settle();const run=f.launches.at(-1);
 assert.equal((await f.runtime.runRecord(f.id,f.item.id,'execute',{direct:true})).id,task.id);
 assert.equal(f.launches.length,1);assert.equal(run.recordOperation,'execute');assert.equal(run.request.digest,undefined);
 const context=await f.flow(run).call(f.id,run.id,'get_automation_context',{});
 assert.equal(context.recordAuthorization.directExecution,true);assert.equal(context.recordAuthorization.approvedProposalDigest,null);assert.match(context.recordAuthorization.rule,/No prior preparation/);
 assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id),/taslağı gerekli/);
 f.db.record(f.id,run.id,{key:f.item.key,url:f.item.url,title:f.item.title,summary:'Verified answers',proposal:'Actual form: verified answers, documents/cv.pdf, no additional commitments'});
 assert.throws(()=>f.db.finish(f.id,run.id,'completed','Only saved a draft'),/Gönderim tamamlanmadı/);
 f.db.reserve(f.id,run.id,f.item.id);assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id));
 f.db.observe(f.id,run.id,f.item.url,'Confirmed submitted');f.db.resolve(f.id,run.id,f.item.id,{status:'completed',url:f.item.url,evidence:'Confirmed submitted'});await f.finish(run);
 assert.equal(f.db.snapshot(f.id).results[0].recordAction.directOperation,null);assert.equal(f.db.get(f.id).mode,originalMode);
 await assert.rejects(f.runtime.runRecord(f.id,f.item.id,'execute',{direct:true}),/yeniden gönderilemez/);
});

test('direct execution is explicit, record-scoped, and still enforces total and daily limits',async t=>{
 const f=fixture(t),{enqueueRecordOperation}=await import('../app/record-operations.mjs');
 f.db.put({...f.db.get(f.id),mode:'auto'});
 assert.throws(()=>enqueueRecordOperation(f.runtime,f.id,f.item.id,'execute',{manual:false,direct:true}),/kullanıcı isteği/);
 await f.runtime.runRecord(f.id,f.item.id,'execute',{direct:true});await settle();const run=f.launches.at(-1);
 const other=f.db.putResult({...f.item,id:'not-assigned',key:'not-assigned'});assert.throws(()=>f.db.reserve(f.id,run.id,other.id),/ait değil/);
 f.db.record(f.id,run.id,{key:f.item.key,url:f.item.url,title:f.item.title,summary:'Checked',proposal:'Verified form'});
 f.db.put({...f.db.get(f.id),maxActionsTotal:0});assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id),/Toplam işlem sınır/);
 f.db.put({...f.db.get(f.id),maxActionsTotal:null,maxActionsPerDay:0});assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id),/Günlük işlem sınır/);
 f.db.put({...f.db.get(f.id),maxActionsPerDay:10,revision:f.db.get(f.id).revision+1});assert.throws(()=>f.db.reserve(f.id,run.id,f.item.id),/yeniden onay/);
});

for(const answerBeforeFinish of [false,true])test(`direct request continues after record questions without a preparation detour (answer before finish: ${answerBeforeFinish})`,async t=>{
 const f=fixture(t);await f.runtime.runRecord(f.id,f.item.id,'execute',{direct:true});await settle();const run=f.launches.at(-1);
 const q=await f.flow(run).call(f.id,run.id,'ask_workspace_question',{text:'Earliest available date?',fields:[{id:'date',label:'Date',type:'date'}]});
 assert.equal(q.taskId,run.taskId);
 if(!answerBeforeFinish)await f.finish(run);
 await f.runtime.answer(f.id,q.id,{date:'2026-10-15'});
 if(answerBeforeFinish){await f.finish(run);await f.runtime.tick();}
 await settle();const next=f.launches.at(-1);assert.notEqual(next.id,run.id);assert.equal(next.recordOperation,'execute');assert.equal(next.request.direct,true);assert.equal(next.recordId,f.item.id);
});

test('stopping a direct request revokes submission authority when a later answer resumes preparation',async t=>{
 const f=fixture(t);await f.runtime.runRecord(f.id,f.item.id,'execute',{direct:true});await settle();const run=f.launches.at(-1);
 const q=await f.flow(run).call(f.id,run.id,'ask_workspace_question',{text:'Missing fact?'});
 await f.runtime.stopWorker(f.id,run.workerId);await f.runtime.answer(f.id,q.id,'Known now');await settle();
 assert.equal(f.launches.at(-1).recordOperation,'prepare');assert.notEqual(f.launches.at(-1).request.direct,true);
});

test('uncertain direct execution cannot be retried as another submission',async t=>{
 const f=fixture(t);await f.runtime.runRecord(f.id,f.item.id,'execute',{direct:true});await settle();const run=f.launches.at(-1);
 f.db.record(f.id,run.id,{key:f.item.key,url:f.item.url,title:f.item.title,summary:'Checked',proposal:'Verified form'});f.db.reserve(f.id,run.id,f.item.id);
 await f.runtime.finish(f.id,'interrupted','Connection lost',run.workerId);
 assert.equal(f.db.result(f.id,f.item.id).status,'uncertain');await assert.rejects(f.runtime.runRecord(f.id,f.item.id,'execute',{direct:true}),/yeniden gönderilemez/);
 assert.equal(f.db.snapshot(f.id).results[0].recordAction.directOperation,null);
});
