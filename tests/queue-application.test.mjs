import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
const listing={company:'Waiting',role:'Engineer',location:'Berlin',fit:'Relevant experience',url:'https://example.test/jobs/waiting'};
function fixture(store=new Store(':memory:')){
 const p=store.candidates()[0]??store.saveProfile({name:'Test',preferences:'Berlin',authorization:'submit'});
 let active=null;const calls=[];
 const c=new Campaigns(store,{now:()=>Date.now()+10000,active:()=>active,changed:()=>{},launch:async(id,prompt)=>{calls.push(prompt);active={candidateId:id,sessionId:'session'};},send:async prompt=>calls.push(prompt),stop:async()=>{active=null;}});
 return{store,p,c,calls};
}
function blocked(f,fields={}){
 const job=f.store.addJob(f.p.id,{...listing,...fields}).job;
 f.store.updateJob(f.p.id,job.id,'working','Form','session');
 f.store.updateJob(f.p.id,job.id,'blocked','Waiting for information','session');
 const q=f.store.ask(f.p.id,{jobId:job.id,question:'Start date?',resumeContext:{browser:'Jev Chrome',tabId:'saved-tab',url:job.url,step:'Availability',nextAction:'Review the saved form'}},'session');
 return{job,q};
}
function finish(f,outcome){const task=f.store.campaign(f.p.id).task;f.c.signal(f.p.id,'Working');f.c.report(f.p.id,'session',{taskId:task.id,outcome,note:'Reviewed'});f.c.signal(f.p.id,'Idle');}
test('manual queue waits for current work, deduplicates, preserves questions and consumes retry once',async()=>{
 const f=fixture();try{
  const {job,q}=blocked(f),checkpoint=f.store.job(f.p.id,job.id).resumeContext;
  const other=f.store.addJob(f.p.id,{...listing,role:'Other role',url:'https://example.test/jobs/other'}).job;
  await f.c.start(f.p.id);const current=f.store.campaign(f.p.id).task;
  assert.equal(current.jobId,other.id);
  const first=f.c.queueApplication(f.p.id,job.id),second=f.c.queueApplication(f.p.id,job.id);
  assert.equal(second.alreadyQueued,true);assert.equal(first.requestId,second.requestId);
  await f.c.tick();assert.equal(f.calls.length,1);assert.equal(f.store.campaign(f.p.id).task.id,current.id);
  f.store.updateJob(f.p.id,other.id,'skipped','Closed','session');finish(f,'done');await f.c.tick();
  const retry=f.store.campaign(f.p.id).task;assert.equal(retry.jobId,job.id);assert.equal(retry.retryRequestId,first.requestId);
  assert.equal(f.store.questions(f.p.id).find(x=>x.id===q.id).answer,null);
  assert.deepEqual(f.store.job(f.p.id,job.id).resumeContext,checkpoint);
  assert.match(f.calls.at(-1),/not an answer or new consent/);
  assert.equal(f.c.queueApplication(f.p.id,job.id).active,true);
  finish(f,'blocked');assert.equal(f.store.campaign(f.p.id).pendingRetries[job.id],undefined);
  await f.c.tick();assert.notEqual(f.store.campaign(f.p.id).task?.jobId,job.id);
 }finally{f.store.close();}
});
test('paused queue survives reopening and dispatches only when started',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jobloop-retry-')),file=join(dir,'db');let f=fixture(new Store(file));
 try{
  const {job}=blocked(f);const result=f.c.queueApplication(f.p.id,job.id);
  await f.c.tick();assert.equal(f.calls.length,0);assert.equal(f.store.campaign(f.p.id).status,'paused');
  f.store.close();f=fixture(new Store(file));
  assert.equal(f.store.campaign(f.p.id).pendingRetries[job.id].requestId,result.requestId);
  await f.c.start(f.p.id);assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);
 }finally{f.store.close();rmSync(dir,{recursive:true,force:true});}
});
test('queue respects candidate ownership, job status and existing application authorization',()=>{
 const f=fixture();try{
  const {job}=blocked(f),other=f.store.saveProfile({name:'Other',preferences:'Remote',authorization:'submit'});
  assert.throws(()=>f.c.queueApplication(other.id,job.id));
  f.store.saveProfile({...f.p,authorization:'research'});assert.throws(()=>f.c.queueApplication(f.p.id,job.id),/izni/);
  f.store.saveProfile({...f.p,authorization:'submit'});
  const source=f.store.sources(f.p.id)[0];f.store.saveSource(f.p.id,{...source,applyMode:'find_only'});
  const sourced=blocked(f,{role:'Sourced role',url:'https://example.test/jobs/source',sourceId:source.id}).job;
  assert.throws(()=>f.c.queueApplication(f.p.id,sourced.id),/izni/);
  f.store.updateJob(f.p.id,job.id,'skipped','Closed','session');assert.throws(()=>f.c.queueApplication(f.p.id,job.id),/bekleyen/);
 }finally{f.store.close();}
});
