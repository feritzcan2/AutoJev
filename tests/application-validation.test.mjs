import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {startMcp} from '../app/mcp.mjs';
import {addRankedJob} from './rank-fixture.mjs';

const checkpoint={browser:'Jev Chrome',tabId:'retained-tab',url:'https://example.test/apply',step:'Required questions',nextAction:'Complete missing fields'};
const failure={submissionPrevented:true,fields:[{label:'Permit type',message:'This field is required'},{label:'Privacy',message:'This field is required'}],evidence:'After submit, client-side validation prevented sending; both field errors remain in the same form.',resumeContext:checkpoint};
const proof={kind:'success_page',text:'Application received',url:'https://example.test/thanks',documents:'CV.pdf'};
function fixture(kind='application'){
 const store=new Store(':memory:'),p=store.saveProfile({name:'Candidate',preferences:'Remote',authorization:'submit'});
 for(const s of store.sources(p.id))store.saveSource(p.id,{...s,enabled:false});
 const job=addRankedJob(store,p.id,{company:'Example',role:'Developer',location:'Remote',fit:'Relevant',url:'https://example.test/apply',sourceId:store.sources(p.id)[0].id}).job;
 for(const status of ['working','prepared','submitting'])store.updateJob(p.id,job.id,status,'Actual form','owner');
 store.saveApplicationCheckpoint(p.id,job.id,checkpoint,'owner');
 if(kind==='verify')store.updateJob(p.id,job.id,'uncertain','Outcome unknown','owner');
 store.saveCampaign(p.id,{status:'running',target:10,task:{id:'task',kind,jobId:job.id,sourceId:job.sourceId,seenWorking:true},attempts:{}});
 const active={candidateId:p.id,sessionId:'owner',state:'Working'};
 const c=new Campaigns(store,{active:()=>active,changed:()=>{}});
 return {store,p,job,c,active};
}
test('Staffbase validation recovery preserves the draft, batches answers and resumes to proof',async()=>{
 const {store,p,job,c}=fixture();let mcp;
 try{
  mcp=await startMcp(store,()=>{},undefined,null,{get:id=>store.campaign(id),report:(...a)=>c.report(...a),recordValidationFailure:(...a)=>c.recordValidationFailure(...a),recordSubmission:(...a)=>c.recordSubmission(...a)});
  const token=mcp.grant(p.id,'owner');
  const call=async(name,args={})=>{
   const r=await(await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json();
   assert.notEqual(r.result.isError,true,JSON.stringify(r.result));return JSON.parse(r.result.content[0].text);
  };
  await call('get_task_context');
  const result=await call('record_validation_failure',{jobId:job.id,...failure});
  assert.equal(result.status,'blocked');assert.equal(result.resumeContext.tabId,checkpoint.tabId);assert.equal(result.recovery.nextAction,'correct_fields_or_ask');
  const fields=[{id:'permit',label:'İzin türün?',type:'select',options:['Blue Card','Residence card'],factKey:'work_authorization'},{id:'privacy',label:'Bu şirketin gizlilik onayı?',type:'boolean',consentScope:'recruitment_privacy'},{id:'salary',label:'Maaş?',type:'number',factKey:'salary_expectation'}];
  const q=await call('ask_candidate',{jobId:job.id,question:'Eksik başvuru bilgileri',resumeContext:checkpoint,fields,applicationBlocker:{kind:'uncovered_consent',consentScope:'recruitment_privacy',evidence:'Permit, privacy and salary are required',reasonUnknown:'Missing facts and consent',review:{cvChecked:'CV has no permit type or salary',missingFacts:[{key:'work_authorization',gap:'Permit type'},{key:'salary_expectation',gap:'Salary'},{key:'application_specific',gap:'Privacy consent'}]}}});
  c.report(p.id,'owner',{taskId:'task',outcome:'blocked',note:'Yanıt bekleniyor'});
  store.answer(p.id,q.id,{permit:'Residence card',privacy:true,salary:65000});c.answered(p.id,q.id);
  assert.equal(c.choose(p.id,store.campaign(p.id)).kind,'application');
  assert.deepEqual(store.reusableAnswers(p.id).map(a=>a.key),['work_authorization','salary_expectation']);
  for(const status of ['working','prepared','submitting'])await call('update_application',{jobId:job.id,status,note:'Corrected form'});
  assert.equal(store.job(p.id,job.id).validationFailure,undefined);
  const receipt=await call('record_submission',{jobId:job.id,...proof});assert.equal(receipt.completion.taskReported,true);
 }finally{await mcp?.close();store.close();}
});
test('uncertain sends cannot be reset without explicit field evidence, matching ownership and retained tab',()=>{
 const {store,p,job,c}=fixture('verify');
 try{
  for(const status of ['working','prepared','blocked'])assert.throws(()=>store.updateJob(p.id,job.id,status,'Try again','owner'),/record_validation_failure/);
  for(const patch of [{submissionPrevented:false},{fields:[]},{evidence:' '},{fields:[{label:'Permit',message:''}]},{resumeContext:{...checkpoint,tabId:'other'}},{resumeContext:{...checkpoint,url:'javascript:bad'}}]){
   assert.throws(()=>c.recordValidationFailure(p.id,'owner',{jobId:job.id,...failure,...patch}));
   assert.equal(store.job(p.id,job.id).status,'uncertain');assert.equal(store.campaign(p.id).task.kind,'verify');
  }
  const other=store.saveProfile({name:'Other',preferences:'Remote'});
  assert.throws(()=>store.recordValidationFailure(other.id,job.id,failure,'owner'));
  assert.throws(()=>c.recordValidationFailure(p.id,'other',{jobId:job.id,...failure}));
  const result=c.recordValidationFailure(p.id,'owner',{jobId:job.id,...failure});assert.equal(result.status,'blocked');assert.equal(store.campaign(p.id).task.kind,'application');
  assert.throws(()=>store.recordSubmission(p.id,job.id,proof,'owner'),/başlatılmadı/);
 }finally{store.close();}
});
test('validation recovery and task changes roll back together on failure',()=>{
 const {store,p,job,c}=fixture('verify');try{
  store.saveCampaign=()=>{throw Error('Synthetic failure');};
  assert.throws(()=>c.recordValidationFailure(p.id,'owner',{jobId:job.id,...failure}),/Synthetic/);
  assert.equal(store.job(p.id,job.id).status,'uncertain');assert.equal(store.campaign(p.id).task.kind,'verify');
  assert.equal(store.db.prepare("SELECT count(*) n FROM events WHERE kind='application_validation_failed'").get().n,0);
 }finally{store.close();}
});
test('recovery honors changed research, preparation and source permissions',async t=>{
 for(const [authorization,mode] of [['research','auto'],['submit','find_only'],['prepare','auto'],['submit','prepare']])await t.test(`${authorization}/${mode}`,()=>{
  const {store,p,job,c,active}=fixture('verify');try{
   store.saveProfile({...store.profile(p.id),authorization});store.saveSource(p.id,{...store.source(p.id,job.sourceId),applyMode:mode});
   const result=c.recordValidationFailure(p.id,'owner',{jobId:job.id,...failure});
   if(authorization==='research'||mode==='find_only'){
    assert.equal(result.recovery.nextAction,'end_turn');assert.equal(store.campaign(p.id).task.report.outcome,'done');
    active.state='Idle';c.signal(p.id,'Idle');assert.equal(store.campaign(p.id).task,null);
   }else{
    assert.equal(result.recovery.nextAction,'correct_fields_or_ask');
    for(const status of ['working','prepared'])store.updateJob(p.id,job.id,status,'Corrected','owner');
    assert.throws(()=>store.updateJob(p.id,job.id,'submitting','New send','owner'));
   }
  }finally{store.close();}
 });
});

test('Kayzen pending verification can continue once after a reply without reopening the application',()=>{
 const {store,p,job,c}=fixture('verify');try{
  const q=store.ask(p.id,{jobId:job.id,question:'Complete email verification',applicationBlocker:{kind:'access',recovery:{kind:'user_only'}}});
  const input={questionId:q.id,verificationReady:true,noFieldErrors:true,siteInstruction:'To submit your application, enter the verification code.',actionLabel:'Submit application',evidence:'Same verification step is ready; dropdown selection is confirmed and all field errors are cleared. No success yet.',resumeContext:checkpoint};
  assert.throws(()=>store.continueVerification(p.id,job.id,input,'owner'),/yanıtlanmış/);
  store.answer(p.id,q.id,'Completed in the browser');
  assert.throws(()=>store.continueVerification(p.id,job.id,{...input,noFieldErrors:false},'owner'),/alan/);
  assert.throws(()=>store.continueVerification(p.id,job.id,{...input,verificationReady:false},'owner'),/hazır/);
  assert.throws(()=>store.continueVerification(p.id,job.id,{...input,resumeContext:{...checkpoint,tabId:'replacement'}},'owner'),/aynı kayıtlı/);
  assert.throws(()=>store.continueVerification(p.id,job.id,input,'other'),/aynı gönderim/);
  const result=store.continueVerification(p.id,job.id,input,'owner');
  assert.equal(result.status,'uncertain');assert.equal(store.campaign(p.id).task.kind,'verify');assert.equal(result.resumeContext.tabId,checkpoint.tabId);
  assert.equal(result.continuation.nextAction,'complete_pending_verification_once');
  assert.throws(()=>store.continueVerification(p.id,job.id,input,'owner'),/zaten ayrıldı/);
  assert.equal(c.recordSubmission(p.id,'owner',{jobId:job.id,...proof}).completion.taskReported,true);
  assert.throws(()=>store.continueVerification(p.id,job.id,input,'owner'),/aynı gönderim/);
 }finally{store.close();}
});
test('verification-only retry permits only a reserved step in the same uncertain attempt',()=>{
 const {store,p,job}=fixture('verify');try{
  const campaign=store.campaign(p.id);campaign.task.verificationOnly=true;store.saveCampaign(p.id,campaign);
  const q=store.ask(p.id,{jobId:job.id,question:'Enter the emailed code',applicationBlocker:{kind:'access',recovery:{kind:'user_only'}}});store.answer(p.id,q.id,'Code entered in saved tab');
  const input={questionId:q.id,verificationReady:true,noFieldErrors:true,siteInstruction:'Submit application after entering the emailed code',actionLabel:'Submit application',evidence:'Same form and tab show accepted code and one remaining submit control, with no confirmation or field error.',resumeContext:checkpoint};
  assert.throws(()=>store.assertSubmissionAllowed(p.id,job.id,checkpoint.url,'owner'),/yalnızca sonucu doğrular/);
  store.continueVerification(p.id,job.id,input,'owner');
  assert.throws(()=>store.assertSubmissionAllowed(p.id,job.id,checkpoint.url,'owner'),/yalnızca sonucu doğrular/);
  assert.throws(()=>store.assertSubmissionAllowed(p.id,job.id,'https://example.test/other','owner',{verificationContinuation:true}),/yalnızca sonucu doğrular/);
  assert.equal(store.assertSubmissionAllowed(p.id,job.id,checkpoint.url,'owner',{verificationContinuation:true}).id,job.id);
 }finally{store.close();}
});
test('verification continuation cannot reuse unrelated replies or revoked submission permissions',()=>{
 const {store,p,job}=fixture('verify');try{
  const q=store.ask(p.id,{jobId:job.id,question:'Human verification',applicationBlocker:{kind:'access',recovery:{kind:'captcha'}}});store.answer(p.id,q.id,'Done');
  const input={questionId:q.id,verificationReady:true,noFieldErrors:true,siteInstruction:'Complete verification',actionLabel:'Continue',evidence:'Explicit remaining verification step',resumeContext:checkpoint};
  const unrelated=store.ask(p.id,{question:'Other question',applicationBlocker:{kind:'access',recovery:{kind:'user_only'}}});store.answer(p.id,unrelated.id,'Done');
  assert.throws(()=>store.continueVerification(p.id,job.id,{...input,questionId:unrelated.id},'owner'),/aynı başvurunun/i);
  store.saveProfile({...store.profile(p.id),authorization:'prepare'});assert.throws(()=>store.continueVerification(p.id,job.id,input,'owner'),/yetki/);
  store.saveProfile({...store.profile(p.id),authorization:'submit'});store.saveSource(p.id,{...store.source(p.id,job.sourceId),applyMode:'prepare'});
  assert.throws(()=>store.continueVerification(p.id,job.id,input,'owner'),/yetki/);
  assert.equal(store.job(p.id,job.id).verificationContinuation,undefined);assert.equal(store.job(p.id,job.id).status,'uncertain');
 }finally{store.close();}
});
test('legacy requests for another task are reinspected once after a verification answer',()=>{
 const {store,p,job,c}=fixture('verify');try{
  const answered=store.ask(p.id,{jobId:job.id,question:'Enter the code directly',applicationBlocker:{kind:'access',recovery:{kind:'user_only'}}});store.answer(p.id,answered.id,'Done');
  const stale=store.ask(p.id,{jobId:job.id,question:'Give me a separate application task',applicationBlocker:{kind:'access',recovery:{kind:'user_only'}}});
  c.recheckPendingVerifications(p.id);
  assert.equal(store.campaign(p.id).pendingRecoveries[job.id],stale.id);
  assert.equal(c.choose(p.id,store.campaign(p.id)).kind,'verify');
  assert.equal(store.questions(p.id).find(q=>q.id===stale.id).answer,null);
  const campaign=store.campaign(p.id);campaign.pendingRecoveries={};campaign.pendingResumes={};store.saveCampaign(p.id,campaign);
  c.recheckPendingVerifications(p.id);assert.deepEqual(store.campaign(p.id).pendingRecoveries,{});
  store.resolveTechnicalQuestion(p.id,stale.id,'The internal continuation tool reserved the existing verification step; no separate user task is needed.');
  assert.ok(!store.questions(p.id).some(q=>q.id===stale.id));
  assert.equal(store.db.prepare('SELECT answer FROM questions WHERE id=?').get(stale.id).answer,null);
 }finally{store.close();}
});
