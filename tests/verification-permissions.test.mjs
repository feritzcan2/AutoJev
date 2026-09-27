import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {addRankedJob} from './rank-fixture.mjs';

const listing={company:'Example',role:'Developer',location:'Remote',fit:'Known fit',url:'https://example.test/job'};
const proof={kind:'success_page',text:'Application received',url:'https://example.test/confirmation',documents:'CV.pdf'};
function fixture(){
 const store=new Store(':memory:'),candidate=store.saveProfile({name:'Candidate',preferences:'Remote',authorization:'submit'});
 for(const source of store.sources(candidate.id))store.saveSource(candidate.id,{...source,enabled:false});
 const source=store.sources(candidate.id)[0];
 const job=addRankedJob(store,candidate.id,{...listing,sourceId:source.id}).job;
 const draft=addRankedJob(store,candidate.id,{...listing,sourceId:source.id,url:'https://example.test/draft',role:'Another role'}).job;
 for(const j of [job,draft])for(const status of ['working','prepared'])store.updateJob(candidate.id,j.id,status,'Form ready','original');
 store.updateJob(candidate.id,job.id,'submitting','Submit started with permission','original');
 return {store,candidate,source,job,draft};
}

test('restricted permissions still allow verification and proof, but never a new submission',async t=>{
 for(const [authorization,applyMode] of [['research','auto'],['prepare','auto'],['submit','prepare'],['submit','find_only'],['research','find_only']]){
  await t.test(`${authorization} / ${applyMode}`,async()=>{
   const {store,candidate:p,source,job,draft}=fixture();let active=null,prompt;
   try{
    store.updateJob(p.id,job.id,'uncertain','Submit result was lost','original');
    store.saveProfile({...store.profile(p.id),authorization});
    store.saveSource(p.id,{...store.source(p.id,source.id),applyMode});
    const campaigns=new Campaigns(store,{active:()=>active,changed:()=>{},launch:async(id,text)=>{prompt=text;active={candidateId:id,sessionId:'verifier',state:'Working'};}});
    await campaigns.start(p.id,{target:10});
    const task=store.campaign(p.id).task;
    assert.equal(task?.kind,'verify');assert.equal(task.jobId,job.id);assert.match(prompt,/WITHOUT resubmitting/);
    assert.equal(store.job(p.id,job.id).sessionId,'verifier');
    assert.throws(()=>store.updateJob(p.id,draft.id,'submitting','New submit','original'),/yetkisi|otomatik gönderime/);
    assert.throws(()=>store.recordSubmission(p.id,draft.id,proof,'original'),/başlatılmadı/);
    assert.throws(()=>campaigns.recordSubmission(p.id,'original',{jobId:job.id,...proof}),/oturuma ait/);
    assert.throws(()=>campaigns.recordSubmission(p.id,'verifier',{jobId:job.id,...proof,text:''}));
    assert.equal(store.job(p.id,job.id).status,'uncertain');assert.equal(store.campaign(p.id).task.report,null);
    const receipt=campaigns.recordSubmission(p.id,'verifier',{jobId:job.id,...proof});
    assert.equal(receipt.status,'submitted');assert.equal(receipt.proof.text,proof.text);
    assert.equal(receipt.completion.taskReported,true);assert.equal(receipt.completion.taskId,task.id);
    assert.equal(store.profile(p.id).authorization,authorization);assert.equal(store.source(p.id,source.id).applyMode,applyMode);
    campaigns.recordSubmission(p.id,'verifier',{jobId:job.id,...proof});
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='submission_recorded'").get().n,1);
    active.state='Idle';campaigns.signal(p.id,'Idle');await campaigns.tick();
    assert.equal(store.campaign(p.id).task,null);assert.equal(store.job(p.id,draft.id).status,'prepared');
   }finally{store.close();}
  });
 }
});

test('confirmation arriving after permission revocation can finish an already-started submission',()=>{
 const {store,candidate:p,source,job}=fixture();
 try{
  store.saveProfile({...store.profile(p.id),authorization:'research'});
  store.saveSource(p.id,{...store.source(p.id,source.id),applyMode:'prepare'});
  assert.equal(store.job(p.id,job.id).status,'submitting');
  const saved=store.recordSubmission(p.id,job.id,proof,'original');
  assert.equal(saved.status,'submitted');assert.equal(saved.proof.text,proof.text);
 }finally{store.close();}
});
