import {unknownScorecard} from './helpers/scorecard.mjs';
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
const assessment=(patch={})=>({status:'scored',scorecard:unknownScorecard(),score:82,summary:'Yetkinlik 90×0.40 + deneyim 80×0.25 + rol 85×0.20 + tercihler 60×0.15 = 82.',evidenceUrl:url,evidence:'Senior JavaScript developer, remote, five years experience.',strengths:['JavaScript deneyimi'],gaps:[],uncertainties:['Maaş açıklanmamış'],...patch});
test('MCP validates numeric and unavailable scores at both recording endpoints',()=>{
 for(const input of [{score:75}, {score:75,scorecard:{ignored:'legacy format'}},assessment(),assessment({status:'unavailable',score:null})]){
  assert.doesNotThrow(()=>validate(assessmentSchema,input));
  assert.doesNotThrow(()=>validate(recordScoreTool.inputSchema,{itemId:'record',...input}));
 }
 assert.throws(()=>validate(assessmentSchema,{}),/Missing score/);
 assert.throws(()=>validate(assessmentSchema,{score:75,unexpected:true}),/Unknown field/);
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
 const start=async()=>{await runtime.runRecord(a.id,item.id,'score');await settle();const run=launches.at(-1),workflow=flow(run);return {run,call:(name,args={})=>workflow.call(a.id,run.id,name,args)};};
 const scan=()=>{const task=runtime.queue.enqueue(a.id,{operation:'scan',capability:'browser.observe',sourceUrl:source,sources:[source],lockKey:'source:'+source});return db.begin(a.id,{kind:'run',taskId:task.id});};
 return {core,db,id:a.id,item,runtime,launches,finish,start,scan};
}

test('job setup requires a scoring rubric and reusable templates preserve the operation',t=>{
 const f=fixture(t),a=f.db.create('job-search',{goal:'Find work',criteria:{preferences:'Remote'},sources:[source]});
 assert.throws(()=>f.db.review(a.id),/Puanlama kriterleri/);
 const template=reusableTemplate(JSON.parse(JSON.stringify(automationTemplate('job-search'))));
 assert.equal(template.recordOperations.score.capability,'browser.evaluate');
 assert.equal(template.recordOperations.score.effect,'read');
 assert.match(template.guidance,/scoringPolicy/);
 assert.equal(automationTemplate('housing').recordOperations.score,false);
});

test('the discovering agent must save the assessment with each new production listing',t=>{
 const f=fixture(t),run=f.scan(),newUrl=source+'/new',input={url:newUrl,title:'New developer',summary:'Observed detail'};
 assert.throws(()=>f.db.record(f.id,run.id,input),/score/);
 assert.equal(f.db.results(f.id).length,1);
 const saved=f.db.record(f.id,run.id,{...input,assessment:{score:82},cells:[{key:'score',value:'99'}]});
 assert.equal(saved.assessment.evidenceUrl,newUrl);assert.equal(saved.assessment.evidence,'');
 assert.equal(saved.cells.score,'82');assert.equal(saved.assessment.runId,run.id);assert.equal(saved.assessment.rubric,rubric);
 assert.equal(saved.status,'found');assert.equal(saved.proposal,'');
 assert.throws(()=>f.core.workspaces.updateCells(f.id,saved.id,[{key:'score',value:'99'}]),/yeniden puanla/);
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

test('the real scoring workflow saves only a score without reading a page or CV',async t=>{
 const f=fixture(t),{run,call}=await f.start();
 await call('record_automation_score',{score:75});
 let saved=f.db.result(f.id,f.item.id);assert.equal(saved.assessment.score,75);assert.equal(saved.cells.score,'75');
 assert.equal(saved.assessment.evidenceUrl,f.item.url);assert.equal(saved.assessment.summary,'');assert.deepEqual(saved.assessment.strengths,[]);assert.equal(saved.assessment.calculation,undefined);
 await call('record_automation_score',{score:88,scorecard:{dimensions:'optional legacy data'},evidence:'Agent paraphrase',summary:''});
 saved=f.db.result(f.id,f.item.id);assert.equal(saved.assessment.score,88);assert.equal(saved.assessment.evidence,'Agent paraphrase');assert.equal(saved.assessment.calculation,undefined);
 assert.equal(f.db.run(run.id).browserSteps,0);await f.finish(run);
});

test('unavailable assessments never fabricate a score and invalid inputs do not overwrite an earlier result',async t=>{
 const f=fixture(t),{run,call}=await f.start();f.db.observe(f.id,run.id,url,'Access unavailable');
 for(const patch of [{score:-1},{score:101},{score:NaN},{score:81.5},{score:undefined},{strengths:'invented'}])await assert.rejects(call('record_automation_score',{itemId:f.item.id,...assessment(patch)}));
 assert.equal(f.db.result(f.id,f.item.id).assessment,undefined);
 await call('record_automation_score',{itemId:f.item.id,...assessment({status:'unavailable',score:null,summary:'İlan açılamadı',evidence:'Access unavailable'})});await f.finish(run);
 const saved=f.db.result(f.id,f.item.id);assert.equal(saved.assessment.score,null);assert.equal(saved.cells.score,'');assert.equal(saved.status,'found');
});

test('the submitted score determines status even when optional status disagrees',async t=>{
 const f=fixture(t),{run,call}=await f.start();
 await call('record_automation_score',{score:0,status:'unavailable'});
 let saved=f.db.result(f.id,f.item.id);assert.equal(saved.assessment.score,0);assert.equal(saved.assessment.status,'scored');
 await call('record_automation_score',{score:null,status:'scored'});
 saved=f.db.result(f.id,f.item.id);assert.equal(saved.assessment.score,null);assert.equal(saved.assessment.status,'unavailable');
 await f.finish(run);
});

const linkedInDetail='https://www.linkedin.com/jobs/view/junior-spezialist-f%C3%BCr-datenschutz-4473093841/';
test('scoring accepts URL variants of the observed listing (slash, tracking, application step) and saves the actual evidence URL',async t=>{
 const f=fixture(t);f.db.putResult({...f.item,url:linkedInDetail});
 const {run,call}=await f.start();f.db.observe(f.id,run.id,linkedInDetail,'Full listing detail');
 for(const evidenceUrl of [linkedInDetail.replace(/\/$/,''),linkedInDetail.replace(/\/$/,'')+'/apply',linkedInDetail+'?trackingId=abc']){
  await call('record_automation_score',{itemId:f.item.id,...assessment({evidenceUrl})});
  assert.equal(f.db.result(f.id,f.item.id).assessment.evidenceUrl,linkedInDetail);
 }
 await f.finish(run);
});

test('optional evidence URLs do not require a new read or change the assigned listing',async t=>{
 const f=fixture(t);f.db.putResult({...f.item,url:linkedInDetail});
 const {run,call}=await f.start();
 for(const evidenceUrl of ['https://de.linkedin.com/jobs/view/4473093841','invalid URL','']){
  await call('record_automation_score',{score:82,evidenceUrl});
  const saved=f.db.result(f.id,f.item.id);assert.equal(saved.url,linkedInDetail);assert.equal(saved.assessment.score,82);
 }
 assert.equal(f.db.result(f.id,f.item.id).assessment.evidenceUrl,linkedInDetail);await f.finish(run);
 const next=await f.start();await next.call('record_automation_score',{score:70});assert.equal(f.db.result(f.id,f.item.id).assessment.score,70);
});

test('source scans also accept an observed listing alias when saving a new assessment',t=>{
 const f=fixture(t),run=f.scan(),alias=linkedInDetail.replace(/\/$/,'')+'?utm_source=alias';
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
 const next=await f.start();let context=await next.call('get_automation_context');if(context.context){let text=context.text;while(context.context.nextOffset!==null){context=await next.call('read_automation_context_part',{contextId:context.context.id,offset:context.context.nextOffset});text+=context.text;}context=JSON.parse(text);}assert.equal(context.automation.criteria.ranking,ranking);
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


test('score text normalization only accepts unambiguous whole numbers from zero to one hundred',async()=>{
 const {normalizeAssessment}=await import('../app/record-scoring.mjs');
 for(const score of ['0','39','100',' 82 ']){
  const input={score,summary:'Unchanged note'},result=normalizeAssessment(input);
  assert.equal(result.score,Number(score));assert.equal(result.summary,input.summary);assert.equal(input.score,score);
 }
 for(const score of ['', ' ', '101','-1','39.5','39/100','39%','0x27','3.9e1','null','039','+39',true,{},NaN,Infinity])assert.equal(normalizeAssessment({score}).score,score);
 assert.equal(normalizeAssessment({status:'unavailable',score:''}).score,null);
});


test('fit scores and mandatory eligibility persist independently for scans and rescoring',async t=>{
 const f=fixture(t),{run,call}=await f.start();
 for(const [score,eligibility] of [[87,'mismatch'],[72,'unverified'],[91,'verified']]){
  await call('record_automation_score',{score,eligibility,eligibilityReason:'Synthetic requirement assessment'});
  const saved=f.db.result(f.id,f.item.id);
  assert.equal(saved.assessment.score,score);assert.equal(saved.cells.score,String(score));
  assert.equal(saved.assessment.eligibility,eligibility);assert.equal(saved.assessment.eligibilityReason,'Synthetic requirement assessment');
  assert.equal(saved.assessment.scoringVersion,4);
 }
 await assert.rejects(call('record_automation_score',{score:99,eligibility:'eligible'}),/durumu/);
 assert.equal(f.db.result(f.id,f.item.id).assessment.score,91);
 await call('record_automation_score',{score:88});assert.equal(f.db.result(f.id,f.item.id).assessment.eligibility,'unverified');
 await call('record_automation_score',{score:null,eligibility:'verified'});assert.equal(f.db.result(f.id,f.item.id).assessment.eligibility,'unverified');
 await f.finish(run);
 const scan=f.scan(),saved=f.db.record(f.id,scan.id,{url:source+'/separate-fit',title:'Synthetic role',summary:'Detail',assessment:{score:84,eligibility:'mismatch',eligibilityReason:'Mandatory license absent'}});
 assert.equal(saved.assessment.score,84);assert.equal(saved.assessment.eligibility,'mismatch');
 f.db.finish(f.id,scan.id,'completed','Done');
});
