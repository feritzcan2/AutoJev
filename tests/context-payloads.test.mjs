import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {startMcp} from '../app/mcp.mjs';
import {rankInput} from './rank-fixture.mjs';

const listing={company:'Example',role:'Engineer',location:'Remote',fit:'Detailed candidate match. '.repeat(100),url:'https://example.test/job'};
const checkpoint={browser:'Jev Chrome',tabId:'owned',url:listing.url,step:'Pending required details',nextAction:'Read the saved reply'};
test('research retains exact facts and consent but omits their duplicate questions and server-owned drafts',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'Candidate',preferences:'Remote',authorization:'prepare'});
  const job=store.addJob(p.id,listing).job,source=store.sources(p.id)[0];
  store.saveSource(p.id,{...source,skillText:'Large source instructions. '.repeat(1000)});
  store.saveApplicationCheckpoint(p.id,job.id,checkpoint,'s');
  const fields=[{id:'permit',label:'Can work here?',type:'boolean',factKey:'work_authorization'}];
  const old=store.ask(p.id,{question:'Older known fact',fields});store.answer(p.id,old.id,{permit:true});
  const fact=store.ask(p.id,{question:'Corrected known fact',fields});store.answer(p.id,fact.id,{permit:false});
  const instruction=store.ask(p.id,{question:'Additional constraints'});store.answer(p.id,instruction.id,'Exclude agency roles');
  const consent=store.ask(p.id,{question:'Recruitment scope',fields:[{id:'privacy',label:'Consent to this scope?',type:'boolean',consentScope:'recruitment_privacy'}]});store.answer(p.id,consent.id,{privacy:false});
  const pending=store.ask(p.id,{question:'Unanswered optional detail'});
  const reply=store.ask(p.id,{jobId:job.id,question:'Job-specific missing date'});store.answer(p.id,reply.id,'Two months');
  store.saveCampaign(p.id,{status:'running',task:{id:'search',kind:'search',sourceId:source.id}});
  const ctx=store.taskContext(p.id);
  assert.deepEqual(ctx.unfinishedTabs,[]);assert.equal(ctx.profile.authorization,'prepare');
  assert.equal(ctx.source.applyMode,source.applyMode);assert.equal(ctx.source.skillText,undefined);
  assert.equal(ctx.reusableAnswers.length,1);assert.equal(ctx.reusableAnswers[0].value,false);assert.equal(ctx.reusableAnswers[0].sourceId,fact.id);
  assert.deepEqual(new Set(ctx.questions.map(q=>q.id)),new Set([instruction.id,consent.id]));
  assert.equal(store.questions(p.id).length,6);assert.equal(store.job(p.id,job.id).resumeContext.tabId,'owned');
  store.saveCampaign(p.id,{status:'running',task:{id:'apply',kind:'application',jobId:job.id}});
  const apply=store.taskContext(p.id);
  assert.equal(apply.job.resumeContext.nextAction,checkpoint.nextAction);assert.equal(apply.unfinishedTabs.length,1);
  assert.ok(apply.questions.some(q=>q.id===pending.id));assert.equal(apply.questions.find(q=>q.id===reply.id).answer,'Two months');
 }finally{store.close();}
});

test('MCP write receipts retain saved rank, duplicate and terminal guards without echoing evidence',async()=>{
 const store=new Store(':memory:');let server;
 try{
  const p=store.saveProfile({name:'Candidate',preferences:'Remote'});server=await startMcp(store);const token=server.grant(p.id,'s');
  const call=async(name,args)=>{
   const response=await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
   const result=(await response.json()).result;assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);
  };
  const added=await call('add_job',listing);assert.equal(added.duplicate,false);assert.equal(added.job.rankDecision.state,'pending');assert.equal(added.job.fit,undefined);
  const input=rankInput(store,p.id,80);input.evidence='Observed listing evidence. '.repeat(100);
  const ranked=await call('record_job_rank',{jobId:added.job.id,...input});
  assert.equal(ranked.rank.score,80);assert.equal(ranked.rankDecision.eligible,true);assert.equal(ranked.rank.evidence,undefined);
  assert.equal(store.job(p.id,ranked.id).rank.evidence,input.evidence.trim());
  assert.ok(JSON.stringify(ranked).length<JSON.stringify(store.job(p.id,ranked.id)).length*.3);
  const existing=await call('add_job',listing);assert.equal(existing.duplicate,true);assert.equal(existing.job.rank.score,80);
  store.setManualJobStatus(p.id,ranked.id,'manual_submitted');
  const sent=await call('add_job',listing);assert.equal(sent.job.status,'submitted');
  const other=store.saveProfile({name:'Other',preferences:'Different'});
  assert.throws(()=>store.applicationHistory(other.id,{jobId:ranked.id}));
 }finally{await server?.close();store.close();}
});

import {compactTaskContext} from '../app/agent-payloads.mjs';
import {presentObservation} from '../app/jev-navigation.mjs';
test('compact application preserves facts, consent, proof, uncertainty and reply scope without mutating records',()=>{
 const original={setup:{status:'complete',mode:'setup',message:'old onboarding '.repeat(300)},campaign:{status:'running',task:{kind:'verification',jobId:'j'}},profile:{authorization:'submit',facts:'Exact candidate facts',learnedFacts:{salary:{value:100,source:'candidate'}},preferences:'No agencies',agentSettings:{model:'x'},applicationPolicy:{marketing:'decline'}},job:{id:'j',status:'uncertain',proof:{evidence:'Pending confirmation'},duplicateApplication:{jobId:'other'},resumeContext:checkpoint,fit:'long ranking '.repeat(300),rank:{score:70,blockers:['gap'],dimensions:{a:'long explanation'},evidence:'listing text'}},questions:[{id:'q',jobId:'j',question:'Consent?',answer:'No',answerValues:{consent:false},fields:[{id:'consent',label:'Consent?',type:'select',consentScope:'other',options:['Yes','No'],help:'help'}]}],reusableAnswers:[{key:'salary_expectation',value:100,sourceId:'q2'}],unfinishedTabs:[{jobId:'j',status:'uncertain',resumeContext:checkpoint}],candidateReplyActions:[{questionId:'q',tool:'stop_application_followup'}]};
 const before=structuredClone(original),out=compactTaskContext(original);
 assert.deepEqual(original,before);
 for(const key of ['authorization','facts','learnedFacts','preferences','applicationPolicy'])assert.deepEqual(out.profile[key],original.profile[key]);
 for(const key of ['status','proof','duplicateApplication','resumeContext'])assert.deepEqual(out.job[key],original.job[key]);
 assert.deepEqual(out.candidateReplyActions,original.candidateReplyActions);
 assert.deepEqual(out.reusableAnswers,original.reusableAnswers);
 assert.equal(out.questions[0].fields[0].consentScope,'other');assert.equal(out.questions[0].answerValues.consent,false);
 assert.deepEqual(out.questions[0].fields[0].options,[]);assert.equal(out.job.fit,undefined);assert.deepEqual(out.job.rank.blockers,['gap']);
 assert.ok(JSON.stringify(out).length<JSON.stringify(original).length*.4);
 assert.deepEqual(compactTaskContext({...original,campaign:null}),{...original,campaign:null});
 const improvement={...original,setup:{status:'complete',mode:'improve',needsTurn:true,message:'Keep this'}};
 assert.deepEqual(compactTaskContext(improvement).setup,improvement.setup);
});
test('observation history does not repeat unchanged prose and full recovery retains history',()=>{
 const slot={owner:'a'},value={url:'https://example.test',elements:[],controls:[],history:[{action:'First'},{action:'Second'}]};
 assert.equal(presentObservation(slot,value).history.length,2);
 assert.equal(presentObservation(slot,value).history,undefined);
 assert.deepEqual(presentObservation(slot,{...value,history:[...value.history,{action:'Third'}]}).history,[{action:'Third'}]);
 assert.deepEqual(presentObservation(slot,value,{full:true}).history,value.history);
});

import {captureControls} from '../app/jev-navigation.mjs';
test('control guidance links only current owner field IDs and distinguishes selection tools',()=>{
 const slot={observed:{controls:[{node:1,role:'textbox'},{node:2,nativeSelect:true},{node:3,choice:{question:'Q',option:'No'}},{node:4,autocomplete:true}],control_guards:{1:['a'],2:['b'],3:['c'],4:['d']}},fillFields:new Map([['f-current',{owner:'a',action:{node:1}}],['f-foreign',{owner:'b',action:{node:2}}]])};
 const result=captureControls(slot,'a').controls;
 assert.equal(result[0].fieldId,'f-current');assert.equal(result[0].recommendedTool,'browser_jev_fill_fields');
 assert.equal(result[1].fieldId,undefined);assert.equal(result[1].recommendedTool,'browser_jev_select_option');
 assert.equal(result[2].recommendedTool,'browser_jev_select_choice');assert.equal(result[3].recommendedTool,'browser_jev_autocomplete');
});
