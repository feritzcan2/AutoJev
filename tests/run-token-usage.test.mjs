import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readRunTokenUsage,requestTokens} from '../app/run-token-usage.mjs';
import {claudeProjectDirectory} from '../app/agent-transcript.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {launchAutomationWorker} from '../app/automation-worker.mjs';

const nativeId='11111111-1111-4111-8111-111111111111',since=1000,until=3000;
const timestamp=at=>new Date(at).toISOString();
const codex=(at,total)=>({timestamp:timestamp(at),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:total}}}});
const claude=(at,id,usage,extra={})=>({timestamp:timestamp(at),type:'assistant',sessionId:nativeId,message:{id,usage},...extra});
async function transcript(t,provider,records){
 const cwd=await mkdtemp(path.join(tmpdir(),'run-tokens-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const options={provider,nativeId,cwd,since,until,codexRoot:cwd,claudeRoot:cwd};
 const directory=provider==='claude'?path.join(cwd,claudeProjectDirectory(cwd)):cwd;await mkdir(directory,{recursive:true});
 const header=provider==='codex'?{type:'session_meta',payload:{id:nativeId,cwd}}:{type:'user',sessionId:nativeId,cwd};
 await writeFile(path.join(directory,provider==='codex'?`rollout-test-${nativeId}.jsonl`:`${nativeId}.jsonl`),[header,...records].map(r=>JSON.stringify(r)+'\n').join(''));
 return options;
}

test('provider totals include cache and reasoning exactly once and reject unknown counts',()=>{
 assert.equal(requestTokens('codex',{input_tokens:100,output_tokens:30,cached_input_tokens:80,reasoning_output_tokens:20}),130);
 assert.equal(requestTokens('claude',{input_tokens:100,output_tokens:30,cache_read_input_tokens:80,cache_creation_input_tokens:20}),230);
 assert.equal(requestTokens('opencode',{input:100,output:30,reasoning:20,cache:{read:80,write:20}}),250);
 assert.equal(requestTokens('opencode',{total:250,input:100,output:30,reasoning:20,cache:{read:80,write:20}}),250);
 for(const bad of [undefined,null,-1,NaN,Infinity,'100'])assert.equal(requestTokens('claude',{input_tokens:bad,output_tokens:30}),null);
 assert.equal(requestTokens('codex',{input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:30}),null);
});

test('Codex resumed totals exclude earlier runs and duplicate notifications, including compaction',async t=>{
 const options=await transcript(t,'codex',[codex(100,1000),codex(500,1800),codex(1200,2000),codex(1300,2000),{type:'compacted'},codex(2400,2800),codex(4000,4000)]);
 assert.equal(await readRunTokenUsage(options),1000);
 assert.equal(await readRunTokenUsage({...options,since:3001,until:5000}),1200);
 assert.equal(await readRunTokenUsage({...options,cwd:options.cwd+'/foreign'}),null);
});

test('Codex handles fresh sessions, resets and large tool output without using a tail estimate',async t=>{
 const options=await transcript(t,'codex',[codex(1200,100),{type:'tool',output:'x'.repeat(3*1024*1024)},codex(2000,140),codex(2200,20),codex(2500,30)]);
 assert.equal(await readRunTokenUsage(options),170);
});

test('Claude counts request IDs once and excludes other runs and sidechains',async t=>{
 const usage={input_tokens:100,output_tokens:10,cache_read_input_tokens:200,cache_creation_input_tokens:50};
 const options=await transcript(t,'claude',[claude(500,'old',usage),claude(1100,'one',usage),claude(1200,'one',{...usage,output_tokens:20}),claude(1300,'one',usage),claude(1500,'side',usage,{isSidechain:true}),claude(1600,'foreign',usage,{sessionId:'other'}),claude(2000,'two',usage),claude(4000,'later',usage)]);
 assert.equal(await readRunTokenUsage(options),730);
});

test('missing or malformed usage remains unknown instead of a zero total',async t=>{
 const options=await transcript(t,'codex',[codex(500,100),{type:'event_msg',payload:{type:'token_count',info:null}}]);
 assert.equal(await readRunTokenUsage(options),null);
 const invalid=await transcript(t,'claude',[claude(1200,'one',{input_tokens:10})]);
 assert.equal(await readRunTokenUsage(invalid),null);
 const zero=await transcript(t,'codex',[codex(1200,0)]);assert.equal(await readRunTokenUsage(zero),0);
});

test('OpenCode sums every run message including compaction, while isolating workspace and session',async t=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'opencode-run-tokens-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const opencodeFile=path.join(cwd,'opencode.db'),id='ses_synthetic0000000000001',db=new DatabaseSync(opencodeFile);t.after(()=>db.close());
 db.exec('CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
 db.prepare('INSERT INTO session VALUES(?,?,NULL)').run(id,cwd);
 const insert=(at,sessionID=id,extra={})=>db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('m'+at,sessionID,at,JSON.stringify({role:'assistant',tokens:{input:10,output:5,reasoning:2,cache:{read:20,write:3}},...extra}));
 insert(500);insert(4000);insert(2000,'other');
 for(let n=0;n<105;n++)insert(1100+n, id, n===100?{summary:true}:{});
 const options={provider:'opencode',nativeId:id,cwd,since,until,opencodeFile};
 assert.equal(await readRunTokenUsage(options),4200);
 assert.equal(await readRunTokenUsage({...options,cwd:cwd+'/foreign'}),null);
 assert.equal(await readRunTokenUsage({...options,since:2500}),null);
});

test('worker close persists final agent and Jev usage, subtracting work from the preceding attempt',async t=>{
 const data=await mkdtemp(path.join(tmpdir(),'worker-tokens-'));t.after(()=>rm(data,{recursive:true,force:true}));
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('custom'),run=db.begin(a.id,'interview');
 const helper=db.jevTasks.create(a.id,run.taskId??run.id,{operation:'collect_details'});helper.usage={input_tokens:1000,output_tokens:200,calls:1};db.jevTasks.save(helper);
 let stopped=false;
 const agents={start:async()=>{},stop:async()=>{stopped=true;helper.usage.input_tokens+=300;helper.usage.output_tokens+=40;db.jevTasks.save(helper);},tokenUsage:async(id,worker,options)=>{assert.equal(stopped,true);assert.equal(id,a.id);assert.equal(options.since,run.startedAt);return 2000;},output:()=>({bytes:[]})};
 const worker=await launchAutomationWorker({data,db,run,automation:a,signal:new AbortController().signal,browser:{},report:()=>{},onEvent:()=>{},agents,mcp:{endpoint:'http://localhost/mcp',grant:()=> 'test',revoke:()=>{}}});
 await worker.close();await worker.close();
 db.finish(a.id,run.id,'interrupted','Stopped');
 assert.deepEqual(db.snapshot(a.id).runs.find(r=>r.id===run.id).tokenUsage,{agentTokens:2000,jevTokens:340,totalTokens:2340});
});
