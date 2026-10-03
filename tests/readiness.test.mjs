import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {collectReadiness,findExecutable,findChrome,inspectLogin,readinessEnvironment} from '../app/readiness.mjs';

const ready={state:'ready',id:'login',label:'Agent oturumu',detail:'Ready'};
const dependencies={findExecutable:async()=>'/safe/bin/cli',inspectLogin:async()=>ready,findChrome:async()=>'/chrome',listChromeProfiles:async()=>[{directory:'Default',name:'Personal'}],existingChromeEndpoint:async()=> 'ws://127.0.0.1:9222/devtools/browser/example',chromePortAvailable:async()=>true,jevStatus:async()=>({configured:true})};
test('OpenCode readiness accepts credentials without exposing account output',async()=>{
 assert.equal((await collectReadiness({provider:'opencode'},dependencies)).ready,true);
 for(const [stdout,expected] of [['\x1b[90m└  2 credentials\x1b[0m\nprivate-account','ready'],['└  0 credentials','warning'],['unknown status','warning']]){
  const result=await inspectLogin('opencode','/safe/opencode',{execImpl:async(file,args)=>{assert.deepEqual(args,['auth','list']);return {stdout,stderr:''};}});
  assert.equal(result.state,expected);assert.doesNotMatch(JSON.stringify(result),/private-account/);
 }
});
test('first-run checks diagnose missing CLI while optional browser runtime checks remain warnings',async()=>{
 let login=0;
 const result=await collectReadiness({provider:'codex'}, {...dependencies,findExecutable:async()=>null,inspectLogin:async()=>{login++;return ready;}});
 assert.equal(result.ready,false);assert.equal(login,0);assert.equal(result.checks.find(check=>check.id==='agent').state,'error');assert.equal(result.checks.some(check=>check.id==='bun'),false);assert.equal(result.checks.find(check=>check.id==='chrome').state,'ready');
});
test('Jev readiness verifies the selected profile, debug port and key without browsing or API calls',async()=>{
 assert.equal((await collectReadiness({provider:'claude',chromeProfile:{directory:'Default'}},dependencies)).ready,true);
 const result=await collectReadiness({chromeProfile:{directory:'Missing'}},{...dependencies,chromePortAvailable:async()=>false,jevStatus:async()=>({configured:false})});
 assert.equal(result.ready,false);assert.deepEqual(result.checks.filter(check=>check.state==='error').map(check=>check.id),['chrome-profile','chrome-debug','jev']);
});
test('input validation rejects arbitrary executable names and profile paths',async()=>{
 for(const input of [null,[],{provider:'sh'},{provider:'toString'},{chromeProfile:{directory:'../secrets'}},{chromeProfile:{directory:23}}])await assert.rejects(()=>collectReadiness(input,dependencies));
});
test('login checks use fixed bounded status commands and redact all CLI output',async()=>{
 const checks=[];
 const execImpl=async(file,args,options)=>{checks.push({file,args,options});return{stdout:'{"loggedIn":true,"email":"private@example.test"}',stderr:'private warning'};};
 const result=await inspectLogin('claude','/safe/claude',{execImpl,home:'/safe/home'});
 assert.equal(result.state,'ready');assert.doesNotMatch(JSON.stringify(result),/private/);assert.deepEqual(checks[0].args,['auth','status','--json']);assert.equal(checks[0].options.timeout,5000);assert.equal(checks[0].options.shell,undefined);assert.equal(checks[0].options.cwd,'/safe/home');
 assert.equal((await inspectLogin('codex','/safe/codex',{execImpl:async()=>({stdout:'',stderr:'Logged in using API key: secret'})})).state,'ready');
 const denied=await inspectLogin('codex','/safe/codex',{execImpl:async()=>{throw Object.assign(Error('secret'),{code:1});}});assert.equal(denied.state,'error');assert.doesNotMatch(JSON.stringify(denied),/secret/);
 assert.equal((await inspectLogin('codex','/safe/codex',{execImpl:async()=>{throw Object.assign(Error('secret'),{code:'ETIMEDOUT'});}})).state,'warning');
});
test('Windows command shims are found but never passed to a shell by login checks',async()=>{
 const checked=[];const executable=await findExecutable('codex',{platform:'win32',env:{Path:'C:\\npm;relative'},accessImpl:async file=>{checked.push(file);if(file!=='C:\\npm\\codex.cmd')throw Error();},statImpl:async()=>({isFile:()=>true})});
 assert.equal(executable,'C:\\npm\\codex.cmd');assert.ok(checked.includes('C:\\npm\\codex.exe'));
 const result=await inspectLogin('codex',executable,{platform:'win32',execImpl:async()=>{throw Error('must not spawn');}});assert.equal(result.state,'warning');
});
test('Unix executable discovery matches TermLoop repaired PATH and ignores relative/cwd entries',{skip:process.platform==='win32'?'Requires Unix executable permission bits':false},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'jobloop-readiness-'));try{
  const name='jobloop-readiness-test-cli',bin=path.join(directory,'.local/bin');await mkdir(bin,{recursive:true});const cli=path.join(bin,name);await writeFile(cli,'#!/bin/sh\nexit 0\n');await chmod(cli,0o755);
  const env=readinessEnvironment({PATH:'.:relative'},'darwin',directory);assert.equal((await findExecutable(name,{env,platform:'darwin'})),cli);
  await chmod(cli,0o644);assert.equal(await findExecutable(name,{env,platform:'darwin'}),null);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('Chrome discovery supports a per-user Windows installation',async()=>{
 const location='C:\\Users\\Example\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
 assert.equal(await findChrome({platform:'win32',env:{LOCALAPPDATA:'C:\\Users\\Example\\AppData\\Local'},accessImpl:async file=>assert.equal(file,location),statImpl:async()=>({isFile:()=>true})}),location);
});
