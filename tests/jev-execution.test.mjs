import test from 'node:test';
import assert from 'node:assert/strict';
import {JevExecution} from '../app/jev-execution.mjs';

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
