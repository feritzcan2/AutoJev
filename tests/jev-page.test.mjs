import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {privateJevPage,retryJevRead} from '../app/jev-page.mjs';

test('a stale cached document handle is invalidated without repeating an evaluation that could be an action',async()=>{
 const page=new EventEmitter();let created=0,evaluations=0,disposed=0;
 const frame={evaluateHandle:async()=>{const generation=++created;return {evaluate:async()=>{evaluations++;if(generation===1)throw Error('jsHandle.evaluate: Target page, context or browser has been closed');return 'fresh';},dispose:async()=>{disposed++;}};}};
 Object.assign(page,{mainFrame:()=>frame,frames:()=>[frame],isClosed:()=>false});
 const wrapped=privateJevPage(page);
 await assert.rejects(wrapped.evaluate(()=>{}),/closed/);assert.equal(evaluations,1);
 assert.equal(await wrapped.evaluate(()=>{}),'fresh');assert.equal(created,2);assert.equal(disposed,1);
});

test('read recovery rebuilds a document after navigation and never retries a closed or disconnected page',async()=>{
 for(const state of ['live','closed','disconnected']){
  const page={isClosed:()=>state==='closed',context:()=>({browser:()=>({isConnected:()=>state!=='disconnected'})})};let reads=0;
  const read=()=>{if(++reads===1)throw Error('Execution context was destroyed, most likely because of a navigation');return {text:'fresh',handles:'fresh'};};
  if(state==='live'){assert.deepEqual(await retryJevRead(page,read,{delay:0}),{text:'fresh',handles:'fresh'});assert.equal(reads,2);}
  else {await assert.rejects(retryJevRead(page,read,{delay:0}),/navigation/);assert.equal(reads,1);}
 }
});

test('read retries are bounded and permission/rate-limit errors are returned immediately',async()=>{
 const page={isClosed:()=>false};
 for(const message of ['Target page, context or browser has been closed','Access denied','Site rate limit']){
  let reads=0;await assert.rejects(retryJevRead(page,()=>{reads++;throw Error(message);},{delay:0}),new RegExp(message));
  assert.equal(reads,message.startsWith('Target')?3:1);
 }
});

test('a navigation event discards only its old private state',async()=>{
 const page=new EventEmitter();let generation=0;
 const frame={evaluateHandle:async()=>{const value=++generation;return {evaluate:async()=>value,dispose:async()=>{}};}};
 Object.assign(page,{mainFrame:()=>frame});const wrapped=privateJevPage(page);
 assert.equal(await wrapped.evaluate(()=>{}),1);page.emit('framenavigated',frame);assert.equal(await wrapped.evaluate(()=>{}),2);
});
