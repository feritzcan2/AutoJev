import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
test('changed technical diagnosis updates one question but keeps facts and other jobs separate',()=>{
 const s=new Store(':memory:');try{
 const p=s.saveProfile({name:'Test',preferences:'Remote'});
 const job=s.addJob(p.id,{company:'Test',role:'Role',location:'Berlin',fit:'Test',url:'https://example.test/job'}).job;
 const blocker={kind:'access',recovery:{kind:'form_entry'},evidence:'City options inaccessible'};
 const first=s.ask(p.id,{jobId:job.id,question:'Select City',applicationBlocker:blocker});
 const next=s.ask(p.id,{jobId:job.id,question:'City still inaccessible after checking',applicationBlocker:{...blocker,evidence:'Fresh check: City empty'}});
 assert.equal(next.id,first.id);assert.equal(next.reused,true);assert.equal(s.questions(p.id).length,1);assert.equal(s.questions(p.id)[0].applicationBlocker.evidence,'Fresh check: City empty');
 const fact=s.ask(p.id,{jobId:job.id,question:'Start date?',applicationBlocker:{kind:'required_form_field'}});assert.notEqual(fact.id,first.id);
 s.answer(p.id,first.id,'Done');const newQuestion=s.ask(p.id,{jobId:job.id,question:'Another technical step',applicationBlocker:blocker});assert.notEqual(newQuestion.id,first.id);
 }finally{s.close();}
});
test('OTP handoff refreshes the open question without inventing an answer',()=>{
 const s=new Store(':memory:');try{
 const p=s.saveProfile({name:'Test',preferences:'Remote'});const j=s.addJob(p.id,{company:'Test',role:'Role',location:'Berlin',fit:'Test',url:'https://example.test/job'}).job;
 const applicationBlocker={kind:'access',recovery:{kind:'user_only'},evidence:'OTP required'};
 const q=s.ask(p.id,{jobId:j.id,question:'Verification code?',applicationBlocker});
 const next=s.ask(p.id,{jobId:j.id,question:'New code requested; previous code expired',applicationBlocker});
 assert.equal(next.id,q.id);assert.equal(next.answer,null);
 }finally{s.close();}
});
