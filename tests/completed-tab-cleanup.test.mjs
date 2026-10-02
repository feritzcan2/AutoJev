import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BrowserTools} from '../app/browser.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

const hash=url=>createHash('sha256').update(url).digest('hex');

function jevFixture(){
  const browser=new JevBrowser('/unused',{connection:'test'}),closed=[],reported=[];
  browser.opening=Promise.resolve({});browser.homeId='home';browser.persistTabs=async()=>{};
  browser.onTabsClosed=async ids=>reported.push(...ids);
  const add=(id,{run='finished',workspace='workspace',draft=false,changed=false,pending=false}={})=>{
    const original=`https://example.test/${id}`,url=()=>changed?original+'/changed':original;
    let isClosed=false;
    browser.tabs.set(id,{id,page:{url,isClosed:()=>isClosed,frames:()=>[{locator:()=>({evaluate:async()=>!draft})}],close:async()=>{isClosed=true;closed.push(id);}}});
    browser.automationRuns.set(id,run);browser.automationWorkspaces.set(id,workspace);browser.urlHashes.set(id,hash(original));
    return {pending};
  };
  return {browser,closed,reported,add};
}

test('completed source scan closes only its known disposable tabs',async()=>{
  const f=jevFixture();f.add('home');f.add('results');f.add('detail');f.add('draft',{draft:true});f.add('changed',{changed:true});f.add('question');f.add('other-run',{run:'other'});f.add('other-workspace',{workspace:'other'});
  const result=await f.browser.closeFinishedAutomationRunTabs('finished','workspace',{sourceScan:true,pendingTabIds:['question']});
  assert.deepEqual(result.closed,['results','detail']);
  assert.deepEqual(result.retained,['draft','changed','question']);
  assert.deepEqual(f.reported,['results','detail']);
  for(const id of ['home','draft','changed','question','other-run','other-workspace'])assert.ok(f.browser.tabs.has(id),id);
});

test('verified record completion closes its exact form tab, preserving other tasks',async()=>{
  const f=jevFixture();f.add('home');f.add('confirmation',{draft:true});f.add('other-run',{run:'other'});
  assert.deepEqual(await f.browser.closeFinishedAutomationRunTabs('finished','workspace'),{closed:['confirmation'],retained:[]});
  assert.deepEqual(f.closed,['confirmation']);assert.ok(f.browser.tabs.has('other-run'));
});

test('access reset closes retained source tabs including solved challenges, preserving personal, record and newer-run tabs',async()=>{
 const f=jevFixture(),source='https://source.test/';
 for(const id of ['home','challenge','form','changed','previous','personal','record','other-source','new-run','other-workspace']){
  f.add(id,{draft:id==='form',changed:id==='changed',run:id==='previous'?'previous':id==='new-run'?'new':'finished',workspace:id==='other-workspace'?'elsewhere':'workspace'});
  if(id!=='personal')f.browser.automationSources.set(id,id==='other-source'?'https://another.test/':source);
  f.browser.automationTabs.set(id,id==='record'?'record:known-record':'source:'+source);
 }
 f.browser.tabs.get('challenge').verification={state:'required'};
 const result=await f.browser.closeFinishedAutomationRunTabs('finished','workspace',{resetSource:source,sourceRunIds:['finished','previous']});
 assert.deepEqual(result.closed,['challenge','form','changed','previous']);assert.deepEqual(result.retained,[]);
 for(const id of ['home','personal','record','other-source','new-run','other-workspace'])assert.ok(f.browser.tabs.has(id),id);
});

test('source reset retries failed tab closes without falsely reporting cleanup complete',async()=>{
 const f=jevFixture(),source='https://source.test/';f.add('challenge');f.browser.automationSources.set('challenge',source);
 const slot=f.browser.tabs.get('challenge'),close=slot.page.close;slot.page.close=async()=>{throw Error('Disconnected');};
 const options={resetSource:source,sourceRunIds:['finished']};
 assert.deepEqual(await f.browser.closeFinishedAutomationRunTabs('finished','workspace',options),{closed:[],retained:['challenge']});
 slot.page.close=close;assert.deepEqual(await f.browser.closeFinishedAutomationRunTabs('finished','workspace',options),{closed:['challenge'],retained:[]});
});

test('separate browser closes only the tab observed for the completed run',async()=>{
  const browser=new BrowserTools('/unused',()=> 'separate'),calls=[];
  let current='https://example.test/done',index=0;
  const client={callTool:async({name,arguments:args})=>{calls.push([name,args]);return {content:[{type:'text',text:name==='browser_tabs'&&args.action==='list'?`### Result\n- ${index}: (current) [Done](${current})\n- 2: [Other](https://example.test/other)`:'### Result\nNo open tabs.'}]};}};
  const connected={client,tools:[{name:'browser_tabs'},{name:'browser_navigate'}],directory:'/unused',workspace:'/unused'};
  browser.clients.set('workspace',{mode:'separate',pending:Promise.resolve(connected)});
  browser.connect=async()=>connected;
  const run={id:'run',workerId:'main',resumeContext:{url:'https://example.test/done'}};
  await browser.call('workspace','browser_navigate',{url:current},run.id);
  assert.deepEqual(await browser.finishAutomationRun('workspace',run,{closeTabs:true}),{closed:[0],retained:[]});
  assert.deepEqual(calls.at(-1),['browser_tabs',{action:'close',index:0}]);
  await browser.call('workspace','browser_navigate',{url:current},run.id);
  index=1;calls.length=0;
  assert.deepEqual(await browser.finishAutomationRun('workspace',run,{closeTabs:true}),{closed:[],retained:[0]});
  assert.equal(calls.length,1);
  index=0;await browser.call('workspace','browser_navigate',{url:current},run.id);
  current='https://example.test/changed';calls.length=0;
  assert.deepEqual(await browser.finishAutomationRun('workspace',run,{closeTabs:true}),{closed:[],retained:[0]});
  assert.equal(calls.length,1);
});

test('separate browser closes every visited tab for a completed run',async()=>{
  const browser=new BrowserTools('/unused',()=> 'separate'),calls=[],urls=new Map([[0,'https://example.test/first'],[1,'https://example.test/second']]);
  let selected=0;
  const client={callTool:async({name,arguments:args})=>{
    calls.push([name,args]);
    if(name==='browser_tabs'&&args.action==='list')return {content:[{type:'text',text:'### Result\n'+[...urls].map(([index,url])=>`- ${index}: ${index===selected?'(current) ':''}[Page](${url})`).join('\n')}]};
    if(name==='browser_tabs'&&args.action==='close')urls.delete(args.index);
    return {content:[{type:'text',text:'### Result'}]};
  }};
  const connected={client,tools:[{name:'browser_tabs'},{name:'browser_navigate'}],directory:'/unused',workspace:'/unused'};
  browser.clients.set('workspace',{mode:'separate',pending:Promise.resolve(connected)});browser.connect=async()=>connected;
  await browser.call('workspace','browser_navigate',{url:urls.get(0)},'run');
  selected=1;await browser.call('workspace','browser_navigate',{url:urls.get(1)},'run');
  assert.deepEqual(await browser.finishAutomationRun('workspace',{id:'run',workerId:'main',resumeContext:{url:urls.get(1)}},{closeTabs:true}),{closed:[1,0],retained:[]});
  assert.deepEqual(calls.filter(([name,args])=>name==='browser_tabs'&&args.action==='close').map(([,args])=>args.index),[1,0]);
});
