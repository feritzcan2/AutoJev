import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {startMcp} from '../app/mcp.mjs';
import {isSubmissionReply,isMissingDocumentsReply,candidateReplyActions,sameDocumentRequirement} from '../app/application-replies.mjs';
import {addRankedJob} from './rank-fixture.mjs';

const documents={kind:'required_form_field',evidence:'Reference letters (Zeugnisse) and university transcripts — required PDF upload',reasonUnknown:'The required PDF is unavailable'};
function fixture(){
 const store=new Store(':memory:'),p=store.saveProfile({name:'Candidate',preferences:'Remote',authorization:'submit',browserMode:'jev'});
 for(const source of store.sources(p.id))store.saveSource(p.id,{...source,enabled:false});
 const job=addRankedJob(store,p.id,{company:'Employer',role:'Legal Counsel',location:'Berlin',fit:'Legal',url:'https://example.test/job'}).job;
 store.updateJob(p.id,job.id,'working','Form open','session');
 store.saveApplicationCheckpoint(p.id,job.id,{browser:'Jev Chrome',tabId:'saved-tab',url:job.url,step:'Required document missing',nextAction:'Resume here'},'session');
 store.saveCampaign(p.id,{status:'running',target:100,task:{id:'task',kind:'application',jobId:job.id},attempts:{},pendingResumes:{}});
 const campaigns=new Campaigns(store,{active:()=>({sessionId:'session',candidateId:p.id,state:'Working'}),changed:()=>{},browserReady:()=>{throw Error('No browser needed');}});
 const answer=(text,blocker=documents,question='Referans ve transkript PDF dosyası var mı?')=>{
  const q=store.ask(p.id,{jobId:job.id,question,applicationBlocker:blocker});store.answer(p.id,q.id,text);campaigns.answered(p.id,q.id);return q;
 };
 return{store,p,job,campaigns,answer};
}
async function mcp(f){
 let cleanup=0;
 const server=await startMcp(f.store,()=>{},undefined,{waiting:()=>true,cleanup:async()=>{cleanup++;return{closed:['saved-tab']};}},
  {get:id=>f.store.campaign(id),recordCandidateReply:(...args)=>f.campaigns.recordCandidateReply(...args)});
 const token=server.grant(f.p.id,'session');
 const call=async(name,args)=>{
  const response=await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  const {result}=await response.json();assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text);
 };
 return{server,call,cleanup:()=>cleanup};
}

test('submission replies require explicit past application submission, not consent, uncertainty or challenge completion',()=>{
 for(const answer of ['gönderdim','Ben başvurdum','ben tamamladım gönderildi işaretke','başvuruldu işaretk\nle','gönderildi olarak işaretle','I submitted my application','I already applied'])assert.equal(isSubmissionReply(answer),true,answer);
 for(const answer of ['tamamladım','kodu tamamladım','CAPTCHA tamamlandı','evet','gönderebilirsin','gönderildi mi?','göndermedim','sanırım gönderdim','I did not submit my application','I will submit my application','I submitted my code','CV gönderdim','başvurdum ama gönderilmedi'])assert.equal(isSubmissionReply(answer),false,answer);
});

test('unavailable documents with an explicit stop do not generate another confirmation question',()=>{
 const f=fixture();try{
  const reply=f.answer('yok başvurma');
  assert.equal(f.store.taskContext(f.p.id).candidateReplyActions[0].tool,'stop_application_followup');
  const result=f.campaigns.stopApplicationFollowup(f.p.id,'session',{jobId:f.job.id,questionId:reply.id});
  assert.equal(result.status,'skipped');assert.equal(result.completion.taskReported,true);assert.equal(f.store.questions(f.p.id).filter(q=>q.answer===null).length,0);
 }finally{f.store.close();}
});

test('known absence is scoped to required documents, including individual structured fields',()=>{
 for(const answer of ['yok','hayır','belgelerim yok','bu belgeler bende yok','I don’t have these documents'])assert.equal(isMissingDocumentsReply({question:'Transkript PDF var mı?',applicationBlocker:documents,answer}),true,answer);
 for(const q of [
  {question:'Rusça seviyen?',applicationBlocker:{...documents,evidence:'Russian proficiency required'},answer:'yok'},
  {question:'Reference PDF?',applicationBlocker:{...documents,kind:'uncovered_consent'},answer:'hayır'},
  {question:'Reference PDF?',applicationBlocker:documents,answer:'yok dedim ama yükledim'},
 ])assert.equal(isMissingDocumentsReply(q),false);
 const q={question:'Dosyalar?',applicationBlocker:documents,fields:[{id:'cv',label:'CV mevcut mu?',type:'boolean'},{id:'reference',label:'Reference letters mevcut mu?',type:'boolean'}],answerValues:{cv:true,reference:false},answer:'CV mevcut mu?: Evet\nReference letters mevcut mu?: Hayır'};
 assert.equal(isMissingDocumentsReply(q),true);
 assert.equal(sameDocumentRequirement(q,{question:'CV dosyası?',applicationBlocker:{...documents,evidence:'CV upload required'}}),false);
 assert.equal(sameDocumentRequirement(q,{question:'Reference letters?',applicationBlocker:{...documents,evidence:'Reference letters required'}}),true);
 for(const question of ['Başvuru için CV dosyasını gönderir misin?','Başvuru onayının ekran görüntüsünü paylaşır mısın?','Doğrulama kodunu gönderdin mi?'])assert.deepEqual(candidateReplyActions({id:'job',status:'working'},[{id:'q',jobId:'job',question,answer:'gönderdim'}]),[],question);
});

test('candidate-reported submission completes via MCP without a synthetic send, browser connection or fabricated receipt',async()=>{
 const f=fixture();let api;
 try{
  const q=f.answer('ben tamamladım gönderildi işaretke',{kind:'access'},'Başvurunun gönderim durumu?');
  f.store.ask(f.p.id,{jobId:f.job.id,question:'Onay ekranını paylaşır mısın?',applicationBlocker:{kind:'access'}});
  // Even revoked submission permission cannot prevent accounting for an actual user report.
  f.store.saveProfile({...f.store.profile(f.p.id),authorization:'research'});
  const before=f.store.campaign(f.p.id),action=f.store.taskContext(f.p.id).candidateReplyActions[0];
  assert.equal(action.tool,'record_candidate_submission');assert.equal(action.questionId,q.id);
  assert.equal(f.campaigns.choose(f.p.id,before).kind,'verify');
  assert.equal(f.campaigns.browserGate(f.p.id,before,before.task),true);
  assert.throws(()=>f.store.updateJob(f.p.id,f.job.id,'prepared','Fake preparation','session'),/record_candidate_submission/);
  api=await mcp(f);
  const resume=await api.call('resume_application',{jobId:f.job.id});assert.equal(resume.status,'candidate_reply_action');
  const receipt=await api.call('record_candidate_submission',{jobId:f.job.id,questionId:q.id});
  assert.equal(receipt.status,'submitted');assert.equal(receipt.manualOutcome,'manual_submitted');assert.equal(receipt.proof,null);
  assert.equal(receipt.candidateSubmission.answer,q.answer??'ben tamamladım gönderildi işaretke');assert.equal(receipt.completion.taskReported,true);
  assert.equal(f.store.campaign(f.p.id).task.report.outcome,'done');assert.equal(f.store.questions(f.p.id).filter(q=>q.answer===null).length,0);
  assert.equal(api.cleanup(),1);
  await api.call('record_candidate_submission',{jobId:f.job.id,questionId:q.id});
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='candidate_submission_recorded'").get().n,1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE json_extract(data,'$.status')='submitting'").get().n,0);
  f.campaigns.signal(f.p.id,'Idle');assert.equal(f.store.campaign(f.p.id).task,null);
  assert.equal(f.campaigns.choose(f.p.id,f.store.campaign(f.p.id)),null);
 }finally{await api?.server.close();f.store.close();}
});

test('missing documents complete once without another question, retain the draft and wait for explicit retry',async()=>{
 const f=fixture();let api;
 try{
  // A legacy follow-up may already exist when the original reply arrives.
  const original=f.store.ask(f.p.id,{jobId:f.job.id,question:'Referans ve transkript dosyası?',applicationBlocker:documents});
  f.store.ask(f.p.id,{jobId:f.job.id,question:'Referans ve transkripti ileride sağlayabilir misin?',applicationBlocker:documents});
  f.store.answer(f.p.id,original.id,'bu belgeler bende yok');f.campaigns.answered(f.p.id,original.id);
  assert.throws(()=>f.store.ask(f.p.id,{jobId:f.job.id,question:'Daha sonra referans ve transkript ekler misin?',applicationBlocker:documents}),/defer_missing_documents/);
  const checkpoint=f.store.job(f.p.id,f.job.id).resumeContext;
  api=await mcp(f);
  const receipt=await api.call('defer_missing_documents',{jobId:f.job.id,questionId:original.id});
  assert.equal(receipt.status,'blocked');assert.equal(receipt.completion.taskReported,true);assert.equal(receipt.missingDocuments.questionId,original.id);
  assert.deepEqual(receipt.resumeContext,checkpoint);assert.equal(api.cleanup(),0);assert.equal(f.store.questions(f.p.id).filter(q=>q.answer===null).length,0);
  await api.call('defer_missing_documents',{jobId:f.job.id,questionId:original.id});
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='application_documents_deferred'").get().n,1);
  f.campaigns.signal(f.p.id,'Idle');assert.equal(f.store.campaign(f.p.id).task,null);
  assert.equal(f.campaigns.choose(f.p.id,{...f.store.campaign(f.p.id),attempts:{}}),null);
  f.campaigns.queueApplication(f.p.id,f.job.id);
  const next=f.campaigns.choose(f.p.id,f.store.campaign(f.p.id));assert.ok(next.retryRequestId);assert.equal(next.jobId,f.job.id);
  f.store.updateJob(f.p.id,f.job.id,'working','New files supplied','session');assert.equal(f.store.job(f.p.id,f.job.id).missingDocuments,undefined);
 }finally{await api?.server.close();f.store.close();}
});

test('reply actions reject other jobs/sessions, superseded answers, absent answers and uncertain document deferrals',()=>{
 const f=fixture();try{
  const q=f.answer('gönderdim',{kind:'access'},'Başvuru durumu?');
  assert.throws(()=>f.campaigns.recordCandidateReply(f.p.id,'other',{jobId:f.job.id,questionId:q.id},'record_candidate_submission'),/etkin/);
  const other=addRankedJob(f.store,f.p.id,{company:'Other',role:'Other',location:'Remote',fit:'Test',url:'https://example.test/other'}).job;
  assert.throws(()=>f.campaigns.recordCandidateReply(f.p.id,'session',{jobId:other.id,questionId:q.id},'record_candidate_submission'),/etkin/);
  const correction=f.answer('göndermedim',{kind:'access'},'Son durum?');
  // Equal timestamps can occur in one transaction/millisecond; newest inserted
  // answer order must still win over an older assertion.
  assert.deepEqual(candidateReplyActions(f.store.job(f.p.id,f.job.id),f.store.questions(f.p.id)),[]);
  assert.throws(()=>f.campaigns.recordCandidateReply(f.p.id,'session',{jobId:f.job.id,questionId:q.id},'record_candidate_submission'),/en son/);
  assert.throws(()=>f.campaigns.recordCandidateReply(f.p.id,'session',{jobId:f.job.id,questionId:correction.id},'record_candidate_submission'),/en son/);
  const missing=f.answer('yok');
  for(const status of ['prepared','submitting','uncertain'])f.store.updateJob(f.p.id,f.job.id,status,'Attempt','session');
  assert.throws(()=>f.campaigns.recordCandidateReply(f.p.id,'session',{jobId:f.job.id,questionId:missing.id},'defer_missing_documents'),/en son/);
  assert.equal(f.store.job(f.p.id,f.job.id).status,'uncertain');
 }finally{f.store.close();}
});

test('unrelated answers retain known document gaps; a newer document answer supersedes them',()=>{
 const f=fixture();try{
  // Create the later document question before its answer, as in legacy data.
  const missing=f.store.ask(f.p.id,{jobId:f.job.id,question:'Transkript PDF var mı?',applicationBlocker:documents});
  const supplied=f.store.ask(f.p.id,{jobId:f.job.id,question:'Transkript PDF yeni durumu?',applicationBlocker:documents});
  f.store.answer(f.p.id,missing.id,'yok');
  f.answer('2 months',{kind:'required_form_field',evidence:'Notice period required'},'Başlangıç tarihi?');
  assert.ok(f.store.taskContext(f.p.id).candidateReplyActions.some(a=>a.questionId===missing.id));
  assert.throws(()=>f.store.ask(f.p.id,{jobId:f.job.id,question:'Transkript sonradan gelir mi?',applicationBlocker:documents}),/defer_missing_documents/);
  f.store.answer(f.p.id,supplied.id,'Transkript PDF dosyasını yükledim');
  assert.deepEqual(f.store.taskContext(f.p.id).candidateReplyActions,[]);
  assert.throws(()=>f.campaigns.recordCandidateReply(f.p.id,'session',{jobId:f.job.id,questionId:missing.id},'defer_missing_documents'),/en son/);
 }finally{f.store.close();}
});

test('explicit sent or stop replies cannot be turned into new confirmation questions',()=>{
 for(const answer of ['Başvurdum','yok başvurma']){
  const f=fixture();try{
   f.answer(answer);
   assert.throws(()=>f.campaigns.askApplicationQuestion(f.p.id,'session',{jobId:f.job.id,question:'Emin misin?',applicationBlocker:{kind:'access'}}),/Yeni teyit sorusu açma/);
   assert.equal(f.store.questions(f.p.id).length,1);
  }finally{f.store.close();}
 }
});

test('reply result, duplicate-question resolution and task report roll back together',()=>{
 for(const [answer,tool] of [['Başvurdum','record_candidate_submission'],['yok','defer_missing_documents']]){
  const f=fixture();try{
   const q=f.answer(answer);
   const before=f.store.job(f.p.id,f.job.id),save=f.store.saveCampaign;
   f.store.saveCampaign=()=>{throw Error('Synthetic persistence failure');};
   assert.throws(()=>f.campaigns.recordCandidateReply(f.p.id,'session',{jobId:f.job.id,questionId:q.id},tool),/Synthetic/);
   assert.deepEqual(f.store.job(f.p.id,f.job.id),before);assert.equal(f.store.campaign(f.p.id).task.report,undefined);
   assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind IN ('candidate_submission_recorded','application_documents_deferred')").get().n,0);
   f.store.saveCampaign=save;
  }finally{f.store.close();}
 }
});
