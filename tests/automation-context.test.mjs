import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomationContext,AUTOMATION_CONTEXT_BYTES} from '../app/automation-context.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {startTestServer} from './helpers/tool-server.mjs';

const size=value=>Buffer.byteLength(JSON.stringify(value));
test('context pages use the byte budget without dropping Unicode or escaped text',()=>{
 for(const prose of ['Ordinary saved instructions. ','Türkçe görev bağlamı. ','家😀\n"\\']){
  const value={facts:prose.repeat(3000)},cache=new AutomationContext();let page=cache.capture(value),text='';
  while(true){
   const bytes=size(page);assert.ok(bytes<=AUTOMATION_CONTEXT_BYTES);
   if(page.context.nextOffset!==null)assert.ok(bytes>=AUTOMATION_CONTEXT_BYTES-20,`underfilled response: ${bytes}`);
   assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
   text+=page.text;if(page.context.nextOffset===null)break;
   page=cache.read({contextId:page.context.id,offset:page.context.nextOffset});
  }
  assert.deepEqual(JSON.parse(text),value);
 }
 const cache=new AutomationContext(),value={facts:'x'.repeat(23000)};
 const first=cache.capture(value),second=cache.read({contextId:first.context.id,offset:first.context.nextOffset});
 assert.equal(second.context.nextOffset,null,'a 23K context should need just one additional call');
});

test('large context preserves exact criteria, permission and recovery state in bounded fragments',()=>{
 const cache=new AutomationContext();
 const value={automation:{criteria:{location:'Berlin',requirements:'ö家😀\n"\\'.repeat(7000)},mode:'observe'},questions:[{answer:false}],scanProgress:{pendingUrls:['https://example.com/pending'],cursor:'saved'},assignedRecord:{status:'uncertain',approved:false}};
 assert.ok(size(value)>52000);
 let page=cache.capture(value),text='',parts=0;
 for(;;){
  assert.ok(size(page)<=AUTOMATION_CONTEXT_BYTES);
  assert.equal(page.context.offset,text.length);
  text+=page.text;parts++;
  if(page.context.nextOffset===null)break;
  assert.ok(page.context.nextOffset>page.context.offset);
  page=cache.read({contextId:page.context.id,offset:page.context.nextOffset});
 }
 assert.ok(parts>1);assert.deepEqual(JSON.parse(text),value);
 const id=page.context.id;
 for(const offset of [-1,NaN,1.5,Infinity,text.length+1])assert.throws(()=>cache.read({contextId:id,offset}),/aralığı/);
 assert.throws(()=>new AutomationContext().read({contextId:id,offset:0}),/bu çalışmaya/);
 cache.capture({...value,revision:2});assert.throws(()=>cache.read({contextId:id,offset:0}),/eski/);
 const next=cache.current.id,small={automation:{mode:'observe'}};
 assert.deepEqual(cache.capture(small),small);assert.throws(()=>cache.read({contextId:next,offset:0}),/eski/);
});

test('automation context can be fully read through MCP without file or browser access',async t=>{
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());
 const db=new AutomationStore(store),a=db.create('housing',{title:'Berlin',goal:'Find homes',criteria:{location:'Berlin'},sources:['https://example.com/homes']});
 for(let n=0;n<3;n++)db.message(a.id,'user',`${n}: `+'Saved requirement. '.repeat(450));
 const run=db.begin(a.id,'interview'),controller=new AbortController();
 const flow=automationWorkflow({db,run,signal:controller.signal,browser:{call(){throw Error('Context must not open the browser');}},report:()=>{}});
 const server=await startTestServer(store,flow);t.after(()=>server.close());const token=server.grant(a.id,run.id);
 const call=async(name,args={})=>{
  const response=await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  const result=(await response.json()).result;assert.ok(!result.isError,JSON.stringify(result));
  assert.ok(Buffer.byteLength(result.content[0].text)<=AUTOMATION_CONTEXT_BYTES);
  return JSON.parse(result.content[0].text);
 };
 let page=await call('get_automation_context'),text='';const id=page.context.id;
 while(true){text+=page.text;if(page.context.nextOffset===null)break;page=await call('read_automation_context_part',{contextId:id,offset:page.context.nextOffset});}
 const saved=JSON.parse(text);assert.deepEqual(saved.messages,db.messages(a.id));assert.deepEqual(saved.automation.criteria,db.get(a.id).criteria);assert.equal(saved.automation.mode,db.get(a.id).mode);assert.equal(saved.currentRun.id,run.id);
 const args={contextId:id,offset:0};
 await assert.rejects(flow.call('foreign',run.id,'read_automation_context_part',args),/geçersiz/);
 await assert.rejects(flow.call(a.id,'foreign','read_automation_context_part',args),/geçersiz/);
 const other=automationWorkflow({db,run,signal:controller.signal,browser:{},report:()=>{}});
 await assert.rejects(other.call(a.id,run.id,'read_automation_context_part',args),/bu çalışmaya/);
 await call('get_automation_context');await assert.rejects(flow.call(a.id,run.id,'read_automation_context_part',args),/eski/);
 controller.abort();await assert.rejects(flow.call(a.id,run.id,'read_automation_context_part',{contextId:page.context.id,offset:0}),/geçersiz/);
});

test('task context excludes unrelated questions and history while keeping exact answers, limits and assigned proposal',async t=>{
 const {automationTaskContext}=await import('../app/automation-task-context.mjs');
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),a=db.create('custom',{goal:'Find',sources:['https://example.test']});
 const source=db.get(a.id).sources[0];
 const own={id:'mine',sourceUrl:source,status:'prepared',proposal:{answers:{consent:false},document:'documents/cv.pdf'},digest:'exact',approvedDigest:'exact'};
 db.putResult({...own,automationId:a.id,key:'mine',url:source+'mine',title:'Mine',createdAt:1,updatedAt:1});
 const saved=db.result(a.id,'mine');
 db.put({...db.get(a.id),maxActionsTotal:9,maxActionsPerDay:2,facts:'Verified fact',referenceData:{profile:{permission:false},applicationPolicy:{minimumScore:75},previousTasks:'irrelevant'.repeat(10000)},questions:[
  {id:'own',recordId:'mine',text:'Consent?',answer:'No',answerValues:{consent:false},fields:[{id:'consent',type:'boolean'}]},
  {id:'global',text:'Location?',answer:'Berlin'},
  {id:'source',sourceUrl:source,text:'Source fact',answer:'Exact'},
  ...Array.from({length:100},(_,i)=>({id:'other'+i,recordId:'elsewhere',text:'Unrelated'.repeat(1000)})),
  {id:'foreign-source',sourceUrl:'https://other.test/',text:'Foreign'}]});
 const active={id:'current',automationId:a.id,kind:'run',recordId:'mine',recordOperation:'execute',operation:db.template(a.templateId).recordOperations.execute.id,sourceUrl:source,request:{manual:true,direct:true,digest:'exact'},scan:{pendingUrls:['https://example.test/pending'],cursor:'exact-cursor'},resumeContext:{tabId:'retained'},observations:[{text:'large'.repeat(10000)}]};
 const context=automationTaskContext(db,a.id,active);
 assert.deepEqual(context.questions.map(q=>q.id),['own','global','source']);assert.equal(context.questions[0].answerValues.consent,false);
 assert.deepEqual(context.assignedRecord,saved);assert.equal(context.recordAuthorization.directExecution,true);assert.equal(context.recordAuthorization.approvedProposalDigest,'exact');
 assert.equal('maxActionsTotal' in context.automation,false);assert.equal('maxActionsPerDay' in context.automation,false);assert.equal(context.automation.facts,'Verified fact');assert.equal(context.referenceData.profile.permission,false);
 assert.deepEqual(context.scanProgress,active.scan);assert.deepEqual(context.currentRun.resumeContext,active.resumeContext);assert.ok(context.currentRun.observations.every(o=>o.text===undefined));
 assert.deepEqual(context.results,[]);assert.deepEqual(context.sourceExamples,[]);assert.equal(context.referenceData.previousTasks,undefined);assert.ok(size(context)<20000);
 const scan=automationTaskContext(db,a.id,{...active,recordId:null,recordOperation:null,operation:'scan'});assert.deepEqual(scan.questions.map(q=>q.id),['global','source']);assert.equal(scan.sourceExamples.length,1);
});
