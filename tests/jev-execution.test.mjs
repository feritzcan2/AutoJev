import test from 'node:test';
import assert from 'node:assert/strict';
import {JevExecution,JEV_WAIT_MS,jevWaitMsFor,observeClientAbort,resetClientLimits} from '../app/jev-execution.mjs';

test('long requests return a receipt and retries/polls never start another helper',async()=>{
 const execution=new JevExecution({waitMs:2});let finish,calls=0;
 const execute=onTask=>{calls++;onTask({id:'one',input:{operation:'collect_details'}});return new Promise(resolve=>{finish=resolve;});};
 assert.deepEqual((await execution.run({operation:'collect_details'},execute)).taskId,'one');
 for(let i=0;i<4;i++)assert.equal((await execution.run({operation:'scan_results'},execute)).status,'running');
 assert.equal((await execution.wait()).status,'running');assert.equal(calls,1);assert.equal(execution.busy,true);
 finish({taskId:'one',status:'needs_agent',batch:{id:'review'}});
 const result=await execution.wait();assert.equal(result.batch.id,'review');assert.equal(execution.busy,false);assert.equal(calls,1);
});

test('a retry after the helper finishes retrieves its unconsumed result',async()=>{
 const execution=new JevExecution({waitMs:2});let finish,calls=0;
 const execute=onTask=>{calls++;onTask({id:'one',input:{operation:'scan_results'}});return new Promise(resolve=>{finish=resolve;});};
 await execution.run({operation:'scan_results'},execute);finish({status:'completed',taskId:'one'});await new Promise(setImmediate);
 assert.equal((await execution.run({operation:'scan_results'},execute)).status,'completed');assert.equal(calls,1);
});

test('late errors are delivered on polling without an unhandled rejection',async()=>{
 const execution=new JevExecution({waitMs:2});let fail;
 await execution.run({operation:'scan_results'},onTask=>{onTask({id:'one',input:{operation:'scan_results'}});return new Promise((_,reject)=>{fail=reject;});});
 fail(Error('Cancelled'));await new Promise(setImmediate);await assert.rejects(()=>execution.wait(),/Cancelled/);
 assert.equal(execution.busy,false);
});

test('transport slices advance without polling and a review stops further work',async()=>{
 const execution=new JevExecution({waitMs:1}),inputs=[];let finish;
 const result=await execution.run({operation:'collect_details'},async(onTask,input)=>{
  inputs.push(input);onTask({id:'same',input:{operation:'collect_details'}});
  if(inputs.length<4)return {taskId:'same',status:'continue',steps:inputs.length};
  return new Promise(resolve=>{finish=resolve;});
 });
 assert.equal(result.status,'running');
 while(!finish)await new Promise(setImmediate);
 assert.deepEqual(inputs,[{operation:'collect_details'},...Array.from({length:3},()=>({taskId:'same'}))]);
 finish({taskId:'same',status:'needs_agent',batch:{id:'review'}});
 await new Promise(setImmediate);assert.equal(execution.busy,false);assert.equal(inputs.length,4);
 assert.equal((await execution.wait()).batch.id,'review');
});

test('automatic continuation observes cancellation between slices',async()=>{
 const execution=new JevExecution({waitMs:100}),controller=new AbortController();let calls=0;
 await assert.rejects(execution.run({operation:'collect_details'},async(onTask)=>{
  controller.signal.throwIfAborted();calls++;onTask({id:'one',input:{operation:'collect_details'}});
  controller.abort(Error('Stopped by user'));return {taskId:'one',status:'continue'};
 }),/Stopped by user/);
 assert.equal(calls,1);assert.equal(execution.busy,false);
});

test('a tool call waits as long as the provider transport allows; unknown providers keep the short window',()=>{
 assert.equal(jevWaitMsFor('claude'),240000,'under Claude Code’s 5 minute idle limit for HTTP tool calls');
 assert.equal(jevWaitMsFor('codex'),240000,'under the tool_timeout_sec=300 passed at launch');
 assert.equal(jevWaitMsFor('opencode'),30000);assert.equal(jevWaitMsFor(undefined),30000);
 for(const value of Object.values(JEV_WAIT_MS))assert.ok(value<300000,'every window stays below the Codex tool timeout');
});

test('a tool call the client dropped teaches a shorter wait for that provider, read live by the execution',async t=>{
 t.after(resetClientLimits);
 observeClientAbort('claude',60000);
 assert.equal(jevWaitMsFor('claude'),55000,'stays under the time the client tolerated');
 observeClientAbort('claude',90000);assert.equal(jevWaitMsFor('claude'),55000,'a longer later tolerance never raises the learned limit');
 observeClientAbort('claude',8000);assert.equal(jevWaitMsFor('claude'),15000,'a floor keeps polling bounded');
 observeClientAbort('codex',NaN);assert.equal(jevWaitMsFor('codex'),240000,'invalid observations are ignored');
 const execution=new JevExecution({waitMs:()=>jevWaitMsFor('opencode')});assert.equal(execution.waitWindow,30000);
 observeClientAbort('opencode',20000);assert.equal(execution.waitWindow,15000);
 let finish;const first=await execution.run({operation:'collect_details'},()=>new Promise(resolve=>{finish=resolve;}));
 assert.equal(first.status,'running');finish({status:'completed',taskId:'t'});await new Promise(setImmediate);
 assert.deepEqual(await execution.run({operation:'collect_details'},()=>{throw Error('second helper');}),{status:'completed',taskId:'t'});
});
