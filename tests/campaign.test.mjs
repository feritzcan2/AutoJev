import {addRankedJob} from './rank-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
function fixture(){const store=new Store(':memory:');const p=store.saveProfile({name:'Test',preferences:'Berlin',facts:'',authorization:'submit'});const [first,...rest]=store.sources(p.id);store.saveSource(p.id,{...first,intervalMinutes:1});for(const source of rest)store.saveSource(p.id,{...source,enabled:false});let time=Date.now()+10000,active=null;const calls=[];const c=new Campaigns(store,{now:()=>time,active:()=>active,changed:()=>{},launch:async(id,prompt)=>{calls.push(prompt);active={candidateId:id,sessionId:'session'};},send:async prompt=>calls.push(prompt),stop:async()=>{active=null;}});return{store,p,c,calls,setTime:t=>time=t,getTime:()=>time,setActive:a=>active=a};}
function finish(f,outcome='done'){const task=f.store.campaign(f.p.id).task;f.c.signal(f.p.id,'Working');f.c.report(f.p.id,'session',{taskId:task.id,outcome,note:'Test complete'});f.c.signal(f.p.id,'Idle');}
const listing={company:'Example',role:'Counsel',location:'Berlin',fit:'Law background',url:'https://example.test/jobs/1'};
test('idle and silence do not duplicate initial work; confirmed completion advances queue',async()=>{const f=fixture();try{
 await f.c.start(f.p.id,{target:2,intervalMinutes:1});assert.equal(f.calls.length,1);f.c.signal(f.p.id,'Idle');await f.c.tick();assert.equal(f.calls.length,1);
 const j=addRankedJob(f.store,f.p.id,listing).job;finish(f);await f.c.tick();assert.equal(f.calls.length,2);assert.equal(f.store.campaign(f.p.id).task.jobId,j.id);
 f.c.signal(f.p.id,'Compacting');await f.c.tick();assert.equal(f.calls.length,2);
}finally{f.store.close();}});
test('no results waits for scheduled rescan, pause blocks dispatch and resume continues',async()=>{const f=fixture();try{
 await f.c.start(f.p.id,{target:2,intervalMinutes:1});finish(f,'no_results');await f.c.tick();assert.equal(f.calls.length,1);f.setTime(f.getTime()+60001);await f.c.tick();assert.equal(f.calls.length,2);await f.c.pause(f.p.id);f.setTime(f.getTime()+60001);await f.c.tick();assert.equal(f.calls.length,2);await f.c.start(f.p.id,{target:2,intervalMinutes:1});assert.equal(f.calls.length,3);
}finally{f.store.close();}});
test('due sources run in order without waiting for another source interval',async()=>{const f=fixture();try{
 const second=f.store.sources(f.p.id)[1];f.store.saveSource(f.p.id,{...second,enabled:true,intervalMinutes:5});
 await f.c.start(f.p.id,{target:2,intervalMinutes:1});assert.match(f.calls[0],/LinkedIn/);finish(f,'no_results');await f.c.tick();assert.equal(f.calls.length,2);assert.match(f.calls[1],/StepStone/);
 finish(f,'no_results');await f.c.tick();assert.equal(f.calls.length,2);
}finally{f.store.close();}});
test('answered application re-enters queue while unanswered jobs do not block independent jobs',async()=>{const f=fixture();try{
 const j=addRankedJob(f.store,f.p.id,listing).job;f.store.updateJob(f.p.id,j.id,'working','Form','session');f.store.updateJob(f.p.id,j.id,'blocked','Needs date','session');const q=f.store.ask(f.p.id,{jobId:j.id,question:'Start date?'});
 await f.c.start(f.p.id,{target:2,intervalMinutes:1});assert.equal(f.store.campaign(f.p.id).task.kind,'search');finish(f);f.store.answer(f.p.id,q.id,'Now');f.c.answered(f.p.id,q.id);await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.jobId,j.id);
}finally{f.store.close();}});
test('an unanswered global question does not stop independent source work',async()=>{const f=fixture();try{
 f.store.ask(f.p.id,{question:'Reusable preference?'});await f.c.start(f.p.id,{target:2,intervalMinutes:1});assert.equal(f.store.campaign(f.p.id).task.kind,'search');assert.match(f.calls[0],/LinkedIn/);assert.match(f.store.campaign(f.p.id).note,/Görev kuyrukta/);
}finally{f.store.close();}});
test('crash uses backoff and uncertain submission becomes verification, never retry-submit',async()=>{const f=fixture();try{
 const j=addRankedJob(f.store,f.p.id,listing).job;f.store.updateJob(f.p.id,j.id,'working','Form','session');f.store.updateJob(f.p.id,j.id,'prepared','Ready','session');f.store.updateJob(f.p.id,j.id,'submitting','Click','session');
 await f.c.start(f.p.id,{target:2,intervalMinutes:1});f.store.recoverSession(f.p.id,'session');f.setActive(null);f.c.exited(f.p.id);await f.c.tick();assert.equal(f.calls.length,1);f.setTime(f.getTime()+40000);await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.kind,'search');finish(f);await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.kind,'verify');assert.match(f.calls.at(-1),/WITHOUT resubmitting/);
}finally{f.store.close();}});
test('target stops scheduler; stale and wrong-session reports rejected',async()=>{const f=fixture();try{
 await f.c.start(f.p.id,{target:1,intervalMinutes:1});const task=f.store.campaign(f.p.id).task;assert.throws(()=>f.c.report(f.p.id,'other',{taskId:task.id,outcome:'done',note:'x'}));
 const j=addRankedJob(f.store,f.p.id,listing).job;for(const status of ['working','prepared','submitting'])f.store.updateJob(f.p.id,j.id,status,'x','session');f.store.recordSubmission(f.p.id,j.id,{kind:'success_page',text:'Received',url:'https://example.test/ok',documents:'CV'},'session');finish(f);await f.c.tick();assert.equal(f.store.campaign(f.p.id).status,'complete');assert.equal(f.calls.length,1);
}finally{f.store.close();}});
test('in-flight launch followed by pause stops the newly created process',async()=>{
 const f=fixture();let resolveLaunch,stops=0;
 f.c.launch=async id=>{await new Promise(r=>resolveLaunch=r);f.setActive({candidateId:id,sessionId:'late'});};
 f.c.stop=async()=>{stops++;f.setActive(null);};
 try{const launch=f.c.start(f.p.id,{target:2,intervalMinutes:1});await f.c.pause(f.p.id);resolveLaunch();await launch;assert.equal(f.store.campaign(f.p.id).status,'paused');assert.equal(stops,1);await f.c.tick();assert.equal(f.store.campaign(f.p.id).task,null);}finally{f.store.close();}
});
test('graceful app shutdown does not convert a running campaign into an interruption',async()=>{const f=fixture();try{
 await f.c.start(f.p.id,{target:2,intervalMinutes:1});f.c.closed=true;f.c.signal(f.p.id,'Interrupted');assert.equal(f.store.campaign(f.p.id).status,'running');
}finally{f.store.close();}});
test('ambiguous message delivery pauses instead of sending a duplicate',async()=>{const f=fixture();try{
 await f.c.start(f.p.id,{target:2,intervalMinutes:1});finish(f,'no_results');f.setTime(f.getTime()+61000);f.c.send=async()=>{throw Error('timeout');};await f.c.tick();assert.equal(f.store.campaign(f.p.id).status,'paused');assert.match(f.store.campaign(f.p.id).note,/teslimi/);
}finally{f.store.close();}});
test('campaign state and pending task survive database reopening',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const dir=mkdtempSync(join(tmpdir(),'jobloop-campaign-'));let s=new Store(join(dir,'db'));
 try{const p=s.saveProfile({name:'Restart',preferences:'Berlin',authorization:'prepare'});s.saveCampaign(p.id,{status:'running',target:50,intervalMinutes:60,task:{id:'pending',kind:'search'},attempts:{},nextSearchAt:1234});s.close();s=new Store(join(dir,'db'));assert.equal(s.campaign(p.id).target,50);assert.equal(s.campaign(p.id).task.id,'pending');assert.equal(s.campaign(p.id).nextSearchAt,1234);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('an answer arriving before the blocked turn ends is not lost and resumes the saved tab first',async()=>{
 const f=fixture();try{
  const older=addRankedJob(f.store,f.p.id,listing).job;
  const job=addRankedJob(f.store,f.p.id,{...listing,url:'https://example.test/jobs/2',role:'Engineer'}).job;
  f.store.updateJob(f.p.id,older.id,'working','Form','session');f.store.updateJob(f.p.id,older.id,'blocked','Other blocker','session');
  f.store.updateJob(f.p.id,job.id,'working','Form','session');
  await f.c.start(f.p.id,{target:10,intervalMinutes:1});assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);
  const q=f.store.ask(f.p.id,{jobId:job.id,question:'Start date?',resumeContext:{browser:'chrome:profile-a',tabId:'tab-42',url:'https://example.test/apply/2#availability',step:'Availability',nextAction:'Fill start date, preserve uploaded CV'}},'session');
  f.store.updateJob(f.p.id,job.id,'blocked','Waiting for answer','session');
  f.store.answer(f.p.id,q.id,'Two months');f.c.answered(f.p.id,q.id);
  await f.c.tick();assert.equal(f.calls.length,1,'the current turn is not interrupted');
  finish(f,'blocked');await f.c.tick();assert.equal(f.calls.length,2);
  assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);
  assert.match(f.calls[1],/get_task_context/);assert.equal(f.store.taskContext(f.p.id).job.resumeContext.tabId,'tab-42');assert.ok(f.store.taskContext(f.p.id).questions.some(q=>q.answer==='Two months'));assert.doesNotMatch(f.calls[1],/tab-42|Two months/);
  f.store.updateJob(f.p.id,job.id,'skipped','Listing closed after response','session');finish(f);assert.equal(f.store.campaign(f.p.id).pendingResumes[job.id],undefined);
 }finally{f.store.close();}
});
test('answered job takes priority after current independent work, while all outstanding questions must be answered',async()=>{
 const f=fixture();try{
  const other=addRankedJob(f.store,f.p.id,listing).job;
  const waiting=addRankedJob(f.store,f.p.id,{...listing,url:'https://example.test/jobs/2',role:'Engineer'}).job;
  f.store.updateJob(f.p.id,waiting.id,'working','Form','session');f.store.updateJob(f.p.id,waiting.id,'blocked','Questions','session');
  const q1=f.store.ask(f.p.id,{jobId:waiting.id,question:'Date?'}),q2=f.store.ask(f.p.id,{jobId:waiting.id,question:'Salary?'});
  await f.c.start(f.p.id,{target:10,intervalMinutes:1});assert.equal(f.store.campaign(f.p.id).task.jobId,other.id);
  f.store.answer(f.p.id,q1.id,'Now');f.c.answered(f.p.id,q1.id);f.store.updateJob(f.p.id,other.id,'skipped','Listing closed','session');finish(f);await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.kind,'search');
  f.store.answer(f.p.id,q2.id,'70000');f.c.answered(f.p.id,q2.id);await f.c.tick();assert.equal(f.calls.length,2);
  finish(f);await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.jobId,waiting.id);
  assert.ok(f.store.taskContext(f.p.id).questions.some(q=>q.answer==='70000'));assert.doesNotMatch(f.calls.at(-1),/70000/);
 }finally{f.store.close();}
});

test('two candidates keep independent running sessions; pausing one leaves the other working',async()=>{
 const store=new Store(':memory:'),sessions=new Map(),messages=[],stops=[];
 const a=store.saveProfile({name:'A',preferences:'Berlin',authorization:'submit'}),b=store.saveProfile({name:'B',preferences:'Remote',authorization:'submit'});
 const c=new Campaigns(store,{active:id=>sessions.get(id),changed:()=>{},launch:async id=>sessions.set(id,{candidateId:id,sessionId:`session-${id}`}),send:async(text,id)=>messages.push({id,text}),stop:async id=>{stops.push(id);sessions.delete(id);}});
 try{
  await c.start(a.id);await c.start(b.id);assert.equal(sessions.size,2);
  const taskA=store.campaign(a.id).task,taskB=store.campaign(b.id).task;
  assert.throws(()=>c.report(a.id,`session-${b.id}`,{taskId:taskA.id,outcome:'done',note:'wrong session'}));
  c.signal(a.id,'Working');c.report(a.id,`session-${a.id}`,{taskId:taskA.id,outcome:'done',note:'A done'});c.signal(a.id,'Idle');
  await c.tick();assert.equal(messages.length,1);assert.equal(messages[0].id,a.id);assert.equal(store.campaign(b.id).task.id,taskB.id);
  await c.pause(a.id);assert.deepEqual(stops,[a.id]);assert.equal(sessions.has(b.id),true);assert.equal(store.campaign(b.id).status,'running');
 }finally{store.close();}
});

test('automatic source cannot manufacture submission authority for a prepare-only candidate',async()=>{
 const f=fixture();try{f.store.saveProfile({...f.p,authorization:'prepare'});const source=f.store.sources(f.p.id)[0];f.store.saveSource(f.p.id,{...source,applyMode:'auto'});addRankedJob(f.store,f.p.id,{...listing,sourceId:source.id});await f.c.start(f.p.id);assert.match(f.calls[0],/prepare the form but do not submit/);assert.doesNotMatch(f.calls[0],/already authorized automatic submission/);}finally{f.store.close();}
});

test('campaign waits for a direct user conversation turn to finish before dispatching',async()=>{
 const f=fixture();try{
  await f.c.start(f.p.id);finish(f,'no_results');f.setTime(f.getTime()+61000);
  for(const state of ['Working','Compacting','Interrupted']){
   f.setActive({candidateId:f.p.id,sessionId:'session',state});await f.c.tick();
   assert.equal(f.calls.length,1);assert.equal(f.store.campaign(f.p.id).task,null);
  }
  f.setActive({candidateId:f.p.id,sessionId:'session',state:'Idle'});await f.c.tick();
  assert.equal(f.calls.length,2);assert.ok(f.store.campaign(f.p.id).task);
 }finally{f.store.close();}
});

test('approved setup hands off to a verifiable campaign task without restarting onboarding',async()=>{
 const store=new Store(':memory:');let prompt;
 try{
  const p=store.createSetup({provider:'claude',model:'default',permission:'default',reasoning:'default',network:null});
  store.saveSetup(p.id,{...store.setup(p.id),status:'running'});
  store.updateSetupProfile(p.id,{stage:'review',message:'Ready',name:'Candidate',facts:'Backend',preferences:'100% remote outside Europe; exclude Germany'});
  const c=new Campaigns(store,{active:()=>null,changed:()=>{},launch:async(id,text)=>{prompt=text;}});
  await assert.rejects(()=>c.start(p.id),/setup/);assert.equal(prompt,undefined);
  store.completeSetup(p.id,{...store.profile(p.id),authorization:'submit'});
  await c.start(p.id);
  assert.match(prompt,/get_task_context/);assert.equal(store.taskContext(p.id).setup.status,'complete');
  assert.ok(prompt.includes(store.campaign(p.id).task.id));assert.equal(store.taskContext(p.id).profile.preferences,'100% remote outside Europe; exclude Germany');
  assert.ok(prompt.length<850);assert.match(prompt,/report_campaign_work/);
 }finally{store.close();}
});

 test('unstarted delivery times out without dispatching a duplicate',async()=>{const f=fixture();try{await f.c.start(f.p.id);f.setTime(f.getTime()+90001);await f.c.tick();assert.equal(f.store.campaign(f.p.id).status,'paused');assert.equal(f.calls.length,1);}finally{f.store.close();}});
 test('failed delivery pauses immediately while genuine long work does not time out',async()=>{const f=fixture();try{await f.c.start(f.p.id);f.c.signal(f.p.id,'Working');f.setTime(f.getTime()+120000);await f.c.tick();assert.equal(f.store.campaign(f.p.id).status,'running');finish(f);f.setTime(f.getTime()+61000);await f.c.tick();f.c.delivery(f.p.id,'Stalled');assert.equal(f.store.campaign(f.p.id).status,'paused');}finally{f.store.close();}});

test('terminal interruption preserves task and resumes once after user finishes typing',async()=>{
 const f=fixture();try{
 await f.c.start(f.p.id);const id=f.store.campaign(f.p.id).task.id;
 f.c.signal(f.p.id,'Working');f.c.signal(f.p.id,'Interrupted');
 assert.equal(f.store.campaign(f.p.id).status,'running');assert.equal(f.store.campaign(f.p.id).task.id,id);
 f.setActive({candidateId:f.p.id,sessionId:'session',state:'Idle'});
 f.setTime(f.getTime()+4000);f.c.input(f.p.id);f.setTime(f.getTime()+2000);await f.c.tick();assert.equal(f.calls.length,1);
 f.setTime(f.getTime()+4000);f.setActive({candidateId:f.p.id,sessionId:'session',state:'Working'});await f.c.tick();assert.equal(f.calls.length,1);
 f.setActive({candidateId:f.p.id,sessionId:'session',state:'Idle'});await f.c.tick();await f.c.tick();assert.equal(f.calls.length,2);assert.equal(f.store.campaign(f.p.id).task.id,id);assert.match(f.calls[1],/SAME interrupted/);
 finish(f);assert.equal(f.store.campaign(f.p.id).task,null);
 }finally{f.store.close();}
});
test('explicit app pause cancels automatic recovery',async()=>{const f=fixture();try{
 await f.c.start(f.p.id);f.c.signal(f.p.id,'Interrupted');await f.c.pause(f.p.id);f.setTime(f.getTime()+10000);await f.c.tick();assert.equal(f.calls.length,1);assert.equal(f.store.campaign(f.p.id).status,'paused');
}finally{f.store.close();}});
test('missing report resumes same source rather than marking it scanned; recovery is bounded',async()=>{const f=fixture();try{
 await f.c.start(f.p.id);const task=f.store.campaign(f.p.id).task;
 for(let i=0;i<3;i++){f.c.signal(f.p.id,'Working');f.c.signal(f.p.id,'Idle');assert.equal(f.store.campaign(f.p.id).task.id,task.id);assert.equal(f.store.source(f.p.id,task.sourceId).lastRunAt,null);f.setActive({candidateId:f.p.id,sessionId:'session',state:'Idle'});f.setTime(f.getTime()+6000);await f.c.tick();}
 f.c.signal(f.p.id,'Working');f.c.signal(f.p.id,'Idle');assert.equal(f.store.campaign(f.p.id).status,'paused');assert.equal(f.calls.length,4);
}finally{f.store.close();}});
test('interrupted submit recovers as verification without resubmission',async()=>{const f=fixture();try{
 const j=addRankedJob(f.store,f.p.id,listing).job;await f.c.start(f.p.id);
 for(const state of ['working','prepared','submitting'])f.store.updateJob(f.p.id,j.id,state,'Form','session');
 f.c.signal(f.p.id,'Interrupted');f.setActive({candidateId:f.p.id,sessionId:'session',state:'Idle'});f.setTime(f.getTime()+6000);await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.kind,'verify');assert.match(f.calls.at(-1),/WITHOUT resubmitting/);
}finally{f.store.close();}});

test('incomplete auto application cannot close or advance; same task recovers then releases for a saved question',async()=>{const f=fixture();try{
 const job=addRankedJob(f.store,f.p.id,listing).job;await f.c.start(f.p.id);const taskId=f.store.campaign(f.p.id).task.id;
 for(const state of ['working','prepared'])f.store.updateJob(f.p.id,job.id,state,'Form ready','session');
 assert.throws(()=>f.c.report(f.p.id,'session',{taskId,outcome:'done',note:'Ready'}),/prepared/);
 assert.throws(()=>f.c.report(f.p.id,'session',{taskId,outcome:'blocked',note:'Need approval'}),/blocked/);
 f.store.updateJob(f.p.id,job.id,'blocked','Needs response','session');
 assert.throws(()=>f.c.report(f.p.id,'session',{taskId,outcome:'blocked',note:'Asked in terminal'}),/ask_candidate/);
 f.c.signal(f.p.id,'Working');f.c.signal(f.p.id,'Idle');assert.equal(f.store.campaign(f.p.id).task.id,taskId);
 f.setActive({candidateId:f.p.id,sessionId:'session',state:'Idle'});f.setTime(f.getTime()+6000);await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.id,taskId);assert.match(f.calls.at(-1),/ask_candidate/);
 const q=f.store.ask(f.p.id,{jobId:job.id,question:'Required access confirmation',applicationBlocker:{kind:'access',evidence:'Tool confirmation required',reasonUnknown:'External tool requires action-time confirmation'}});
 finish(f,'blocked');await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.kind,'search');
 f.store.answer(f.p.id,q.id,'Confirmed');f.c.answered(f.p.id,q.id);finish(f);await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);
 }finally{f.store.close();}});
test('technical blockers require evidence and no user dependency',async()=>{const f=fixture();try{
 const job=addRankedJob(f.store,f.p.id,listing).job;await f.c.start(f.p.id);const taskId=f.store.campaign(f.p.id).task.id;
 for(const state of ['working','blocked'])f.store.updateJob(f.p.id,job.id,state,'Site outage','session');
 assert.throws(()=>f.c.report(f.p.id,'session',{taskId,outcome:'blocked',note:'Outage',blocker:{kind:'technical',requiresUserInput:true,evidence:'503',reason:'Site down'}}));
 f.c.report(f.p.id,'session',{taskId,outcome:'blocked',note:'Outage',blocker:{kind:'technical',requiresUserInput:false,evidence:'HTTP 503 on employer form',reason:'Site unavailable'}});
 assert.equal(f.store.campaign(f.p.id).task.report.blocker.evidence,'HTTP 503 on employer form');
 }finally{f.store.close();}});
test('prepare-only task can finish prepared but auto task cannot use no_results',async()=>{const f=fixture();try{
 f.store.saveProfile({...f.store.profile(f.p.id),authorization:'prepare'});const job=addRankedJob(f.store,f.p.id,listing).job;await f.c.start(f.p.id);
 for(const state of ['working','prepared'])f.store.updateJob(f.p.id,job.id,state,'Ready','session');
 const taskId=f.store.campaign(f.p.id).task.id;assert.throws(()=>f.c.report(f.p.id,'session',{taskId,outcome:'no_results',note:'No results'}));finish(f);assert.equal(f.store.campaign(f.p.id).task,null);
 }finally{f.store.close();}});

test('legacy prepared auto application is eligible despite an earlier incomplete attempt',async()=>{const f=fixture();try{
 const job=addRankedJob(f.store,f.p.id,listing).job;for(const status of ['working','prepared'])f.store.updateJob(f.p.id,job.id,status,'Ready','session');
 f.store.saveCampaign(f.p.id,{status:'paused',attempts:{[job.id]:f.getTime()+100000}});await f.c.start(f.p.id);assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);
 }finally{f.store.close();}});

test('missing-tab recovery queues the same job without inventing a reply or interrupting current work',async()=>{
 const f=fixture();try{
  const job=addRankedJob(f.store,f.p.id,listing).job;f.store.updateJob(f.p.id,job.id,'working','Form','session');f.store.updateJob(f.p.id,job.id,'blocked','Manual field check needed','session');
  const q=f.store.ask(f.p.id,{jobId:job.id,question:'Email missing?',applicationBlocker:{kind:'access',recovery:{kind:'form_entry'}}});
  await f.c.start(f.p.id,{target:2});const taskId=f.store.campaign(f.p.id).task.id;
  f.c.recheckLegacyFormQuestions(f.p.id);assert.equal(f.store.campaign(f.p.id).formVerificationMigration,1);assert.equal(f.c.recoverQuestion(f.p.id,q.id).queued,true);
  assert.equal(f.store.questions(f.p.id)[0].answer,null);
  assert.equal(f.store.campaign(f.p.id).task.id,taskId);
  const next=f.c.choose(f.p.id,f.store.campaign(f.p.id));assert.equal(next.jobId,job.id);assert.equal(next.recoveryQuestionId,q.id);
  await f.c.pause(f.p.id);f.c.recoverQuestion(f.p.id,q.id);assert.equal(f.store.campaign(f.p.id).status,'paused');
 }finally{f.store.close();}
});

test('start explains disabled sources and automatically dispatches after enabling one',async()=>{
 const f=fixture();try{
  for(const source of f.store.sources(f.p.id))f.store.saveSource(f.p.id,{...source,enabled:false});
  await f.c.start(f.p.id);assert.equal(f.calls.length,0);
  assert.equal(f.store.campaign(f.p.id).waitingReason,'no_enabled_sources');
  assert.match(f.store.campaign(f.p.id).note,/Sources/);
  const source=f.store.sources(f.p.id)[0];f.store.saveSource(f.p.id,{...source,enabled:true});
  await f.c.start(f.p.id);assert.equal(f.calls.length,1);assert.equal(f.store.campaign(f.p.id).waitingReason,undefined);
 }finally{f.store.close();}
});
