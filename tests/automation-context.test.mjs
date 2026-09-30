import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomationContext,AUTOMATION_CONTEXT_BYTES} from '../app/automation-context.mjs';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {startMcp} from '../app/mcp.mjs';

const size=value=>Buffer.byteLength(JSON.stringify(value));
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
 const store=new Store(':memory:');t.after(()=>store.close());
 const db=new AutomationStore(store),a=db.create('housing',{title:'Berlin',goal:'Find homes',criteria:{location:'Berlin'},sources:['https://example.com/homes']});
 for(let n=0;n<3;n++)db.message(a.id,'user',`${n}: `+'Saved requirement. '.repeat(450));
 const run=db.begin(a.id,'interview'),controller=new AbortController();
 const flow=automationWorkflow({db,run,signal:controller.signal,browser:{call(){throw Error('Context must not open the browser');}},report:()=>{}});
 const server=await startMcp(store,()=>{},async()=>({}),null,null,flow);t.after(()=>server.close());const token=server.grant(a.id,run.id);
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
