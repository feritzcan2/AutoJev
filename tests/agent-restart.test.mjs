import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {restartAgentFresh} from '../app/agent-restart.mjs';
import {selectResume} from '../app/resume.mjs';
import {addRankedJob} from './rank-fixture.mjs';

function fixture(){
 const store=new Store(':memory:');
 const p=store.saveProfile({name:'Restart',preferences:'Berlin',authorization:'submit'});
 store.setCv(p.id,'/tmp/CV.pdf');
 const settings=store.profile(p.id).agentSettings;
 store.saveConversation(p.id,settings.provider,'old-thread',settings);
 const events=[];let active={candidateId:p.id,sessionId:'old-session'};
 const stop=async id=>{events.push('stop');store.recoverSession(id,'old-session');store.saveConversation(id,settings.provider,'late-thread',settings);active=null;};
 const campaigns=new Campaigns(store,{active:()=>active,stop,changed:()=>{},send:async()=>assert.fail('Must launch fresh'),launch:async(id,prompt)=>{events.push('launch');assert.equal(selectResume(store,id,settings),undefined);active={candidateId:id,sessionId:'new-session'};}});
 const deps={store,campaigns,stop,resetBrowser:async id=>{assert.equal(id,p.id);assert.equal(active,null);events.push('browser');}};
 return{store,p,settings,events,deps};
}
test('fresh restart clears even late identity and keeps the browser, facts and other candidates',async()=>{
 const f=fixture();try{
  const other=f.store.saveProfile({name:'Other',preferences:'Remote',authorization:'research'});
  f.store.saveConversation(other.id,'codex','other-thread',{});
  const before=f.store.profile(f.p.id);
  const result=await restartAgentFresh(f.deps,f.p.id);
  assert.equal(result.fresh,true);assert.deepEqual(f.events,['stop','launch']);
  assert.deepEqual(f.store.profile(f.p.id),before);
  assert.equal(f.store.conversation(other.id,'codex'),'other-thread');
 }finally{f.store.close();}
});
test('fresh conversation verifies an interrupted submission without discarding application state',async()=>{
 const f=fixture();try{
  const j=addRankedJob(f.store,f.p.id,{company:'Test',role:'Engineer',location:'Berlin',fit:'Backend',url:'https://example.test/job'}).job;
  for(const status of ['working','prepared','submitting'])f.store.updateJob(f.p.id,j.id,status,'Form','old-session');
  f.store.saveCampaign(f.p.id,{status:'running',target:75,intervalMinutes:45,task:{id:'pending',kind:'application',jobId:j.id,seenWorking:true},attempts:{}});
  await restartAgentFresh(f.deps,f.p.id);
  const campaign=f.store.campaign(f.p.id);
  assert.equal(campaign.target,75);assert.equal(campaign.intervalMinutes,45);
  assert.equal(campaign.task.kind,'verify');assert.equal(campaign.task.jobId,j.id);
  assert.equal(f.store.job(f.p.id,j.id).status,'uncertain');
  assert.deepEqual(f.events,['stop','launch']);
 }finally{f.store.close();}
});
test('invalid restart settings leave the running conversation intact',async()=>{
 const f=fixture();try{
  await assert.rejects(restartAgentFresh(f.deps,f.p.id,{target:0}));
  assert.deepEqual(f.events,[]);assert.equal(f.store.conversation(f.p.id,f.settings.provider),'old-thread');
 }finally{f.store.close();}
});
test('restart at a reached target preserves the conversation and browser without reporting success',async()=>{
 const f=fixture();try{
  const job=f.store.addJob(f.p.id,{company:'Sent',role:'Engineer',location:'Remote',fit:'Backend',url:'https://example.test/sent'}).job;
  f.store.setManualJobStatus(f.p.id,job.id,'manual_submitted');
  const campaign={status:'complete',target:1,intervalMinutes:30,task:null,attempts:{}};f.store.saveCampaign(f.p.id,campaign);
  await assert.rejects(restartAgentFresh(f.deps,f.p.id),/1 başvuru gönderildi, hedef 1/);
  assert.deepEqual(f.events,[]);assert.deepEqual(f.store.campaign(f.p.id),campaign);
  assert.equal(f.store.conversation(f.p.id,f.settings.provider),'old-thread');
 }finally{f.store.close();}
});
