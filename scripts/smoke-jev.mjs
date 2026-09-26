// Real Chrome + real Jobloop MCP. --live uses TypeSafe; otherwise only its decision is mocked.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../app/store.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {startMcp} from '../app/mcp.mjs';
import {startJevFixture,JEV_DEMO_GOAL} from './jev-demo.mjs';
const live=process.argv.includes('--live'),directory=await mkdtemp(path.join(os.tmpdir(),'jev-mcp-'));
const fixture=await startJevFixture(),store=new Store(':memory:');
const candidate=store.saveProfile({name:'Synthetic test',preferences:'Remote Python',browserMode:'jev'});
const other=store.saveProfile({name:'Other candidate',preferences:'Remote',browserMode:'jev'});
const browsers=new BrowserTools(directory,id=>store.profile(id).browserMode,()=>({connection:'separate'}));
const server=await startMcp(store,()=>{},undefined,browsers),token=server.grant(candidate.id,'agent-a'),otherToken=server.grant(other.id,'agent-b'),resumed=server.grant(candidate.id,'agent-resumed');
const call=async(name,args={},bearer=token,allowError=false)=>{
  const response=await fetch(server.endpoint,{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  const rpc=await response.json();assert.equal(response.status,200);const result=rpc.result;assert.ok(result,JSON.stringify(rpc));
  if(allowError)return result;
  assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text);
};
function mockDecision(page){
  let action=page.actions.find(a=>a.kind==='fill'&&a.label==='Keywords'&&a.value!=='Python');
  action??=page.actions.find(a=>a.kind==='select'&&a.label==='Location → Remote');
  action??=page.actions.find(a=>a.kind==='select'&&a.label==='Seniority → Senior');
  if(!action&&!page.text.includes('2 jobs · Filters applied'))action=page.actions.find(a=>a.kind==='click'&&a.label==='Search jobs');
  return {operation:action?{fill:'TYPE_TEXT',select:'SELECT',click:'CLICK'}[action.kind]:'DONE',action:action??null,confidence:1,latency_ms:0};
}
try{
  const {client}=await browsers.connect(candidate.id);client.headless=true;if(!live)client.choose=mockDecision;
  (await browsers.connect(other.id)).client.headless=true;
  let page=await call('browser_jev_open',{url:fixture.url});assert.ok(page.tabId);
  assert.equal((await call('browser_jev_observe',{tabId:page.tabId},otherToken,true)).isError,true);
  for(let i=0;i<12;i++){
    const next=await call('browser_jev_next',{tabId:page.tabId,goal:JEV_DEMO_GOAL});console.log(next.operation,next.action?.label??'');
    assert.equal((await call('browser_jev_act',{tabId:page.tabId,decisionId:next.decisionId},resumed,true)).isError,true);
    if(next.needsText)assert.equal((await call('browser_jev_act',{tabId:page.tabId,decisionId:next.decisionId},token,true)).isError,true);
    page=await call('browser_jev_act',{tabId:page.tabId,decisionId:next.decisionId,...(next.needsText?{text:'Python'}:{})});
    assert.equal((await call('browser_jev_act',{tabId:page.tabId,decisionId:next.decisionId},token,true)).isError,true);
    if(next.operation==='DONE')break;
    assert.notEqual(next.operation,'BLOCKED');assert.equal(page.executed,true);
  }
  const slot=client.tab(page.tabId),actual=await slot.page.evaluate(()=>({query:document.querySelector('#query').value,location:document.querySelector('#location').value,seniority:document.querySelector('#seniority').value,summary:document.querySelector('#summary').textContent,jobs:[...document.querySelectorAll('[data-job]:not([hidden])')].map(e=>e.dataset.job)}));
  assert.deepEqual(actual,{query:'Python',location:'remote',seniority:'senior',summary:'2 jobs · Filters applied',jobs:['atlas','northstar']});
  assert.equal((await call('browser_jev_observe',{tabId:page.tabId},resumed)).tabId,page.tabId);
  console.log(live?'JEV_LIVE_MCP_AND_AGENT_TEXT_PASS':'JEV_MCP_AND_AGENT_TEXT_PASS');
  // Target replacement, occlusion and uncertain input must not lead to blind retries.
  client.choose=page=>({operation:'TYPE_TEXT',action:page.actions.find(a=>a.kind==='fill'),confidence:1});
  let next=await call('browser_jev_next',{tabId:page.tabId,goal:'Change the query'});
  await slot.page.evaluate(()=>{document.querySelector('#query').value='changed by user';});
  let result=await call('browser_jev_act',{tabId:page.tabId,decisionId:next.decisionId,text:'Python'});assert.equal(result.status,'stale');assert.equal(result.executed,false);
  next=await call('browser_jev_next',{tabId:page.tabId,goal:'Change the query'});
  await slot.page.evaluate(()=>{const e=document.createElement('div');e.id='cover';e.style='position:fixed;inset:0;z-index:999;background:white';document.body.append(e);});
  result=await call('browser_jev_act',{tabId:page.tabId,decisionId:next.decisionId,text:'Python'});assert.equal(result.status,'stale');assert.equal(result.executed,false);
  await slot.page.evaluate(()=>document.querySelector('#cover').remove());
  next=await call('browser_jev_next',{tabId:page.tabId,goal:'Change the query'});
  const send=slot.cdp.send.bind(slot.cdp);slot.cdp.send=async(method,args)=>{if(method==='Input.insertText')throw Error('Synthetic interrupted input');return send(method,args);};
  result=await call('browser_jev_act',{tabId:page.tabId,decisionId:next.decisionId,text:'Python'});assert.equal(result.status,'uncertain');assert.equal(result.executed,'unknown');slot.cdp.send=send;
  await slot.page.evaluate(()=>{const label=document.createElement('label');label.textContent='CV';const input=document.createElement('input');input.type='file';label.append(input);document.body.append(label);});
  const file=path.join(directory,'candidates',candidate.id,'CV.txt');await writeFile(file,'Synthetic CV');
  const observed=await call('browser_jev_observe',{tabId:page.tabId});assert.equal(observed.uploads.length,1);
  const outside=path.join(directory,'outside.txt');await writeFile(outside,'Other candidate');
  assert.equal((await call('browser_jev_upload',{tabId:page.tabId,uploadId:observed.uploads[0].uploadId,filePath:outside},token,true)).isError,true);
  result=await call('browser_jev_upload',{tabId:page.tabId,uploadId:observed.uploads[0].uploadId,filePath:file});assert.equal(result.executed,true);
  assert.equal(await slot.page.locator('input[type=file]').evaluate(e=>e.files[0].name),'CV.txt');
  console.log('JEV_STALE_OCCLUSION_UNCERTAIN_UPLOAD_SCOPE_PASS');
}finally{await browsers.close();await server.close();store.close();await fixture.close();await rm(directory,{recursive:true,force:true});}
