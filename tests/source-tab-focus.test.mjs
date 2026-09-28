import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserTools} from '../app/browser.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

function fixture(){
 const profile={directory:'Default'},browser=new BrowserTools('/unused',()=> 'jev',()=>({profile}));
 const client=new JevBrowser('/unused',{profile}),focused=[];
 client.browser={isConnected:()=>true};client.homeId='home';
 browser.clients.set('candidate',{mode:'jev',pending:Promise.resolve({client})});
 browser.connect=async()=>assert.fail('Source tab controls must not connect to Chrome');
 const add=(id,task='search-task')=>{
  const slot={id,page:{url:()=>`https://example.test/${id}`,isClosed:()=>false,bringToFront:async()=>focused.push(id)}};
  client.tabs.set(id,slot);client.tabSearches.set(id,task);return slot;
 };
 const task={id:'search-task',kind:'search',sourceId:'source'},source={id:'source'};
 return {profile,browser,client,focused,add,task,source};
}

test('source control finds the live task tab without a manually saved checkpoint',async()=>{
 const f=fixture();f.add('home');f.add('draft');f.client.tabJobs.set('draft','job');f.add('other-search','other-task');f.add('search');
 const tabs=await f.browser.sourceTabs('candidate',[f.source,{id:'other-source'}],f.task);
 assert.deepEqual(tabs,{source:{browser:'Jev Chrome',tabId:'search',url:'https://example.test/search'}});
 assert.deepEqual(await f.browser.focusSource('candidate',f.source,f.task),{focused:true});
 assert.deepEqual(f.focused,['search']);
 assert.deepEqual(await f.browser.sourceTabs('other-candidate',[f.source],f.task),{});
});

test('source checkpoint prefers its open tab and disappears after closure',async()=>{
 const f=fixture(),saved=f.add('saved');f.add('listing');
 f.source.resumeContext={browser:'Jev Chrome',tabId:'saved'};
 assert.equal((await f.browser.sourceTabs('candidate',[f.source],f.task)).source.tabId,'saved');
 saved.page.isClosed=()=>true;
 assert.equal((await f.browser.sourceTabs('candidate',[f.source],f.task)).source.tabId,'listing');
 f.client.tabs.get('listing').page.isClosed=()=>true;
 assert.deepEqual(await f.browser.sourceTabs('candidate',[f.source],f.task),{});
 await assert.rejects(()=>f.browser.focusSource('candidate',f.source,f.task),{code:'TAB_MISSING'});
 assert.deepEqual(f.focused,[]);
});

test('disconnected or changed Chrome profile never gets a source tab control',async()=>{
 const f=fixture();f.add('search');f.client.browser.isConnected=()=>false;
 assert.deepEqual(await f.browser.sourceTabs('candidate',[f.source],f.task),{});
 f.client.browser.isConnected=()=>true;f.client.profile={directory:'Other'};
 assert.deepEqual(await f.browser.sourceTabs('candidate',[f.source],f.task),{});
});
