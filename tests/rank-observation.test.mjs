import test from 'node:test';
import assert from 'node:assert/strict';
import {presentRankObservation} from '../app/jev-rank-observation.mjs';
import {compactTaskContext} from '../app/agent-payloads.mjs';
const fakeSlot=(text)=>{
 const frame={evaluate:async (fn,limit)=>({text:text.slice(0,limit),truncated:text.length>limit})};
 return {owner:'worker1',page:{frames:()=>[frame],mainFrame:()=>frame}};
};
test('rank preserves errors, verification, omitted text evidence and owner recovery',async()=>{
 const slot=fakeSlot('a'.repeat(61000));
 const value={observationId:'o1',url:'https://example.test',text:'Tail salary and requirements',status:'no_progress',executed:false,verification:{kind:'challenge'},scrollTargets:[{controlId:'s1'}],fillFields:[{fieldId:'secret'}],elements:[],clickTargets:[{targetId:'t1',role:'link',label:'Details'},{targetId:'t2',role:'button',label:'Submit'}]};
 const first=await presentRankObservation(slot,value);
 assert.equal(first.reading.truncated,true);assert.equal(first.viewportText,value.text);assert.equal(first.status,value.status);assert.deepEqual(first.verification,value.verification);assert.deepEqual(first.scrollTargets,value.scrollTargets);assert.equal(first.clickTargets.length,1);
 const repeat=await presentRankObservation(slot,value);assert.equal(repeat.textUnchanged,true);assert.equal(repeat.text,undefined);
 slot.owner='worker2';assert.ok((await presentRankObservation(slot,value)).text);
 assert.ok((await presentRankObservation(slot,{...value,url:'https://other.test'})).text);
});
test('submission guidance is conditional and never resets stored status',()=>{
 const base={campaign:{task:{kind:'verify'}},setup:{status:'complete'},profile:{authorization:'submit'},reusableAnswers:[],questions:[],unfinishedTabs:[],job:{id:'j',status:'uncertain',proof:null}};
 const out=compactTaskContext(base);assert.equal(out.job.status,'uncertain');assert.match(out.submissionRecovery.nextAction,/record_submission directly/);assert.match(out.submissionRecovery.continuation,/answered access/);assert.equal(base.submissionRecovery,undefined);
 assert.equal(compactTaskContext({...base,job:{...base.job,status:'working'}}).submissionRecovery,undefined);
});
