import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {gmailAccess,inspectGmailAccess,withCodexApps} from '../app/connector-access.mjs';
function server(handler){const calls=[];let closed=false;return {calls,get closed(){return closed;},spawnProcess:()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.exitCode=null;child.kill=()=>{closed=true;child.exitCode=0;child.emit('exit',0);};child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const rpc=JSON.parse(line);calls.push(rpc);if(rpc.id){const result=handler(rpc);if(result!==undefined)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:rpc.id,result})+'\n'));}}});return child;}};}
test('Gmail discovery paginates and uses the provider URL without handling OAuth secrets',async()=>{
 const fake=server(rpc=>rpc.method==='initialize'?{}:rpc.params.cursor?{data:[{id:'gmail-test',name:'Gmail',isAccessible:false,isEnabled:true,installUrl:'https://chatgpt.com/apps/gmail/gmail-test'}],nextCursor:null}:{data:[{name:'Other'}],nextCursor:'next'});
 const result=await inspectGmailAccess('codex','/tmp',{spawnProcess:fake.spawnProcess});assert.equal(result.status,'missing');assert.match(result.installUrl,/chatgpt.com/);assert.equal(fake.calls.filter(c=>c.method==='app/list').length,2);assert.equal(fake.closed,true);
});
test('catalog availability does not claim mailbox identity; unknown provider and unsafe URLs are explicit',async()=>{
 assert.equal(gmailAccess({id:'x',isAccessible:true,isEnabled:true}).status,'available');assert.equal(gmailAccess({id:'x',isAccessible:true,isEnabled:false}).status,'disabled');assert.equal(gmailAccess({installUrl:'https://evil.example/auth'}).installUrl,null);assert.equal(gmailAccess(null).status,'unavailable');assert.equal((await inspectGmailAccess('claude','/tmp')).status,'provider_setup');
});
test('provider timeout closes the metadata process and rejects rather than claiming missing Gmail',async()=>{
 const fake=server(()=>undefined);await assert.rejects(withCodexApps('/tmp',()=>{}, {spawnProcess:fake.spawnProcess,timeoutMs:5}),/zaman aşımı/);assert.equal(fake.closed,true);
});
