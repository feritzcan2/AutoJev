import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import {JevCdpTransport} from '../app/jev-cdp.mjs';
import {BrowserConnections} from '../app/browser-connection.mjs';
import {BrowserTools} from '../app/browser.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const windowFocus=(url,focused=true)=>fetch(url+(focused?'/focused':'/blurred'),{method:'POST',headers:{Origin:new URL(url).origin}});
const openReadyWindow=async url=>{await fetch(url);await windowFocus(url);};
test('late internal CDP responses never enter the Playwright callback map',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const sent=[],forwarded=[],socket={readyState:1,send:data=>sent.push(JSON.parse(data))};
 const transport=new JevCdpTransport(socket);transport.onmessage=message=>forwarded.push(message);
 const request=transport.call('Target.getTargets'),rejected=assert.rejects(request,/zaman aşımı/);
 t.mock.timers.tick(15000);await rejected;
 transport.receive({id:sent[0].id,result:{targetInfos:[]}});
 transport.receive({id:sent[0].id,error:{code:-32000,message:'Late error'}});
 assert.equal(forwarded.length,0);assert.equal(transport.pending.size,0);
 const result={id:12,result:{}};transport.receive(result);
 const event={method:'Target.attachedToTarget',params:{sessionId:'owned'}};transport.receive(event);
 assert.deepEqual(forwarded,[result,event]);
 const next=transport.call('Target.getTargets');transport.receive({id:sent[1].id,result:{targetInfos:[]}});
 assert.deepEqual(await next,{targetInfos:[]});assert.equal(transport.pending.size,0);
});
async function chromeFixture(t){
  const server=createServer(),websockets=new WebSocketServer({noServer:true}),sockets=new Set();
  let requests=0;
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',()=>requests++);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    for(const ws of websockets.clients)ws.terminate();
    for(const socket of sockets)socket.destroy();
    await Promise.all([new Promise(resolve=>websockets.close(resolve)),new Promise(resolve=>server.close(resolve))]);
  });
  return {
    endpoint:`ws://127.0.0.1:${server.address().port}/devtools/browser/fixture`,
    get requests(){return requests;},
    nextRequest:()=>new Promise(resolve=>server.once('upgrade',(request,socket,head)=>resolve({
      socket,
      allow:()=>new Promise(accepted=>websockets.handleUpgrade(request,socket,head,accepted))
    })))
  };
}

test('a delayed Chrome approval keeps one request and resumes after 15 minutes',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),abort=new AbortController();
  t.mock.timers.enable({apis:['setTimeout','Date']});
  let transport;
  const connections=new BrowserConnections({connect:async()=>{transport=await JevCdpTransport.connect(chrome.endpoint,{signal:abort.signal});}});
  t.after(()=>{connections.close();abort.abort();transport?.close();});
  const request=chrome.nextRequest();connections.prepare('candidate');
  const prompt=await request;
  for(let minute=0;minute<15;minute++){
    t.mock.timers.tick(60000);await flush();
    connections.prepare('candidate');
    connections.prepare('candidate',{force:true});await flush();
    assert.equal(connections.status('candidate').state,'connecting');
    assert.equal(connections.status('candidate').attempts,1);
    assert.equal(chrome.requests,1);
  }
  const peer=await prompt.allow();
  peer.on('message',data=>{const {id}=JSON.parse(data);peer.send(JSON.stringify({id,result:{targetInfos:[]}}));});
  await connections.pending.get('candidate');
  assert.equal(connections.status('candidate').ready,true);
  assert.deepEqual(await transport.call('Target.getTargets'),{targetInfos:[]});
  assert.equal(chrome.requests,1);
});

test('closing or changing a candidate cancels an unanswered approval',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'jobloop-approval-'));
  const browsers=new BrowserTools(directory,()=>({profile:{directory:'Default'},endpoint:async()=>chrome.endpoint,openWindow:openReadyWindow}));
  t.after(async()=>{await browsers.close();await rm(directory,{recursive:true,force:true});});
  let request=chrome.nextRequest();browsers.prepare('candidate');await request;
  const oldPending=browsers.connections.pending.get('candidate');
  await browsers.resetCandidate('candidate');await oldPending;
  assert.equal(browsers.status('candidate').state,'idle');
  assert.equal(browsers.connections.pending.has('candidate'),false);
  request=chrome.nextRequest();browsers.prepare('candidate');await request;
  const pending=browsers.connections.pending.get('candidate');
  await browsers.close();await pending;
  assert.equal(browsers.connections.pending.size,0);
  assert.equal(chrome.requests,2);
});

test('closing during setup also cancels CDP commands after approval',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'jobloop-approval-'));
  const browsers=new BrowserTools(directory,()=>({profile:{directory:'Default'},endpoint:async()=>chrome.endpoint,openWindow:openReadyWindow}));
  t.after(async()=>{await browsers.close();await rm(directory,{recursive:true,force:true});});
  const request=chrome.nextRequest();browsers.prepare('candidate');
  const peer=await(await request).allow();
  const command=await new Promise(resolve=>peer.once('message',data=>resolve(JSON.parse(data))));
  assert.equal(command.method,'Target.getTargets');
  const pending=browsers.connections.pending.get('candidate');
  await browsers.close();await pending;
  assert.equal(browsers.connections.pending.size,0);
  assert.equal(browsers.status('candidate').ready,false);
});

test('an already cancelled connection never opens an approval request',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),abort=new AbortController();abort.abort();
  await assert.rejects(JevCdpTransport.connect(chrome.endpoint,{signal:abort.signal}),{name:'AbortError'});
  assert.equal(chrome.requests,0);
});

test('a closed selected profile is opened and focused before Chrome receives an approval request',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'jobloop-profile-approval-'));
  let opened,marker,windows=0,activeProfile='Other';const windowOpened=new Promise(resolve=>opened=resolve);
  const browsers=new BrowserTools(directory,()=>({profile:{directory:'Profile 2'},endpoint:async()=>{assert.equal(activeProfile,'Profile 2');return chrome.endpoint;},openWindow:async(url,profile)=>{
    assert.equal(profile.directory,'Profile 2');windows++;marker=url;opened();
  }}));
  t.after(async()=>{await browsers.close();await rm(directory,{recursive:true,force:true});});
  browsers.prepare('candidate');await windowOpened;
  await fetch(marker);await windowFocus(marker,false);await flush();
  assert.equal(chrome.requests,0,'neither launching nor loading a background window grants readiness');
  browsers.prepare('candidate',{force:true});assert.equal(windows,1);
  const request=chrome.nextRequest();activeProfile='Profile 2';await windowFocus(marker);await request;
  assert.equal(chrome.requests,1);assert.equal(windows,1);
  const pending=browsers.connections.pending.get('candidate');await browsers.resetCandidate('candidate');await pending;
  assert.equal(browsers.status('candidate').state,'idle');
});

test('switching profiles while the selected window loads cancels it without requesting permission',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'jobloop-profile-loading-'));
  let opened,marker;const windowOpened=new Promise(resolve=>opened=resolve);
  const browsers=new BrowserTools(directory,()=>({profile:{directory:'Profile 2'},endpoint:async()=>chrome.endpoint,openWindow:async url=>{marker=url;opened();}}));
  t.after(async()=>{await browsers.close();await rm(directory,{recursive:true,force:true});});
  browsers.prepare('candidate');await windowOpened;const pending=browsers.connections.pending.get('candidate');
  await browsers.resetCandidate('candidate');await pending;
  assert.equal(chrome.requests,0);assert.equal(browsers.status('candidate').state,'idle');
  await assert.rejects(fetch(marker));
});

test('restarted workspaces cannot switch the active profile during another approval or connection setup',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'jobloop-restart-approval-'));
  const opened=[];
  const browsers=new BrowserTools(directory,id=>({profile:{directory:id},endpoint:async()=>chrome.endpoint,openWindow:async(url,profile)=>{
    opened.push(profile.directory);await openReadyWindow(url);
  }}));
  t.after(async()=>{await browsers.close();await rm(directory,{recursive:true,force:true});});
  let request=chrome.nextRequest();browsers.prepare('Default');const first=await request;
  browsers.prepare('Profile 2');await browsers.connect('Profile 2');
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.deepEqual(opened,['Default'],'a queued profile must not steal focus from the pending approval');
  assert.equal(chrome.requests,1);
  const peer=await first.allow();
  await new Promise(resolve=>peer.once('message',resolve));
  await flush();assert.deepEqual(opened,['Default'],'restoring tabs also belongs to the exclusive setup');
  request=chrome.nextRequest();await browsers.resetCandidate('Default');await request;
  assert.deepEqual(opened,['Default','Profile 2']);assert.equal(chrome.requests,2);
});

test('closing the app cancels queued profiles before any more Chrome windows open',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'jobloop-close-approval-'));
  const opened=[];
  const browsers=new BrowserTools(directory,id=>({profile:{directory:id},endpoint:async()=>chrome.endpoint,openWindow:async(url,profile)=>{
    opened.push(profile.directory);await openReadyWindow(url);
  }}));
  t.after(async()=>{await browsers.close();await rm(directory,{recursive:true,force:true});});
  const request=chrome.nextRequest();browsers.prepare('Default');await request;
  browsers.prepare('Profile 2');await browsers.connect('Profile 2');
  await new Promise(resolve=>setTimeout(resolve,50));
  const pending=[...browsers.connections.pending.values()];
  await browsers.close();await Promise.all(pending);
  assert.deepEqual(opened,['Default']);assert.equal(chrome.requests,1);
  assert.equal(browsers.connections.pending.size,0);
});

test('a profile changed while queued never opens its old window, and a denial lets the next workspace connect',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),directory=await mkdtemp(path.join(os.tmpdir(),'jobloop-queued-profile-'));
  const opened=[];let selected='Profile 2';
  const browsers=new BrowserTools(directory,id=>({profile:{directory:id==='changed'?selected:id},endpoint:async()=>chrome.endpoint,openWindow:async(url,profile)=>{
    opened.push(profile.directory);await openReadyWindow(url);
  }}));
  t.after(async()=>{await browsers.close();await rm(directory,{recursive:true,force:true});});
  let request=chrome.nextRequest();browsers.prepare('Default');const first=await request;
  browsers.prepare('changed');await browsers.connect('changed');
  const old=browsers.connections.pending.get('changed');
  await browsers.resetCandidate('changed');await old;selected='Profile 3';
  browsers.prepare('changed');await browsers.connect('changed');
  request=chrome.nextRequest();first.socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');await request;
  assert.deepEqual(opened,['Default','Profile 3']);assert.equal(chrome.requests,2);
});

test('owned tabs attach their out-of-process form frames without attaching other tabs',{timeout:5000},async t=>{
  const chrome=await chromeFixture(t),request=chrome.nextRequest();
  const transportPromise=JevCdpTransport.connect(chrome.endpoint);
  const peer=await(await request).allow(),transport=await transportPromise;
  t.after(()=>transport.close());
  const commands=[];
  peer.on('message',data=>{
    const command=JSON.parse(data);commands.push(command);
    peer.send(JSON.stringify({id:command.id,result:command.method==='Target.attachToTarget'?{sessionId:'owned-page-session'}:{}}));
  });
  await transport.attach('owned-page');
  assert.equal(commands.length,2);
  assert.deepEqual(commands[0].params,{targetId:'owned-page',flatten:true});
  assert.equal(commands[1].method,'Target.setAutoAttach');
  assert.equal(commands[1].sessionId,'owned-page-session');
  assert.equal(commands[1].params.waitForDebuggerOnStart,true);
  assert.deepEqual(commands[1].params.filter,[{type:'iframe',exclude:false},{exclude:true}]);
});
