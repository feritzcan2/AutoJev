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
test('unrecognized errors, failed repairs and repeated damage do not create a fresh conversation',async()=>{
 for(const mode of ['other','repair','again']){const calls=[];const engine={request:async op=>{calls.push(op);if(op==='repair-history'&&mode!=='repair')return{};throw Error(mode==='other'?'unavailable':op==='repair-history'?'unrecognized damage':'provider history is damaged');}};await assert.rejects(()=>startWithResumeRepair(engine,args));assert.deepEqual(calls,mode==='other'?['start']:mode==='repair'?['start','repair-history']:['start','repair-history','start']);}
});
