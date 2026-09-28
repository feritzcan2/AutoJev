import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {addRankedJob} from './rank-fixture.mjs';
import {pendingQuestions} from '../src/activity.js';

function fixture(){
 const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Remote',authorization:'prepare'});
 for(const source of store.sources(p.id))store.saveSource(p.id,{...source,enabled:false});
 let active=null;const calls=[];
 const c=new Campaigns(store,{active:()=>active,changed:()=>{},launch:async(id,prompt)=>{calls.push(['launch',prompt]);active={candidateId:id,sessionId:'session',state:'Idle'};},send:async prompt=>calls.push(['send',prompt]),stop:async()=>{calls.push(['stop']);active=null;}});
 const block=()=>{
  const job=addRankedJob(store,p.id,{company:'Waiting',role:'Engineer',location:'Remote',fit:'Relevant',url:'https://example.test/job'}).job;
  store.updateJob(p.id,job.id,'working','Form','session');store.updateJob(p.id,job.id,'blocked','Needs date','session');
  const q=store.ask(p.id,{jobId:job.id,question:'Start date?',resumeContext:{browser:'Jev Chrome',tabId:'saved-tab',url:job.url,step:'Availability',nextAction:'Review form'}},'session');
  return {job,q};
 };
 return {store,p,c,calls,block,setActive:value=>active=value};
}

for(const outcome of ['manual_submitted','already_submitted'])test(`start at the application limit includes ${outcome} and leaves the campaign untouched`,async()=>{
 const f=fixture();try{
  const {job}=f.block();f.store.setManualJobStatus(f.p.id,job.id,outcome);
  const campaign={status:'complete',target:1,intervalMinutes:45,task:null,attempts:{},note:'Başvuru hedefine ulaşıldı'};
  f.store.saveCampaign(f.p.id,campaign);const sources=f.store.sources(f.p.id);
  await assert.rejects(f.c.start(f.p.id),/1 başvuru gönderildi, hedef 1/);
  assert.deepEqual(f.store.campaign(f.p.id),campaign);assert.deepEqual(f.store.sources(f.p.id),sources);assert.equal(f.calls.length,0);
  f.store.saveSource(f.p.id,{...sources[0],enabled:true});
  const resumed=await f.c.start(f.p.id,{target:2});
  assert.equal(resumed.status,'running');assert.equal(resumed.target,2);assert.equal(resumed.intervalMinutes,45);assert.equal(f.calls.length,1);
 }finally{f.store.close();}
});

for(const status of [null,'paused','stopped'])test(`queue starts ${status??'new'} campaign and retains candidate answers and settings`,async()=>{
 const f=fixture();try{
  const {job,q}=f.block(),checkpoint=f.store.job(f.p.id,job.id).resumeContext;
  if(status)f.store.saveCampaign(f.p.id,{status,target:75,intervalMinutes:45,task:null,attempts:{}});
  const result=await f.c.queueAndStartApplication(f.p.id,job.id),c=f.store.campaign(f.p.id);
  assert.equal(c.status,'running');assert.equal(c.task.jobId,job.id);assert.equal(c.task.retryRequestId,result.requestId);
  assert.equal(c.target,status?75:100);assert.equal(c.intervalMinutes,status?45:30);assert.equal(f.calls.length,1);
  assert.equal(f.store.questions(f.p.id).find(x=>x.id===q.id).answer,null);
  assert.deepEqual(f.store.job(f.p.id,job.id).resumeContext,checkpoint);assert.equal(f.store.profile(f.p.id).authorization,'prepare');
  assert.doesNotMatch(result.message,/başlatınca/);
  await f.c.queueAndStartApplication(f.p.id,job.id);assert.equal(f.calls.length,1);
 }finally{f.store.close();}
});

test('queue behind a running task keeps the current agent and task',async()=>{
 const f=fixture();try{
  const {job}=f.block();const source=f.store.sources(f.p.id)[0];f.store.saveSource(f.p.id,{...source,enabled:true});
  await f.c.start(f.p.id);const task=f.store.campaign(f.p.id).task;
  await f.c.queueAndStartApplication(f.p.id,job.id);
  assert.equal(f.calls.length,1);assert.equal(f.store.campaign(f.p.id).task.id,task.id);assert.ok(f.store.campaign(f.p.id).pendingRetries[job.id]);
 }finally{f.store.close();}
});

for(const status of [null,'paused','stopped'])test(`question retry starts ${status??'new'} campaign without answering the question`,async()=>{
 const f=fixture();try{
  const {job,q}=f.block(),checkpoint=f.store.job(f.p.id,job.id).resumeContext;
  if(status)f.store.saveCampaign(f.p.id,{status,target:75,intervalMinutes:45,task:null,attempts:{}});
  const result=await f.c.retryQuestion(f.p.id,q.id),c=f.store.campaign(f.p.id);
  assert.equal(result.queued,true);assert.equal(c.status,'running');assert.equal(c.task.jobId,job.id);
  assert.equal(c.task.recoveryQuestionId,q.id);assert.equal(c.task.resumeQuestionId,q.id);
  assert.equal(c.target,status?75:100);assert.equal(c.intervalMinutes,status?45:30);
  assert.equal(f.store.questions(f.p.id).find(item=>item.id===q.id).answer,null);
  assert.equal(pendingQuestions(JSON.parse(JSON.stringify(f.store.snapshot(f.p.id)))).length,0);
  assert.deepEqual(f.store.job(f.p.id,job.id).resumeContext,checkpoint);
  assert.equal((await f.c.retryQuestion(f.p.id,q.id)).active,true);assert.equal(f.calls.length,1);
 }finally{f.store.close();}
});

test('question retry preserves unrelated work and verifies an uncertain send before any new application',async()=>{
 const f=fixture();try{
  const {job,q}=f.block(),source=f.store.sources(f.p.id)[0];
  f.store.saveSource(f.p.id,{...source,enabled:true});await f.c.start(f.p.id);
  const task=f.store.campaign(f.p.id).task;
  await f.c.retryQuestion(f.p.id,q.id);
  assert.equal(f.store.campaign(f.p.id).task.id,task.id);assert.equal(f.calls.length,1);
  await f.c.pause(f.p.id);
  const uncertain=f.store.job(f.p.id,job.id);uncertain.status='uncertain';f.store.saveJob(uncertain,'fixture');
  f.store.saveProfile({...f.store.profile(f.p.id),authorization:'research'});
  await f.c.retryQuestion(f.p.id,q.id);
  assert.equal(f.store.campaign(f.p.id).task.kind,'verify');
  assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);
  assert.equal(f.store.job(f.p.id,job.id).status,'uncertain');
  assert.equal(f.store.questions(f.p.id).find(item=>item.id===q.id).answer,null);
 }finally{f.store.close();}
});

test('question retry resumes an interrupted task once and cancellation prevents further retries',async()=>{
 const f=fixture();try{
  const {job,q}=f.block();
  f.store.saveCampaign(f.p.id,{status:'paused',attempts:{},task:{id:'interrupted',kind:'application',jobId:job.id,applyMode:'prepare',delivery:'Blocked',seenWorking:false}});
  await f.c.retryQuestion(f.p.id,q.id);
  const task=f.store.campaign(f.p.id).task;
  assert.equal(task.id,'interrupted');assert.equal(task.recoveryQuestionId,q.id);assert.equal(task.resumeQuestionId,q.id);
  f.c.signal(f.p.id,'Working');f.c.report(f.p.id,'session',{taskId:task.id,outcome:'blocked',note:'Still needs date'});f.c.signal(f.p.id,'Idle');await f.c.tick();
  assert.equal(f.store.campaign(f.p.id).pendingRecoveries[job.id],undefined);
  assert.equal(f.store.campaign(f.p.id).pendingResumes[job.id],undefined);assert.equal(f.calls.length,1);
  assert.equal(pendingQuestions(f.store.snapshot(f.p.id))[0].id,q.id);
  f.store.setManualJobStatus(f.p.id,job.id,'withdrawn');
  await assert.rejects(f.c.retryQuestion(f.p.id,q.id),/açık başvuru sorusu bulunamadı/);
  assert.equal(f.store.job(f.p.id,job.id).manualOutcome,'withdrawn');assert.equal(f.calls.length,1);
 }finally{f.store.close();}
});

test('retry hides an existing question during active work and restores it when the check still needs an answer',async()=>{
 const f=fixture();try{
  const {job,q}=f.block();
  await f.c.queueAndStartApplication(f.p.id,job.id);
  const task=f.store.campaign(f.p.id).task;
  assert.equal(pendingQuestions(f.store.snapshot(f.p.id))[0].id,q.id);
  assert.equal((await f.c.retryQuestion(f.p.id,q.id)).active,true);
  assert.equal(pendingQuestions(f.store.snapshot(f.p.id)).length,0);assert.equal(f.calls.length,1);
  f.c.signal(f.p.id,'Working');f.c.report(f.p.id,'session',{taskId:task.id,outcome:'blocked',note:'Still needs date'});f.c.signal(f.p.id,'Idle');
  assert.equal(pendingQuestions(f.store.snapshot(f.p.id))[0].id,q.id);
  assert.equal(f.store.questions(f.p.id)[0].answer,null);
  assert.equal(f.store.campaign(f.p.id).pendingRecoveries[job.id],undefined);
 }finally{f.store.close();}
});

test('retry keeps unrelated questions visible and restores the question when startup fails or the campaign pauses',async()=>{
 const f=fixture();try{
  const {job,q}=f.block();
  const other=f.store.addJob(f.p.id,{company:'Other',role:'Engineer',location:'Remote',fit:'Relevant',url:'https://example.test/other'}).job;
  const unrelated=f.store.ask(f.p.id,{jobId:other.id,question:'Other question'}),global=f.store.ask(f.p.id,{question:'Profile question'});
  f.c.launch=async()=>{throw Error('Start failed');};
  await f.c.retryQuestion(f.p.id,q.id);
  assert.ok(pendingQuestions(f.store.snapshot(f.p.id)).some(item=>item.id===q.id));
  f.c.launch=async()=>{f.setActive({candidateId:f.p.id,sessionId:'session',state:'Idle'});};
  await f.c.retryQuestion(f.p.id,q.id);
  assert.deepEqual(pendingQuestions(f.store.snapshot(f.p.id)).map(item=>item.id).sort(),[global.id,unrelated.id].sort());
  assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);
  await f.c.pause(f.p.id);
  assert.ok(pendingQuestions(f.store.snapshot(f.p.id)).some(item=>item.id===q.id));
 }finally{f.store.close();}
});

test('explicit question retry overrides profile mode while preserving candidate scope and browser readiness',async()=>{
 const f=fixture();try{
  const {job,q}=f.block(),other=f.store.saveProfile({name:'Other',preferences:'Remote'});
  await assert.rejects(f.c.retryQuestion(other.id,q.id),/açık başvuru sorusu bulunamadı/);
  f.store.saveProfile({...f.store.profile(f.p.id),authorization:'research'});
  f.c.browserReady=()=>({ready:false});
  const result=await f.c.retryQuestion(f.p.id,q.id);
  assert.match(result.message,/Chrome (?:izni ve )?bağlantısı bekleniyor/);assert.equal(f.calls.length,0);
  assert.equal(f.store.campaign(f.p.id).pendingRecoveries[job.id],q.id);assert.ok(f.store.job(f.p.id,job.id).manualApplication);
 }finally{f.store.close();}
});

test('requeue after blocked delivery resumes the saved task and consumes the retry once',async()=>{
 const f=fixture();try{
  const {job}=f.block();
  f.store.saveCampaign(f.p.id,{status:'paused',target:100,intervalMinutes:30,attempts:{},task:{id:'interrupted',kind:'application',jobId:job.id,applyMode:'prepare',delivery:'Blocked',seenWorking:false}});
  f.setActive({candidateId:f.p.id,sessionId:'old',state:'Idle'});
  const result=await f.c.queueAndStartApplication(f.p.id,job.id),task=f.store.campaign(f.p.id).task;
  assert.equal(task.id,'interrupted');assert.equal(task.retryRequestId,result.requestId);
  assert.deepEqual(f.calls.map(x=>x[0]),['stop','launch']);assert.match(f.calls[1][1],/explicitly (?:re)?queued/);
  f.c.signal(f.p.id,'Working');f.c.report(f.p.id,'session',{taskId:task.id,outcome:'blocked',note:'Still needs date'});f.c.signal(f.p.id,'Idle');await f.c.tick();
  assert.equal(f.store.campaign(f.p.id).pendingRetries[job.id],undefined);assert.equal(f.calls.length,2);
 }finally{f.store.close();}
});

test('queued work waits for browser readiness and reports launch errors honestly',async()=>{
 const f=fixture();try{
  const {job}=f.block();f.c.browserReady=()=>({ready:false});
  const result=await f.c.queueAndStartApplication(f.p.id,job.id);
  assert.match(result.message,/Chrome (?:izni ve )?bağlantısı bekleniyor/);assert.equal(f.calls.length,0);
  f.c.browserReady=()=>({ready:true});f.c.launch=async()=>{throw Error('Önce CV seç');};
  const failed=await f.c.queueAndStartApplication(f.p.id,job.id);
  assert.match(failed.message,/Önce CV seç/);assert.ok(f.store.campaign(f.p.id).pendingRetries[job.id]);
 }finally{f.store.close();}
});

test('enabling a source starts a stopped campaign with its saved settings',async()=>{
 const f=fixture();try{
  f.store.saveCampaign(f.p.id,{status:'stopped',target:75,intervalMinutes:45,attempts:{},task:null});
  const source=f.store.sources(f.p.id)[0];await f.c.saveSource(f.p.id,{...source,enabled:true});
  const c=f.store.campaign(f.p.id);assert.equal(c.status,'running');assert.equal(c.task.sourceId,source.id);
  assert.equal(c.target,75);assert.equal(c.intervalMinutes,45);assert.equal(f.calls.length,1);
 }finally{f.store.close();}
});

test('adding an enabled source starts a new campaign',async()=>{
 const f=fixture();try{
  const source=await f.c.saveSource(f.p.id,{name:'New source',url:'https://example.test/jobs',query:'Backend',intervalMinutes:30,enabled:true});
  assert.equal(f.store.campaign(f.p.id).task.sourceId,source.id);assert.equal(f.calls.length,1);
 }finally{f.store.close();}
});

test('editing or disabling a source leaves a paused campaign paused',async()=>{
 const f=fixture();try{
  const source=f.store.sources(f.p.id)[0];f.store.saveSource(f.p.id,{...source,enabled:true});
  f.store.saveCampaign(f.p.id,{status:'paused',attempts:{},task:null});
  await f.c.saveSource(f.p.id,{...source,enabled:true,intervalMinutes:60});
  await f.c.saveSource(f.p.id,{...source,enabled:false});
  assert.equal(f.store.campaign(f.p.id).status,'paused');assert.equal(f.calls.length,0);
 }finally{f.store.close();}
});

test('enabling another source keeps the running task and agent',async()=>{
 const f=fixture();try{
  const [first,second]=f.store.sources(f.p.id);await f.c.saveSource(f.p.id,{...first,enabled:true});const task=f.store.campaign(f.p.id).task;
  await f.c.saveSource(f.p.id,{...second,enabled:true});
  assert.equal(f.calls.length,1);assert.equal(f.store.campaign(f.p.id).task.id,task.id);
 }finally{f.store.close();}
});

test('simultaneous queue and source enable share startup while the old session closes',async()=>{
 const f=fixture();try{
  const {job}=f.block(),source=f.store.sources(f.p.id)[0];f.store.saveCampaign(f.p.id,{status:'paused',target:75,intervalMinutes:45,attempts:{},task:null});
  f.setActive({candidateId:f.p.id,sessionId:'old',state:'Idle'});
  let release;const closing=new Promise(resolve=>{release=resolve;});
  f.c.stop=async()=>{f.calls.push(['stop']);await closing;f.setActive(null);};
  const queued=f.c.queueAndStartApplication(f.p.id,job.id),enabled=f.c.saveSource(f.p.id,{...source,enabled:true});
  await new Promise(setImmediate);assert.deepEqual(f.calls.map(x=>x[0]),['stop']);release();await Promise.all([queued,enabled]);
  assert.deepEqual(f.calls.map(x=>x[0]),['stop','launch']);assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);assert.equal(f.store.source(f.p.id,source.id).enabled,true);
 }finally{f.store.close();}
});

for(const status of ['paused','running'])test(`saved reply wakes ${status} campaign without losing pending work`,async()=>{
 const f=fixture();try{
  const {job,q}=f.block();
  f.store.saveCampaign(f.p.id,{status,target:200,intervalMinutes:45,task:null,attempts:{[job.id]:Date.now()}});
  f.store.answer(f.p.id,q.id,'Tomorrow');
  const result=await f.c.continueAfterAnswer(f.p.id,q.id);
  assert.equal(result.delivery,'queued');assert.equal(f.store.campaign(f.p.id).status,'running');
  assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);assert.equal(f.store.campaign(f.p.id).task.resumeQuestionId,q.id);
  assert.equal(f.store.campaign(f.p.id).target,200);assert.equal(f.calls.length,1);
 }finally{f.store.close();}
});
test('failed wake preserves the reply and reports the actual delivery failure',async()=>{
 const f=fixture();try{
  const {q}=f.block();f.store.saveCampaign(f.p.id,{status:'paused',target:200,intervalMinutes:30,task:null,attempts:{}});
  f.store.answer(f.p.id,q.id,'Tomorrow');f.c.launch=async()=>{throw Error('Provider unavailable');};
  const result=await f.c.continueAfterAnswer(f.p.id,q.id);
  assert.equal(result.delivery,'saved');assert.match(result.message,/Provider unavailable/);
  assert.equal(f.store.questions(f.p.id).find(x=>x.id===q.id).answer,'Tomorrow');
 }finally{f.store.close();}
});
test('reply after blocked delivery recovers unfinished task and keeps answered application queued',async()=>{
 const f=fixture();try{
  const {job,q}=f.block();const source=f.store.sources(f.p.id)[0];
  f.store.saveSource(f.p.id,{...source,enabled:true});await f.c.start(f.p.id);
  const task=f.store.campaign(f.p.id).task;
  f.c.delivery(f.p.id,'Blocked');f.store.answer(f.p.id,q.id,'Tomorrow');
  await f.c.continueAfterAnswer(f.p.id,q.id);
  const c=f.store.campaign(f.p.id);
  assert.equal(c.status,'running');assert.equal(c.task.id,task.id);
  assert.equal(c.pendingResumes[job.id],q.id);assert.equal(f.calls.filter(x=>x[0]==='stop').length,1);
 }finally{f.store.close();}
});
test('answer during a working turn does not interrupt or dispatch another turn',async()=>{
 const f=fixture();try{
  const {job,q}=f.block();const source=f.store.sources(f.p.id)[0];
  f.store.saveSource(f.p.id,{...source,enabled:true});await f.c.start(f.p.id);
  const task=f.store.campaign(f.p.id).task;
  f.setActive({candidateId:f.p.id,sessionId:'session',state:'Working'});f.c.signal(f.p.id,'Working');
  f.store.answer(f.p.id,q.id,'Tomorrow');await f.c.continueAfterAnswer(f.p.id,q.id);
  assert.equal(f.store.campaign(f.p.id).task.id,task.id);assert.equal(f.calls.length,1);
  assert.equal(f.store.campaign(f.p.id).pendingResumes[job.id],q.id);
 }finally{f.store.close();}
});
