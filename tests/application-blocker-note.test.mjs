import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {addRankedJob} from './rank-fixture.mjs';

test('a changed blocker updates its note without changing state or repeating identical events',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'Candidate',preferences:'Remote',authorization:'submit'});
  const job=addRankedJob(store,p.id,{company:'Example',role:'Engineer',url:'https://example.test/job',location:'Remote',fit:'Relevant'}).job;
  store.updateJob(p.id,job.id,'working','Form open','owner');
  store.saveApplicationCheckpoint(p.id,job.id,{browser:'Chrome',tabId:'saved',url:job.url,step:'Form',nextAction:'Keep form'},'owner');
  store.updateJob(p.id,job.id,'blocked','Old permission blocker','owner');
  const before=store.job(p.id,job.id);
  assert.throws(()=>store.updateJob(p.id,job.id,'blocked','Overwrite','other'),/başka bir oturuma/);
  const updated=store.updateJob(p.id,job.id,'blocked','Site doğrulama hatası: reCAPTCHA kota sınırı.','owner');
  assert.equal(updated.status,'blocked');assert.match(updated.note,/kota/);assert.deepEqual(updated.resumeContext,before.resumeContext);assert.equal(updated.proof,null);
  const count=()=>store.db.prepare('SELECT count(*) AS n FROM events').get().n,n=count();
  store.updateJob(p.id,job.id,'blocked',updated.note,'owner');assert.equal(count(),n);
  assert.throws(()=>store.updateJob(p.id,job.id,'blocked',' ','owner'),/Açıklama/);
 }finally{store.close();}
});

test('a question on an already blocked form replaces the old explanation with the observed blocker',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'Candidate',preferences:'Remote',authorization:'submit'});
  const job=addRankedJob(store,p.id,{company:'Example',role:'Engineer',url:'https://example.test/job',location:'Remote',fit:'Relevant'}).job;
  store.updateJob(p.id,job.id,'working','Form','owner');store.updateJob(p.id,job.id,'blocked','Permission pending','owner');
  store.saveCampaign(p.id,{status:'running',task:{id:'task',kind:'application',jobId:job.id}});
  const campaigns=new Campaigns(store,{active:()=>({sessionId:'owner'}),changed:()=>{}});
  const evidence='Site doğrulama hatası: reCAPTCHA kota sınırı; gönder düğmesi pasif.';
  const receipt=campaigns.askApplicationQuestion(p.id,'owner',{jobId:job.id,question:'Doğrulama engeli devam ediyor.',applicationBlocker:{kind:'access',evidence,reasonUnknown:'Form ilerlemiyor'}});
  assert.equal(receipt.completion.taskReported,true);assert.equal(store.job(p.id,job.id).note,'Engel: '+evidence);
  assert.equal(store.campaign(p.id).task.report.note,'Engel: '+evidence);
 }finally{store.close();}
});
