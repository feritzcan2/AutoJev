import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {startMcp} from '../app/mcp.mjs';
const listing={company:'Example',role:'Developer',location:'Remote',fit:'Known fit',url:'https://example.test/job'};
const proof={kind:'success_page',text:'Application received',url:'https://example.test/confirmation',documents:'CV.pdf'};
async function fixture(){
 const store=new Store(':memory:'),candidate=store.saveProfile({name:'Candidate',preferences:'Remote',authorization:'submit'});
 const job=store.addJob(candidate.id,listing).job;let active=null,launches=0;
 const campaigns=new Campaigns(store,{active:()=>active,changed:()=>{},launch:async()=>{launches++;active={candidateId:candidate.id,sessionId:'owner',state:'Working'};},send:async()=>{launches++;},stop:async()=>{active=null;}});
 await campaigns.start(candidate.id,{target:1});campaigns.signal(candidate.id,'Working');
 const update=status=>store.updateJob(candidate.id,job.id,status,'Observed state','owner');update('working');
 return {store,candidate,job,campaigns,update,launches:()=>launches,setState:state=>{active.state=state;}};
}
test('MCP proof receipt replaces an earlier blocked report, is retryable and releases only on Idle',async()=>{
 const f=await fixture();const {store,candidate:p,job,campaigns:c}=f;let mcp;
 try{
  const taskId=store.campaign(p.id).task.id;
  const q=store.ask(p.id,{jobId:job.id,question:'Required consent?'});f.update('blocked');
  c.report(p.id,'owner',{taskId,outcome:'blocked',note:'Waiting for answer'});
  store.answer(p.id,q.id,'Confirmed');c.answered(p.id,q.id);
  for(const state of ['working','prepared','submitting'])f.update(state);
  let cleanupCalls=0;
  const browser={cleanup:async id=>{cleanupCalls++;assert.equal(store.job(id,job.id).status,'submitted');assert.equal(store.campaign(id).task?.report?.outcome??'done','done');if(cleanupCalls===2)throw Error('Browser disconnected');return {closed:['owned-tab']};}};
  mcp=await startMcp(store,()=>{},undefined,browser,{get:id=>store.campaign(id),report:(...args)=>c.report(...args),recordSubmission:(...args)=>c.recordSubmission(...args)});
  const token=mcp.grant(p.id,'owner');
  const call=async(name,args)=>{
   const res=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
   return (await res.json()).result;
  };
  let result=await call('record_submission',{jobId:job.id,...proof});assert.notEqual(result.isError,true);
  const receipt=JSON.parse(result.content[0].text);assert.equal(receipt.status,'submitted');assert.equal(receipt.completion.taskReported,true);assert.equal(receipt.completion.taskId,taskId);assert.equal(receipt.completion.nextAction,'end_turn');assert.deepEqual(receipt.tabCleanup.closed,['owned-tab']);
  assert.equal(store.campaign(p.id).task.report.outcome,'done');assert.equal(store.campaign(p.id).pendingResumes[job.id],undefined);
  await c.tick();assert.equal(f.launches(),1);assert.equal(store.campaign(p.id).task.id,taskId);
  result=await call('record_submission',{jobId:job.id,...proof});assert.notEqual(result.isError,true);assert.equal(JSON.parse(result.content[0].text).tabCleanup.deferred,true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='submission_recorded'").get().n,1);
  result=await call('report_campaign_work',{taskId,outcome:'done',note:'Late redundant report'});assert.notEqual(result.isError,true);
  result=await call('update_application',{jobId:job.id,status:'working',note:'Incorrect completion update'});assert.equal(result.isError,true);assert.equal(store.job(p.id,job.id).status,'submitted');
  f.setState('Idle');c.signal(p.id,'Idle');assert.equal(store.campaign(p.id).task,null);await c.tick();assert.equal(store.campaign(p.id).status,'complete');assert.equal(f.launches(),1);
  result=await call('record_submission',{jobId:job.id,...proof});
  assert.equal(JSON.parse(result.content[0].text).completion.taskReported,false);assert.equal(store.campaign(p.id).task,null);
 }finally{await mcp?.close();store.close();}
});
test('invalid proof and wrong session cannot complete a task',async()=>{
 const f=await fixture();try{
  f.update('prepared');f.update('submitting');
  for(const [session,data] of [['other',proof],['owner',{...proof,text:''}]]){
   assert.throws(()=>f.campaigns.recordSubmission(f.candidate.id,session,{jobId:f.job.id,...data}));
   assert.equal(f.store.job(f.candidate.id,f.job.id).status,'submitting');assert.equal(f.store.campaign(f.candidate.id).task.report,null);
  }
 }finally{f.store.close();}
});
test('proof and task completion roll back together on a persistence failure',async()=>{
 const f=await fixture();try{
  f.update('prepared');f.update('submitting');
  const save=f.store.saveCampaign.bind(f.store);f.store.saveCampaign=()=>{throw Error('Synthetic write failure');};
  assert.throws(()=>f.campaigns.recordSubmission(f.candidate.id,'owner',{jobId:f.job.id,...proof}),/Synthetic/);
  assert.equal(f.store.job(f.candidate.id,f.job.id).status,'submitting');assert.equal(f.store.campaign(f.candidate.id).task.report,null);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='submission_recorded'").get().n,0);
  f.store.saveCampaign=save;
  assert.equal(f.campaigns.recordSubmission(f.candidate.id,'owner',{jobId:f.job.id,...proof}).completion.taskReported,true);
 }finally{f.store.close();}
});
test('another job or candidate proof cannot complete the current task',async()=>{
 const f=await fixture();try{
  const other=f.store.addJob(f.candidate.id,{...listing,url:'https://example.test/other',role:'Other'}).job;
  for(const state of ['working','prepared','submitting'])f.store.updateJob(f.candidate.id,other.id,state,'Observed','owner');
  const receipt=f.campaigns.recordSubmission(f.candidate.id,'owner',{jobId:other.id,...proof});
  assert.equal(receipt.completion.taskReported,false);assert.equal(f.store.campaign(f.candidate.id).task.report,null);
  const second=f.store.saveProfile({name:'Other candidate',preferences:'Remote',authorization:'submit'});
  assert.throws(()=>f.campaigns.recordSubmission(second.id,'owner',{jobId:f.job.id,...proof}),/bulunamadı/);
  assert.equal(f.store.job(f.candidate.id,f.job.id).status,'working');
 }finally{f.store.close();}
});
test('legacy blocked reports can become done only with a completed application',async()=>{
 const f=await fixture();try{
  const taskId=f.store.campaign(f.candidate.id).task.id;
  f.store.ask(f.candidate.id,{jobId:f.job.id,question:'Required answer?'});f.update('blocked');
  f.campaigns.report(f.candidate.id,'owner',{taskId,outcome:'blocked',note:'Question saved'});
  assert.throws(()=>f.campaigns.report(f.candidate.id,'owner',{taskId,outcome:'done',note:'Not actually done'}));
  assert.equal(f.store.campaign(f.candidate.id).task.report.outcome,'blocked');
  f.update('skipped');f.campaigns.report(f.candidate.id,'owner',{taskId,outcome:'done',note:'Listing closed'});
  assert.equal(f.store.campaign(f.candidate.id).task.report.outcome,'done');
 }finally{f.store.close();}
});
