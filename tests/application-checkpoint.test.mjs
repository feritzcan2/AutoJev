import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.mjs';
import {tools,validate,startMcp} from '../app/mcp.mjs';
const resumeContext={browser:'chrome/profile1',tabId:'actual-tab-17',url:'https://example.test/apply/42#questions',step:'Salary question',nextAction:'Fill salary and review uploaded CV'};
const listing={company:'Example',role:'Developer',location:'Berlin',fit:'Test',url:'https://example.test/42'};
test('application checkpoint survives questions, answers and restart, scoped to owner and candidate',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jobloop-checkpoint-'));let store=new Store(join(dir,'db'));
 try{
  const p=store.saveProfile({name:'Candidate',preferences:'Berlin'}),other=store.saveProfile({name:'Other',preferences:'Remote'}),job=store.addJob(p.id,listing).job;
  store.updateJob(p.id,job.id,'working','Filling form','session');
  assert.throws(()=>store.saveApplicationCheckpoint(other.id,job.id,resumeContext,'session'),/bulunamadı/);
  assert.throws(()=>store.saveApplicationCheckpoint(p.id,job.id,resumeContext,'wrong'),/oturuma/);
  assert.throws(()=>store.saveApplicationCheckpoint(p.id,job.id,{...resumeContext,url:'javascript:alert(1)'},'session'),/URL/);
  const question=store.ask(p.id,{jobId:job.id,question:'Salary?',resumeContext},'session');
  store.updateJob(p.id,job.id,'blocked','Waiting','session');store.answer(p.id,question.id,'70000');
  store.close();store=new Store(join(dir,'db'));
  const saved=store.snapshot(p.id);assert.equal(saved.jobs[0].resumeContext.tabId,resumeContext.tabId);assert.equal(saved.jobs[0].resumeContext.url,resumeContext.url);assert.equal(saved.questions[0].answer,'70000');
  store.reclaim(p.id,job.id,'resumed-session');assert.equal(store.job(p.id,job.id).resumeContext.step,'Salary question');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('MCP accepts observed checkpoint data and infers the question job from the active task',async()=>{
 const store=new Store(':memory:'),p=store.saveProfile({name:'Candidate',preferences:'Berlin'}),job=store.addJob(p.id,listing).job;
 store.updateJob(p.id,job.id,'working','Form','session');
 const schema=tools.find(t=>t.name==='ask_candidate').inputSchema;
 validate(schema,{question:'Salary?',resumeContext});assert.throws(()=>validate(schema,{question:'Salary?',resumeContext:{tabId:'made-up'}}));
 const mcp=await startMcp(store,()=>{},async()=>({}),null,{get:()=>({task:{jobId:job.id}})}),token=mcp.grant(p.id,'session');
 try{
  await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_applications',arguments:{}}})});
  const res=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ask_candidate',arguments:{question:'Salary?',resumeContext,applicationBlocker:{kind:'required_form_field',review:{cvChecked:'No CV supplied',missingFacts:[{key:'salary_expectation',gap:'Expected salary is unknown'}]},evidence:'Expected salary *',reasonUnknown:'Salary is absent from CV, profile and saved answers'}}}})});
  const result=(await res.json()).result;assert.notEqual(result.isError,true);assert.equal(store.questions(p.id)[0].jobId,job.id);assert.equal(store.job(p.id,job.id).resumeContext.tabId,resumeContext.tabId);
 }finally{await mcp.close();store.close();}
});
