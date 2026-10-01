import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {AgentSessions} from '../app/agent-sessions.mjs';
import {automationWorkflow,launchAutomationWorker} from '../app/automation-worker.mjs';
import {setupAgentHistory,setupAgentSettings} from '../app/setup-agent.mjs';
import {CONVERSATION_WORKER} from '../app/workspace-conversation.mjs';
import {startWithResumeRepair} from '../app/resume.mjs';

const profile='builtin.agent-profile.loop-web-interview';
async function fixture(t,provider='codex'){
 const data=await mkdtemp(path.join(tmpdir(),'setup-agent-session-')),launches=[],messages=[],events=new Map();
 let core,db,runtime,agents;
 const open=()=>{
  core=new WorkspaceDatabase(path.join(data,'data.sqlite'));db=new AutomationStore(core);
  agents=new AgentSessions({root:process.cwd(),data,createEngine:(_binary,_directory,onEvent)=>({request:async(op,args)=>{
   if(op==='start'){launches.push(args);events.set(args.sessionId,onEvent);await onEvent({event:'identity',sessionId:args.sessionId,nativeId:args.resumeId??'native-'+launches.length});}
   if(op==='message')messages.push(args);return {};
  },close:async()=>{}})});
  runtime=new WebTasks(db,{launch:(run,automation,onEvent,signal)=>launchAutomationWorker({root:process.cwd(),data,db,run,automation,onEvent,signal,agents,browser:{},report:(...args)=>runtime.report(...args),mcp:{endpoint:'http://localhost/mcp',grant:()=> 'test',revoke:()=>{}}})});
 };
 const close=async()=>{await runtime.close();await agents.close();core.close();};
 open();const a=db.create('custom',{title:'Kurulum',agentSettings:{provider,model:'default',reasoning:'default',permission:'default',contextRestartPercent:20}});
 t.after(async()=>{await close();await rm(data,{recursive:true,force:true});});
 return {id:a.id,launches,messages,events,get core(){return core;},get db(){return db;},get runtime(){return runtime;},get agents(){return agents;},reopen:async()=>{await close();open();}};
}

for(const provider of ['codex','claude','opencode'])test(`${provider}: first setup, follow-ups, close/reopen and application restart preserve one native identity`,async t=>{
 const f=await fixture(t,provider),{id}=f;
 const first=await f.runtime.message(id,'İlk çalışma alanını kuralım.');
 assert.equal(first.workerId,CONVERSATION_WORKER);assert.equal(first.interactive,true);
 const flow=automationWorkflow({db:f.db,run:first,signal:new AbortController().signal,browser:{},report:(...args)=>f.runtime.report(...args)});
 const context=await flow.call(id,first.id,'get_automation_context',{});assert.equal(context.conversation.setupComplete,false);
 await flow.call(id,first.id,'save_automation_plan',{title:'Ev araştırması',goal:'Berlin evleri',criteria:[{key:'outcome',value:'Listele'},{key:'rules',value:'Berlin'},{key:'completion',value:'Kullanıcı durdurunca'}],sources:['https://example.com/homes'],instructions:'',facts:''});
 assert.equal(f.db.get(id).goal,'Berlin evleri','Initial profile is available for review');
 await flow.call(id,first.id,'finish_automation_run',{status:'completed',summary:'Hazır'});
 f.db.review(id);
 await f.runtime.message(id,'Devam edelim.');assert.equal(f.launches.length,1);assert.equal(f.messages.length,1);
 const session=[...f.agents.sessions.values()][0];session.contextUsage={peakPercent:100};
 await f.runtime.stopWorker(id,CONVERSATION_WORKER);
 assert.equal(setupAgentHistory(f.db,id).forProfile(profile).conversation(id,provider),'native-1','Context threshold never rotates setup');
 await f.runtime.message(id,'Tekrar açtım.');assert.equal(f.launches.at(-1).resumeId,'native-1');
 await f.reopen();await f.runtime.message(id,'Uygulamayı yeniden açtım.');assert.equal(f.launches.at(-1).resumeId,'native-1');
 // Unrelated worker settings and updated profile instructions cannot reset chat.
 await f.runtime.stopWorker(id,CONVERSATION_WORKER);
 f.db.save(id,{agentSettings:{...f.db.get(id).agentSettings,provider:provider==='codex'?'claude':'codex',model:'other-worker-model'}});
 const history=setupAgentHistory(f.db,id).forProfile(profile),saved=history.conversationSettings(id,provider,'native-1');history.saveConversation(id,provider,'native-1',{...saved,agentProfileDigest:'old-profile-version'});
 await f.runtime.message(id,'Aynı sohbet devam ediyor.');assert.equal(f.launches.at(-1).provider,provider);assert.equal(f.launches.at(-1).resumeId,'native-1');
});

test('model/provider changes and explicit restart reset only setup; unchanged saves and compaction preserve it',async t=>{
 const f=await fixture(t),{id}=f;const run=await f.runtime.message(id,'Başla');
 const original=setupAgentSettings(f.db,id);f.runtime.report(id,run.id,'completed','Hazır');
 await f.runtime.configureConversation(id,{...original});assert.equal(f.launches.length,1);
 await f.runtime.configureConversation(id,{...original,contextCompactPercent:60});assert.equal(f.launches.length,1);
 await assert.rejects(f.runtime.configureConversation(id,{...original,provider:'bad'}),/sağlayıcı/);assert.equal(f.runtime.slots(id)[0].run.id,run.id);
 const workerSettings=f.db.get(id).agentSettings;
 await f.runtime.configureConversation(id,{...original,model:'new-model'});assert.equal(f.launches.at(-1).resumeId,undefined);assert.equal(f.launches.at(-1).model,'new-model');
 const native='native-'+f.launches.length;
 await f.runtime.stopWorker(id,CONVERSATION_WORKER);await f.runtime.message(id,'Devam');assert.equal(f.launches.at(-1).resumeId,native);
 await f.runtime.configureConversation(id,{...original,provider:'claude'});assert.equal(f.launches.at(-1).resumeId,undefined);
 await f.runtime.configureConversation(id,original);assert.equal(f.launches.at(-1).resumeId,undefined,'Changing back cannot revive an older model session');
 await f.runtime.configureConversation(id,null,{restart:true});assert.equal(f.launches.at(-1).resumeId,undefined);
 assert.deepEqual(f.db.get(id).agentSettings,workerSettings);
});

test('legacy initial setup migrates its exact interview identity even after Worker 1 runs source tasks',async t=>{
 const f=await fixture(t),{id}=f,settings=f.db.get(id).agentSettings;
 f.core.workspaces.history(id).forProfile(profile).saveConversation(id,'codex','initial-setup',settings);
 f.core.workspaces.history(id).forProfile('builtin.agent-profile.loop-web-run').saveConversation(id,'codex','source-worker',settings);
 f.db.save(id,{agentSettings:{...settings,provider:'opencode',model:'worker-model'}});
 await f.runtime.message(id,'Eski kurulumdan devam.');assert.equal(f.launches.at(-1).resumeId,'initial-setup');
 assert.equal(f.launches.at(-1).provider,'codex','Legacy setup keeps its own provider settings');
 await f.runtime.configureConversation(id,null,{restart:true});assert.equal(f.launches.at(-1).resumeId,undefined);
 await f.reopen();await f.runtime.message(id,'Yeni sohbetten devam.');assert.equal(f.launches.at(-1).resumeId,'native-2');
 assert.equal(f.core.workspaces.history(id).conversation(id,'codex'),'source-worker');
});

test('persistent resume rejection preserves history and never starts fresh automatically',async()=>{
 const calls=[];
 await assert.rejects(startWithResumeRepair({request:async(op,args)=>{calls.push({op,args});throw Error('conversation not found');}},{provider:'opencode',resumeId:'saved'},()=>{assert.fail('Must not discard the saved identity');},{allowFreshFallback:false}),/Oturum korundu/);
 assert.equal(calls.length,1);assert.equal(calls[0].args.resumeId,'saved');
});

test('a form answer after application restart resumes setup with that answer despite profile changes',async t=>{
 const f=await fixture(t),{id}=f,run=await f.runtime.message(id,'Tercihlerimi kaydet.');
 const question=f.db.askQuestion(id,{text:'Hangi semt?'},{runId:run.id});
 await f.reopen();
 f.db.save(id,{goal:'Yeni profil hedefi'});
 await f.runtime.answer(id,question.id,'Mitte');
 assert.equal(f.launches.at(-1).resumeId,'native-1');assert.match(f.launches.at(-1).prompt,/Mitte/);
});
