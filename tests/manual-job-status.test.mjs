import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';

test('manual outcomes close questions, prevent automated retries and allow correction',()=>{
 const store=new Store(':memory:');
 try{
  const profile=store.saveProfile({name:'Candidate',preferences:'Remote',facts:'',authorization:'research'});
  const other=store.saveProfile({name:'Other',preferences:'Remote',facts:'',authorization:'research'});
  const job=store.addJob(profile.id,{url:'https://example.com/jobs/1',company:'Company',role:'Engineer',location:'Remote',fit:'Relevant'}).job;
  store.ask(profile.id,{jobId:job.id,question:'Ready?'});
  assert.throws(()=>store.setManualJobStatus(other.id,job.id,'withdrawn'),/bulunamadı/);
  assert.throws(()=>store.setManualJobStatus(profile.id,job.id,'found'),/Geçersiz/);
  const submitted=store.setManualJobStatus(profile.id,job.id,'manual_submitted');
  assert.equal(submitted.status,'submitted');
  assert.equal(submitted.proof,null);
  assert.equal(store.questions(profile.id).length,0);
  assert.equal(store.snapshot(profile.id).jobs[0].manualOutcome,'manual_submitted');
  assert.throws(()=>store.updateJob(profile.id,job.id,'working','Retry','agent'),/Geçersiz geçiş/);
  assert.equal(store.addJob(profile.id,job).duplicate,true);
  const withdrawn=store.setManualJobStatus(profile.id,job.id,'withdrawn');
  assert.equal(withdrawn.status,'skipped');
  assert.equal(withdrawn.manualOutcome,'withdrawn');
  assert.throws(()=>store.recordSubmission(profile.id,job.id,{},'agent'),/başlatılmadı/);
  assert.equal(store.setManualJobStatus(profile.id,job.id,'manual_submitted').status,'submitted');
 }finally{store.close();}
});

test('manual changes preserve a verified submission',()=>{
 const store=new Store(':memory:');
 try{
  const profile=store.saveProfile({name:'Candidate',preferences:'Remote',facts:'',authorization:'prepare'});
  const job=store.addJob(profile.id,{url:'https://example.com/jobs/2',company:'Company',role:'Engineer',location:'Remote',fit:'Relevant'}).job;
  job.status='submitted';job.proof={text:'Received'};store.saveJob(job,'submission_recorded');
  assert.equal(store.setManualJobStatus(profile.id,job.id,'withdrawn').status,'skipped');
  assert.equal(store.setManualJobStatus(profile.id,job.id,'already_submitted').status,'already_submitted');
  assert.deepEqual(store.job(profile.id,job.id).proof,{text:'Received'});
 }finally{store.close();}
});
