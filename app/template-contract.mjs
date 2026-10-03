import {browserDefinition} from './browser-definition.mjs';
import {normalizeTemplateSources} from './template-sources.mjs';
import {normalizeRecordOperations} from './record-operation-definitions.mjs';
import {normalizeMailContract} from './mail-contract.mjs';
const key=/^[a-z][a-z0-9_-]{0,59}$/;
const text=(value,label,max=6000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+' geçersiz');return value.trim();};
export function templateContract(input,driver=browserDefinition){
 const execution=input.execution??{driver:driver.id};
 if(execution.driver!==driver.id)throw Error('Desteklenmeyen template yürütücüsü');
 const maxWorkers=execution.maxWorkers??8;if(!Number.isInteger(maxWorkers)||maxWorkers<1||maxWorkers>8)throw Error('Worker sınırı 1–8 olmalı');
 const defaults=driver.workflow;
 const workflow=(input.workflow??defaults).map(step=>{
  if(!key.test(step.id)||!driver.capabilities[step.capability]||!['source','record'].includes(step.scope)||!Array.isArray(step.after??[]))throw Error('Geçersiz template adımı');
  return {id:step.id,capability:step.capability,effect:driver.capabilities[step.capability].effect,scope:step.scope,instructions:text(step.instructions,'Adım talimatı'),after:[...new Set(step.after??[])]};
 });
 if(!workflow.length||workflow.length>20||new Set(workflow.map(s=>s.id)).size!==workflow.length)throw Error('Adımlar benzersiz ve 1–20 arasında olmalı');
 const visited=new Set(),visiting=new Set(),byId=new Map(workflow.map(s=>[s.id,s]));
 const visit=id=>{if(visited.has(id))return;if(visiting.has(id)||!byId.has(id))throw Error('Template adım bağımlılığı geçersiz');visiting.add(id);for(const parent of byId.get(id).after)visit(parent);visiting.delete(id);visited.add(id);};
 for(const step of workflow)visit(step.id);
 const records=input.records??{},states=(records.states??driver.records.states).map(s=>{if(!key.test(s.id))throw Error('Geçersiz kayıt durumu');return {id:s.id,label:text(s.label,'Durum adı',100)};});
 if(!states.length||states.length>40||new Set(states.map(s=>s.id)).size!==states.length)throw Error('Kayıt durumları benzersiz olmalı');
 const stateIds=new Set(states.map(s=>s.id));
 const actions=(records.actions??[]).map(a=>{if(!key.test(a.id)||!stateIds.has(a.to)||!Array.isArray(a.from)||!a.from.length||a.from.some(s=>!stateIds.has(s)))throw Error('Geçersiz kayıt geçişi');return {id:a.id,label:text(a.label,'İşlem adı',100),from:a.from,to:a.to};});
 if(actions.length>30||new Set(actions.map(a=>a.id)).size!==actions.length)throw Error('İşlemler benzersiz olmalı');
 if(records.initial&&!stateIds.has(records.initial))throw Error('Başlangıç durumu tanımlı olmalı');
 const bindings=records.bindings??driver.records.bindings;
 for(const [name,value]of Object.entries(bindings))if(!key.test(name)||!key.test(value)||['__proto__','constructor','prototype'].includes(value))throw Error('Geçersiz alan eşlemesi');
 const identity=records.identity??'key';if(!['url','key'].includes(identity))throw Error('Geçersiz kayıt kimlik kuralı');
 const recordOperations=normalizeRecordOperations(input.recordOperations,driver);
 if(workflow.some(step=>Object.values(recordOperations).some(op=>op.id===step.id)))throw Error('Kayıt işlemi kimliği workflow içinde tekrar edemez');
 return {...input,version:2,kind:driver.kind,mail:normalizeMailContract(input.mail),defaultSources:normalizeTemplateSources(input.defaultSources),execution:{driver:execution.driver,maxWorkers},workflow,recordOperations,records:{states,actions,bindings,identity,initial:records.initial??states[0].id,dismissLabel:text(records.dismissLabel??'Kaydı ele','Eleme düğmesi',100)}};
}
export function findOperation(template,id){return template.workflow.find(s=>s.id===id)??Object.values(template.recordOperations??{}).find(s=>s.id===id);}
export function operationFor(template,id){const operation=findOperation(template,id);if(!operation)throw Error('Template adımı bulunamadı');return operation;}
