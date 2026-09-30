import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserTools} from '../app/browser.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {groupWorkspaceTabs} from '../src/workspace-tabs.js';

function fixture(kind='web'){
 const profile={directory:'Default'},browser=new BrowserTools('/unused',()=> 'jev',()=>({profile,...(kind==='jobs'?{lifecycle:{jobs:[]},checkpoints:[{browser:'Jev Chrome',tabId:'saved'}]}:{lifecycle:{multiWorker:true}})}));
 const client=new JevBrowser('/unused',{profile}),focused=[],closedTabs=[];
 client.browser={isConnected:()=>true};client.homeId='home';
 browser.clients.set('workspace',{mode:'jev',pending:Promise.resolve({client})});
 browser.connect=async()=>assert.fail('Listing or focusing must not start Chrome');
 const add=(id)=>{let closed=false;client.tabs.set(id,{id,page:{url:()=>`https://example.test/${id}`,isClosed:()=>closed,bringToFront:async()=>focused.push(id),close:async()=>{closed=true;closedTabs.push(id);}}});return()=>{closed=true;};};
 return {browser,client,focused,closedTabs,add,profile};
}

test('Sources shows only live tabs owned by the web workspace and focuses an exact tab',async()=>{
 const f=fixture(),close=f.add('web');f.add('foreign');f.add('home');
 f.client.automationWorkspaces.set('web','workspace');f.client.automationWorkspaces.set('foreign','another-workspace');
 f.client.automationSources.set('web','https://example.test/search');
 assert.deepEqual((await f.browser.workspaceTabs('workspace')).map(tab=>tab.tabId),['web']);
 assert.equal((await f.browser.workspaceTabs('workspace'))[0].sourceUrl,'https://example.test/search');
 assert.deepEqual(await f.browser.focusWorkspaceTab('workspace','web'),{focused:true});assert.deepEqual(f.focused,['web']);
 await assert.rejects(f.browser.focusWorkspaceTab('workspace','foreign'),{code:'TAB_MISSING'});
 close();assert.deepEqual(await f.browser.workspaceTabs('workspace'),[]);
 await assert.rejects(f.browser.focusWorkspaceTab('workspace','web'),{code:'TAB_MISSING'});
});

test('Sources recovers live workspace tabs opened before workspace labels existed',async()=>{
 const f=fixture();for(const id of ['home','legacy','personal','other-workspace'])f.add(id);
 f.client.transport={owned:new Set(['home','legacy','other-workspace'])};
 f.client.automationWorkspaces.set('other-workspace','another-workspace');
 assert.deepEqual((await f.browser.workspaceTabs('workspace')).map(tab=>tab.tabId),['legacy']);
 assert.deepEqual(await f.browser.focusWorkspaceTab('workspace','legacy'),{focused:true});
 assert.deepEqual(f.focused,['legacy']);
});

test('bulk close only closes the listed live workspace tabs',async()=>{
 const f=fixture();for(const id of ['home','first','second','foreign'])f.add(id);
 f.client.automationWorkspaces.set('first','workspace');f.client.automationWorkspaces.set('second','workspace');f.client.automationWorkspaces.set('foreign','another-workspace');
 const tabs=await f.browser.workspaceTabs('workspace');
 await assert.rejects(f.browser.closeWorkspaceTabs('workspace',[{tabId:'foreign',url:'https://example.test/foreign'}]),{code:'TAB_CHANGED'});
 await assert.rejects(f.browser.closeWorkspaceTabs('workspace',[{tabId:'first',url:'https://example.test/changed'}]),{code:'TAB_CHANGED'});
 assert.deepEqual(f.closedTabs,[]);
 assert.deepEqual(await f.browser.closeWorkspaceTabs('workspace',tabs.map(({tabId,url,sourceUrl})=>({tabId,url,sourceUrl}))),{closed:['first','second'],failed:[]});
 assert.deepEqual(f.closedTabs,['first','second']);
 assert.deepEqual(await f.browser.workspaceTabs('workspace'),[]);
});

test('Sources includes open job, search and saved tabs but excludes unrelated Chrome tabs',async()=>{
 const f=fixture('jobs');for(const id of ['home','job','search','saved','personal'])f.add(id);
 f.client.tabJobs.set('job','job-id');f.client.tabSearches.set('search','task-id');
 const tabs=await f.browser.workspaceTabs('workspace');
 assert.deepEqual(tabs.map(tab=>[tab.tabId,tab.kind]),[['job','application'],['search','search'],['saved','workspace']]);
 assert.equal(tabs[0].jobId,'job-id');assert.equal(tabs[1].searchTaskId,'task-id');
 f.client.profile={directory:'Other'};assert.deepEqual(await f.browser.workspaceTabs('workspace'),[]);
});

test('web browser calls mark their workspace for live tab ownership',async()=>{
 const calls=[],browser={prepare:()=>({ready:true}),async call(id,name,args,session,options){calls.push({id,name,options});return {content:[{type:'text',text:JSON.stringify({tabId:'tab',url:'https://example.test/page'})}]};}};
 const adapter=automationBrowser(browser,{mode:'jev',sourceUrl:'https://example.test/list'});
 await adapter.call('workspace','browser_navigate',{url:'https://example.test/page'},'run');
 await adapter.call('workspace','browser_snapshot',{},'run');
 assert.deepEqual(calls.map(call=>call.options.automationWorkspaceId),['workspace','workspace','workspace']);
 assert.deepEqual(calls.map(call=>call.options.automationSourceUrl),['https://example.test/list','https://example.test/list','https://example.test/list']);
});

test('source menus count legacy tabs by unique host and new cross-site tabs by saved source',()=>{
 const sources=[{id:'klein',url:'https://www.kleinanzeigen.de/s-wohnung-mieten/berlin/'},{id:'immo',url:'https://www.immobilienscout24.de/Suche/'}];
 const tabs=[...Array.from({length:5},(_,index)=>({tabId:String(index),url:`https://www.kleinanzeigen.de/s-anzeige/${index}`})),{tabId:'immo',url:'https://www.immobilienscout24.de/expose/1'},{tabId:'redirect',url:'https://auth.example.com/login',sourceUrl:sources[1].url},{tabId:'personal',url:'https://unknown.example.com/'}];
 const {grouped,other}=groupWorkspaceTabs(tabs,sources);
 assert.equal(grouped.get('klein').length,5);assert.equal(grouped.get('immo').length,2);assert.deepEqual(other.map(tab=>tab.tabId),['personal']);
});

test('a shared host without a source assignment stays in the other tabs menu',()=>{
 const sources=[{id:'a',url:'https://example.com/search/a'},{id:'b',url:'https://example.com/search/b'}],tab={tabId:'old',url:'https://example.com/detail/1'};
 const {grouped,other}=groupWorkspaceTabs([tab],sources);
 assert.equal(grouped.get('a').length,0);assert.equal(grouped.get('b').length,0);assert.deepEqual(other,[tab]);
});
