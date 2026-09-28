import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.mjs';
import {questionKnowledge,validateQuestionReview,validateQuestionConsent} from '../app/question-gate.mjs';

test('explicit answers survive restart and cross jobs without exporting consent or other candidates',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jobloop-answers-'));let s=new Store(join(dir,'db'));
 try{
  const p=s.saveProfile({name:'Candidate',preferences:'Berlin'}),other=s.saveProfile({name:'Other',preferences:'Remote'});
  const first=s.addJob(p.id,{company:'First',role:'Dev',location:'Berlin',fit:'Test',url:'https://example.test/one'}).job;
  const second=s.addJob(p.id,{company:'Second',role:'Dev',location:'Berlin',fit:'Test',url:'https://example.test/two'}).job;
  const fields=[{id:'permit',label:'Çalışma ve ikamet iznin var mı?',type:'boolean',factKey:'work_authorization'},{id:'salary',label:'Yıllık brüt EUR?',type:'number',factKey:'salary_expectation'},{id:'privacy',label:'Bu şirkete izin?',type:'boolean',consentScope:'recruitment_privacy'}];
  const q=s.ask(p.id,{jobId:first.id,question:'Eksikler',fields});s.answer(p.id,q.id,{permit:false,salary:0,privacy:true});
  const secret=s.ask(other.id,{question:'Other fact',fields:[{id:'salary',label:'Other salary',type:'number',factKey:'salary_expectation'}]});s.answer(other.id,secret.id,{salary:123456});
  s.saveCampaign(p.id,{status:'running',task:{kind:'application',jobId:second.id}});
  s.close();s=new Store(join(dir,'db'));
  const ctx=s.taskContext(p.id);assert.equal(ctx.questions.length,0);assert.equal(ctx.reusableAnswers.length,2);
  assert.deepEqual(ctx.reusableAnswers.map(a=>a.value),[false,0]);assert.equal(ctx.reusableAnswers[0].sourceId,q.id);
  assert.ok(!JSON.stringify(ctx).includes('Other salary'));assert.equal(s.profile(p.id).applicationPolicy.acceptPrivacy,false);
  const review={cvChecked:'CV read',missingFacts:[{key:'work_authorization',gap:'Permit question'}]};
  assert.throws(()=>validateQuestionReview(s,p.id,{applicationBlocker:{kind:'required_form_field',review}},questionKnowledge(s,p.id)),/kayıtlı bilgi/);
  review.missingFacts[0].knownValueGap='Employer needs a category, not just work/residence permission';
  assert.doesNotThrow(()=>validateQuestionReview(s,p.id,{applicationBlocker:{kind:'required_form_field',review}},questionKnowledge(s,p.id)));
  const correction=s.ask(p.id,{question:'Düzeltme',fields:[fields[0]]});s.answer(p.id,correction.id,{permit:true});
  assert.equal(s.reusableAnswers(p.id).filter(a=>a.key==='work_authorization').length,1);assert.equal(s.reusableAnswers(p.id)[0].value,true);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('legacy single-fact forms are reusable, mixed free-text and employer consent are not',()=>{
 const s=new Store(':memory:');try{
  const p=s.saveProfile({name:'Candidate',preferences:'Berlin'});
  const field={id:'work_residence',label:'Work and residence permit?',type:'boolean'};
  const blocker={kind:'required_form_field',review:{missingFacts:[{key:'work_authorization',gap:'Combined permission'}]}};
  const legacy=s.ask(p.id,{question:'Legacy',fields:[field],applicationBlocker:blocker});s.answer(p.id,legacy.id,{work_residence:true});
  const ambiguous=s.ask(p.id,{question:'Mixed facts',fields:[{...field,factKey:'work_authorization'},{id:'salary',label:'Salary?',type:'number',factKey:'salary_expectation'}],applicationBlocker:blocker});s.answer(p.id,ambiguous.id,'yes');
  const consent=s.ask(p.id,{question:'Privacy?',fields:[{id:'privacy',label:'Privacy?',type:'boolean'}],applicationBlocker:{kind:'uncovered_consent',review:{missingFacts:[{key:'application_specific',gap:'Consent'}]}}});s.answer(p.id,consent.id,{privacy:true});
  const result=s.reusableAnswers(p.id);assert.equal(result.length,1);assert.equal(result[0].sourceId,legacy.id);
 }finally{s.close();}
});
test('all consent scopes in a batch are checked and cannot be tagged as reusable facts',()=>{
 const s=new Store(':memory:');try{
  const p=s.saveProfile({name:'Candidate',preferences:'Berlin',authorization:'submit'});
  const input={question:'Batch',fields:[{id:'privacy',label:'Privacy?',type:'boolean',consentScope:'recruitment_privacy'},{id:'submit',label:'Send?',type:'boolean',consentScope:'submission'}],applicationBlocker:{kind:'uncovered_consent',consentScope:'recruitment_privacy'}};
  assert.throws(()=>validateQuestionConsent(s,p.id,null,input),/zaten onaylı/);
  input.fields.pop();assert.doesNotThrow(()=>validateQuestionConsent(s,p.id,null,input));
  s.saveApplicationPolicy(p.id,{...p.applicationPolicy,acceptPrivacy:true});assert.throws(()=>validateQuestionConsent(s,p.id,null,input),/zaten onaylı/);
  input.fields[0].factKey='work_authorization';assert.throws(()=>s.ask(p.id,input),/ayrı alanlar/);
 }finally{s.close();}
});
test('an unanswered batch is reused across retries without overwriting its fields or answers',()=>{
 const s=new Store(':memory:');try{
  const p=s.saveProfile({name:'Candidate',preferences:'Berlin'}),fields=[{id:'salary',label:'Salary?',type:'number',factKey:'salary_expectation'}];
  const q=s.ask(p.id,{question:'Missing details',fields});
  const retry=s.ask(p.id,{question:'Reworded introduction',fields});assert.equal(retry.id,q.id);assert.equal(retry.reused,true);assert.equal(s.questions(p.id).length,1);
  s.answer(p.id,q.id,{salary:65000});
  assert.equal(s.questions(p.id)[0].answerValues.salary,65000);
  assert.notEqual(s.ask(p.id,{question:'Explicit correction',fields}).id,q.id);
 }finally{s.close();}
});
