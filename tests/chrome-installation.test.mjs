import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromeUserDataDirectory,listChromeProfiles} from '../app/chrome-profiles.mjs';
import {findChrome} from '../app/chrome-installation.mjs';
import {existingChromeEndpoint,openChromeWindow} from '../app/jev-chrome.mjs';

test('Chrome profile storage resolves the native per-user directory on each platform',()=>{
 assert.equal(chromeUserDataDirectory({platform:'darwin',home:'/Users/example',env:{}}),'/Users/example/Library/Application Support/Google/Chrome');
 assert.equal(chromeUserDataDirectory({platform:'linux',home:'/home/example',env:{XDG_CONFIG_HOME:'/custom/config'}}),'/custom/config/google-chrome');
 assert.equal(chromeUserDataDirectory({platform:'win32',home:'C:\\Users\\example',env:{LOCALAPPDATA:'D:\\Local'}}),'D:\\Local\\Google\\Chrome\\User Data');
 assert.equal(chromeUserDataDirectory({platform:'win32',home:'C:\\Users\\example',env:{}}),'C:\\Users\\example\\AppData\\Local\\Google\\Chrome\\User Data');
});
test('Chrome installation discovery includes per-user macOS and Linux stable packages',async()=>{
 const file='/Users/example/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 assert.equal(await findChrome({platform:'darwin',home:'/Users/example',env:{},accessImpl:async candidate=>{if(candidate!==file)throw Error();},statImpl:async()=>({isFile:()=>true})}),file);
 assert.equal(await findChrome({platform:'linux',home:'/home/example',env:{PATH:'/usr/bin'},accessImpl:async candidate=>{if(candidate!=='/usr/bin/google-chrome-stable')throw Error();},statImpl:async()=>({isFile:()=>true})}),'/usr/bin/google-chrome-stable');
});
test('Chrome debug endpoint stays on loopback and handles Windows line endings',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'jobloop-chrome-'));try{
  const file=path.join(directory,'DevToolsActivePort');
  await writeFile(file,'9222\r\n/devtools/browser/example-1\r\n');assert.equal(await existingChromeEndpoint({directory}),'ws://127.0.0.1:9222/devtools/browser/example-1');
  for(const content of ['0\n/devtools/browser/example','65536\n/devtools/browser/example','evil.example\n/devtools/browser/example','9222\nws://remote.example/browser','9222\n/devtools/page/example']){await writeFile(file,content);await assert.rejects(()=>existingChromeEndpoint({directory}),/geçersiz/);}
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('launch uses the discovered installation and selected profile as arguments, never shell text',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'jobloop-chrome-'));try{
  await writeFile(path.join(directory,'Local State'),JSON.stringify({profile:{last_used:'Default',info_cache:{Default:{name:'Personal'},'Profile 1':{name:'Work'},'../outside':{name:'Invalid'}}}}));
  assert.deepEqual((await listChromeProfiles({directory})).map(profile=>profile.directory),['Default','Profile 1']);
  let called=0;const executable='/Users/example/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const options={directory,findChromeImpl:async()=>executable,execImpl:async(file,args,settings)=>{called++;assert.equal(file,executable);assert.deepEqual(args,['--profile-directory=Profile 1','--new-window','http://127.0.0.1:9999/marker']);assert.equal(settings.shell,undefined);}};
  await openChromeWindow('http://127.0.0.1:9999/marker',{directory:'Profile 1'},options);assert.equal(called,1);
  await assert.rejects(()=>openChromeWindow('http://127.0.0.1:9999/marker',{directory:'../outside'},options),/bulunamadı/);assert.equal(called,1);
  await assert.rejects(()=>openChromeWindow('http://127.0.0.1:9999/marker',{directory:'Default'},{...options,findChromeImpl:async()=>null}),/Chrome bulunamadı/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
