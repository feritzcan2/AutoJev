import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
const fixture=()=>{const store=new Store(':memory:'),p=store.saveProfile({name:'Candidate',preferences:'Berlin',facts:'Backend engineer',authorization:'prepare'});return{store,p};};
test('reusable answered facts update profile without changing authorization and newer correction wins',()=>{
 const {store,p}=fixture();try{
  const q=store.ask(p.id,{question:'Notice period?'});store.answer(p.id,q.id,'My notice period is 3 months.');
  const input={key:'notice_period',value:'3 months',source:'answer',sourceId:q.id,evidence:'3 months'};
  const updated=store.rememberFact(p.id,input);assert.match(updated.facts,/Backend engineer/);assert.match(updated.facts,/\[notice_period\] 3 months/);assert.equal(updated.authorization,'prepare');assert.deepEqual(updated.applicationPolicy,p.applicationPolicy);assert.equal(updated.learnedFacts.notice_period.sourceId,q.id);
  const correction=store.ask(p.id,{question:'Correction?'});store.answer(p.id,correction.id,'Actually 2 months');store.rememberFact(p.id,{...input,value:'2 months',sourceId:correction.id,evidence:'2 months'});
  assert.doesNotMatch(store.profile(p.id).facts,/3 months/);assert.throws(()=>store.rememberFact(p.id,input),/Eski yanıt/);
  const saved=store.saveProfile({...store.profile(p.id),facts:'Manual corrected profile'});assert.deepEqual(saved.learnedFacts,{});
 }finally{store.close();}
});
test('fact sources stay candidate scoped and cannot grant consent or invent evidence',()=>{
 const {store,p}=fixture();try{
  const other=store.saveProfile({name:'Other',preferences:'Remote'}),q=store.ask(other.id,{question:'Language?'});store.answer(other.id,q.id,'C1 English');
  const input={key:'language_levels',value:'English C1',source:'answer',sourceId:q.id,evidence:'C1 English'};
  assert.throws(()=>store.rememberFact(p.id,input),/adayın/);
  assert.throws(()=>store.rememberFact(p.id,{...input,key:'acceptPrivacy'}),/genel/);
  assert.throws(()=>store.rememberFact(p.id,{...input,source:'profile',sourceId:p.id,evidence:'C1 English'}),/Alıntı/);
  assert.throws(()=>store.rememberFact(p.id,{...input,source:'cv',sourceId:'/other/cv.pdf'}),/CV/);
  const result=store.rememberFact(p.id,{key:'experience',value:'Backend engineer',source:'profile',sourceId:p.id,evidence:'Backend engineer'});assert.equal(result.learnedFacts.experience.source,'profile');
 }finally{store.close();}
});

test('group recruitment consent is explicit, candidate-scoped, revocable and separate from marketing',()=>{
 const {store,p}=fixture();try{
  const other=store.saveProfile({name:'Other',preferences:'Remote'});assert.equal(store.profile(p.id).applicationPolicy.groupRecruitmentConsent,false);
  store.saveApplicationPolicy(p.id,{...p.applicationPolicy,acceptPrivacy:true,groupRecruitmentConsent:true});
  const policy=store.profile(p.id).applicationPolicy;assert.equal(policy.groupRecruitmentConsent,true);assert.equal(policy.marketing,'decline');assert.equal(policy.legalAgreements,'ask');assert.equal(store.profile(other.id).applicationPolicy.groupRecruitmentConsent,false);
  store.saveApplicationPolicy(p.id,{...policy,groupRecruitmentConsent:false});assert.equal(store.profile(p.id).applicationPolicy.groupRecruitmentConsent,false);
 }finally{store.close();}
});
