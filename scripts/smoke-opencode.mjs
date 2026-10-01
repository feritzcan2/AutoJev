// Uses the real OpenCode TUI with a local model fixture and real AutoJev MCP.
// No provider credentials, external model calls, or job applications are needed.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Engine} from '../app/engine.mjs';
import {TerminalScreen} from '../app/terminal-screen.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationTools} from '../app/automation-worker.mjs';
import {startToolServer} from '../app/tool-server.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'autojev-opencode-'));
const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),candidate=db.create('custom',{title:'Synthetic test'});
let engine,identity,state,requests=[],output='';
const screen=new TerminalScreen({rows:32,cols:120});
const server=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const input=JSON.parse(body);requests.push(input);
 const user=input.messages.findLast(m=>m.role==='user');
 const marker=JSON.stringify(user).includes('SECOND_TURN')?'SECOND_TURN':JSON.stringify(user).includes('RESUMED_TURN')?'RESUMED_TURN':'FIRST_TURN';
 const last=input.messages.at(-1),call=last.role!=='tool';
 const delta=call?{role:'assistant',tool_calls:[{index:0,id:'call_'+randomUUID(),type:'function',function:{name:'jobloop_ask_workspace_question',arguments:JSON.stringify({text:marker})}}]}:{role:'assistant',content:'LOCAL_FIXTURE_DONE'};
 res.writeHead(200,{'content-type':'text/event-stream'});
 for(const part of [{delta,finish_reason:null},{delta:{},finish_reason:call?'tool_calls':'stop'}])res.write(`data: ${JSON.stringify({id:'chat_fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...part}]})}\n\n`);
 res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const mcp=await startToolServer({assertOwner:id=>store.workspaces.get(id),resolve:grant=>grant.workflow,defaultWorkflow:{tools:[automationTools.find(t=>t.name==='ask_workspace_question')],call:(id,session,name,args)=>db.askQuestion(id,args)},onHook:hook=>engine.request('hook',{token:hook.token,observation:hook.observation})});
const wait=async(check)=>{const until=Date.now()+30000;while(!check()){if(Date.now()>until)throw Error(`OpenCode timeout: ${state}; requests=${requests.length}\n${await screen.text()}\n${output.slice(-1000)}`);await new Promise(r=>setTimeout(r,100));}};
const profile={id:'builtin.agent-profile.loop-trial',version:1,name:'Fixture',description:'Local transport test',category:'Test',instructions:'AUTOJEV_SYSTEM_SENTINEL. This is a local test. Only use the supplied MCP tool.',agent_id:'opencode',selection:{model:'default',permission:'default',reasoning:'default'}};
try{
 await mkdir(path.join(directory,'runtime'));
 await writeFile(path.join(directory,'opencode.json'),JSON.stringify({model:'fixture/local',small_model:'fixture/local',enabled_providers:['fixture'],provider:{fixture:{npm:'@ai-sdk/openai-compatible',name:'Local fixture',options:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'synthetic'},models:{local:{name:'Local',limit:{context:64000,output:4000}}}}}}));
 for(const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME']){process.env[key]=path.join(directory,key);await mkdir(process.env[key]);}
 engine=new Engine(path.resolve('engine/target/debug/jobloop-engine'),path.join(directory,'processes'),event=>{
  if(event.event==='output'){screen.write(event.bytes,0);output=(output+Buffer.from(event.bytes).toString()).slice(-20000);}
  if(event.event==='identity')identity=event.nativeId;
  if(event.event==='state')state=event.state;
 });
 screen.terminal.onData(text=>engine.request('input',{text}).catch(()=>{}));
 const launch=async(prompt,resumeId)=>{const sessionId=randomUUID();state=null;await engine.request('start',{sessionId,cwd:directory,runtimeDirectory:path.join(directory,'runtime'),endpoint:mcp.endpoint,token:mcp.grant(candidate.id,sessionId),provider:'opencode',model:'default',permission:'default',reasoning:'default',network:null,agentProfile:profile,approvedTools:['ask_workspace_question'],rows:32,cols:120,prompt,resumeId});};
 const firstPrompt='--help\nFIRST_TURN Türkçe \'literal\' $HOME';
 await launch(firstPrompt);
 await wait(()=>(db.get(candidate.id).questions??[]).some(q=>q.text==='FIRST_TURN')&&state==='Some(Idle)'&&identity);
 assert.match(identity,/^ses_/);
 assert.ok(requests.some(r=>r.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes(JSON.stringify(firstPrompt).slice(1,-1)))),'Leading flags and newlines must reach the model literally');
 assert.ok(requests.some(r=>r.messages.some(m=>m.role==='system'&&JSON.stringify(m.content).includes('AUTOJEV_SYSTEM_SENTINEL'))));
 console.log('OPENCODE_MCP_INSTRUCTIONS_AND_OBSERVATION_PASS');
 await engine.request('message',{text:'SECOND_TURN'});
 await wait(()=>(db.get(candidate.id).questions??[]).some(q=>q.text==='SECOND_TURN')&&state==='Some(Idle)');
 console.log('OPENCODE_CONTINUATION_PASS');
 const original=identity;await engine.request('stop');
 await launch('RESUMED_TURN',original);
 await wait(()=>(db.get(candidate.id).questions??[]).some(q=>q.text==='RESUMED_TURN')&&state==='Some(Idle)');
 assert.equal(identity,original);
 console.log('OPENCODE_NATIVE_RESUME_PASS');
}finally{
 await engine?.close();await mcp.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await screen.dispose();store.close();await rm(directory,{recursive:true,force:true});
}
