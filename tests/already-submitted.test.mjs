import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {startMcp} from '../app/mcp.mjs';
const proof={kind:'already_submitted',text:'You applied on 27 September 2026. View application',url:'https://join.com/applications/123',documents:'Not exposed by the site'};
test('existing external application completes directly without synthetic submit or new authorization',async()=>{
 const store=new Store(':memory:');let server;
 try{
  const p=store.saveProfile({name:'Candidate',preferences:'Remote',authorization:'research'});
  const job=store.addJob(p.id,{company:'Boardwise',role:'Technical Lead',location:'Remote',fit:'Match',url:'https://join.com/jobs/123'}).job;
  store.saveCampaign(p.id,{status:'running',target:100,task:{id:'task',kind:'application',jobId:job.id},attempts:{}});
  const campaigns=new Campaigns(store,{active:()=>({sessionId:'session',candidateId:p.id}),changed:()=>{}});
  server=await startMcp(store,()=>{},undefined,null,{get:id=>store.campaign(id),recordSubmission:(...args)=>campaigns.recordSubmission(...args)});
  const token=server.grant(p.id,'session');
  const response=await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'record_submission',arguments:{jobId:job.id,...proof}}})});
  const {result}=await response.json();assert.notEqual(result.isError,true,JSON.stringify(result));
  const saved=JSON.parse(result.content[0].text);assert.equal(saved.status,'already_submitted');assert.equal(saved.completion.taskReported,true);assert.equal(saved.proof.text,proof.text);
  assert.equal(store.campaign(p.id).task.report.outcome,'done');
  assert.notEqual(campaigns.choose(p.id,store.campaign(p.id))?.jobId,job.id);
  assert.throws(()=>store.updateJob(p.id,job.id,'working','Retry','session'),/Geçersiz geçiş/);
  assert.equal(store.recordSubmission(p.id,job.id,proof,'session').status,'already_submitted');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='existing_submission_recorded'").get().n,1);
 }finally{await server?.close();store.close();}
});
test('existing application recording validates proof and session ownership; manual status works in every state',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'Candidate',preferences:'Remote'});
  const job=store.addJob(p.id,{company:'Test',role:'Lead',location:'Remote',fit:'Match',url:'https://example.test/job'}).job;
  job.status='blocked';job.sessionId='owner';store.saveJob(job,'test');
  assert.throws(()=>store.recordSubmission(p.id,job.id,proof,'other'),/oturuma/);
  assert.throws(()=>store.recordSubmission(p.id,job.id,{...proof,text:''},'owner'));
  for(const status of ['found','working','prepared','submitting','uncertain','blocked','submitted','already_submitted','skipped']){
   job.status=status;store.saveJob(job,'test');
   assert.equal(store.setManualJobStatus(p.id,job.id,'already_submitted').status,'already_submitted');
   assert.equal(store.setManualJobStatus(p.id,job.id,'withdrawn').status,'skipped');
  }
 }finally{store.close();}
});
