import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Engine} from '../app/engine.mjs';
import {collectReadiness} from '../app/readiness.mjs';

test('missing CLI errors give the same recovery steps through readiness and engine requests',{timeout:10000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'jobloop-missing-cli-')),file=path.join(directory,'engine.mjs');let engine;
 await writeFile(file,`import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const {id,op,provider}=JSON.parse(line);
 const error=op==='launch'?'agent CLI for '+provider+' was not found on the launch PATH':op==='unknown'?'Unrelated engine failure':null;
 console.log(JSON.stringify({id,error,result:{}}));
}).on('close',()=>process.exit(0));
`);
 try{
  engine=new Engine(process.execPath,file,()=>{});
  for(const provider of ['codex','claude']){
   const readiness=await collectReadiness({provider},{findExecutable:async()=>null});
   const detail=readiness.checks.find(check=>check.id==='agent').detail;
   assert.equal(readiness.ready,false);
   assert.ok(detail.includes(provider+' --version'));
   assert.ok(detail.includes(provider==='codex'?'codex login':'claude auth login'));
   assert.match(detail,/AutoJev bu aracı içermez/);
   await assert.rejects(engine.request('launch',{provider}),error=>error.message===detail);
  }
  await assert.rejects(engine.request('unknown'),{message:'Unrelated engine failure'});
  assert.deepEqual(await engine.request('catalog'),{});
 }finally{await engine?.close();await rm(directory,{recursive:true,force:true});}
});
