import {WebTasks} from '../app/web-template.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {AgentProfiles,agentProfileId,profileDigest} from '../app/agent-profiles.mjs';
import {WEB_AGENTS,webAgentProfile,AUTOMATION_INSTRUCTIONS} from '../app/automation-agent-profiles.mjs';
import {automationWorkflow,launchAutomationWorker} from '../app/automation-worker.mjs';
import {AgentSessions} from '../app/agent-sessions.mjs';
import {InstructionLog} from '../app/instruction-log.mjs';
import {selectResume} from '../app/resume.mjs';
const settings={provider:'codex',model:'default',permission:'default',reasoning:'default',network:null};
function fixture(t){const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('custom',{title:'Profiles'}),profiles=new AgentProfiles(core.workspaces,{validate:async()=>{}});profiles.register(WEB_AGENTS);return {core,db,a,profiles};}
test('saved agent revisions are isolated by workspace and reject stale editor saves',async t=>{
 const {db,a,profiles}=fixture(t),b=db.create('custom',{title:'Other'}),original=profiles.get(a.id,'web-run');
 const saved=await profiles.update(a.id,'web-run',{instructions:'Work only this task.',expectedRevision:0});assert.equal(saved.version,2);assert.equal(profiles.get(a.id,'web-run').instructions,saved.instructions);assert.equal(profiles.get(b.id,'web-run').instructions,original.instructions);
 await assert.rejects(profiles.update(a.id,'web-run',{instructions:'stale',expectedRevision:0}),/değişti/);
 assert.equal(profiles.get(a.id,'web-interview').version,1);
});
test('each web role receives only its own task instructions',()=>{
 for(const kind of ['interview','trial','run']){const profile=webAgentProfile(kind,settings);assert.equal(profile.id,agentProfileId('web-'+kind));for(const [other,marker] of [['interview','Interview:'],['trial','Trial:'],['run','Run:']])assert.equal(profile.instructions.includes(marker),kind===other);}
 assert.doesNotMatch(AUTOMATION_INSTRUCTIONS,/Interview:|Trial:|Run:/);
});
test('native conversations are scoped to agent and revision; unprofiled legacy history is never resumed',t=>{
 const {core,a}=fixture(t),base=core.workspaces.history(a.id),interview=base.forProfile(agentProfileId('web-interview')),run=base.forProfile(agentProfileId('web-run'));
 base.saveConversation(a.id,'codex','legacy',settings);assert.equal(selectResume(interview,a.id,settings),undefined);
 const launch={...settings,agentProfileDigest:profileDigest(webAgentProfile('interview',settings))};
 interview.saveConversation(a.id,'codex','setup-chat',launch);run.saveConversation(a.id,'codex','work-chat',{...launch,agentProfileDigest:'work'});
 assert.equal(selectResume(interview,a.id,launch),'setup-chat');assert.equal(selectResume(run,a.id,launch),undefined);assert.equal(selectResume(interview,a.id,{...launch,agentProfileDigest:'changed'}),undefined);
 interview.forgetConversation(a.id,'codex','setup-chat');assert.equal(run.conversation(a.id,'codex'),'work-chat');base.forgetConversation(a.id,'codex','work-chat');assert.equal(run.conversation(a.id,'codex'),null);
});
test('run and trial contexts exclude raw setup messages but preserve the saved plan',async t=>{
 const {a,db}=fixture(t);db.message(a.id,'user','Private interview message');
 for(const kind of ['interview','trial','run']){
  const run={id:kind,automationId:a.id,kind,observations:[]};const flow=automationWorkflow({db:{get:id=>db.get(id),template:id=>db.template(id),messages:id=>db.messages(id),activeRun:()=>run,runs:()=>[],results:()=>[]},run,signal:{aborted:false},browser:{},report:()=>{}});
  const context=await flow.call(a.id,kind,'get_automation_context',{});assert.equal(context.messages.length,kind==='interview'?db.messages(a.id).length:0);assert.equal(context.automation.title,'Profiles');
 }
});
test('interviews resume their conversation; trials start fresh and require a current access check',async t=>{
 const {db,a}=fixture(t),data=await mkdtemp(path.join(tmpdir(),'loop-trial-context-'));t.after(()=>rm(data,{recursive:true,force:true}));
 const launches=[],agents={start:async input=>launches.push(input),stop:async()=>{},output:()=>({bytes:[]})},mcp={endpoint:'http://localhost/mcp',grant:()=> 'test-token',revoke:()=>{}};
 for(const kind of ['interview','trial','trial']){
  const run={id:'run-'+launches.length,automationId:a.id,kind};
  const worker=await launchAutomationWorker({data,db,run,automation:a,signal:{aborted:false},browser:{},report:()=>{},onEvent:()=>{},agents,mcp});await worker.close();
 }
 assert.equal(launches[0].resume,true);
 for(const launch of launches.slice(1)){assert.equal(launch.resume,false);assert.match(launch.prompt,/run_workspace_source_tool before any browser discovery/);assert.match(launch.prompt,/Previous runs are historical context/);assert.match(launch.prompt,/site_wait response is current application evidence/);assert.match(launch.prompt,/When the selected method or its configured fallback uses the browser/);assert.match(launch.prompt,/actual tool call returns a permission error/);assert.doesNotMatch(launch.prompt,/Do not use other browser tools/);}
});
for(const provider of ['claude','codex','opencode'])test(`${provider}: setup launch resumes native history until model or permission changes`,async t=>{
 const {core,db,a}=fixture(t),dir=await mkdtemp(path.join(tmpdir(),'loop-setup-resume-')),launches=[];
 const agents=new AgentSessions({root:process.cwd(),data:dir,createEngine:(_binary,_directory,onEvent)=>({
  request:async(op,args)=>{if(op==='start'){launches.push(args);await onEvent({event:'identity',sessionId:args.sessionId,nativeId:args.resumeId??'native-'+launches.length});}return {};},close:async()=>{}
 })});
 t.after(async()=>{await agents.close();await rm(dir,{recursive:true,force:true});});
 const mcp={endpoint:'http://localhost/mcp',grant:()=> 'test-token',revoke:()=>{}};
 const initial={...settings,provider},runtime=new WebTasks(db,{launch:async()=>({close:async()=>{}})});
 t.after(()=>runtime.close());
 for(const agentSettings of [initial,{...initial,contextCompactPercent:60},{...initial,model:'new-model'},{...initial,model:'new-model',permission:'bypassPermissions'}]){
  await runtime.configureConversation(a.id,agentSettings);
  const run=db.putRun({id:'setup-'+launches.length,automationId:a.id,kind:'interview'});
  const worker=await launchAutomationWorker({root:process.cwd(),data:dir,db,run,automation:{...a,agentSettings},signal:{aborted:false},browser:{},report:()=>{},onEvent:()=>{},agents,mcp});
  await worker.close();
 }
 assert.deepEqual(launches.map(l=>l.resumeId),[undefined,'native-1',undefined,undefined]);
 assert.equal(core.workspaces.history(a.id,'conversation').forProfile(agentProfileId('web-interview')).conversation(a.id,provider),'native-4');
});

for(const provider of ['claude','codex','opencode'])test(`${provider}: record continuation launches the exact native conversation even after an unrelated task`,async t=>{
 const {core,db,a}=fixture(t),dir=await mkdtemp(path.join(tmpdir(),'loop-record-resume-')),launches=[];
 const agents=new AgentSessions({root:process.cwd(),data:dir,createEngine:(_binary,_directory,onEvent)=>({
  request:async(op,args)=>{if(op==='start'){launches.push(args);await onEvent({event:'identity',sessionId:args.sessionId,nativeId:args.resumeId??'native-'+launches.length});}return {};},close:async()=>{}
 })});
 t.after(async()=>{await agents.close();await rm(dir,{recursive:true,force:true});});
 const mcp={endpoint:'http://localhost/mcp',grant:()=> 'test-token',revoke:()=>{}};
 for(const [id,recordId,continuation,model] of [['asking','one',null,'default'],['other','two',null,'default'],['answer','one',{runId:'asking'},'default'],['changed','one',{runId:'asking'},'new-model']]){
  const run=db.putRun({id,automationId:a.id,kind:'run',recordOperation:'prepare',recordId,continuation});
  const worker=await launchAutomationWorker({root:process.cwd(),data:dir,db,run,automation:{...a,agentSettings:{...settings,provider,model}},signal:{aborted:false},browser:{},report:()=>{},onEvent:()=>{},agents,mcp});
  await worker.close();
 }
 assert.deepEqual(launches.map(l=>l.resumeId),[undefined,undefined,'native-1',undefined]);
 assert.equal(db.run('asking').conversation.nativeId,'native-1');
 assert.equal(db.run('answer').conversation.nativeId,'native-1');
});

test('launch pins the saved native profile and journal filters match its identity',async t=>{
 const {core,a,profiles}=fixture(t),log=new InstructionLog(core.workspaces),dir=await mkdtemp(path.join(tmpdir(),'loop-profiles-'));t.after(()=>rm(dir,{recursive:true,force:true}));const calls=[];
 const agents=new AgentSessions({root:process.cwd(),data:dir,profiles,instructions:log,createEngine:()=>({request:async(op,args)=>{calls.push({op,args});return{};},close:async()=>{}})});t.after(()=>agents.close());
 await agents.start({id:a.id,sessionId:'setup',settings,cwd:dir,runtimeDirectory:dir,prompt:'Start',agentProfile:webAgentProfile('interview',settings),history:core.workspaces.history(a.id)});
 const sent=calls.find(c=>c.op==='start').args;assert.equal(sent.agentProfile.id,agentProfileId('web-interview'));assert.equal(sent.resumeId,undefined);
 await profiles.update(a.id,'web-interview',{instructions:'New instructions',expectedRevision:0});assert.equal(agents.sessions.get(a.id).agentProfile.version,1);
 const history=log.history(a.id,{profile:agentProfileId('web-interview')});assert.ok(history.events.length>0);assert.equal(log.history(a.id,{profile:agentProfileId('web-run')}).events.length,0);
 const event=log.detail(a.id,history.events.find(e=>e.kind==='launch').seq);const snapshot=JSON.parse(event.parts.find(p=>p.key==='session-agent-profile').text);assert.equal(snapshot.agent.version,1);assert.equal(snapshot.session_id,'setup');
});
