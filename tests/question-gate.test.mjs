import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';import {startMcp} from '../app/mcp.mjs';
test('application questions require real blockers and cannot request already-granted submission consent',async()=>{
 const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Berlin',authorization:'submit'}),job=store.addJob(p.id,{company:'Example',role:'Developer',location:'Berlin',fit:'Test',url:'https://example.test/job'}).job;
 const mcp=await startMcp(store,()=>{},async()=>({}),null,{get:()=>({task:{jobId:job.id}})}),token=mcp.grant(p.id,'session');
 const call=async args=>{await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_applications',arguments:{}}})});if(args.applicationBlocker)args={...args,applicationBlocker:{...args.applicationBlocker,review:{cvChecked:'No CV present',missingFacts:[{key:'application_specific',gap:'Observed required field unanswered'}]}}};const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ask_candidate',arguments:args}})});return(await response.json()).result;};
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

import {questionKnowledge,validateQuestionReview} from '../app/question-gate.mjs';
test('task review survives MCP restart without another context read and never crosses tasks',async()=>{
 const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Remote'});
 const job=store.addJob(p.id,{company:'Example',role:'Dev',location:'Remote',fit:'Test',url:'https://example.test/restart'}).job;
 store.saveCampaign(p.id,{status:'running',task:{id:'first',kind:'application',jobId:job.id}});
 let server=await startMcp(store),token=server.grant(p.id,'before');
 const call=async(name,args={})=>(await(await fetch(server.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 const question={jobId:job.id,question:'Required start date?',applicationBlocker:{kind:'required_form_field',evidence:'Start date *',reasonUnknown:'No supported date',review:{cvChecked:'No CV',missingFacts:[{key:'notice_period',gap:'Exact date unknown'}]}}};
 try{
  assert.equal((await call('ask_candidate',question)).isError,true);
  await call('get_task_context');
  await server.close();server=await startMcp(store);token=server.grant(p.id,'after');
  store.saveProfile({...store.profile(p.id),facts:'Additional information received'});
  assert.notEqual((await call('ask_candidate',question)).isError,true);
  store.saveCampaign(p.id,{status:'running',task:{id:'second',kind:'application',jobId:job.id}});
  assert.equal((await call('ask_candidate',question)).isError,true);
  const access={jobId:job.id,question:'Restore the original browser tool',applicationBlocker:{kind:'access',evidence:'Original Chrome tool unavailable',reasonUnknown:'Cannot inspect saved draft',recovery:{kind:'user_only',userActionReason:'Enable the original browser tool'}}};
  assert.notEqual((await call('ask_candidate',access)).isError,true);
  access.applicationBlocker.recovery.userActionReason=' ';
  assert.equal((await call('ask_candidate',access)).isError,true);
 }finally{await server.close();store.close();}
});
test('question review reuses task-start reads but checks current known facts and manual-entry evidence',()=>{
 const store=new Store(':memory:');
 try{
  const p=store.saveProfile({name:'Test',preferences:'Berlin',facts:'Email: test@example.test'});
  store.rememberFact(p.id,{key:'contact',value:'test@example.test',source:'profile',sourceId:p.id,evidence:'test@example.test'});
  const review={cvChecked:'No CV present',missingFacts:[{key:'contact',gap:'Email required'}]};
  const input={applicationBlocker:{kind:'required_form_field',review}};
  assert.throws(()=>validateQuestionReview(store,p.id,input,null),/get_task_context/);
  const read=questionKnowledge(store,p.id);
  assert.throws(()=>validateQuestionReview(store,p.id,input,read),/kayıtlı bilgi/);
  review.missingFacts[0].knownValueGap='Saved email present; mandatory LinkedIn URL absent';
  assert.doesNotThrow(()=>validateQuestionReview(store,p.id,input,read));
  input.applicationBlocker.kind='access';
  assert.throws(()=>validateQuestionReview(store,p.id,input,read),/userActionReason/);
  input.applicationBlocker.recovery={kind:'form_entry',userActionReason:'Field clears both tool inputs; user can type in saved tab',attempts:[{method:'fill and blur',result:'empty'}]};
  assert.throws(()=>validateQuestionReview(store,p.id,input,read),/screenshot/);
  input.applicationBlocker.recovery.visualCheck={method:'screenshot',result:'empty',evidence:'Email visibly empty after blur'};
  assert.throws(()=>validateQuestionReview(store,p.id,input,read),/iki farklı/);
  input.applicationBlocker.recovery.attempts.push({method:'keyboard type and blur',result:'empty'});
  assert.doesNotThrow(()=>validateQuestionReview(store,p.id,input,read));
  input.applicationBlocker.recovery={kind:'user_only',userActionReason:'Observed MFA requires user code'};
  assert.doesNotThrow(()=>validateQuestionReview(store,p.id,input,read));
  const q=store.ask(p.id,{question:'New correction'});store.answer(p.id,q.id,'New email');
  assert.doesNotThrow(()=>validateQuestionReview(store,p.id,input,read));
  const other=store.saveProfile({name:'Other',preferences:'Remote'});
  input.applicationBlocker.kind='required_form_field';
  assert.throws(()=>validateQuestionReview(store,other.id,input,read),/get_task_context/);
 }finally{store.close();}
});

test('technical resolution is candidate scoped and never fabricates an answer or consent',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'Test',preferences:'Remote'}),other=store.saveProfile({name:'Other',preferences:'Remote'});
  const q=store.ask(p.id,{question:'Type email',applicationBlocker:{kind:'access',recovery:{kind:'form_entry'}}});
  assert.throws(()=>store.resolveTechnicalQuestion(other.id,q.id,'Visible value'));
  store.resolveTechnicalQuestion(p.id,q.id,'Screenshot confirms email visibly filled despite masked DOM');
  assert.equal(store.questions(p.id).length,0);
  assert.equal(store.db.prepare('SELECT answer FROM questions WHERE id=?').get(q.id).answer,null);
  const consent=store.ask(p.id,{question:'Consent?',applicationBlocker:{kind:'uncovered_consent'}});
  assert.throws(()=>store.resolveTechnicalQuestion(p.id,consent.id,'Assumed'));
 }finally{store.close();}
});

test('CAPTCHA escalation requires a remaining challenge and attempts or a concrete tool limitation',async()=>{
 const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Remote'});
 const job=store.addJob(p.id,{company:'Example',role:'Dev',location:'Remote',fit:'Test',url:'https://example.test/captcha'}).job;
 store.saveCampaign(p.id,{status:'running',task:{id:'task',kind:'application',jobId:job.id}});
 const server=await startMcp(store),token=server.grant(p.id,'session');
 const call=async(name,args={})=>(await(await fetch(server.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
 try{
  await call('get_task_context');
  const recovery={kind:'captcha',userActionReason:'Complete the remaining challenge in the retained tab',captchaCheck:{state:'required',capability:'supported',evidence:'Fresh screenshot still shows the challenge'}};
  const input={jobId:job.id,question:'Complete this remaining challenge',applicationBlocker:{kind:'access',evidence:'Visible CAPTCHA challenge',reasonUnknown:'The challenge did not clear automatically',recovery}};
  assert.equal((await call('ask_candidate',input)).isError,true);
  recovery.attempts=[{method:'Normal visible challenge controls',result:'Challenge remained after verification'}];
  for(const state of ['checking','cleared']){
   recovery.captchaCheck.state=state;assert.equal((await call('ask_candidate',input)).isError,true);
  }
  recovery.captchaCheck.state='required';
  assert.notEqual((await call('ask_candidate',input)).isError,true); // No irrelevant CV review.
  delete recovery.attempts;
  for(const capability of ['tool_disallowed','not_exposed']){
   recovery.captchaCheck.capability=capability;delete recovery.captchaCheck.limitation;
   assert.equal((await call('ask_candidate',input)).isError,true);
   recovery.captchaCheck.limitation=capability==='tool_disallowed'?'Active browser tool explicitly requires human handling':'Challenge is inside an iframe the active tool cannot expose';
   assert.notEqual((await call('ask_candidate',input)).isError,true);
  }
  assert.equal(store.questions(p.id).length,3);
 }finally{await server.close();store.close();}
});
