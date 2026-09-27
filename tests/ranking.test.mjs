import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../app/store.mjs';
import {rankDecision} from '../app/ranking.mjs';
import {Campaigns,campaignPrompt} from '../app/campaign.mjs';
import {startMcp} from '../app/mcp.mjs';
import {rankInput} from './rank-fixture.mjs';
const listing={company:'Example',role:'Backend',location:'Remote',url:'https://example.test/job',fit:'Backend evidence'};
function fixture(){
 const store=new Store(':memory:'),p=store.saveProfile({name:'Candidate',preferences:'Remote backend',facts:'Python backend. Berlin.',authorization:'submit'});
 for(const source of store.sources(p.id))store.saveSource(p.id,{...source,enabled:false});
 const c=new Campaigns(store,{active:()=>({candidateId:p.id,sessionId:'s',state:'Idle'}),launch:async()=>{},send:async()=>{},stop:async()=>{},changed:()=>{}});
 const state={status:'running',attempts:{},target:100,intervalMinutes:30,wakeAt:0};
 const add=(n,score)=>{const j=store.addJob(p.id,{...listing,url:`https://example.test/${n}`,role:`Backend ${n}`}).job;return score===undefined?j:store.rankJob(p.id,j.id,rankInput(store,p.id,score));};
 return{store,p,c,state,add};
}
test('weighted score is computed by the store and the >50 boundary is strict',()=>{const f=fixture();try{
 const j=f.add('weights');const input=rankInput(f.store,f.p.id);input.dimensions.technical.score=80;input.dimensions.experience.score=60;input.dimensions.role.score=100;input.dimensions.preferences.score=50;
 const ranked=f.store.rankJob(f.p.id,j.id,input);assert.equal(ranked.rank.score,75);
 const low=f.add('50',50),high=f.add('51',51);
 assert.equal(rankDecision(f.p,low).eligible,false);assert.equal(rankDecision(f.p,high).eligible,true);
 assert.throws(()=>f.store.updateJob(f.p.id,low.id,'working','Form','s'),/puanlama/);
 f.store.updateJob(f.p.id,high.id,'working','Form','s');
 assert.equal(f.store.jobs(f.p.id).length,3);assert.equal(f.store.job(f.p.id,low.id).status,'found');
}finally{f.store.close();}});
test('all listings remain saved; old blocker notes and uncertain facts never veto the score',()=>{const f=fixture();try{
 const j=f.add('unknown'),u=f.store.rankJob(f.p.id,j.id,rankInput(f.store,f.p.id,70,{uncertainties:['Salary and remote geography not stated']}));
 assert.equal(rankDecision(f.p,u).eligible,true);
 const input=rankInput(f.store,f.p.id,99,{blockers:[{requirement:'US residence only',listingEvidence:'Must reside in the United States',candidateEvidence:'Candidate resides only in Berlin and excludes relocation'}]});
 const blocked=f.store.rankJob(f.p.id,f.add('blocked').id,input);assert.equal(rankDecision(f.p,blocked).state,'eligible');assert.equal(f.c.choose(f.p.id,f.state).jobId,blocked.id);assert.throws(()=>f.store.queueRankedJob(f.p.id,j.id));
 input.blockers[0].candidateEvidence='';assert.throws(()=>f.store.rankJob(f.p.id,j.id,input));
 const unavailable=f.store.rankJob(f.p.id,f.add('unavailable').id,{profileKey:f.store.profile(f.p.id).rankingProfileKey,status:'unavailable',summary:'Employer returned 403 after browser retry'});
 assert.equal(unavailable.rank.score,null);assert.equal(unavailable.status,'found');assert.equal(rankDecision(f.p,unavailable).state,'unavailable');
}finally{f.store.close();}});
test('rank threshold and explicit user exception never raise candidate or source authorization',()=>{const f=fixture();try{
 const low=f.add('low',40);assert.equal(f.c.choose(f.p.id,f.state),null);
 f.store.queueRankedJob(f.p.id,low.id);assert.equal(f.c.choose(f.p.id,f.state).kind,'application');
 const source=f.store.sources(f.p.id)[0];f.store.saveSource(f.p.id,{...source,applyMode:'find_only'});
 const sourced=f.store.addJob(f.p.id,{...listing,sourceId:source.id}).job;f.store.rankJob(f.p.id,sourced.id,rankInput(f.store,f.p.id,99));
 f.store.saveProfile({...f.store.profile(f.p.id),authorization:'research'});assert.equal(f.c.choose(f.p.id,f.state),null);
 f.store.saveProfile({...f.store.profile(f.p.id),authorization:'submit'});assert.equal(f.c.choose(f.p.id,f.state).jobId,low.id);
 f.store.rankJob(f.p.id,low.id,rankInput(f.store,f.p.id,40));assert.equal(f.c.choose(f.p.id,f.state).jobId,low.id,'a duplicate rank preserves the user exception');
 f.store.saveRankThreshold(f.p.id,39);assert.equal(f.c.choose(f.p.id,f.state).jobId,low.id);assert.equal(f.store.profile(f.p.id).authorization,'submit');
 for(const value of [-1,101,50.5,'50',null])assert.throws(()=>f.store.saveRankThreshold(f.p.id,value));
}finally{f.store.close();}});
test('scheduler chooses highest eligible score, preserving current work and answered drafts',async()=>{const f=fixture();try{
 const mid=f.add('mid',65),high=f.add('high',95),low=f.add('low',30);
 assert.equal(f.c.choose(f.p.id,f.state).jobId,high.id);
 f.store.updateJob(f.p.id,mid.id,'working','Existing draft','s');assert.equal(f.c.choose(f.p.id,f.state).jobId,mid.id);
 f.store.updateJob(f.p.id,mid.id,'blocked','Date needed','s');const q=f.store.ask(f.p.id,{jobId:mid.id,question:'Date?'});assert.equal(f.c.choose(f.p.id,f.state).jobId,high.id);
 f.store.answer(f.p.id,q.id,'Now');f.state.pendingResumes={[mid.id]:q.id};assert.equal(f.c.choose(f.p.id,f.state).jobId,mid.id);
 const task={id:'current-search',kind:'search',seenWorking:true,createdAt:Date.now()};f.store.saveCampaign(f.p.id,{...f.state,task});await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.id,task.id);
 assert.equal(f.store.job(f.p.id,low.id).status,'found');
}finally{f.store.close();}});
test('legacy unranked listing gets a rank task, durable rank required before releasing it',async()=>{const f=fixture();try{
 const j=f.add('legacy');await f.c.start(f.p.id);const task=f.store.campaign(f.p.id).task;
 assert.equal(task.kind,'rank');assert.match(campaignPrompt({task,profile:f.p}),/rank-jobs/);
 assert.throws(()=>f.c.report(f.p.id,'s',{taskId:task.id,outcome:'done',note:'done'}),/Puanlama/);
 f.store.rankJob(f.p.id,j.id,rankInput(f.store,f.p.id,80));f.c.signal(f.p.id,'Working');f.c.report(f.p.id,'s',{taskId:task.id,outcome:'done',note:'Ranked'});f.c.signal(f.p.id,'Idle');
 await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.kind,'application');assert.equal(f.store.campaign(f.p.id).task.jobId,j.id);
 assert.equal(f.store.job(f.p.id,j.id).status,'found');
}finally{f.store.close();}});
test('unavailable rank is reported blocked, leaves the record and allows other work',async()=>{const f=fixture();try{
 const j=f.add('unavailable');await f.c.start(f.p.id);const task=f.store.campaign(f.p.id).task;
 f.store.rankJob(f.p.id,j.id,{profileKey:f.store.profile(f.p.id).rankingProfileKey,status:'unavailable',summary:'Listing retrieval failed'});
 assert.throws(()=>f.c.report(f.p.id,'s',{taskId:task.id,outcome:'done',note:'done'}));
 f.c.signal(f.p.id,'Working');f.c.report(f.p.id,'s',{taskId:task.id,outcome:'blocked',note:'Cannot retrieve'});f.c.signal(f.p.id,'Idle');
 assert.equal(f.store.job(f.p.id,j.id).status,'found');assert.equal(f.c.choose(f.p.id,f.store.campaign(f.p.id)),null);
}finally{f.store.close();}});
test('profile, CV and version changes preserve the first score and never schedule another rank',()=>{const f=fixture();try{
 const j=f.add('profile',70),original=j.rank;
 f.store.saveProfile({...f.store.profile(f.p.id),facts:'Different experience',preferences:'Different preferences',rankThreshold:60});
 f.store.setCv(f.p.id,'/fixture/CV.pdf');f.store.setCv(f.p.id,'/fixture/CV.pdf');
 assert.equal(f.c.choose(f.p.id,f.state).kind,'application');
 assert.equal(rankDecision(f.store.profile(f.p.id),{...j,rank:{...original,version:0}}).eligible,true);
 const retried=f.store.rankJob(f.p.id,j.id,{...rankInput(f.store,f.p.id,10),profileKey:original.profileKey});
 assert.deepEqual(retried.rank,original);
 assert.equal(f.store.snapshot(f.p.id).jobs[0].rankDecision.state,'eligible');
 f.store.saveRankThreshold(f.p.id,80);assert.equal(rankDecision(f.store.profile(f.p.id),retried).state,'below_threshold');
 assert.equal(f.c.choose(f.p.id,f.state),null);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='job_ranked'").get().n,1);
}finally{f.store.close();}});
test('profile changes preserve draft, score and submission eligibility while revocation still applies',()=>{const f=fixture();try{
 const j=f.add('draft',90);f.store.updateJob(f.p.id,j.id,'working','Draft','s');f.store.updateJob(f.p.id,j.id,'prepared','Ready','s');
 f.store.saveApplicationCheckpoint(f.p.id,j.id,{browser:'Chrome',tabId:'123',url:j.url,step:'Salary',nextAction:'Fill salary'},'s');
 f.store.saveProfile({...f.store.profile(f.p.id),facts:'New facts',authorization:'prepare'});
 assert.throws(()=>f.store.updateJob(f.p.id,j.id,'submitting','Send','s'),/yetkisi/);
 f.store.saveProfile({...f.store.profile(f.p.id),authorization:'submit'});
 f.store.rankJob(f.p.id,j.id,rankInput(f.store,f.p.id,40));
 const saved=f.store.job(f.p.id,j.id);assert.equal(saved.rank.score,90);assert.equal(saved.status,'prepared');assert.equal(saved.resumeContext.tabId,'123');
 assert.equal(f.c.choose(f.p.id,f.state).kind,'application');
 f.store.updateJob(f.p.id,j.id,'submitting','Send','s');
}finally{f.store.close();}});
test('uncertain submission verification is selected despite stale rank or source mode changes',()=>{const f=fixture();try{
 const j=f.add('uncertain',80);for(const status of ['working','prepared','submitting'])f.store.updateJob(f.p.id,j.id,status,'step','s');f.store.recoverSession(f.p.id,'s');
 f.store.saveProfile({...f.store.profile(f.p.id),facts:'Changed profile'});const chosen=f.c.choose(f.p.id,f.state);assert.equal(chosen.kind,'verify');assert.equal(chosen.jobId,j.id);
}finally{f.store.close();}});
test('ranking persists over restart and remains candidate-scoped',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jobloop-rank-'));let store=new Store(join(dir,'db'));
 try{const p=store.saveProfile({name:'A',preferences:'Backend',rankThreshold:65}),other=store.saveProfile({name:'B',preferences:'Legal'});const job=store.addJob(p.id,listing).job;
 store.rankJob(p.id,job.id,rankInput(store,p.id,70));assert.throws(()=>store.rankJob(other.id,job.id,rankInput(store,other.id)));
 store.close();store=new Store(join(dir,'db'));assert.equal(store.snapshot(p.id).jobs[0].rank.score,70);assert.equal(store.profile(p.id).rankThreshold,65);assert.equal(store.snapshot(p.id).jobs[0].rankDecision.eligible,true);
 assert.equal(store.addJob(p.id,listing).duplicate,true);assert.equal(store.jobs(p.id).length,1);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('MCP accepts integer dimensions and rejects invalid scores, stale evidence and cross-candidate writes',async()=>{const f=fixture();let server;try{
 server=await startMcp(f.store);const token=server.grant(f.p.id,'s'),job=f.add('mcp');
 const call=async args=>{const r=await fetch(server.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'record_job_rank',arguments:args}})});return(await r.json()).result;};
 let result=await call({jobId:job.id,...rankInput(f.store,f.p.id,80)});assert.equal(result.isError,undefined);assert.equal(JSON.parse(result.content[0].text).rank.score,80);
 for(const score of [101,1.5,'80']){const input=rankInput(f.store,f.p.id);input.dimensions.technical.score=score;assert.equal((await call({jobId:job.id,...input})).isError,true);}
 assert.equal((await call({jobId:job.id,...rankInput(f.store,f.p.id),score:100})).isError,true);
 const other=f.store.saveProfile({name:'Other',preferences:'Remote'}),foreign=f.store.addJob(other.id,listing).job;assert.equal((await call({jobId:foreign.id,...rankInput(f.store,f.p.id)})).isError,true);
}finally{await server?.close();f.store.close();}});
test('disabled search sources still permit existing applications, find-only explains the hold',async()=>{const f=fixture();try{
 const source=f.store.sources(f.p.id)[0];f.store.saveSource(f.p.id,{...source,enabled:false,applyMode:'find_only'});
 const job=f.store.addJob(f.p.id,{...listing,sourceId:source.id}).job;f.store.rankJob(f.p.id,job.id,rankInput(f.store,f.p.id,90));
 assert.equal(f.store.snapshot(f.p.id).jobs[0].queueState.state,'find_only');assert.equal(f.c.choose(f.p.id,f.state),null);
 await f.c.start(f.p.id);assert.equal(f.store.campaign(f.p.id).waitingReason,'source_apply_mode');assert.match(f.store.campaign(f.p.id).note,/1 ilan/);
 f.store.saveSource(f.p.id,{...f.store.source(f.p.id,source.id),applyMode:'auto'});assert.equal(f.store.source(f.p.id,source.id).enabled,false);
 await f.c.tick();assert.equal(f.store.campaign(f.p.id).task.kind,'application');assert.equal(f.store.campaign(f.p.id).task.jobId,job.id);
}finally{f.store.close();}});
test('answered draft keeps its score and resumes before a new high-score application',()=>{const f=fixture();try{
 const draft=f.add('draft',65);f.store.updateJob(f.p.id,draft.id,'working','Form','s');f.store.updateJob(f.p.id,draft.id,'blocked','Date','s');
 const q=f.store.ask(f.p.id,{jobId:draft.id,question:'Date?'});f.store.answer(f.p.id,q.id,'Now');f.store.saveProfile({...f.store.profile(f.p.id),facts:'New start date fact'});
 f.state.pendingResumes={[draft.id]:q.id};f.add('new',99);const next=f.c.choose(f.p.id,f.state);assert.equal(next.kind,'application');assert.equal(next.jobId,draft.id);
}finally{f.store.close();}});
