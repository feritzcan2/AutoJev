import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {launchEnvironment,resolveLaunchEnvironment} from '../app/launch-environment.mjs';
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

test('Linux desktop launch discovers terminal-installed CLIs and their Node interpreter',async()=>{
 const env={HOME:'/home/fixture',SHELL:'/bin/bash',PATH:'/usr/bin:/bin',KEEP:'desktop'},bin='/home/fixture/.nvm/versions/node/v22.14.0/bin';
 const resolved=await resolveLaunchEnvironment(env,{platform:'linux',execImpl:async(file,args,options)=>{
  assert.equal(file,'/bin/bash');assert.equal(args[0],'-ic');assert.match(args[1],/JOBLOOP_SHELL_PATH/);
  assert.equal(options.timeout,5000);assert.equal(options.killSignal,'SIGKILL');assert.equal(options.cwd,env.HOME);assert.equal(options.env,env);
  return {stdout:`Welcome to bash\n\0JOBLOOP_SHELL_PATH=${bin}:/usr/bin:/bin:.:relative\0Goodbye\n`,stderr:'no job control'};
 }});
 assert.equal(resolved.PATH,`${bin}:/usr/bin:/bin:/home/fixture/.local/bin:/home/fixture/.bun/bin`);
 assert.equal(resolved.KEEP,'desktop');assert.equal(env.PATH,'/usr/bin:/bin');
 const readiness=await collectReadiness({provider:'codex'},{env:resolved,platform:'linux',home:env.HOME,
  findExecutable:(name,options)=>findExecutable(name,{...options,accessImpl:async file=>{if(file!==`${bin}/codex`)throw Error('missing');},statImpl:async()=>({isFile:()=>true})}),
  inspectLogin:async(provider,file,{env})=>{assert.equal(file,`${bin}/codex`);assert.equal(env.PATH,resolved.PATH);return {id:'login',state:'ready'};}
 });
 assert.equal(readiness.ready,true);
});

test('real Bash rc PATH reaches engine children and launches an npm-style CLI',{skip:process.platform==='win32',timeout:10000},async()=>{
 const home=await mkdtemp(path.join(tmpdir(),'jobloop-shell-')),bin=path.join(home,'.nvm/versions/node/fixture/bin'),file=path.join(home,'engine.mjs');
 const previous=process.env.PATH;let engine;
 try{
  await mkdir(bin,{recursive:true});await symlink(process.execPath,path.join(bin,'node'));
  await writeFile(path.join(bin,'codex'),'#!/usr/bin/env node\nconsole.log("fixture-codex");\n',{mode:0o755});
  await writeFile(path.join(home,'.bashrc'),'export PATH="$HOME/.nvm/versions/node/fixture/bin:$PATH"\nprintf "shell startup noise\\n"\n');
  const env=await resolveLaunchEnvironment({HOME:home,PATH:'/usr/bin:/bin',SHELL:'/bin/bash'},{platform:'linux'});
  assert.equal(await findExecutable('codex',{env}),path.join(bin,'codex'));
  await writeFile(file,`import {createInterface} from 'node:readline';
import {execFileSync} from 'node:child_process';
createInterface({input:process.stdin}).on('line',line=>{const {id,op}=JSON.parse(line);console.log(JSON.stringify({id,result:op==='probe'?execFileSync('codex',['--version'],{encoding:'utf8'}).trim():{}}));}).on('close',()=>process.exit(0));
`);
  process.env.PATH=env.PATH;engine=new Engine(process.execPath,file,()=>{});
  if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;
  assert.equal(await engine.request('probe'),'fixture-codex');
 }finally{
  if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;
  await engine?.close();await rm(home,{recursive:true,force:true});
 }
});

test('shell recovery tolerates missing, noisy or stalled shells and skips Windows',async()=>{
 const env={HOME:'/home/fixture',SHELL:'/bin/bash',PATH:'/usr/bin'};
 for(const execImpl of [async()=>{throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});},async()=>({stdout:'startup failed'}),async()=>({stdout:'\0JOBLOOP_SHELL_PATH=.:relative\0'}),async()=>({stdout:'\0JOBLOOP_SHELL_PATH=/unclosed'})]){
  assert.deepEqual(await resolveLaunchEnvironment(env,{platform:'linux',execImpl}),launchEnvironment(env,'linux'));
 }
 const windows={Path:'C:\\Windows',SHELL:'/bin/bash'};
 assert.deepEqual(await resolveLaunchEnvironment(windows,{platform:'win32',execImpl:()=>assert.fail('must not invoke a shell')}),windows);
 assert.deepEqual(await resolveLaunchEnvironment({...env,SHELL:'relative'},{platform:'linux',execImpl:()=>assert.fail('must use an absolute shell')}),launchEnvironment({...env,SHELL:'relative'},'linux'));
});
