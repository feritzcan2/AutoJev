import test from 'node:test';
import assert from 'node:assert/strict';
import {JevBrowser} from '../app/jev-browser.mjs';

function fixture(){
 const browser=new JevBrowser('/unused',{connection:'test'}),closed=[],reported=[];
 const state={automationWorkspaceId:'workspace',automationSourceUrl:'https://source.test/',automationTabKey:'source:https://source.test/'};
 let created=0;
 const context={newPage:async()=>{
  const id='tab-'+(++created);let url='about:blank',isClosed=false;
  return {id,url:()=>url,isClosed:()=>isClosed,context:()=>context,
   goto:async value=>{url=value;throw Error('net::ERR_HTTP2_PROTOCOL_ERROR');},
   commitError:()=>{url='chrome-error://chromewebdata/';},navigateByUser:value=>{url=value;},
   close:async()=>{isClosed=true;closed.push(id);}};
 }};
 browser.context=async()=>context;browser.reconcileJobs=async()=>{};browser.persistTabs=async()=>{};
 browser.onTabsClosed=async ids=>reported.push(...ids);
 browser.track=async(_context,page)=>{const slot={id:page.id,page};browser.tabs.set(slot.id,slot);return slot;};
 const open=async({owner='run',scope=state,fresh=true,url='https://source.test/listing'}={})=>{
  const response=await browser.callTool({name:'browser_jev_open',arguments:{url}},owner,{...scope,automationFreshTab:fresh});
  const result=JSON.parse(response.content[0].text);assert.match(result.navigationError,/ERR_HTTP2_PROTOCOL_ERROR/);
  return browser.tabs.get(result.tabId);
 };
 return {browser,state,open,closed,reported,get created(){return created;}};
}

test('hundreds of fresh detail retries retain only one failed tab, including late error commits',async()=>{
 const f=fixture();
 for(let i=0;i<200;i++){
  const slot=await f.open({url:`https://${i%2?'another':'source'}.test/listing?id=${i}`});
  // Chrome can commit its internal error document after goto has rejected.
  slot.page.commitError();
  assert.equal(f.browser.tabs.size,1);
 }
 assert.equal(f.closed.length,199);assert.deepEqual(f.reported,f.closed);
 assert.equal(f.browser.automationRuns.size,1);assert.equal(f.browser.automationSources.size,1);
 const current=[...f.browser.tabs.values()][0],created=f.created;
 assert.equal((await f.open({fresh:false})).id,current.id,'Ordinary navigation reuses the existing failed tab');
 assert.equal(f.created,created);
});

test('failed read cleanup preserves other owners, sources, records, challenges and user navigation',async()=>{
 const f=fixture();
 const otherRun=await f.open({owner:'other-run'});otherRun.page.commitError();
 const otherSource=await f.open({scope:{...f.state,automationSourceUrl:'https://other.test/',automationTabKey:'source:https://other.test/'}});otherSource.page.commitError();
 const otherWorkspace=await f.open({scope:{...f.state,automationWorkspaceId:'other-workspace'}});otherWorkspace.page.commitError();
 const changed=await f.open();changed.page.commitError();changed.page.navigateByUser('https://source.test/application-form');
 const record=await f.open();record.page.commitError();f.browser.automationTabs.set(record.id,'record:application');
 const job=await f.open();job.page.commitError();f.browser.tabJobs.set(job.id,'application');
 const challenge=await f.open();challenge.page.commitError();challenge.verification={state:'required'};
 const failed=await f.open();failed.page.commitError();
 await f.open();
 assert.deepEqual(f.closed,[failed.id]);
 for(const slot of [otherRun,otherSource,otherWorkspace,changed,record,job,challenge])assert.ok(f.browser.tabs.has(slot.id));
});

test('a failed tab close prevents allocating further retry tabs',async()=>{
 const f=fixture(),failed=await f.open();failed.page.commitError();
 failed.page.close=async()=>{throw Error('Disconnected');};
 const created=f.created;
 await assert.rejects(f.open(),/yeni kontrol sekmesi açılmadı/);
 assert.equal(f.created,created);assert.equal(f.browser.tabs.size,1);
});
