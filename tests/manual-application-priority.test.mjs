import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {WorkerCampaigns} from '../app/worker-campaigns.mjs';
import {validateQuestionConsent} from '../app/question-gate.mjs';
import {rankInput} from './rank-fixture.mjs';

function fixture(t,{authorization='research',file=':memory:'}={}){
 const store=new Store(file),p=store.saveProfile({name:'Priority',preferences:'Remote',authorization}),sessions=new Map(),calls=[];
 const options={now:()=>Date.now()+10000,active:(id,worker='main')=>sessions.get(worker),changed:()=>{},launch:async(id,prompt,job,worker='main')=>{sessions.set(worker,{candidateId:id,sessionId:worker,state:'Idle'});calls.push(prompt);},send:async text=>calls.push(text),stop:async(id,worker='main')=>sessions.delete(worker)};
 const c=new Campaigns(store,options),workers=new WorkerCampaigns(store,options);
 const source=store.sources(p.id)[0];store.saveSource(p.id,{...source,enabled:false,applyMode:'find_only'});
 for(const s of store.sources(p.id))store.saveSource(p.id,{...s,enabled:false});
 let n=0;
 const add=()=>store.addJob(p.id,{company:'Employer '+(++n),role:'Engineer',location:'Remote',fit:'Fixture',url:'https://example.test/'+n,sourceId:source.id}).job;
 t.after(()=>{store.close();});return{store,p,c,workers,source,add,calls};
}
for(const authorization of ['research','prepare','submit'])test(`manual job bypasses ${authorization}, find_only, missing score and full target only for assigned job`,async t=>{
 const {store,p,c,add,source,calls}=fixture(t,{authorization}),sent=add(),job=add(),other=add();
 store.saveJob({...sent,status:'submitted',proof:{text:'Existing confirmation'}},'submission_recorded');
 store.saveCampaign(p.id,{status:'complete',target:1,intervalMinutes:30,task:null,attempts:{}});
 c.queueApplication(p.id,job.id);await c.start(p.id);
 const task=store.campaign(p.id).task;assert.equal(task.kind,'application');assert.equal(task.jobId,job.id);assert.ok(task.manualRequestId);
 assert.match(calls[0],/user explicitly authorized submission/);
 const ctx=store.taskContext(p.id);assert.equal(ctx.applicationAuthorization.mode,'submit');assert.equal(ctx.profile.authorization,authorization);assert.equal(ctx.source.applyMode,'find_only');
 assert.equal(store.source(p.id,source.id).applyMode,'find_only');
 assert.throws(()=>store.updateJob(p.id,other.id,'working','Other','main'));
 store.updateJob(p.id,job.id,'working','Fill','main');store.updateJob(p.id,job.id,'prepared','Ready','main');
 assert.throws(()=>c.report(p.id,'main',{taskId:task.id,outcome:'done',note:'Prepared'}),/bitmedi/);
 assert.throws(()=>validateQuestionConsent(store,p.id,job.id,{fields:[{consentScope:'submission'}]}),/zaten onaylı/);
 assert.doesNotThrow(()=>validateQuestionConsent(store,p.id,job.id,{fields:[{consentScope:'recruitment_privacy'}]}));
 store.updateJob(p.id,job.id,'submitting','Send','main');
 assert.throws(()=>store.updateJob(p.id,job.id,'working','Again','main'),/Geçersiz geçiş/);
 store.recordSubmission(p.id,job.id,{kind:'success_page',text:'Thanks for applying',url:job.url,documents:'CV'},'main');
 c.signal(p.id,'Working');c.report(p.id,'main',{taskId:task.id,outcome:'done',note:'Sent'});c.signal(p.id,'Idle');await c.tick();
 assert.equal(store.campaign(p.id).status,'complete');assert.equal(store.campaign(p.id).pendingRetries[job.id],undefined);
 assert.throws(()=>c.queueApplication(p.id,job.id));
});

test('manual requests are FIFO, outrank automated jobs and reserve distinct jobs across workers',async t=>{
 const {store,p,c,workers,add}=fixture(t,{authorization:'submit'}),first=add(),second=add(),auto=add(),extra=store.workerState.add(p.id);
 store.rankJob(p.id,first.id,rankInput(store,p.id,2));store.rankJob(p.id,second.id,rankInput(store,p.id,99));
 store.saveJob({...auto,status:'uncertain'},'job_updated');
 c.queueApplication(p.id,first.id);c.queueApplication(p.id,second.id);
 await workers.start(p.id,{target:1});
 const a=store.campaign(p.id).task,b=store.forWorker(extra.id).campaign(p.id).task;
 assert.equal(a.jobId,first.id);assert.equal(b.jobId,second.id);assert.equal(a.kind,'application');assert.equal(b.kind,'application');
 assert.throws(()=>store.forWorker(extra.id).updateJob(p.id,first.id,'working','Foreign worker','wrong'));
});

test('queueing while ranking survives the rank turn and bypasses a low score',async t=>{
 const {store,p,c,add}=fixture(t),job=add();await c.start(p.id);const rank=store.campaign(p.id).task;assert.equal(rank.kind,'rank');
 c.queueApplication(p.id,job.id);store.rankJob(p.id,job.id,rankInput(store,p.id,3));
 c.signal(p.id,'Working');c.report(p.id,'main',{taskId:rank.id,outcome:'done',note:'Ranked'});c.signal(p.id,'Idle');await c.tick();
 assert.equal(store.campaign(p.id).task.kind,'application');assert.ok(store.campaign(p.id).task.manualRequestId);
});

test('manual blocked request waits for actual answer then resumes beyond target with same authorization',async t=>{
 const {store,p,c,add}=fixture(t),job=add();c.queueApplication(p.id,job.id);await c.start(p.id);
 store.updateJob(p.id,job.id,'working','Fill','main');store.updateJob(p.id,job.id,'blocked','Start date?','main');const q=store.ask(p.id,{jobId:job.id,question:'Start date?'});
 c.signal(p.id,'Working');c.report(p.id,'main',{taskId:store.campaign(p.id).task.id,outcome:'blocked',note:'Waiting'});c.signal(p.id,'Idle');
 assert.equal(c.choose(p.id,store.campaign(p.id)),null);
 const submitted=add();store.saveJob({...submitted,status:'submitted'},'submission_recorded');store.saveCampaign(p.id,{...store.campaign(p.id),status:'complete',target:1});
 store.answer(p.id,q.id,'Tomorrow');await c.continueAfterAnswer(p.id,q.id);
 assert.equal(store.campaign(p.id).task.jobId,job.id);assert.equal(store.taskContext(p.id).applicationAuthorization.mode,'submit');
});

test('legacy manual retries migrate durably, automatic recoveries never gain authorization',t=>{
 const dir=mkdtempSync(join(tmpdir(),'jobloop-manual-')),file=join(dir,'db');let store=new Store(file);
 try{
  const p=store.saveProfile({name:'Migration',preferences:'Remote',authorization:'research'});
  const make=name=>store.addJob(p.id,{company:name,role:'Engineer',location:'Remote',fit:'Fixture',url:'https://example.test/'+name}).job;
  const manual=make('manual'),automatic=make('automatic');
  store.saveCampaign(p.id,{status:'paused',target:1,attempts:{},pendingRetries:{[manual.id]:{requestId:'saved-request',queuedAt:100}},pendingRecoveries:{[automatic.id]:'question'}});store.close();store=new Store(file);
  assert.equal(store.job(p.id,manual.id).manualApplication.requestId,'saved-request');assert.equal(store.job(p.id,automatic.id).manualApplication,undefined);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('an uncertain job can be prioritized beyond target without authorizing submission or losing its question',async t=>{
 const {store,p,c,add,calls}=fixture(t),sent=add(),job=add(),other=add();
 store.saveJob({...sent,status:'submitted',proof:{text:'Existing success'}},'submission_recorded');
 const checkpoint={browser:'Jev Chrome',tabId:'saved',url:job.url,step:'Submit returned an error',nextAction:'Check existing outcome'};
 store.saveJob({...job,status:'uncertain',sessionId:'old',resumeContext:checkpoint},'job_updated');
 const q=store.ask(p.id,{jobId:job.id,question:'Could you check the receipt?'});
 store.saveCampaign(p.id,{status:'complete',target:1,intervalMinutes:30,task:null,attempts:{[job.id]:Date.now()}});
 const first=c.queueApplication(p.id,job.id),again=c.queueApplication(p.id,job.id);
 assert.equal(first.verificationOnly,true);assert.equal(first.requestId,again.requestId);assert.equal(again.alreadyQueued,true);
 assert.equal(store.job(p.id,job.id).status,'uncertain');assert.deepEqual(store.job(p.id,job.id).resumeContext,checkpoint);
 await c.start(p.id);const task=store.campaign(p.id).task;
 assert.equal(task.kind,'verify');assert.equal(task.verificationOnly,true);assert.equal(task.jobId,job.id);
 assert.match(calls[0],/WITHOUT resubmitting/);assert.match(calls[0],/priority verification(?: of the existing attempt)? only/);
 assert.equal(store.taskContext(p.id).applicationAuthorization.mode,'verify');assert.equal(store.job(p.id,other.id).manualApplication,undefined);
 assert.equal(store.questions(p.id).find(x=>x.id===q.id).answer,null);
 for(const status of ['working','prepared','submitting'])assert.throws(()=>store.updateJob(p.id,job.id,status,'Retry','main'),/yalnızca sonucu doğrular/);
 assert.throws(()=>store.assertSubmissionAllowed(p.id,job.id,job.url,'main'),/yeniden başvuru gönderilemez/);
 assert.throws(()=>c.report(p.id,'main',{taskId:task.id,outcome:'done',note:'No proof'}),/bitmedi/);
 c.signal(p.id,'Working');c.report(p.id,'main',{taskId:task.id,outcome:'blocked',note:'Still uncertain'});c.signal(p.id,'Idle');
 assert.equal(store.campaign(p.id).pendingRetries[job.id],undefined);assert.equal(store.job(p.id,job.id).status,'uncertain');
 await c.tick();assert.equal(store.campaign(p.id).task,null);
});

test('priority verification records real proof and never grants permission for a new application',async t=>{
 const {store,p,c,add}=fixture(t),job=add();store.saveJob({...job,status:'uncertain',sessionId:'old'},'job_updated');
 await c.queueAndStartApplication(p.id,job.id);const task=store.campaign(p.id).task;
 assert.equal(task.kind,'verify');
 const receipt=c.recordSubmission(p.id,'main',{jobId:job.id,kind:'success_page',text:'Application received',url:job.url,documents:'CV'});
 assert.equal(receipt.status,'submitted');assert.equal(receipt.completion.taskReported,true);
 c.signal(p.id,'Idle');assert.equal(store.campaign(p.id).task,null);assert.equal(store.campaign(p.id).pendingRetries[job.id],undefined);
 assert.throws(()=>c.queueApplication(p.id,job.id));assert.equal(store.profile(p.id).authorization,'research');
});

test('field evidence during priority verification finishes the check without turning it into a sending task',async t=>{
 const {store,p,c,add}=fixture(t,{authorization:'submit'}),job=add();
 const checkpoint={browser:'Jev Chrome',tabId:'saved',url:job.url,step:'Field error',nextAction:'Check error'};
 store.saveJob({...job,status:'uncertain',sessionId:'old',resumeContext:checkpoint},'job_updated');
 await c.queueAndStartApplication(p.id,job.id);c.signal(p.id,'Working');
 const result=c.recordValidationFailure(p.id,'main',{jobId:job.id,submissionPrevented:true,fields:[{label:'Email',message:'Required'}],evidence:'Submit was blocked by required-field validation.',resumeContext:checkpoint});
 assert.equal(result.status,'blocked');assert.equal(result.recovery.nextAction,'end_turn');assert.equal(store.campaign(p.id).task.kind,'verify');
 assert.throws(()=>store.updateJob(p.id,job.id,'working','Fill','main'),/yalnızca sonucu doğrular/);
 assert.throws(()=>store.continueVerification(p.id,job.id,{},'main'));
 c.signal(p.id,'Idle');assert.equal(store.campaign(p.id).task,null);assert.equal(c.choose(p.id,store.campaign(p.id))?.kind,'rank');
});
