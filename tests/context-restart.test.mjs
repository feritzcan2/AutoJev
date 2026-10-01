import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ContextUsage,contextTokens,contextSample} from '../app/context-usage.mjs';

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
