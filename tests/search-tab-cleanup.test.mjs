import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {JevBrowser} from '../app/jev-browser.mjs';
import {Store} from '../app/store.mjs';
import {startMcp} from '../app/mcp.mjs';

test('restored tab lists identify search tasks and application drafts for resumption',async()=>{
 const browser=new JevBrowser('/unused',{connection:'test'});
 browser.context=async()=>({});browser.reconcileJobs=async()=>{};browser.homeId='home';
 for(const id of ['home','search','listing','draft','other-search','unclassified'])browser.tabs.set(id,{id,page:{url:()=>`https://example.test/${id}`}});
 for(const id of ['search','listing','draft'])browser.tabSearches.set(id,'current-task');
 browser.tabSearches.set('other-search','other-task');browser.tabJobs.set('draft','application');
 const result=JSON.parse((await browser.callTool({name:'browser_jev_tabs',arguments:{}},'new-session',{taskKind:'search'})).content[0].text);
 assert.deepEqual(result.tabs.filter(t=>t.searchTaskId==='current-task'&&!t.jobId).map(t=>t.tabId),['search','listing']);
 assert.equal(result.tabs.find(t=>t.tabId==='draft').jobId,'application');
 assert.equal(result.tabs.some(t=>t.tabId==='home'),false);
 assert.deepEqual(result.tabs.find(t=>t.tabId==='unclassified'),{tabId:'unclassified',url:'https://example.test/unclassified'});
});

test('search cleanup closes only finished task tabs and preserves drafts, unrelated and changed tabs',async()=>{
 const browser=new JevBrowser('/unused',{connection:'test'}),closed=[];
 browser.opening=Promise.resolve({});browser.context=async()=>({});browser.persistTabs=async()=>{};
 browser.homeId='home';
 const add=(id,task,{openerId='home',changed=false}={})=>{
  const url=`https://example.test/${id}`;
  browser.tabs.set(id,{id,openerId,page:{url:()=>changed?url+'/changed':url,isClosed:()=>false,frames:()=>[{locator:()=>({evaluate:async()=>true})}],close:async()=>closed.push(id)}});
  if(task)browser.tabSearches.set(id,task);
  browser.urlHashes.set(id,createHash('sha256').update(url).digest('hex'));
 };
 add('home');add('search','task');add('listing','task');add('popup','task',{openerId:'listing'});
 add('draft','task');add('draft-popup','task',{openerId:'draft'});
 add('other-search','other-task');add('unclassified');add('changed','task',{changed:true});
 const state={jobs:[{id:'job',status:'blocked',resumeContext:{browser:'Jev Chrome',tabId:'draft'}}],sourceTabIds:['search']};
 const result=await browser.cleanupSearch('task',state);
 assert.deepEqual(closed.sort(),['listing','popup','search']);
 assert.deepEqual(result.closed.sort(),closed);
 for(const id of ['home','draft','draft-popup','other-search','unclassified','changed'])assert.ok(browser.tabs.has(id),id);
 assert.equal(browser.tabSearches.has('search'),false);
 assert.deepEqual((await browser.cleanupSearch('task',state)).closed,[]);
});

test('successful completed search and rank reports clean tabs and clear closed source checkpoints',async()=>{
 const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Remote'});
 const source=store.sources(p.id)[0],calls=[];
 const task={id:'search-task',kind:'search',sourceId:source.id};
 store.saveCampaign(p.id,{status:'running',task});
 store.saveSourceCheckpoint(p.id,source.id,{browser:'Jev Chrome',tabId:'search-tab',url:'https://example.test/search'});
 let reject=false;
 const campaigns={get:id=>store.campaign(id),report:()=>{if(reject)throw Error('Invalid report');return {...store.campaign(p.id),task:{...store.campaign(p.id).task,report:{outcome:'done'}}};}};
 const browser={cleanupSearch:async(id,taskId)=>{calls.push([id,taskId]);return {closed:['search-tab'],retained:['draft']};}};
 const mcp=await startMcp(store,()=>{},undefined,browser,campaigns),token=mcp.grant(p.id,'session');
 const call=async outcome=>(await(await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'report_campaign_work',arguments:{taskId:task.id,outcome,note:'Search result'}}})})).json()).result;
 try{
  await call('blocked');assert.equal(calls.length,0);assert.ok(store.source(p.id,source.id).resumeContext);
  reject=true;assert.equal((await call('done')).isError,true);assert.equal(calls.length,0);
  reject=false;const completed=await call('done');assert.notEqual(completed.isError,true);assert.equal(JSON.parse(completed.content[0].text).completion.taskReported,true);
  assert.deepEqual(calls,[[p.id,task.id]]);assert.equal(store.source(p.id,source.id).resumeContext,null);
  store.saveCampaign(p.id,{status:'running',task:{...task,kind:'rank'}});
  await call('done');assert.equal(calls.length,2);assert.deepEqual(calls[1],[p.id,task.id]);
 }finally{await mcp.close();store.close();}
});
