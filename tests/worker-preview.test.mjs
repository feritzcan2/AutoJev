import test from 'node:test';
import assert from 'node:assert/strict';
import {workerPreviews} from '../app/worker-preview.mjs';

function fixture(){
 const sessions=new Map([['main',{sessionId:'run-1'}],['worker-2',{sessionId:'run-2'}]]),calls=[];
 const client={connection:'existing',profile:{directory:'Default'},browser:{isConnected:()=>true},tabs:new Map(),automationWorkspaces:new Map(),automationRuns:new Map()};
 const connection={client},browsers={clients:new Map([['workspace',connection]]),options:()=>({profile:{directory:'Default'}})};
 const add=(id,run='run-1',workspace='workspace',previewAt=0)=>{
  const slot={id,previewAt,pending:{decisionId:'keep'},observed:{title:id},page:{isClosed:()=>false,url:()=>`https://example.test/${id}`},cdp:{send:async(method,params)=>{calls.push({id,method,params});return {data:Buffer.from(id).toString('base64')};}}};
  client.tabs.set(id,slot);client.automationWorkspaces.set(id,workspace);client.automationRuns.set(id,run);return slot;
 };
 return {sessions,calls,client,browsers,connection,add,preview:workerPreviews({browsers,sessionFor:(id,worker)=>sessions.get(worker)})};
}

test('each worker receives only its latest owned tab, without invalidating agent decisions',async()=>{
 const f=fixture();f.add('older');const latest=f.add('latest','run-1','workspace',10);f.add('second-worker','run-2');f.add('other-workspace','run-1','other',100);f.add('previous-run','old','workspace',200);
 assert.equal((await f.preview('workspace','main')).tabId,'latest');
 assert.equal((await f.preview('workspace','worker-2')).tabId,'second-worker');
 assert.deepEqual(latest.pending,{decisionId:'keep'});
 assert.deepEqual(f.calls.map(c=>c.method),['Page.captureScreenshot','Page.captureScreenshot']);
 assert.ok(f.calls.every(c=>c.params.captureBeyondViewport===false));
});

test('preview never starts a browser and explains idle, unsupported and disconnected states',async()=>{
 const f=fixture();f.add('page');
 f.sessions.delete('main');assert.equal((await f.preview('workspace','main')).state,'idle');
 f.sessions.set('main',{sessionId:'run-1'});f.browsers.clients.clear();assert.equal((await f.preview('workspace','main')).state,'waiting');
 assert.equal(f.calls.length,0);
});

test('no matching tab and a changed Chrome profile cannot leak another preview',async()=>{
 const f=fixture();f.add('other','run-2');assert.equal((await f.preview('workspace','main')).state,'empty');
 f.add('page');f.browsers.options=()=>({profile:{directory:'Profile 2'}});assert.equal((await f.preview('workspace','main')).state,'waiting');assert.equal(f.calls.length,0);
});

for(const change of ['session','owner','workspace','url','closed','connection'])test(`an in-flight screenshot is discarded after ${change} changes`,async()=>{
 const f=fixture(),slot=f.add('page');let finish;
 slot.cdp.send=()=>new Promise(resolve=>{finish=resolve;});
 const request=f.preview('workspace','main');
 if(change==='session')f.sessions.set('main',{sessionId:'run-new'});
 if(change==='owner')f.client.automationRuns.set('page','run-2');
 if(change==='workspace')f.client.automationWorkspaces.set('page','other');
 if(change==='url')slot.page.url=()=> 'https://other.test';
 if(change==='closed')slot.page.isClosed=()=>true;
 if(change==='connection')f.browsers.clients.set('workspace',{client:f.client});
 finish({data:'private'});const result=await request;assert.equal(result.state,'waiting');assert.equal(result.image,undefined);
});

test('concurrent refreshes share a capture and a failed capture can recover',async()=>{
 const f=fixture(),slot=f.add('page');let finish,count=0;
 slot.cdp.send=()=>{count++;return new Promise(resolve=>{finish=resolve;});};
 const first=f.preview('workspace','main'),second=f.preview('workspace','main');assert.equal(count,1);assert.equal(first,second);
 finish({data:'image'});assert.equal((await first).state,'ready');
 slot.cdp.send=async()=>{throw Error('Target closed');};assert.equal((await f.preview('workspace','main')).state,'waiting');
 slot.cdp.send=async()=>({data:'recovered'});assert.equal((await f.preview('workspace','main')).state,'ready');
});

test('a timed-out CDP capture cannot accumulate requests on later refreshes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture(),slot=f.add('page');let finish,count=0;
 slot.cdp.send=()=>{count++;return new Promise(resolve=>{finish=resolve;});};
 const first=f.preview('workspace','main');assert.equal(count,1);
 t.mock.timers.tick(4000);assert.equal((await first).state,'waiting');
 // Refreshing for minutes must not enqueue more screenshots or waiters on
 // the unresolved Chrome request, including when another worker takes over.
 for(let i=0;i<200;i++)assert.equal((await f.preview('workspace','main')).state,'waiting');
 f.client.automationRuns.set('page','run-2');assert.equal((await f.preview('workspace','worker-2')).state,'waiting');
 assert.equal(count,1);
 finish({data:'late-frame'});await Promise.resolve();await Promise.resolve();
 slot.cdp.send=async()=>{count++;return {data:'fresh-frame'};};
 const fresh=await f.preview('workspace','worker-2');assert.equal(fresh.state,'ready');assert.equal(count,2);assert.ok(fresh.image.endsWith('fresh-frame'));
});
