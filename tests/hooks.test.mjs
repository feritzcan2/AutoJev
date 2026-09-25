import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {startMcp} from '../app/mcp.mjs';
test('hook responses include the bounded body length expected by TermLoop forwarder',async()=>{
 const store=new Store(':memory:');let received;
 const mcp=await startMcp(store,()=>{},async hook=>{received=hook;return{accepted:true};});
 try{const payload={id:'hook-1',token:'scoped-test',observation:{eventName:'SessionStart'}};const response=await fetch(mcp.endpoint.replace('/mcp','/agent-observation'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const body=await response.text();assert.equal(response.status,200);assert.equal(Number(response.headers.get('content-length')),Buffer.byteLength(body));assert.deepEqual(JSON.parse(body),{id:'hook-1',accepted:true});assert.deepEqual(received,payload);}finally{await mcp.close();store.close();}
});
