import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireTabRendering} from '../app/jev-rendering.mjs';
import {waitForDocument} from '../app/jev-document.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

test('nested observations cannot suspend rendering before the parent form operation finishes',async()=>{
 const commands=[];
 const slot={page:{evaluate:async()=>true},cdp:{send:async(method,args)=>commands.push(args.enabled)}};
 const release=await acquireTabRendering(slot);
 try{
  let reads=0;slot.page.evaluate=async()=>({url:'https://fixture.test',loading:++reads===1,hidden:true});
  await waitForDocument(slot,{attempts:2,wait:async()=>{}});
  assert.deepEqual(commands,[true]);
 }finally{await release();}
 assert.deepEqual(commands,[true,false]);await release();assert.deepEqual(commands,[true,false]);
});

test('rendering sessions are independent per tab and restore after the last concurrent user',async()=>{
 const commands=[[],[]],slots=commands.map(log=>({page:{evaluate:async()=>true},cdp:{send:async(method,args)=>log.push(args.enabled)}}));
 const [first,nested,other]=await Promise.all([acquireTabRendering(slots[0]),acquireTabRendering(slots[0]),acquireTabRendering(slots[1])]);
 await first();assert.deepEqual(commands,[[true],[true]]);
 await other();assert.deepEqual(commands,[[true],[true,false]]);
 await nested();assert.deepEqual(commands,[[true,false],[true,false]]);
});

test('cancelled or failed preparation restores rendering before returning the error',async()=>{
 for(const outcome of ['abort','failure']){
  const abort=new AbortController(),commands=[];
  const slot={page:{evaluate:async()=>true},cdp:{send:async(method,{enabled})=>{
   commands.push(enabled);if(enabled){if(outcome==='abort')abort.abort();else throw Error('CDP failed');}
  }}};
  await assert.rejects(acquireTabRendering(slot,{signal:abort.signal}),outcome==='abort'?{name:'AbortError'}:/CDP failed/);
  assert.deepEqual(commands,[true,false]);
 }
 const abort=new AbortController();abort.abort();
 await assert.rejects(acquireTabRendering({page:{evaluate:()=>assert.fail('Already cancelled')}},{signal:abort.signal}),{name:'AbortError'});
});

test('foreground tabs keep their normal focus state',async()=>{
 const release=await acquireTabRendering({page:{evaluate:async()=>false},cdp:{send:()=>assert.fail('Foreground page needs no emulation')}});
 await release();
});

test('unresponsive visibility, enable and cleanup commands have a bounded lifetime',async()=>{
 for(const stuck of ['visibility','enable','cleanup']){
  const commands=[],never=new Promise(()=>{});
  const slot={page:{evaluate:()=>stuck==='visibility'?never:Promise.resolve(true)},cdp:{send:async(method,{enabled})=>{
   commands.push(enabled);if(stuck===(enabled?'enable':'cleanup'))return never;
  }}};
  if(stuck==='cleanup'){const release=await acquireTabRendering(slot,{timeoutMs:10});await release();}
  else await assert.rejects(acquireTabRendering(slot,{timeoutMs:10}),{code:'TAB_RENDER_TIMEOUT'});
  assert.deepEqual(commands,stuck==='visibility'?[]:[true,false]);
  // Timed-out sessions cannot block later operations on the same tab.
  slot.page.evaluate=async()=>false;await(await acquireTabRendering(slot,{timeoutMs:10}))();
 }
});

test('cancellation interrupts a pending rendering command and still restores the tab',async()=>{
 const abort=new AbortController(),commands=[];let started;
 const pending=new Promise(resolve=>{started=resolve;});
 const slot={page:{evaluate:async()=>true},cdp:{send:async(method,{enabled})=>{
  commands.push(enabled);if(enabled){started();return new Promise(()=>{});}
 }}};
 const operation=acquireTabRendering(slot,{signal:abort.signal});
 await pending;abort.abort();await assert.rejects(operation,{name:'AbortError'});
 assert.deepEqual(commands,[true,false]);
});

test('cancelling before the first browser call does not inspect or activate the tab',async()=>{
 const abort=new AbortController();
 const slot={page:{evaluate:()=>assert.fail('Cancelled read')},cdp:{send:()=>assert.fail('Cancelled activation')}};
 const pending=acquireTabRendering(slot,{signal:abort.signal});abort.abort();
 await assert.rejects(pending,{name:'AbortError'});
});

test('cancelling one waiter does not cancel another operation sharing that tab',async()=>{
 const commands=[],abort=new AbortController();let ready,started;
 const prepared=new Promise(resolve=>{started=resolve;}),pending=new Promise(resolve=>{ready=resolve;});
 const slot={page:{evaluate:async()=>true},cdp:{send:async(method,{enabled})=>{commands.push(enabled);if(enabled){started();await pending;}}}};
 const parent=acquireTabRendering(slot);await prepared;
 const nested=acquireTabRendering(slot,{signal:abort.signal});abort.abort();await assert.rejects(nested,{name:'AbortError'});
 assert.deepEqual(commands,[true]);ready();const release=await parent;await release();assert.deepEqual(commands,[true,false]);
});

test('foreign worker tabs are rejected before rendering or inspecting their DOM',async()=>{
 const client=new JevBrowser('/unused'),slot={id:'foreign',page:{url:()=> 'https://fixture.test',isClosed:()=>false,evaluate:()=>assert.fail('Foreign page read')},cdp:{send:()=>assert.fail('Foreign page emulated')}};
 client.tabs.set(slot.id,slot);client.context=async()=>({});client.reconcileJobs=async()=>{};
 await assert.rejects(client.callTool({name:'browser_jev_observe',arguments:{tabId:slot.id}},'worker',{multiWorker:true}),/başka bir worker/);
});

test('navigation during rendering preparation retries only the read in the new document',async()=>{
 const client=new JevBrowser('/unused'),commands=[];let reads=0,observations=0;
 const slot={page:{isClosed:()=>false,evaluate:async()=>{if(++reads===1)throw Error('Execution context was destroyed');return true;}},cdp:{send:async(method,{enabled})=>commands.push(enabled)}};
 client.observeOnce=async()=>{observations++;return {text:'Fresh document'};};
 assert.deepEqual(await client.observe(slot),{text:'Fresh document'});
 assert.equal(observations,1);assert.deepEqual(commands,[true,false]);
});

test('revealing a control in a background tab runs with rendering enabled and restores it afterwards',async()=>{
 const {revealInView}=await import('../app/jev-rendering.mjs');
 for(const hidden of [true,false]){
  const commands=[],scrolled=[];
  const slot={page:{evaluate:async()=>hidden},cdp:{send:async(method,{enabled})=>commands.push(enabled)}};
  await revealInView(slot,{scrollIntoViewIfNeeded:async options=>{scrolled.push({...options,during:[...commands]});}});
  assert.deepEqual(scrolled,[{timeout:2000,during:hidden?[true]:[]}]);
  assert.deepEqual(commands,hidden?[true,false]:[]);
 }
 const slot={page:{evaluate:async()=>true},cdp:{send:async(method,{enabled})=>commands.push(enabled)}},commands=[];
 await assert.rejects(revealInView(slot,{scrollIntoViewIfNeeded:async()=>{throw Error('Timeout 2000ms exceeded');}}),/Timeout/);
 assert.deepEqual(commands,[true,false],'a failed reveal still restores the tab');
});
