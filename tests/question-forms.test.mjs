import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {normalizeFields,validateAnswers} from '../app/question-forms.mjs';
import {validate} from '../app/tool-schema.mjs';
import {startTestServer} from './helpers/tool-server.mjs';
import {automationWorkflow,automationTools as tools} from '../app/automation-worker.mjs';
const fields=[{id:'permit',label:'Çalışma iznin var mı?',type:'boolean'},{id:'salary',label:'Maaş',type:'number'},{id:'days',label:'Günler',type:'multiselect',options:['Pazartesi','Salı']}];
test('forms validate explicit false, zero and choice answers; no inferred consent or unknown fields',()=>{
 const f=normalizeFields(fields);assert.deepEqual(validateAnswers(f,{permit:false,salary:0,days:['Salı']}).values,{permit:false,salary:0,days:['Salı']});
 for(const bad of [{salary:10,days:['Salı']},{permit:'yes',salary:10,days:['Salı']},{permit:true,salary:10,days:['Friday']},{permit:true,salary:10,days:['Salı'],extra:true}])assert.throws(()=>validateAnswers(f,bad));
 assert.throws(()=>normalizeFields([...fields,fields[0]]));assert.throws(()=>validateAnswers(normalizeFields([{id:'date',label:'Tarih',type:'date'}]),{date:'2026-02-30'}));
 validate(tools.find(t=>t.name==='ask_workspace_question').inputSchema,{text:'Başvuruyu tamamlayalım',fields});validate({type:'object',properties:{},additionalProperties:false},{});
});
test('structured answers remain candidate-scoped, preserve readable evidence and reject double answers',async()=>{
 const core=new WorkspaceDatabase(':memory:'),s=new AutomationStore(core),p=s.create('job-search'),other=s.create('custom'),run=s.begin(p.id,'interview');
 const flow=automationWorkflow({db:s,run,signal:new AbortController().signal,browser:{},report:()=>{}}),mcp=await startTestServer(core,flow),token=mcp.grant(p.id,run.id);
 try{
  const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ask_workspace_question',arguments:{text:'İki bilgi',fields:fields.slice(0,2)}}})});
  const result=(await response.json()).result;assert.notEqual(result.isError,true);const q=s.get(p.id).questions[0];assert.equal(q.fields.length,2);
  assert.throws(()=>s.answerQuestion(other.id,q.id,{permit:true,salary:70000}));assert.throws(()=>s.answerQuestion(p.id,q.id,'   '));
  s.answerQuestion(p.id,q.id,{permit:false,salary:70000});assert.match(s.get(p.id).questions[0].answer,/Hayır/);assert.equal(s.get(p.id).questions[0].answerValues.salary,70000);assert.throws(()=>s.answerQuestion(p.id,q.id,{permit:true,salary:1}));
  const legacy=s.askQuestion(p.id,{text:'Legacy?'});s.answerQuestion(p.id,legacy.id,'Normal text');assert.equal(s.get(p.id).questions.at(-1).answer,'Normal text');
 }finally{await mcp.close();core.close();}
});

test('a form accepts a free-text reply without fabricating structured answers',()=>{const core=new WorkspaceDatabase(':memory:'),s=new AutomationStore(core);try{const p=s.create('job-search'),q=s.askQuestion(p.id,{text:'Details',fields});const result=s.answerQuestion(p.id,q.id,'İznim var, maaş beklentimi henüz belirlemedim.');assert.equal(result.answerValues,null);assert.equal(s.get(p.id).questions[0].fields.length,3);assert.match(s.get(p.id).questions[0].answer,/henüz belirlemedim/);assert.throws(()=>s.answerQuestion(p.id,q.id,'Again'));}finally{core.close();}});
