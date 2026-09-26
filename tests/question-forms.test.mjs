import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {normalizeFields,validateAnswers} from '../app/question-forms.mjs';
import {validate,tools,startMcp} from '../app/mcp.mjs';
const fields=[{id:'permit',label:'Çalışma iznin var mı?',type:'boolean'},{id:'salary',label:'Maaş',type:'number'},{id:'days',label:'Günler',type:'multiselect',options:['Pazartesi','Salı']}];
test('forms validate explicit false, zero and choice answers; no inferred consent or unknown fields',()=>{
 const f=normalizeFields(fields);assert.deepEqual(validateAnswers(f,{permit:false,salary:0,days:['Salı']}).values,{permit:false,salary:0,days:['Salı']});
 for(const bad of [{salary:10,days:['Salı']},{permit:'yes',salary:10,days:['Salı']},{permit:true,salary:10,days:['Friday']},{permit:true,salary:10,days:['Salı'],extra:true}])assert.throws(()=>validateAnswers(f,bad));
 assert.throws(()=>normalizeFields([...fields,fields[0]]));assert.throws(()=>validateAnswers(normalizeFields([{id:'date',label:'Tarih',type:'date'}]),{date:'2026-02-30'}));
 validate(tools.find(t=>t.name==='ask_candidate').inputSchema,{question:'Başvuruyu tamamlayalım',fields});validate({type:'object',properties:{},additionalProperties:false},{});
});
test('structured answers remain candidate-scoped, preserve readable evidence and reject double answers',async()=>{
 const s=new Store(':memory:'),p=s.saveProfile({name:'Test',preferences:'Berlin'}),other=s.saveProfile({name:'Other',preferences:'Remote'});
 const mcp=await startMcp(s),token=mcp.grant(p.id,'session');
 try{
  const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ask_candidate',arguments:{question:'İki bilgi',fields:fields.slice(0,2)}}})});
  const result=(await response.json()).result;assert.notEqual(result.isError,true);const q=s.questions(p.id)[0];assert.equal(q.fields.length,2);
  assert.throws(()=>s.answer(other.id,q.id,{permit:true,salary:70000}));assert.throws(()=>s.answer(p.id,q.id,'   '));
  s.answer(p.id,q.id,{permit:false,salary:70000});assert.match(s.questions(p.id)[0].answer,/Hayır/);assert.equal(s.questions(p.id)[0].answerValues.salary,70000);assert.throws(()=>s.answer(p.id,q.id,{permit:true,salary:1}));
  const legacy=s.ask(p.id,{question:'Legacy?'});s.answer(p.id,legacy.id,'Normal text');assert.equal(s.questions(p.id)[0].answer,'Normal text');
 }finally{await mcp.close();s.close();}
});

test('a form accepts a free-text reply without fabricating structured answers',()=>{const s=new Store(':memory:');try{const p=s.saveProfile({name:'Test',preferences:'Berlin'}),q=s.ask(p.id,{question:'Details',fields});const result=s.answer(p.id,q.id,'İznim var, maaş beklentimi henüz belirlemedim.');assert.equal(result.answerValues,null);assert.equal(s.questions(p.id)[0].fields.length,3);assert.match(s.questions(p.id)[0].answer,/henüz belirlemedim/);assert.throws(()=>s.answer(p.id,q.id,'Again'));}finally{s.close();}});
