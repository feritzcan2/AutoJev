import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {saveProfileWithBrowserChange} from '../app/browser-engine-change.mjs';
const fixture=()=>{
 const store=new Store(':memory:');
 const profile=store.saveProfile({name:'Candidate',preferences:'Engineer',browserMode:'jev',authorization:'submit'});
 const calls=[];
 const deps={store,stop:async()=>calls.push('stop'),resetBrowser:async()=>calls.push('reset'),campaigns:{pause:async id=>{calls.push('pause');store.saveCampaign(id,{...store.campaign(id),status:'paused',task:null});},start:async()=>calls.push('start')}};
 const job=(status)=>{
  const j=store.addJob(profile.id,{company:'Company',role:status,location:'Berlin',fit:'Match',url:`https://example.test/${status}`}).job;
  Object.assign(j,{status,sessionId:'old-session',resumeContext:{browser:'Jev Chrome',tabId:`old-${status}`,url:j.url},browserProgress:{submissionState:status,fields:[{value:'known'}]}});
  store.saveJob(j,'fixture');return j;
 };
 return {store,profile,calls,deps,job};
};
test('engine switch archives unfinished drafts and queues fresh work, preserving uncertain/completed applications and answers',async()=>{
 const f=fixture();try{
  const drafts=['working','prepared','blocked'].map(f.job),protectedJobs=['submitting','uncertain','submitted','already_submitted','skipped'].map(f.job);
  f.store.saveCampaign(f.profile.id,{status:'running',target:100,intervalMinutes:30,task:{jobId:drafts[0].id},attempts:Object.fromEntries(drafts.map(j=>[j.id,Date.now()]))});
  const known=f.store.ask(f.profile.id,{jobId:drafts[0].id,question:'Known answer?'},'old-session');
  f.store.db.prepare('UPDATE questions SET answer=? WHERE id=?').run('Berlin',known.id);
  const technical=f.store.ask(f.profile.id,{jobId:drafts[0].id,question:'Click old tab',applicationBlocker:{kind:'access'}},'old-session');
  const missing=f.store.ask(f.profile.id,{jobId:drafts[0].id,question:'Missing fact'},'old-session');
  await saveProfileWithBrowserChange(f.deps,{...f.profile,browserMode:'separate'});
  assert.deepEqual(f.calls,['pause','reset','start']);
  for(const j of drafts){const now=f.store.job(f.profile.id,j.id);assert.equal(now.resumeContext,null);assert.equal(now.browserProgress,undefined);assert.equal(now.sessionId,null);assert.equal(now.previousBrowserDraft.resumeContext.tabId,j.resumeContext.tabId);assert.ok(f.store.campaign(f.profile.id).pendingRetries[j.id]);}
  for(const j of protectedJobs)assert.deepEqual(f.store.job(f.profile.id,j.id),j);
  const questions=f.store.questions(f.profile.id);
  assert.equal(questions.find(q=>q.id===known.id).answer,'Berlin');
  assert.ok(questions.some(q=>q.id===missing.id));assert.ok(!questions.some(q=>q.id===technical.id));
 }finally{f.store.close();}
});
test('same engine settings save does not reset drafts; paused campaign remains paused',async()=>{
 const f=fixture();try{
  const j=f.job('blocked');
  await saveProfileWithBrowserChange(f.deps,{...f.profile,name:'Renamed'});
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.store.job(f.profile.id,j.id),j);
  f.store.saveCampaign(f.profile.id,{status:'paused',attempts:{}});
  await saveProfileWithBrowserChange(f.deps,{...f.profile,browserMode:'separate'});
  assert.deepEqual(f.calls,['pause','reset']);assert.equal(f.store.campaign(f.profile.id).status,'paused');
 }finally{f.store.close();}
});
test('stop failure prevents mode and draft changes',async()=>{
 const f=fixture();try{
  const j=f.job('blocked');f.deps.stop=async()=>{throw Error('cannot stop');};
  await assert.rejects(()=>saveProfileWithBrowserChange(f.deps,{...f.profile,browserMode:'separate'}),/cannot stop/);
  assert.equal(f.store.profile(f.profile.id).browserMode,'jev');assert.deepEqual(f.store.job(f.profile.id,j.id),j);
 }finally{f.store.close();}
});
