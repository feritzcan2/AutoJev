import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {JevBrowser} from '../app/jev-browser.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {RESEARCH_TAB_LIMIT} from '../app/jev-tab-lifecycle.mjs';
import {JevCdpTransport} from '../app/jev-cdp.mjs';

function fixture(){
  const browser=new JevBrowser('/unused',{connection:'test'}),closed=[];
  browser.opening=Promise.resolve({});browser.context=async()=>({});browser.homeId='home';
  const add=(id,task='task',options={})=>{
    let isClosed=false,url=`https://example.test/${id}`,fail=options.fail;
    const slot={id,openerId:options.openerId??'home',page:{
      url:()=>url,isClosed:()=>isClosed,
      frames:()=>[{locator:()=>({evaluate:async()=>{if(options.unreadable)throw Error('Frame unavailable');return !options.draft;}})}],
      close:async()=>{if(fail){fail=false;throw Error('Temporary Chrome failure');}isClosed=true;closed.push(id);},
    }};
    browser.tabs.set(id,slot);if(task)browser.tabSearches.set(id,task);
    browser.urlHashes.set(id,createHash('sha256').update(url).digest('hex'));
    return {slot,navigate:value=>{url=value;}};
  };
  return {browser,add,closed};
}

test('core retries cleanup after a busy browser and a transient close failure',async()=>{
  const {browser,add,closed}=fixture();add('finished','finished-task',{fail:true});
  browser.busy=true;
  assert.equal((await browser.cleanupSearch('finished-task')).deferred,true);
  assert.ok(browser.cleanupTasks.has('finished-task'));
  browser.busy=false;
  const first=await browser.cleanupCompleted({activeSearchTaskIds:[]});
  assert.deepEqual(first.retained,['finished']);assert.ok(browser.cleanupTasks.has('finished-task'));
  assert.deepEqual((await browser.cleanupCompleted({activeSearchTaskIds:[]})).closed,['finished']);
  assert.deepEqual(closed,['finished']);assert.equal(browser.cleanupTasks.size,0);
});

test('core collects legacy research but preserves paused work, source checkpoints, drafts and verification',async()=>{
  const {browser,add,closed}=fixture();
  add('old','retired');add('paused','paused-task');add('other-worker','worker-task');
  add('source','retired');add('draft','retired',{draft:true});add('unknown-frame','retired',{unreadable:true});
  add('application','retired');add('child','retired',{openerId:'application'});
  add('verification','retired').slot.verification={handoff:true};
  add('personal',null);
  add('user-navigation','retired').navigate('https://personal.example/');
  await browser.cleanupCompleted({activeSearchTaskIds:['paused-task','worker-task'],sourceTabIds:['source'],jobs:[{id:'job',status:'uncertain',resumeContext:{browser:'Jev Chrome',tabId:'application'}}]});
  assert.deepEqual(closed,['old']);
  for(const id of ['paused','other-worker','source','draft','unknown-frame','application','child','verification','personal','user-navigation'])assert.ok(browser.tabs.has(id),id);
});

test('a completed source checkpoint is released, but another worker actively using it wins',async()=>{
  const {browser,add}=fixture();add('source','finished');
  const state={activeSearchTaskIds:['new-task'],completedSearchTaskIds:['finished'],sourceTabIds:['source'],activeSourceTabIds:['source']};
  assert.deepEqual((await browser.cleanupCompleted(state)).closed,[]);
  assert.ok(browser.cleanupTasks.has('finished'));
  assert.deepEqual((await browser.cleanupCompleted({...state,activeSourceTabIds:[]})).closed,['source']);
});

test('research stays bounded across many opens, preserving other workers and drafts',async()=>{
  const {browser,add}=fixture();
  add('draft','task',{draft:true});add('other-worker','other');
  const state={activeSearchTaskId:'task',activeSearchTaskIds:['task','other']};
  for(let i=0;i<RESEARCH_TAB_LIMIT*4;i++){
    await browser.reserveResearchTab(state);add(`listing-${i}`);
    assert.ok(browser.tabs.size<=RESEARCH_TAB_LIMIT);
  }
  assert.ok(browser.tabs.has('draft'));assert.ok(browser.tabs.has('other-worker'));
});

test('the limit refuses to destroy protected tabs when none can be recycled',async()=>{
  const {browser,add,closed}=fixture();
  for(let i=0;i<RESEARCH_TAB_LIMIT;i++)add(`draft-${i}`,'task',{draft:true});
  await assert.rejects(browser.reserveResearchTab({activeSearchTaskId:'task',activeSearchTaskIds:['task']}),{code:'RESEARCH_TAB_LIMIT'});
  assert.deepEqual(closed,[]);
});

test('a large protected backlog does not starve later disposable research tabs',async()=>{
  const {browser,add,closed}=fixture();
  for(let i=0;i<RESEARCH_TAB_LIMIT;i++)add(`draft-${i}`,'retired',{draft:true});
  add('collect-after-drafts','retired');
  const state={activeSearchTaskIds:[]};
  await browser.cleanupCompleted(state);assert.deepEqual(closed,[]);
  await browser.cleanupCompleted(state);assert.deepEqual(closed,['collect-after-drafts']);
  assert.equal(browser.tabs.size,RESEARCH_TAB_LIMIT);
});

test('a repeated research open reuses the same task tab without opening a page',async()=>{
  const {browser,add}=fixture();const {slot}=add('listing');
  browser.observe=async()=>({tabId:slot.id,url:slot.page.url(),text:'Listing'});
  const result=await browser.callTool({name:'browser_jev_open',arguments:{url:slot.page.url()}},'session',{taskKind:'search',activeSearchTaskId:'task',activeSearchTaskIds:['task']});
  const page=JSON.parse(result.content[0].text);
  assert.equal(page.tabId,'listing');assert.equal(page.reused,true);assert.equal(browser.tabs.size,1);
});

test('maintenance retries independently of the ended worker and clears source checkpoints',async()=>{
  const {browser,add}=fixture();add('finished','old',{fail:true});
  let state={activeSearchTaskIds:[],completedSearchTaskIds:['old']};
  const tools=new BrowserTools('/unused',()=>({lifecycle:state})),cleared=[];
  tools.clients.set('candidate',{mode:'jev',client:browser,pending:Promise.resolve({client:browser})});
  tools.onTabsClosed=(id,tabs)=>cleared.push([id,tabs]);
  browser.onTabsClosed=tabs=>tools.onTabsClosed('candidate',tabs);
  const worker=tools.forWorker('removed-worker',()=>false);
  const failed=await worker.cleanupSearch('candidate','old');assert.deepEqual(failed.retained,['finished']);
  state={activeSearchTaskIds:[]};
  assert.deepEqual((await tools.maintain('candidate')).closed,['finished']);
  assert.deepEqual(cleared,[['candidate',['finished']]]);
});

test('maintenance does not connect, accumulate behind operations, or cross a profile switch',async()=>{
  const tools=new BrowserTools('/unused',()=>({profile:{directory:'new'}}));
  tools.open=async()=>assert.fail('Must not create a connection');
  assert.equal((await tools.maintain('candidate')).deferred,true);
  const {browser}=fixture();browser.profile={directory:'old'};
  browser.cleanupCompleted=async()=>assert.fail('Wrong profile');
  tools.clients.set('candidate',{mode:'jev',client:browser,pending:Promise.resolve({client:browser})});
  tools.operations.set('candidate',new Promise(()=>{}));
  assert.equal((await tools.maintain('candidate')).deferred,true);
  tools.operations.delete('candidate');
  assert.equal((await tools.maintain('candidate')).deferred,true);
  assert.equal(tools.operations.size,0);
});

test('destroyed CDP targets retire ownership, attachments and per-tab metadata',()=>{
  const {browser,add}=fixture();add('dead','old');add('parent',null).slot.openedFrames=new Map([['https://example.test/frame','dead']]);
  browser.tabJobs.set('dead','job');browser.cleanupTasks.add('old');
  const transport=new JevCdpTransport({});browser.transport=transport;
  transport.owned.add('dead');transport.attached.add('dead');
  transport.onTargetDestroyed=id=>browser.forgetTab(id);
  const forwarded=[];transport.onmessage=message=>forwarded.push(message);
  transport.receive({method:'Target.targetDestroyed',params:{targetId:'dead'}});
  assert.equal(transport.owned.size,0);assert.equal(transport.attached.size,0);
  for(const map of [browser.tabs,browser.tabJobs,browser.tabSearches,browser.urlHashes])assert.equal(map.has('dead'),false);
  assert.equal(browser.cleanupTasks.size,0);assert.equal(browser.tabs.get('parent').openedFrames.size,0);
  assert.equal(forwarded.length,1);
});
