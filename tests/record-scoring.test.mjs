import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationTemplate,reusableTemplate} from '../app/automation-templates.mjs';
import {activeRecordOperations,recordOperationStatus} from '../src/record-operation-status.js';
import {validate} from '../app/tool-schema.mjs';
import {recordScoreTool,assessmentSchema} from '../app/record-scoring.mjs';

const source='https://example.test/jobs',url=source+'/developer',settle=()=>new Promise(resolve=>setImmediate(resolve));
const rubric='Yetkinlik %40, deneyim %25, rol %20, çalışma tercihleri %15. Alt sınır 70/100.';
const assessment=(patch={})=>({status:'scored',score:82,summary:'Yetkinlik 90×0.40 + deneyim 80×0.25 + rol 85×0.20 + tercihler 60×0.15 = 82.',evidenceUrl:url,evidence:'Senior JavaScript developer, remote, five years experience.',strengths:['JavaScript deneyimi'],gaps:[],uncertainties:['Maaş açıklanmamış'],...patch});
test('MCP validates numeric and unavailable scores at both recording endpoints',()=>{
 for(const input of [assessment(),assessment({status:'unavailable',score:null})]){
  assert.doesNotThrow(()=>validate(assessmentSchema,input));
  assert.doesNotThrow(()=>validate(recordScoreTool.inputSchema,{itemId:'record',...input}));
 }
 for(const score of ['80',true,{},81.5,101,-1,NaN])assert.throws(()=>validate(assessmentSchema,assessment({score})),/arguments.score/);
});
function fixture(t){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);
 const a=db.create('job-search',{goal:'Find jobs',criteria:{preferences:'Remote JavaScript',ranking:rubric},sources:[source]});db.review(a.id);
 const seed=db.begin(a.id,'run'),item=db.record(a.id,seed.id,{url,title:'Developer',summary:'Saved listing'});db.finish(a.id,seed.id,'completed','Saved');
 const launches=[],runtime=new WebTasks(db,{launch:async run=>{launches.push(run);return {close:async()=>{}};}});
 t.after(async()=>{await runtime.close();core.close();});
 const flow=run=>automationWorkflow({db,run,signal:{aborted:false},browser:{},report:(...args)=>runtime.report(...args)});
 const finish=async(run,status='completed')=>{runtime.report(a.id,run.id,status,'Done');await runtime.finish(a.id,status,'Done',run.workerId);};
 const start=async()=>{await runtime.runRecord(a.id,item.id,'score');await settle();const run=launches.at(-1);return {run,call:(name,args={})=>flow(run).call(a.id,run.id,name,args)};};
 const scan=()=>{const task=runtime.queue.enqueue(a.id,{operation:'scan',capability:'browser.observe',sourceUrl:source,sources:[source],lockKey:'source:'+source});return db.begin(a.id,{kind:'run',taskId:task.id});};
 return {core,db,id:a.id,item,runtime,launches,finish,start,scan};
}

test('job setup requires a scoring rubric and reusable templates preserve the operation',t=>{
 const f=fixture(t),a=f.db.create('job-search',{goal:'Find work',criteria:{preferences:'Remote'},sources:[source]});
 assert.throws(()=>f.db.review(a.id),/Puanlama kriterleri/);
 const template=reusableTemplate(JSON.parse(JSON.stringify(automationTemplate('job-search'))));
 assert.equal(template.recordOperations.score.capability,'browser.evaluate');
 assert.equal(template.recordOperations.score.effect,'read');
 assert.match(template.guidance,/discovering agent/);
 assert.equal(automationTemplate('housing').recordOperations.score,false);
});

test('the discovering agent must save the assessment with each new production listing',t=>{
 const f=fixture(t),run=f.scan(),newUrl=source+'/new',input={url:newUrl,title:'New developer',summary:'Observed detail'};
 assert.throws(()=>f.db.record(f.id,run.id,input),/assessment/);
 assert.equal(f.db.results(f.id).length,1);
 assert.throws(()=>f.db.record(f.id,run.id,{...input,assessment:assessment({evidenceUrl:newUrl})}),/gözlemle/);
 f.db.observe(f.id,run.id,newUrl,'Full listing detail');
 const saved=f.db.record(f.id,run.id,{...input,assessment:assessment({evidenceUrl:newUrl}),cells:[{key:'score',value:'99'}]});
 assert.equal(saved.cells.score,'82');assert.equal(saved.assessment.runId,run.id);assert.equal(saved.assessment.rubric,rubric);
 assert.equal(saved.status,'found');assert.equal(saved.proposal,'');
 const duplicate=f.db.record(f.id,run.id,input);assert.equal(duplicate.id,saved.id);assert.deepEqual(duplicate.assessment,saved.assessment);
 f.db.finish(f.id,run.id,'completed','Done');
});

test('manual scoring preserves an approved draft and only exposes assessment writes',async t=>{
 const f=fixture(t),item=f.db.putResult({...f.item,status:'prepared',proposal:'Verified form answers',digest:'approved-proposal',approvedDigest:'approved-proposal',evidence:'Existing evidence',actionUrl:'https://forms.test/apply',cells:{company:'Company',score:'20'}});
 const {run,call}=await f.start(),context=await call('get_automation_context');
 assert.equal(context.recordAuthorization.operation,'score');assert.equal(context.assignedOperation.capability,'browser.evaluate');
 const workflow=automationWorkflow({db:f.db,run,signal:{aborted:false},browser:{}});
 assert.ok(workflow.tools.some(tool=>tool.name==='record_automation_score'));
 for(const name of ['record_automation_result','reserve_automation_action','record_automation_outcome','update_workspace_cells','browser_upload_document']){
  assert.equal(workflow.tools.some(tool=>tool.name===name),false);
  await assert.rejects(call(name,{itemId:item.id}),/yalnızca değerlendirme/);
 }
 assert.throws(()=>f.db.record(f.id,run.id,{url}),/record_automation_score/);
 assert.throws(()=>f.db.reserve(f.id,run.id,item.id),/gönderim yapamaz/);
 assert.throws(()=>f.db.finish(f.id,run.id,'completed','No result'),/puanlama sonucunu/);
 f.db.observe(f.id,run.id,url,assessment().evidence);
 await call('record_automation_score',{itemId:item.id,...assessment()});await f.finish(run);
 const saved=f.db.result(f.id,item.id);
 for(const key of ['status','proposal','digest','approvedDigest','evidence','actionUrl','revision','runId'])assert.deepEqual(saved[key],item[key],key);
 assert.equal(saved.cells.company,'Company');assert.equal(saved.cells.score,'82');
 assert.equal(f.db.snapshot(f.id).results[0].recordAction.scoreOperation.label,'Yeniden puanla');
 assert.equal(f.db.snapshot(f.id).results[0].recordAction.operation.kind,'execute');
});

test('unavailable assessments never fabricate a score and invalid inputs do not overwrite an earlier result',async t=>{
 const f=fixture(t),{run,call}=await f.start();f.db.observe(f.id,run.id,url,'Access unavailable');
 for(const patch of [{score:-1},{score:101},{score:NaN},{score:81.5},{score:null},{status:'unavailable',score:0},{strengths:'invented'},{summary:''}])await assert.rejects(call('record_automation_score',{itemId:f.item.id,...assessment(patch)}));
 assert.equal(f.db.result(f.id,f.item.id).assessment,undefined);
 await call('record_automation_score',{itemId:f.item.id,...assessment({status:'unavailable',score:null,summary:'İlan açılamadı',evidence:'Access unavailable'})});await f.finish(run);
 const saved=f.db.result(f.id,f.item.id);assert.equal(saved.assessment.score,null);assert.equal(saved.cells.score,'');assert.equal(saved.status,'found');
});

const linkedInDetail='https://www.linkedin.com/jobs/view/junior-spezialist-f%C3%BCr-datenschutz-4473093841/';
test('scoring accepts LinkedIn URL variants of the observed listing and saves the actual evidence URL',async t=>{
 const f=fixture(t);f.db.putResult({...f.item,url:linkedInDetail});
 const {run,call}=await f.start();f.db.observe(f.id,run.id,linkedInDetail,'Full listing detail');
 for(const evidenceUrl of ['https://www.linkedin.com/jobs/view/4473093841','https://de.linkedin.com/jobs/view/junior-spezialist-f%C3%BCr-datenschutz-4473093841',linkedInDetail+'?trackingId=abc']){
  await call('record_automation_score',{itemId:f.item.id,...assessment({evidenceUrl})});
  assert.equal(f.db.result(f.id,f.item.id).assessment.evidenceUrl,linkedInDetail);
 }
 await f.finish(run);
});

test('URL variant matching still requires evidence from this run and the same listing identity',async t=>{
 const f=fixture(t);f.db.putResult({...f.item,url:linkedInDetail});
 const {run,call}=await f.start(),save=evidenceUrl=>call('record_automation_score',{itemId:f.item.id,...assessment({evidenceUrl})});
 const alias='https://de.linkedin.com/jobs/view/4473093841';
 await assert.rejects(save(alias),/gözlemle/);
 f.db.observe(f.id,run.id,linkedInDetail,' ');
 await assert.rejects(save(alias),/gözlemle/);
 f.db.observe(f.id,run.id,linkedInDetail,'Full listing detail');
 for(const evidenceUrl of ['https://www.linkedin.com/jobs/view/4473093842','https://linkedin.com.evil.test/jobs/view/4473093841','https://www.linkedin.com/jobs','https://example.jobs.personio.de/job/4473093841'])await assert.rejects(save(evidenceUrl),/gözlemle/);
 assert.equal(f.db.result(f.id,f.item.id).assessment,undefined);
 await save(alias);await f.finish(run);
 const next=await f.start();await assert.rejects(next.call('record_automation_score',{itemId:f.item.id,...assessment({evidenceUrl:alias})}),/gözlemle/);
});

test('source scans also accept an observed listing alias when saving a new assessment',t=>{
 const f=fixture(t),run=f.scan(),alias='https://de.linkedin.com/jobs/view/4473093841';
 f.db.observe(f.id,run.id,linkedInDetail,'Full listing detail');
 const saved=f.db.record(f.id,run.id,{url:alias,title:'New listing',summary:'Observed detail',assessment:assessment({evidenceUrl:alias})});
 assert.equal(saved.assessment.evidenceUrl,linkedInDetail);assert.equal(saved.cells.score,'82');
 f.db.finish(f.id,run.id,'completed','Done');
});

test('scoring remains scoped to its record and rejects a changed profile',async t=>{
 const f=fixture(t),other=f.db.putResult({...f.item,id:'other',key:source+'/other',url:source+'/other'}),{run,call}=await f.start();
 f.db.observe(f.id,run.id,url,'Detail');
 await assert.rejects(call('record_automation_score',{itemId:other.id,...assessment()}),/atanmış/);
 f.db.put({...f.db.get(f.id),revision:2});
 await assert.rejects(call('record_automation_score',{itemId:f.item.id,...assessment()}),/Profil değişti/);
 assert.equal(f.db.result(f.id,f.item.id).assessment,undefined);
});

test('the source-discovery conversation can draft later rubric changes for review and future scoring',async t=>{
 const f=fixture(t),first=await f.start();f.db.observe(f.id,first.run.id,url,'Detail');
 await first.call('record_automation_score',{itemId:f.item.id,...assessment()});await f.finish(first.run);
 const old=f.db.result(f.id,f.item.id).assessment;
 const chat=await f.runtime.message(f.id,'Puanlama kriterlerimi değiştir: yetkinlik %70, deneyim %30.');
 const flow=automationWorkflow({db:f.db,run:chat,signal:{aborted:false},browser:{}}),a=f.db.get(f.id),ranking='Yetkinlik %70, deneyim %30.';
 const draft=await flow.call(f.id,chat.id,'save_automation_plan',{title:a.title,goal:a.goal,criteria:Object.entries({...a.criteria,ranking}).map(([key,value])=>({key,value})),sources:a.sources,instructions:a.instructions,facts:a.facts});
 assert.equal(draft.applied,false);assert.equal(f.db.get(f.id).criteria.ranking,rubric);assert.deepEqual(f.db.get(f.id).sources,a.sources);
 await f.finish(chat);f.db.save(f.id,f.db.get(f.id).planDraft.plan);f.db.review(f.id);
 assert.equal(f.db.get(f.id).criteria.ranking,ranking);assert.deepEqual(f.db.result(f.id,f.item.id).assessment,old);
 assert.notEqual(f.db.get(f.id).revision,old.revision);
 const next=await f.start(),context=await next.call('get_automation_context');assert.equal(context.automation.criteria.ranking,ranking);
});

test('repeated requests share one task, wake an existing worker, and report scoring activity',async t=>{
 const f=fixture(t);f.runtime.workers.setEnabled(f.id,'main',false);
 const first=await f.runtime.runRecord(f.id,f.item.id,'score'),second=await f.runtime.runRecord(f.id,f.item.id,'score');await settle();
 assert.equal(first.id,second.id);assert.equal(f.launches.length,1);assert.equal(f.runtime.workers.get(f.id,'main').enabled,true);
 await assert.rejects(f.runtime.runRecord(f.id,f.item.id,'prepare'),/başka bir görev/);
 const row=f.db.snapshot(f.id).results[0];assert.equal(row.recordAction.scoreOperation.disabled,true);assert.equal(recordOperationStatus(row).label,'Puanlanıyor');
 const run=f.launches[0],s=f.db.snapshot(f.id);s.activeRuns=[run];s.workers=[{id:'main',active:{sessionId:run.id},execution:{task:{id:run.id}}}];
 assert.deepEqual(activeRecordOperations(s),[{kind:'score',count:1,label:'puanlanıyor'}]);
 await f.finish(run,'blocked');assert.equal(f.db.snapshot(f.id).results[0].recordAction.retryOperation.kind,'score');
});

for(const answerBeforeFinish of [false,true])test(`a scoring question resumes scoring (answer before finish: ${answerBeforeFinish})`,async t=>{
 const f=fixture(t),{run,call}=await f.start(),q=await call('ask_workspace_question',{text:'Hangi kriter daha önemli?'});
 if(!answerBeforeFinish)await f.finish(run);
 await f.runtime.answer(f.id,q.id,'Remote work');
 if(answerBeforeFinish){await f.finish(run);await f.runtime.tick();}
 await settle();assert.equal(f.launches.at(-1).recordOperation,'score');assert.notEqual(f.launches.at(-1).id,run.id);
});

test('trial examples remain unscored and completed records cannot be rescored',async t=>{
 const f=fixture(t),trial=f.db.begin(f.id,'trial');f.db.observe(f.id,trial.id,source,'Source');
 assert.throws(()=>f.db.record(f.id,trial.id,{url:source+'/sample',title:'Sample',summary:'Research',assessment:assessment()}),/puanı kaydedilemez/);
 const sample=f.db.record(f.id,trial.id,{url:source+'/sample',title:'Sample',summary:'Research'});assert.equal(sample.assessment,undefined);
 f.db.finish(f.id,trial.id,'completed','Checked');
 await assert.rejects(f.runtime.runRecord(f.id,sample.id,'score'),/Araştırma örneği/);
 f.db.putResult({...f.item,status:'completed'});await assert.rejects(f.runtime.runRecord(f.id,f.item.id,'score'),/yeniden gönderilemez/);
});
