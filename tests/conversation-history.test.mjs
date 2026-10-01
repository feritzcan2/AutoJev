import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {AgentSessions} from '../app/agent-sessions.mjs';
import {startTestServer} from './helpers/tool-server.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {automationWorkflow,automationPrompt,launchAutomationWorker} from '../app/automation-worker.mjs';
import {conversationRequest,workspaceHistory,CONVERSATION_WORKER} from '../app/workspace-conversation.mjs';

function fixture(t){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);
 const a=db.create('housing',{title:'Ev takibi',goal:'Berlin evleri',criteria:{location:'Berlin',budget:'1500',requirements:'2 oda'},sources:['https://example.com/homes']});
 t.after(()=>core.close());
 const start=text=>{const message=db.message(a.id,'user',text,{conversation:true});return db.begin(a.id,{kind:'interview',messageId:message.id},CONVERSATION_WORKER);};
 return {core,db,id:a.id,start};
}

test('new and resumed chat inputs contain only the pinned request, with history and profile details fetched on demand',async t=>{
 const {db,id,start}=fixture(t);
 const old=db.message(id,'assistant','OLD_REPORT '.repeat(700),{conversation:false});
 db.put({...db.get(id),referenceData:{profile:{experience:'LONG_CV '.repeat(2000)}},questions:[{id:'old-question',text:'OLD_SETUP',answer:'OLD_ANSWER'}]});
 const run=start('Sen mi puanladın?'),original=automationTaskContext(db,id,run);
 assert.equal(original.referenceData,undefined);assert.equal(original.template.fields,undefined);
 assert.deepEqual(original.questions,[]);assert.equal(original.previousRuns,undefined);assert.equal(original.results,undefined);
 const request=conversationRequest(db,id,run),prompt=automationPrompt(run,request);
 assert.match(prompt,/Sen mi puanladın/);assert.match(prompt,/Do not preload old messages or summaries/);
 assert.doesNotMatch(JSON.stringify(original)+prompt,/OLD_REPORT|OLD_SETUP|LONG_CV/);
 // A newer worker reply or even a newer user message must not replace the
 // request captured by a launching/resuming run.
 db.message(id,'assistant','A concurrent worker report',{conversation:false});
 db.message(id,'user','A later unrelated message',{conversation:true});
 assert.deepEqual(automationTaskContext(db,id,run),original);
 assert.deepEqual(conversationRequest(db,id,run),request);
 assert.ok(JSON.stringify(original).length<3000);
 const flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:{}});
 const history=await flow.call(id,run.id,'get_workspace_history',{kind:'messages',itemId:old.id});
 assert.equal(history.entries[0].text,old.text);
 const server=await startTestServer(db.store,flow);t.after(()=>server.close());const token=server.grant(id,run.id);
 const response=await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_workspace_history',arguments:{kind:'messages',itemId:old.id}}})});
 const result=(await response.json()).result;assert.ok(!result.isError,JSON.stringify(result));assert.equal(JSON.parse(result.content[0].text).entries[0].id,old.id);
 await assert.rejects(flow.call('foreign',run.id,'get_workspace_history',{kind:'messages'}),/geçersiz/);
 await assert.rejects(flow.call(id,'foreign','get_workspace_history',{kind:'messages'}),/geçersiz/);
 // Explicitly requested long profile data still uses exact paged context.
 let page=await flow.call(id,run.id,'get_automation_context',{section:'profile'}),text='';
 while(page.context){text+=page.text;if(page.context.nextOffset===null)break;page=await flow.call(id,run.id,'read_automation_context_part',{contextId:page.context.id,offset:page.context.nextOffset});}
 assert.equal(JSON.parse(text).referenceData.profile.experience,db.get(id).referenceData.profile.experience);
 assert.equal((await flow.call(id,run.id,'get_automation_context',{section:'questions'})).questions[0].answer,'OLD_ANSWER');
 assert.ok((await flow.call(id,run.id,'get_automation_context',{section:'template'})).template.guidance);
 assert.deepEqual(automationTaskContext(db,id,run),original,'lookups do not expand later default context');
});

test('history is searchable beyond the UI window, paginated without duplicates, and isolated to its workspace',t=>{
 const {db,id}=fixture(t),foreign=db.create('custom',{title:'Other workspace'}),existing=db.messages(id).length;
 const first=db.message(id,'assistant','Needle report from the first scan');
 for(let i=0;i<105;i++)db.message(id,'assistant','Report '+i);
 const secret=db.message(foreign.id,'assistant','Needle report from another workspace');
 assert.ok(!db.messages(id).some(m=>m.id===first.id));
 assert.deepEqual(workspaceHistory(db,id,{kind:'messages',query:'Needle'}).entries.map(m=>m.id),[first.id]);
 assert.deepEqual(workspaceHistory(db,id,{kind:'messages',itemId:secret.id}).entries,[]);
 const seen=[];let before;
 do{const page=workspaceHistory(db,id,{kind:'messages',limit:10,before});seen.push(...page.entries.map(m=>m.id));before=page.nextBefore;}while(before);
 assert.equal(seen.length,106+existing);assert.equal(new Set(seen).size,106+existing);assert.equal(seen[105],first.id);
 db.putRun({id:'score-run',automationId:id,kind:'run',workerId:'main',recordId:'record',recordOperation:'score',status:'completed',summary:'Score changed from 88 to 42',observations:[{text:'Do not replay large browser output'}]});
 db.putRun({id:'foreign-run',automationId:foreign.id,kind:'run',recordId:'record',summary:'Foreign score'});
 const runs=workspaceHistory(db,id,{kind:'runs',recordId:'record'});
 assert.equal(runs.entries.length,1);assert.equal(runs.entries[0].workerId,'main');assert.equal(runs.entries[0].summary,'Score changed from 88 to 42');assert.equal(runs.entries[0].observations,undefined);
 for(const input of [{kind:'bogus'},{kind:'messages',limit:11},{kind:'messages',before:0},{kind:'messages',recordId:'record'}])assert.throws(()=>workspaceHistory(db,id,input));
});

test('a fresh form-answer turn includes only the submitted questions, not old conversation or setup answers',t=>{
 const {db,id,start}=fixture(t),run=start('Semti değiştirelim.');
 const question=db.askQuestion(id,{text:'Hangi semt?'},{runId:run.id});
 db.askQuestion(id,{text:'Old setup question'});
 db.finish(id,run.id,'completed','Waiting for an answer');db.answerQuestion(id,question.id,'Mitte');
 const next=db.begin(id,'interview',CONVERSATION_WORKER),request=conversationRequest(db,id,next);
 assert.equal(request.message,undefined);assert.deepEqual(request.answers.map(q=>q.answer),['Mitte']);
 const context=automationTaskContext(db,id,next);assert.deepEqual(context.messages,[]);assert.deepEqual(context.questions.map(q=>q.id),[question.id]);
 assert.doesNotMatch(automationPrompt(next,request),/Semti değiştirelim|Old setup/);
});

for(const provider of ['codex','opencode'])test(`${provider}: resume failures preserve the native conversation and retry without replaying history`,async t=>{
 const {core,db,id,start}=fixture(t),data=await mkdtemp(path.join(tmpdir(),'conversation-history-'));
 db.save(id,{agentSettings:{provider,model:'default',reasoning:'default',permission:'default'}});
 const launches=[];let rejectResume=false;
 const agents=new AgentSessions({root:process.cwd(),data,createEngine:(_binary,_directory,onEvent)=>({request:async(op,args)=>{
  if(op==='start'){
   launches.push(args);
   if(rejectResume&&args.resumeId){rejectResume=false;throw Error('conversation not found');}
   await onEvent({event:'identity',sessionId:args.sessionId,nativeId:args.resumeId??'native-'+launches.length});
  }return {};
 },close:async()=>{}})});
 t.after(async()=>{await agents.close();await rm(data,{recursive:true,force:true});});
 const mcp={endpoint:'http://localhost/mcp',grant:()=> 'test-token',revoke:()=>{}};
 const launch=async text=>{
  const run=start(text),handle=await launchAutomationWorker({root:process.cwd(),data,db,run,automation:db.get(id),signal:{aborted:false},browser:{},report:()=>{},onEvent:()=>{},agents,mcp});
  db.finish(id,run.id,'completed','OLD_SUMMARY');await handle.close();return launches.at(-1);
 };
 db.message(id,'assistant','OLD_WORKER_REPORT',{conversation:false});
 const first=await launch('First question');assert.equal(first.resumeId,undefined);assert.match(first.prompt,/First question/);
 const second=await launch('Follow-up question');assert.equal(second.resumeId,'native-1');assert.match(second.prompt,/Follow-up question/);assert.doesNotMatch(second.prompt,/First question/);
 rejectResume=true;await assert.rejects(launch('Question after repair'),/Oturum korundu/);
 const failed=db.runs(id).find(run=>run.status==='running');db.finish(id,failed.id,'failed','Resume failed');
 const retried=await launch('Retry');assert.equal(retried.resumeId,'native-1');
 assert.deepEqual(launches.map(l=>l.resumeId),[undefined,'native-1','native-1','native-1']);
 for(const l of launches)assert.doesNotMatch(l.prompt,/OLD_WORKER_REPORT|OLD_SUMMARY/);
 assert.ok(core.workspaces.history(id,CONVERSATION_WORKER));
});
