// Real regular Chrome profiles: only the other profile is open at connection time.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {findChrome} from '../app/chrome-installation.mjs';
import {JevCdpTransport} from '../app/jev-cdp.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

async function until(read){
 for(let i=0;i<100;i++){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}
 throw Error('Chrome fixture did not become ready');
}
const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'jev-closed-profile-'))),executable=await findChrome();
const server=createServer((req,res)=>{
 const login=new URL(req.url,'http://localhost').searchParams.get('login');
 res.writeHead(200,{'Content-Type':'text/html',...(login?{'Set-Cookie':`login=${login}; Path=/`}:{})});
 res.end('<title>Profile fixture</title><h1>Synthetic profile check</h1><label>Draft<input id="draft"></label>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const child=spawn(executable,[`--user-data-dir=${directory}`,'--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--profile-directory=Default',url+'?login=personal'],{stdio:'ignore'});
const exited=new Promise(resolve=>child.once('exit',resolve));
let transport,client,personalClient,restarted=[];
try{
 const lines=await until(()=>readFile(path.join(directory,'DevToolsActivePort'),'utf8').then(text=>text.trim().split('\n')).catch(()=>null));
 const endpoint=`ws://127.0.0.1:${lines[0]}${lines[1]}`;
 transport=await JevCdpTransport.connect(endpoint);
 const targets=async()=>(await transport.call('Target.getTargets')).targetInfos.filter(t=>t.type==='page');
 const launch=(profile,page)=>promisify(execFile)(executable,[`--user-data-dir=${directory}`,`--profile-directory=${profile}`,'--new-window',page],{timeout:10000});
 await launch('Profile 2',url+'?login=work');
 const selected=await until(async()=>(await targets()).find(t=>t.url===url+'?login=work'));
 const {sessionId}=await transport.call('Target.attachToTarget',{targetId:selected.targetId,flatten:true});
 await until(async()=>(await transport.call('Runtime.evaluate',{expression:'document.cookie',returnByValue:true},sessionId)).result.value==='login=work');
 for(const target of await targets())if(target.browserContextId===selected.browserContextId)await transport.call('Target.closeTarget',{targetId:target.targetId});
 await until(async()=>!(await targets()).some(t=>t.browserContextId===selected.browserContextId));
 const personal=await until(async()=>(await targets()).find(t=>t.url===url+'?login=personal'));
 const order=[];
 client=new JevBrowser(path.join(directory,'jev'),{profile:{directory:'Profile 2'},endpoint:async()=>{order.push('connect');return endpoint;},openWindow:async(marker,profile)=>{
  order.push('open:'+profile.directory);await launch(profile.directory,marker);
 }});
 await client.context();assert.deepEqual(order,['open:Profile 2','connect']);
 const result=JSON.parse((await client.callTool({name:'browser_jev_open',arguments:{url}},'fixture')).content[0].text);
 assert.equal(await client.tab(result.tabId).page.evaluate(()=>document.cookie),'login=work');
 assert.ok((await targets()).some(t=>t.targetId===personal.targetId));
 assert.equal(client.tabs.has(personal.targetId),false);
 console.log('JEV_CLOSED_PROFILE_OPEN_FOCUS_BEFORE_CONNECTION_PASS');
 // Simulate the app reconnecting two saved workspaces together after restart.
 // Chrome stays open with both sessions and unsent forms throughout.
 personalClient=new JevBrowser(path.join(directory,'personal-jev'),{profile:{directory:'Default'},endpoint:async()=>endpoint,openWindow:async(marker,profile)=>launch(profile.directory,marker)});
 const personalResult=JSON.parse((await personalClient.callTool({name:'browser_jev_open',arguments:{url}},'fixture')).content[0].text);
 const saved=[
  {profile:'Default',directory:path.join(directory,'personal-jev'),id:personalResult.tabId,login:'personal',draft:'Personal draft'},
  {profile:'Profile 2',directory:path.join(directory,'jev'),id:result.tabId,login:'work',draft:'Work draft'}
 ];
 await personalClient.tab(personalResult.tabId).page.locator('#draft').fill(saved[0].draft);
 await client.tab(result.tabId).page.locator('#draft').fill(saved[1].draft);
 await Promise.all([client.close(),personalClient.close()]);
 for(let round=0;round<2;round++){
  const startupOrder=[],profiles=round?[...saved].reverse():saved;
  restarted=profiles.map(saved=>new JevBrowser(saved.directory,{profile:{directory:saved.profile},openWindow:async(marker,profile)=>{
   startupOrder.push('open:'+profile.directory);await launch(profile.directory,marker);
  },endpoint:async()=>{startupOrder.push('connect:'+saved.profile);return endpoint;}}));
  await Promise.all(restarted.map(async(browser,index)=>{await browser.context();startupOrder.push('ready:'+profiles[index].profile);}));
  const started=startupOrder.filter(event=>event.startsWith('open:')).map(event=>event.slice(5));
  assert.deepEqual([...started].sort(),profiles.map(saved=>saved.profile).sort());
  assert.deepEqual(startupOrder,started.flatMap(profile=>['open:'+profile,'connect:'+profile,'ready:'+profile]));
  for(const [index,browser] of restarted.entries()){
   const record=profiles[index],slot=browser.tab(record.id);
   assert.equal(await slot.page.evaluate(()=>document.cookie),'login='+record.login);
   assert.equal(await slot.page.locator('#draft').inputValue(),record.draft);
   assert.equal(browser.tabs.has(profiles[1-index].id),false);
   assert.equal(browser.tabs.has(personal.targetId),false);
  }
  assert.ok((await targets()).some(t=>t.targetId===personal.targetId));
  await Promise.all(restarted.map(browser=>browser.close()));
 }
 console.log('JEV_RESTART_CONCURRENT_PROFILES_SAME_SESSIONS_AND_DRAFTS_PASS');
}finally{await Promise.all([client,personalClient,...restarted].map(browser=>browser?.close()));transport?.close();child.kill();await exited;await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
