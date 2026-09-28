import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {startMcp} from '../app/mcp.mjs';
import {rankDecision} from '../app/ranking.mjs';
import {rankInput} from './rank-fixture.mjs';
function fixture(){
 const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Remote',browserMode:'jev'});
 const job=store.addJob(p.id,{company:'Test',role:'Engineer',url:'https://example.test/job',location:'Remote',fit:'Test'}).job;
 return {store,p,job};
}
test('legacy HTTP-only failure is pending once; browser failure is durable but user can requeue; score stays stable',()=>{
 const {store,p,job}=fixture();try{
  job.rank={status:'unavailable',score:null,summary:'WebFetch HTTP 410'};store.saveJob(job,'fixture');
  assert.equal(rankDecision(p,store.job(p.id,job.id)).state,'pending');
  const c=new Campaigns(store,{});assert.equal(c.choose(p.id,{attempts:{}}).kind,'rank');
  const input={profileKey:store.profile(p.id).rankingProfileKey,status:'unavailable',summary:'Browser denied access'};
  assert.throws(()=>store.rankJob(p.id,job.id,input),/WebFetch/);
  store.rankJob(p.id,job.id,{...input,browserCheck:{backend:'jev',url:job.url,evidence:'Access denied in Chrome'}});
  assert.equal(rankDecision(p,store.job(p.id,job.id)).state,'unavailable');
  store.retryJobRank(p.id,job.id);assert.equal(rankDecision(p,store.job(p.id,job.id)).state,'pending');
  const scored=store.rankJob(p.id,job.id,rankInput(store,p.id,80));assert.equal(scored.rank.score,80);assert.equal(scored.rankRetry,undefined);
  assert.equal(store.rankJob(p.id,job.id,rankInput(store,p.id,20)).rank.score,80);
  assert.throws(()=>store.retryJobRank(p.id,job.id));
 }finally{store.close();}
});
test('MCP requires same-session same-listing Jev observation, not a claimed WebFetch failure',async()=>{
 const {store,p,job}=fixture();let server;
 try{
  const browser={call:async(id,name,args)=>({content:[{type:'text',text:JSON.stringify({browser:'Jev Chrome',tabId:'tab',observationId:args.url===job.url?'matching':'other',url:args.url,text:'Access denied'})}]})};
  server=await startMcp(store,()=>{},undefined,browser);const token=server.grant(p.id,'session'),otherToken=server.grant(p.id,'other');
  const call=async(name,args,bearer=token)=>(await(await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
  const input={jobId:job.id,profileKey:store.profile(p.id).rankingProfileKey,status:'unavailable',summary:'HTTP 410'};
  assert.equal((await call('record_job_rank',input)).isError,true);
  input.browserCheck={backend:'jev',url:job.url,evidence:'Access denied',observationId:'matching'};
  assert.equal((await call('record_job_rank',input)).isError,true);
  await call('browser_jev_open',{url:'https://example.test/other'});
  input.browserCheck.observationId='other';assert.equal((await call('record_job_rank',input)).isError,true);
  await call('browser_jev_open',{url:job.url});input.browserCheck.observationId='matching';
  assert.equal((await call('record_job_rank',input,otherToken)).isError,true);
  assert.notEqual((await call('record_job_rank',input)).isError,true);
  assert.equal(store.job(p.id,job.id).rank.browserCheck.observationId,'matching');
 }finally{await server?.close();store.close();}
});
