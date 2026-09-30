import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ContextUsage,contextTokens,contextSample} from '../app/context-usage.mjs';
import {rotateAgentContext} from '../app/agent-restart.mjs';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';

const nativeId='11111111-1111-4111-8111-111111111111';
const codex=tokens=>({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:tokens,cached_input_tokens:90000,output_tokens:5000},model_context_window:1000000,total_token_usage:{input_tokens:9000000}}}});
const claude=tokens=>({type:'context_usage',sessionId:nativeId,cwd:'/candidate',tokens:typeof tokens==='number'&&tokens>=0?tokens+90000:tokens,contextWindow:1000000});
const jsonl=records=>records.map(r=>JSON.stringify(r)+'\n').join('');

test('16 percent uses each provider-reported capacity, including 1M and changed models',()=>{
 for(const capacity of [200000,1000000,258400]){
  const record=codex(capacity*.16);record.payload.info.model_context_window=capacity;
  assert.equal(contextSample('codex',record,nativeId).percent,16);
  const status={type:'context_usage',sessionId:nativeId,tokens:capacity*.16,contextWindow:capacity};
  assert.equal(contextSample('claude',status,nativeId).percent,16);
 }
 const record=codex(40000);record.payload.info.model_context_window=200000;
 assert.equal(contextSample('codex',record,nativeId).percent,20);
 record.payload.info.model_context_window=1000000;
 assert.equal(contextSample('codex',record,nativeId).percent,4);
 for(const capacity of [undefined,null,0,-1,'1000000']){
  record.payload.info.model_context_window=capacity;
  assert.equal(contextSample('codex',record,nativeId).percent,null);
  assert.equal(contextSample('claude',{...claude(30000),contextWindow:capacity},nativeId).percent,null);
 }
});

test('provider samples use request context, handle caching once, and reject unknown data',()=>{
 assert.equal(contextTokens('codex',codex(120000),nativeId),120000);
 assert.equal(contextTokens('claude',claude(30000),nativeId),120000);
 assert.equal(contextTokens('claude',{...claude(30000),isSidechain:true},nativeId),null);
 assert.equal(contextTokens('claude',{...claude(30000),sessionId:'another'},nativeId),null);
 for(const bad of [null,'120000',-1,NaN,Infinity]){
  assert.equal(contextTokens('codex',codex(bad),nativeId),null);
  assert.equal(contextTokens('claude',claude(bad),nativeId),null);
 }
 assert.equal(contextTokens('codex',{type:'event_msg',payload:{type:'token_count',info:{model_context_window:1000000,total_token_usage:{input_tokens:9000000}}}},nativeId),null);
 assert.equal(contextTokens('claude',{type:'assistant',sessionId:nativeId},nativeId),null);
});

for(const provider of ['codex','claude'])test(`${provider}: exact conversation read, partial writes and compaction keep the crossed threshold`,async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'jobloop-context-'));
 const directory=path.join(root,provider==='codex'?'2026/09/27':'-candidate');await mkdir(directory,{recursive:true});
 const file=path.join(directory,provider==='codex'?`rollout-2026-09-27-${nativeId}.jsonl`:`${nativeId}.jsonl`);
 const header=provider==='codex'?{type:'session_meta',payload:{id:nativeId,cwd:'/candidate'}}:{type:'user',sessionId:nativeId,cwd:'/candidate'};
 const sample=tokens=>provider==='codex'?codex(tokens):claude(tokens-90000);
 try{
  await writeFile(file,jsonl([header,sample(100000)]));
  const reader=new ContextUsage({provider,nativeId,cwd:'/candidate',root,statusFile:provider==='claude'?file:undefined});
  assert.equal((await reader.read()).tokens,100000);
  const line=JSON.stringify(sample(130000));await appendFile(file,line.slice(0,60));
  assert.equal((await reader.read()).tokens,100000,'partial records are not measurements');
  await appendFile(file,line.slice(60)+'\n'+jsonl([sample(95000)]));
  const usage=await reader.read();assert.equal(usage.tokens,95000);assert.equal(usage.peakPercent,13);assert.equal(usage.caughtUp,true);
  assert.equal((await reader.read()).peakPercent,13,'unchanged file keeps the threshold latched');
  const other=new ContextUsage({provider,nativeId,cwd:'/other-candidate',root,statusFile:provider==='claude'?file:undefined});assert.equal((await other.read()).tokens,null);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('incremental reads stay bounded and finish a backlog before dispatch',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'jobloop-context-'));
 const file=path.join(root,`rollout-test-${nativeId}.jsonl`);
 try{
  await writeFile(file,jsonl([{type:'session_meta',payload:{id:nativeId,cwd:'/candidate'}},codex(100)]));
  const reader=new ContextUsage({provider:'codex',nativeId,cwd:'/candidate',root,chunkBytes:1024});await reader.read();
  await appendFile(file,jsonl([codex(150000),{type:'tool',data:'x'.repeat(5000)},codex(40000)]));
  let usage=await reader.read();assert.equal(usage.pending,true);assert.equal(usage.peakPercent,15);
  for(let i=0;i<10&&usage.pending;i++)usage=await reader.read();
  assert.equal(usage.pending,false);assert.equal(usage.tokens,40000);assert.equal(usage.peakPercent,15);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Codex compaction proof is incremental and does not invent a context measurement',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'jobloop-context-'));
 const file=path.join(root,`rollout-test-${nativeId}.jsonl`);
 try{
  await writeFile(file,jsonl([{type:'session_meta',payload:{id:nativeId,cwd:'/candidate'}},codex(500000)]));
  const reader=new ContextUsage({provider:'codex',nativeId,cwd:'/candidate',root});
  assert.equal((await reader.read()).compactionId,null);
  await appendFile(file,jsonl([{type:'compacted',timestamp:'2026-09-28T10:00:00Z',payload:{}}]));
  const result=await reader.read();assert.equal(result.compactionId,'2026-09-28T10:00:00Z');assert.equal(result.tokens,500000);
  assert.equal((await reader.read()).compactionId,result.compactionId);
 }finally{await rm(root,{recursive:true,force:true});}
});

function fixture(provider='codex',threshold=16){
 const store=new Store(':memory:');
 const profile=store.saveProfile({name:'Context test',preferences:'Remote',agentSettings:{provider,model:'default',permission:'default',reasoning:'default',network:null,contextRestartPercent:threshold}});
 let active=null,usage={percent:18,peakPercent:18,caughtUp:true};const calls=[];
 const stop=async()=>{calls.push('stop');store.saveConversation(profile.id,provider,'late-identity',profile.agentSettings);active=null;};
 const campaigns=new Campaigns(store,{active:()=>active,changed:()=>{},readContext:async()=>usage,
  launch:async id=>{calls.push('launch');assert.equal(store.conversation(id,provider),null);active={candidateId:id,provider,sessionId:`session-${calls.length}`,state:'Working'};store.saveConversation(id,provider,'thread',profile.agentSettings);},
  send:async()=>calls.push('send'),stop,rotateContext:(id,session,usage,threshold)=>rotateAgentContext({store,stop},id,session,usage,threshold)});
 const signal=state=>{active.state=state;campaigns.signal(profile.id,state);};
 const report=()=>campaigns.report(profile.id,active.sessionId,{taskId:store.campaign(profile.id).task.id,outcome:'no_results',note:'Search finished'});
 return{store,profile,campaigns,calls,signal,report,active:()=>active,setUsage:value=>usage=value};
}

for(const provider of ['codex','claude'])test(`${provider}: restart only after valid task report AND Idle, with next task in a fresh session`,async()=>{
 const f=fixture(provider);try{
  await f.campaigns.start(f.profile.id);f.signal('Working');await f.campaigns.tick();assert.deepEqual(f.calls,['launch']);
  f.report();await f.campaigns.tick();assert.deepEqual(f.calls,['launch'],'saved report does not interrupt the turn');
  const before=f.store.profile(f.profile.id);f.signal('Idle');await f.campaigns.tick();
  assert.deepEqual(f.calls,['launch','stop','launch']);assert.deepEqual(f.store.profile(f.profile.id),before);
  assert.equal(f.store.campaign(f.profile.id).status,'running');
  assert.equal(f.store.snapshot(f.profile.id).events.filter(e=>e.kind==='agent_context_restart').length,1);
 }finally{f.store.close();}
});

test('an unreported or interrupted task continues in the existing conversation',async()=>{
 const f=fixture();try{
  await f.campaigns.start(f.profile.id);f.signal('Working');f.signal('Idle');await f.campaigns.tick();
  assert.deepEqual(f.calls,['launch']);assert.ok(f.store.campaign(f.profile.id).task.recovery);
  f.signal('Interrupted');await f.campaigns.tick();assert.deepEqual(f.calls,['launch']);
 }finally{f.store.close();}
});

for(const [name,threshold,usage] of [
 ['disabled',0,{percent:18,peakPercent:18}],
 ['below threshold',16,{percent:15.99,peakPercent:15.99}],
 ['unavailable',16,{percent:null,peakPercent:0,caughtUp:false}],
])test(`${name}: dispatch continues without resetting`,async()=>{
 const f=fixture('codex',threshold);try{
  f.setUsage(usage);await f.campaigns.start(f.profile.id);f.signal('Working');f.report();f.signal('Idle');await f.campaigns.tick();assert.deepEqual(f.calls,['launch','send']);
 }finally{f.store.close();}
});

test('exactly 16 percent triggers renewal after completion',async()=>{
 const f=fixture();try{
  f.setUsage({percent:16,peakPercent:16});await f.campaigns.start(f.profile.id);f.signal('Working');f.report();f.signal('Idle');await f.campaigns.tick();
  assert.deepEqual(f.calls,['launch','stop','launch']);
 }finally{f.store.close();}
});

test('legacy token thresholds are not reinterpreted as percentages',()=>{
 const f=fixture();try{
  const {contextRestartPercent:ignored,...settings}=f.profile.agentSettings;
  const saved=f.store.saveProfile({...f.profile,agentSettings:{...settings,contextRestartTokens:160000}});
  assert.equal(saved.agentSettings.contextRestartPercent,0);assert.equal(saved.agentSettings.contextRestartTokens,undefined);
 }finally{f.store.close();}
});

test('disabling the setting while a turn runs cancels its pending renewal',async()=>{
 const f=fixture();try{
  await f.campaigns.start(f.profile.id);f.signal('Working');await f.campaigns.tick();
  f.store.saveProfile({...f.profile,agentSettings:{...f.profile.agentSettings,contextRestartPercent:0}});
  f.report();f.signal('Idle');await f.campaigns.tick();assert.deepEqual(f.calls,['launch','send']);
 }finally{f.store.close();}
});

test('pause during asynchronous usage read prevents restart and dispatch',async()=>{
 const f=fixture();try{
  await f.campaigns.start(f.profile.id);f.signal('Working');f.report();f.signal('Idle');
  let resolve;f.campaigns.readContext=()=>new Promise(r=>resolve=r);
  const tick=f.campaigns.tick();await f.campaigns.pause(f.profile.id);resolve({percent:18,peakPercent:18});await tick;
  assert.deepEqual(f.calls,['launch','stop']);assert.equal(f.store.campaign(f.profile.id).status,'paused');
 }finally{f.store.close();}
});

test('failed stop retries with backoff without dispatching into an uncertain process',async()=>{
 const f=fixture();try{
  await f.campaigns.start(f.profile.id);f.signal('Working');f.report();f.signal('Idle');
  f.campaigns.rotateContext=()=>{throw Error('stop failed');};await f.campaigns.tick();
  assert.equal(f.store.campaign(f.profile.id).status,'running');assert.deepEqual(f.calls,['launch']);
  assert.equal(f.store.conversation(f.profile.id,'codex'),'thread');
  let attempts=0;f.campaigns.rotateContext=()=>{attempts++;throw Error('stop failed');};
  await f.campaigns.tick();assert.equal(attempts,0);
  for(const failure of [2,3,4]){f.campaigns.now=()=>f.store.campaign(f.profile.id).contextRestartRetry.readyAt;await f.campaigns.tick();assert.equal(f.store.campaign(f.profile.id).contextRestartRetry.failures,failure);}
  assert.equal(f.store.campaign(f.profile.id).status,'paused');assert.deepEqual(f.calls,['launch']);
 }finally{f.store.close();}
});

test('context setting persists and invalid thresholds cannot change a profile',()=>{
 const f=fixture();try{
  assert.equal(f.store.profile(f.profile.id).agentSettings.contextRestartPercent,16);
  for(const value of [-1,101,999,1.2,'16',null,NaN])assert.throws(()=>f.store.saveProfile({...f.profile,agentSettings:{...f.profile.agentSettings,contextRestartPercent:value}}),/Context/);
  assert.equal(f.store.profile(f.profile.id).agentSettings.contextRestartPercent,16);
 }finally{f.store.close();}
});

test('renewal preserves saved forms, replies, schedules and other candidates when changing providers',async()=>{
 const f=fixture();try{
  await f.campaigns.start(f.profile.id);f.signal('Working');f.report();f.signal('Idle');
  const job=f.store.addJob(f.profile.id,{url:'https://example.test/saved',company:'Saved',role:'Role',location:'Remote',fit:'Test'}).job;
  f.store.saveApplicationCheckpoint(f.profile.id,job.id,{browser:'Jev Chrome',tabId:'saved-tab',url:job.url,step:'Form',nextAction:'Await answer'},f.active().sessionId);
  const question=f.store.ask(f.profile.id,{jobId:job.id,question:'Start date?'});f.store.answer(f.profile.id,question.id,'Next month');
  const other=f.store.saveProfile({name:'Other',preferences:'Remote'});f.store.saveConversation(other.id,'codex','other-thread',{});
  f.store.saveConversation(f.profile.id,'claude','older-claude-thread',{});
  f.store.saveProfile({...f.profile,agentSettings:{...f.profile.agentSettings,provider:'claude'}});
  const before=f.store.snapshot(f.profile.id);
  let stopped=false;
  await rotateAgentContext({store:f.store,stop:async()=>{stopped=true;}},f.profile.id,f.active(),{percent:18,peakPercent:18},16);
  assert.equal(stopped,true);const after=f.store.snapshot(f.profile.id);
  for(const key of ['jobs','questions','sources','campaign','profile'])assert.deepEqual(after[key],before[key]);
  assert.equal(f.store.conversation(f.profile.id,'codex'),null);assert.equal(f.store.conversation(f.profile.id,'claude'),null);
  assert.equal(f.store.conversation(other.id,'codex'),'other-thread');
 }finally{f.store.close();}
});

test('usage backlog delays the next task without stopping work early',async()=>{
 const f=fixture();try{
  await f.campaigns.start(f.profile.id);f.signal('Working');f.report();f.signal('Idle');
  f.setUsage({percent:18,peakPercent:18,pending:true});await f.campaigns.tick();assert.deepEqual(f.calls,['launch']);
  f.setUsage({percent:4,peakPercent:18,pending:false});await f.campaigns.tick();assert.deepEqual(f.calls,['launch','stop','launch']);
 }finally{f.store.close();}
});

test('transient renewal failure retries once and launches fresh after confirmed stop',async()=>{
 const f=fixture();try{
  await f.campaigns.start(f.profile.id);f.signal('Working');f.report();f.signal('Idle');
  const rotate=f.campaigns.rotateContext;let attempts=0;
  f.campaigns.rotateContext=(...args)=>{if(++attempts===1)throw Error('PTY operation failed');return rotate(...args);};
  await f.campaigns.tick();const at=f.store.campaign(f.profile.id).contextRestartRetry.readyAt;
  f.campaigns.now=()=>at;await f.campaigns.tick();
  assert.deepEqual(f.calls,['launch','stop','launch']);assert.equal(f.store.campaign(f.profile.id).contextRestartRetry,undefined);
 }finally{f.store.close();}
});
test('manual pause cancels a scheduled context retry',async()=>{
 const f=fixture();try{
  await f.campaigns.start(f.profile.id);f.signal('Working');f.report();f.signal('Idle');
  f.campaigns.rotateContext=()=>{throw Error('PTY failed');};await f.campaigns.tick();
  await f.campaigns.pause(f.profile.id);assert.equal(f.store.campaign(f.profile.id).contextRestartRetry,null);
  await f.campaigns.tick();assert.deepEqual(f.calls,['launch','stop']);
 }finally{f.store.close();}
});
