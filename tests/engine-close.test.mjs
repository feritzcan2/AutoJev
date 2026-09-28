import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Engine} from '../app/engine.mjs';
test('PTY stop error is recovered only after the engine exits',async()=>{
 const engine=Object.create(Engine.prototype),child=new EventEmitter();
 child.exitCode=null;child.signalCode=null;let finish;
 child.stdin={end:()=>{finish=()=>{child.exitCode=0;child.emit('exit',0);};}};
 child.kill=()=>assert.fail('No forced kill needed');engine.child=child;
 engine.request=async()=>{throw Error('PTY operation failed: Operation not permitted');};
 let done=false;const close=engine.close().then(()=>done=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
 finish();await close;assert.equal(done,true);
});
test('already exited engine needs no stop request',async()=>{
 const engine=Object.create(Engine.prototype);engine.child={exitCode:0,signalCode:null};
 engine.request=()=>assert.fail('Process already exited');await engine.close();
});
