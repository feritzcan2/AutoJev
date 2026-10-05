import test from 'node:test';
import assert from 'node:assert/strict';
import {startToolServer} from '../app/tool-server.mjs';

test('a tool call the client drops before the answer reports its elapsed time to the workflow once',async t=>{
 const aborts=[],tools=[{name:'slow',description:'Waits',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
 const protocol={tools,call:()=>new Promise(resolve=>setTimeout(()=>resolve({done:true}),400))};
 const server=await startToolServer({resolve:()=>protocol,assertOwner:()=>{}});t.after(()=>server.close());
 const token=server.grant('workspace','session','main',{clientAborted:ms=>aborts.push(ms)});
 const call=signal=>fetch(server.endpoint,{method:'POST',signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'slow',arguments:{}}})});
 await assert.rejects(call(AbortSignal.timeout(80)));
 await new Promise(resolve=>setTimeout(resolve,500));
 assert.equal(aborts.length,1);assert.ok(aborts[0]>=40&&aborts[0]<400,'elapsed time near the client timeout: '+aborts[0]);
 // A call that completes in time reports nothing.
 const response=await call();assert.equal(response.status,200);assert.deepEqual(JSON.parse((await response.json()).result.content[0].text),{done:true});
 assert.equal(aborts.length,1);
});
