import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchEnvironment} from '../app/launch-environment.mjs';
import {collectReadiness,findExecutable,readinessEnvironment} from '../app/readiness.mjs';
import {Engine} from '../app/engine.mjs';

test('macOS GUI PATH discovers Homebrew agent CLIs with the same environment used for login checks',async()=>{
 const inherited={HOME:'/Users/fixture',PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},checked=[];
 const result=await collectReadiness({provider:'codex'},{env:inherited,platform:'darwin',home:inherited.HOME,
  findExecutable:(name,options)=>findExecutable(name,{...options,accessImpl:async file=>{checked.push(file);if(file!=='/opt/homebrew/bin/codex')throw Error('missing');},statImpl:async()=>({isFile:()=>true})}),
  inspectLogin:async(provider,file,{env})=>{assert.equal(provider,'codex');assert.equal(file,'/opt/homebrew/bin/codex');assert.deepEqual(env,launchEnvironment(inherited,'darwin'));return {id:'login',state:'ready',label:'Session',detail:'Fixture'};}
 });
 assert.equal(result.ready,true);assert.equal(result.checks.find(check=>check.id==='agent').state,'ready');assert.ok(checked.includes('/usr/local/bin/bun'));assert.equal(inherited.PATH,'/usr/bin:/bin:/usr/sbin:/sbin');
});
test('launch repair preserves command precedence, appends missing paths only, and leaves Windows unchanged',()=>{
 const input={HOME:'/Users/fixture',PATH:'/custom/bin:/usr/local/bin:/usr/bin',OTHER:'preserved'};
 const output=launchEnvironment(input,'darwin');
 assert.equal(output.PATH,'/custom/bin:/usr/local/bin:/usr/bin:/Users/fixture/.local/bin:/Users/fixture/.bun/bin:/opt/homebrew/bin');
 assert.deepEqual(launchEnvironment(output,'darwin'),output);assert.equal(output.OTHER,'preserved');assert.notEqual(output,input);
 assert.equal(readinessEnvironment,launchEnvironment);
 const windows={USERPROFILE:'C:\\Users\\fixture',Path:'C:\\tools;C:\\Windows'};assert.deepEqual(launchEnvironment(windows,'win32'),windows);
 const linux=launchEnvironment({PATH:'/usr/bin'},'linux','/home/fixture');assert.equal(linux.PATH,'/usr/bin:/home/fixture/.local/bin:/home/fixture/.bun/bin');
});
test('engine spawn inherits the repaired launch environment',{timeout:10000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'jobloop-engine-env-')),file=path.join(directory,'fixture.mjs');let engine;
 await writeFile(file,`import {createInterface} from 'node:readline';\nconsole.log(JSON.stringify({event:'environment',path:process.env.PATH}));\ncreateInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);console.log(JSON.stringify({id:value.id,result:{}}));}).on('close',()=>process.exit(0));\n`);
 const previous=process.env.PATH;
 try{
  process.env.PATH=process.platform==='win32'?'C:\\Windows\\System32':'/usr/bin:/bin:/usr/sbin:/sbin';
  const expected=Object.entries(launchEnvironment()).find(([key])=>key.toUpperCase()==='PATH')?.[1];let receive;
  const observed=new Promise(resolve=>{receive=resolve;});engine=new Engine(process.execPath,file,event=>{if(event.event==='environment')receive(event.path);});
  if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;
  assert.equal(await observed,expected);await engine.close();
 }finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;await engine?.close();await rm(directory,{recursive:true,force:true});}
});
