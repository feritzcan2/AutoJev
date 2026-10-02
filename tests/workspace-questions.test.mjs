import test from 'node:test';
import {WebTasks} from '../app/web-template.mjs';
import {unreportedInterviewRun} from '../app/automation-recovery.mjs';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow,launchAutomationWorker} from '../app/automation-worker.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

for(const template of ['job-search','housing','appointment','custom'])test(`${template}: agent asks typed questions and receives validated workspace-scoped answers`,async t=>{
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create(template),other=db.create('custom'),run=db.begin(a.id,'interview');
 const flow=automationWorkflow({root:process.cwd(),db,run,signal:new AbortController().signal,browser:{},report:()=>{}}),call=(name,args={})=>flow.call(a.id,run.id,name,args);
 const fields=[{id:'date',label:'Başlangıç',type:'date'},{id:'choice',label:'Tercih',type:'select',options:['A','B']},{id:'count',label:'Adet',type:'number'},{id:'consent',label:'Onay',type:'boolean'},{id:'areas',label:'Bölgeler',type:'multiselect',options:['X','Y']}];
 const q=await call('ask_workspace_question',{text:'Eksik bilgiler',fields});assert.equal((await call('ask_workspace_question',{text:'Eksik bilgiler',fields})).id,q.id);
 assert.throws(()=>db.answerQuestion(other.id,q.id,{}),/ait değil/);assert.throws(()=>db.answerQuestion(a.id,q.id,{date:'2026-02-30'}),/geçerli/);
 const answer={date:'2026-10-01',choice:'A',count:2,consent:false,areas:['X','Y']};db.answerQuestion(a.id,q.id,answer);
 let context=await call('get_automation_context');if(context.context){let text=context.text;while(context.context.nextOffset!==null){context=await call('read_automation_context_part',{contextId:context.context.id,offset:context.context.nextOffset});text+=context.text;}context=JSON.parse(text);}
 assert.deepEqual(context.questions[0].answerValues,answer);assert.equal(db.messages(a.id).at(-1).role,'user');assert.throws(()=>db.answerQuestion(a.id,q.id,answer),/zaten/);
 const free=await call('ask_workspace_question',{text:'Başka bilgi?',fields:[{id:'text',label:'Bilgi',type:'text'}]});assert.equal(db.answerQuestion(a.id,free.id,'Kendi cümlelerim').answerValues,null);
});

test('shared worker launch wires common question and context tools',async t=>{
 const data=await mkdtemp(path.join(tmpdir(),'workspace-launch-'));t.after(()=>rm(data,{recursive:true,force:true}));const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('job-search'),run=db.begin(a.id,'interview');let granted,started;
 const worker=await launchAutomationWorker({root:process.cwd(),data,db,run,automation:a,signal:new AbortController().signal,browser:{},report:()=>{},onEvent:()=>{},agents:{start:async input=>{started=input;},stop:async()=>{},output:()=>({bytes:[]})},mcp:{grant:(id,session,worker,flow)=>{granted=flow;return 'token';},revoke:()=>{},endpoint:'http://localhost/test'}});
 assert.equal(started.resume,true);started.onRecord('history_repaired',{fresh:true});assert.equal(core.db.prepare('SELECT kind FROM workspace_events ORDER BY seq DESC LIMIT 1').get().kind,'history_repaired');assert.ok(started.approvedTools.includes('ask_workspace_question'));assert.ok(granted.tools.some(t=>t.name==='get_automation_context'));await worker.close();
});

test('template setup is idempotent, form submission continues with saved answers, and launch failure preserves them',async t=>{
 const core=new WorkspaceDatabase(':memory:');const db=new AutomationStore(core),a=db.create('housing'),starts=[];let fail=false;
 const runtime=new WebTasks(db,{launch:async run=>{starts.push(run);if(fail)throw Error('Provider unavailable');return {close:async()=>{}};}});t.after(async()=>{await runtime.close();core.close();});
 const first=await runtime.setup(a.id);assert.equal((await runtime.setup(a.id)).id,first.id);assert.equal(starts.length,1);assert.equal(db.messages(a.id).filter(m=>m.role==='user').length,0);
 const q=db.askQuestion(a.id,{text:'Bütçe?',fields:[{id:'budget',label:'Bütçe',type:'number'}]});assert.equal(unreportedInterviewRun(db,a.id,first.id).status,'completed');
 await assert.rejects(runtime.answer(a.id,q.id,{budget:'invalid'}),/geçerli/);assert.equal(starts.length,1);
 await runtime.answer(a.id,q.id,{budget:1500});assert.equal(starts.length,2);assert.notEqual(starts[1].id,first.id);assert.equal(db.get(a.id).questions[0].answerValues.budget,1500);assert.equal(unreportedInterviewRun(db,a.id,starts[1].id),null);
 const next=db.askQuestion(a.id,{text:'Nerede?'});fail=true;await runtime.answer(a.id,next.id,'Berlin');assert.equal(db.get(a.id).questions[1].answer,'Berlin');assert.match(db.messages(a.id).at(-1).text,/Yanıtın kaydedildi.*Provider unavailable/);
});
