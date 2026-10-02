// Real OpenCode + engine, local model fixture. No external model or browser.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Engine} from '../app/engine.mjs';
import {TerminalScreen} from '../app/terminal-screen.mjs';
import {ContextUsage} from '../app/context-usage.mjs';
import {startToolServer} from '../app/tool-server.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'jobloop-opencode-context-')),steps=[],screen=new TerminalScreen({rows:32,cols:120});
let engine,identity,state,requests=0,mainRequests=0;
const server=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);requests++;
 const main=Boolean(input.tools?.some(t=>t.function?.name==='jobloop_fixture_step'));
 if(main)mainRequests++;
 const call=main&&steps.length<3;
 const delta=call?{role:'assistant',tool_calls:[{index:0,id:'call_'+randomUUID(),type:'function',function:{name:'jobloop_fixture_step',arguments:JSON.stringify({step:steps.length+1})}}]}:{role:'assistant',content:main?'FIXTURE_DONE':`The user requested three fixture steps. Completed steps: ${steps.join(',')}. Continue with step ${steps.length+1} using jobloop_fixture_step, then finish.`};
 res.writeHead(200,{'content-type':'text/event-stream'});
 for(const part of [{delta,finish_reason:null},{delta:{},finish_reason:call?'tool_calls':'stop'}])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local',choices:[{index:0,...part}]})}\n\n`);
 res.write(`data: ${JSON.stringify({id:'fixture',choices:[],usage:{prompt_tokens:main&&mainRequests===1?35000:2000,completion_tokens:30,total_tokens:main&&mainRequests===1?35030:2030}})}\n\n`);
 res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const protocol={tools:[{name:'fixture_step',description:'Complete one synthetic fixture step.',inputSchema:{type:'object',properties:{step:{type:'integer'}},required:['step'],additionalProperties:false}}],call:(_owner,_session,_name,args)=>{assert.equal(args.step,steps.length+1);steps.push(args.step);return {completed:steps.length,next:steps.length<3?'Continue with the next step':'All steps completed'};}};
const mcp=await startToolServer({assertOwner:()=>{},resolve:()=>protocol,onHook:hook=>engine.request('hook',{token:hook.token,observation:hook.observation})});
try{
 await mkdir(path.join(directory,'runtime'));
 await writeFile(path.join(directory,'opencode.json'),JSON.stringify({model:'fixture/local',small_model:'fixture/local',enabled_providers:['fixture'],provider:{fixture:{npm:'@ai-sdk/openai-compatible',name:'Local fixture',options:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'synthetic'},models:{local:{name:'Local',limit:{context:64000,output:4000}}}}}}));
 for(const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME']){process.env[key]=path.join(directory,key);await mkdir(process.env[key]);}
 const modelsFile=path.join(directory,'models.json');await writeFile(modelsFile,JSON.stringify({fixture:{models:{local:{limit:{context:64000,output:4000}}}}}));
 engine=new Engine(path.resolve('engine/target/debug/jobloop-engine'),path.join(directory,'processes'),event=>{
  if(event.event==='output')screen.write(event.bytes,0);
  if(event.event==='identity')identity=event.nativeId;
  if(event.event==='state')state=event.state;
 });
 screen.terminal.onData(text=>engine.request('input',{text}).catch(()=>{}));
 const sessionId=randomUUID();await engine.request('start',{sessionId,cwd:directory,runtimeDirectory:path.join(directory,'runtime'),endpoint:mcp.endpoint,token:mcp.grant('fixture',sessionId),provider:'opencode',model:'default',permission:'default',reasoning:'default',network:null,approvedTools:['fixture_step'],rows:32,cols:120,prompt:'Run fixture steps 1, 2 and 3 in order with jobloop_fixture_step, then say FIXTURE_DONE. Do not use other tools.',opencodeCompaction:{providerID:'fixture',modelID:'local',inputLimit:22000,reserved:2000,contextWindow:64000,outputLimit:4000}});
 const until=Date.now()+60000;let usage;
 while(Date.now()<until){
  if(identity){usage=await new ContextUsage({provider:'opencode',nativeId:identity,cwd:directory,modelsFile}).read();if(steps.length===3&&state==='Some(Idle)'&&usage.compactionId)break;}
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.deepEqual(steps,[1,2,3]);assert.ok(usage?.compactionId,'Native automatic compaction must be observed');assert.equal(usage.tokens,2000);assert.equal(usage.contextWindow,64000);
 console.log(JSON.stringify({nativeCompaction:true,steps,contextAfter:usage.tokens,requests}));
}finally{await engine?.close().catch(()=>{});screen.dispose();await mcp.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
