import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';import {startMcp} from '../app/mcp.mjs';
test('application questions require real blockers and cannot request already-granted submission consent',async()=>{
 const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Berlin',authorization:'submit'}),job=store.addJob(p.id,{company:'Example',role:'Developer',location:'Berlin',fit:'Test',url:'https://example.test/job'}).job;
 const mcp=await startMcp(store,()=>{},async()=>({}),null,{get:()=>({task:{jobId:job.id}})}),token=mcp.grant(p.id,'session');
 const call=async args=>{const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ask_candidate',arguments:args}})});return(await response.json()).result;};
 try{
  assert.equal((await call({question:'Strong Java expertise?'})).isError,true);
  const approval={question:'May I submit?',applicationBlocker:{kind:'uncovered_consent',consentScope:'submission',evidence:'Submit application',reasonUnknown:'Approval'}};
  assert.equal((await call(approval)).isError,true);assert.equal(store.questions(p.id).length,0);
  const legitimate={question:'Mandatory permit field',applicationBlocker:{kind:'required_form_field',evidence:'Work permit type *',reasonUnknown:'Not present in CV, profile or previous answers'}};
  assert.notEqual((await call(legitimate)).isError,true);assert.equal(store.questions(p.id)[0].applicationBlocker.evidence,'Work permit type *');
  store.saveApplicationPolicy(p.id,{...store.profile(p.id).applicationPolicy,groupRecruitmentConsent:true});assert.equal((await call({...approval,applicationBlocker:{...approval.applicationBlocker,consentScope:'group_recruitment'}})).isError,true);
  store.saveProfile({...store.profile(p.id),authorization:'prepare'});assert.notEqual((await call(approval)).isError,true);assert.equal(store.profile(p.id).authorization,'prepare');
 }finally{await mcp.close();store.close();}
});
