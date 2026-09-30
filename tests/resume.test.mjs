import test from 'node:test';
import assert from 'node:assert/strict';
import {startWithResumeRepair} from '../app/resume.mjs';
const args={provider:'codex',resumeId:'original',sessionId:'runtime',cwd:'/candidate',runtimeDirectory:'/runtime'};
test('known damage repairs once then retries the same conversation and settings',async()=>{
 const calls=[];let repaired;
 const engine={request:async(op,data)=>{calls.push({op,data});if(calls.length===1)throw Error('the provider history is damaged and requires explicit repair');return {repaired:true};}};
 await startWithResumeRepair(engine,args,r=>repaired=r);
 assert.deepEqual(calls.map(c=>c.op),['start','repair-history','start']);assert.deepEqual(calls[2].data,args);assert.equal(repaired.repaired,true);
});
test('provider rejection while resuming retries once as a fresh conversation',async()=>{
 const calls=[];let recovery;
 const engine={request:async(op,data)=>{calls.push({op,data});if(calls.length===1)throw Error('the provider rejected runtime preparation');return {started:true};}};
 await startWithResumeRepair(engine,args,result=>recovery=result);
 assert.deepEqual(calls.map(c=>c.op),['start','start']);assert.equal(calls[1].data.resumeId,undefined);assert.deepEqual(recovery,{fresh:true,replacedResumeId:'original'});
});
test('remote permission rejection starts fresh once and preserves model, permissions and task prompt',async()=>{
 const calls=[],input={...args,model:'gpt-5.6-terra',permission:'bypassPermissions',prompt:'Continue saved job'};
 const engine={request:async(op,data)=>{calls.push({op,data});if(calls.length===1)throw Error('Error: Permission overrides are not supported when resuming a remote task.');return {started:true};}};
 await startWithResumeRepair(engine,input);
 assert.equal(calls.length,2);assert.deepEqual(calls[1].data,{...input,resumeId:undefined});
});
test('unknown outcomes and fresh failures never loop',async()=>{
 for(const message of ['unavailable','request timeout']){
  let calls=0;await assert.rejects(startWithResumeRepair({request:async()=>{calls++;throw Error(message);}},args));assert.equal(calls,1);
 }
 let calls=0;await assert.rejects(startWithResumeRepair({request:async()=>{calls++;throw Error('failed to resume');}},args));assert.equal(calls,2);
});
test('persistent history damage falls back fresh after one repair',async()=>{
 const calls=[];const engine={request:async(op,data)=>{calls.push({op,data});if(op==='repair-history')return {repaired:true};if(data.resumeId)throw Error('provider history is damaged');return {started:true};}};
 await startWithResumeRepair(engine,args);assert.deepEqual(calls.map(c=>c.op),['start','repair-history','start','start']);assert.equal(calls[3].data.resumeId,undefined);
});
import {rejectedResumeOnExit} from '../app/resume.mjs';
test('late CLI rejection is eligible for fresh recovery only on a resumed Codex process',()=>{
 const active={provider:'codex',resumeId:'original',resumeDiagnostic:'Error: Permission overrides are not supported when resuming a remote task.'};
 assert.equal(rejectedResumeOnExit(active),true);assert.equal(rejectedResumeOnExit({...active,resumeReady:true}),true);assert.equal(rejectedResumeOnExit({...active,resumeId:null}),false);assert.equal(rejectedResumeOnExit({...active,resumeDiagnostic:'normal output'}),false);
});

import {selectResume} from '../app/resume.mjs';
import {Store} from '../app/store.mjs';
test('model, permission or network changes start fresh; compatible settings preserve resume',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'Test',preferences:'Remote'}),settings={provider:'codex',permission:'plan',network:false};
  store.saveConversation(p.id,'codex','old');assert.equal(selectResume(store,p.id,settings),undefined);
  store.saveConversation(p.id,'codex','old',settings);assert.equal(selectResume(store,p.id,settings),'old');
  assert.equal(selectResume(store,p.id,{...settings,model:'default'}),'old');
  assert.equal(selectResume(store,p.id,{...settings,model:'another-model'}),undefined);
  assert.equal(selectResume(store,p.id,{...settings,reasoning:'high'}),undefined);
  assert.equal(selectResume(store,p.id,{...settings,permission:'bypassPermissions'}),undefined);
  assert.equal(selectResume(store,p.id,{...settings,network:true}),undefined);
  store.saveConversation(p.id,'codex','new',{...settings,permission:'bypassPermissions'});
  assert.equal(selectResume(store,p.id,{...settings,permission:'bypassPermissions'}),'new');
 }finally{store.close();}
});
