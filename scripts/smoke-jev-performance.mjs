// Real isolated Chrome, synthetic modal, no external site mutation or API key.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';
const remember=controlState();
const directory=await mkdtemp(path.join(os.tmpdir(),'jev-performance-'));
let modelCalls=0;
const client=new JevBrowser(directory,{connection:'separate',headless:true,config:async()=>({}),choose:async(page,goal)=>{
  modelCalls++;const action=page.actions.find(a=>goal==='scroll'?a.kind==='scroll'&&a.delta>0:a.kind==='click'&&a.label===goal);
  assert.ok(action,goal);return {operation:action.kind==='scroll'?'SCROLL_DOWN':'CLICK',action,confidence:1};
}});
let wireBytes=0;
const call=async(name,args,owner='test')=>{
  const text=(await client.callTool({name,arguments:args},owner)).content[0].text;
  wireBytes=Buffer.byteLength(text);return remember(JSON.parse(text));
};
try{
  const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
  const options=Array.from({length:230},(_,i)=>`<option value="c${i}">Country ${i}</option>`).join('');
  const fixture=`<style>body{height:4000px;margin:0} [role=dialog]{position:fixed;top:30px;left:30px;width:420px;background:white;border:1px solid;padding:10px} #pane{height:240px;overflow:auto}label{display:block}input,select{display:block} .space{height:450px}</style>
    <button>Background action</button><div role="dialog" aria-modal="true"><form id="pane" aria-label="Application form" onsubmit="event.preventDefault();window.submits++">
    <label>Name<input id="first"></label><div class="space"></div>
    <label>Email<input id="email" type="email" required></label><label>Country<select id="country"><option value="">Choose</option>${options}<option value="DE">Germany</option></select></label>
    <div class="space"></div><button type="button" id="inertButton" onclick="window.clicks++">No effect</button><button>Submit application</button></form></div>`;
  const reset=async()=>{await page.setContent(fixture);await page.evaluate(()=>{window.submits=0;window.clicks=0;});return call('browser_jev_observe',{tabId});};
  let observed=await reset();
  assert.equal(observed.controls.find(c=>c.label==='Email').visible,false);
  assert.equal(observed.elements.some(e=>e.label==='Email'||e.label==='Background action'),false);
  assert.deepEqual(observed.scrollTargets.map(s=>s.label),['Application form']);
  const initialBytes=Buffer.byteLength(JSON.stringify(observed)),start=Date.now();
  // One reveal, one fill, one exact selection: no Jev/model round trips.
  observed=await call('browser_jev_reveal',{tabId,controlId:observed.controls.find(c=>c.label==='Email').controlId});
  assert.equal(observed.visible,true);assert.equal(await page.evaluate(()=>scrollY),0);
  const email=observed.fillFields.find(f=>f.label==='Email');assert.ok(email);
  observed=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:email.fieldId,text:'test@example.com'}]});
  assert.equal(observed.status,'ready');
  observed=await call('browser_jev_select_option',{tabId,controlId:observed.controls.find(c=>c.label==='Country').controlId,option:'Germany'});
  assert.equal(observed.selection.verified,true);assert.equal(observed.selection.actual,'DE');
  assert.equal(await page.locator('#email').inputValue(),'test@example.com');assert.equal(modelCalls,0);
  assert.equal(await page.evaluate(()=>window.submits),0);assert.equal(await page.evaluate(()=>scrollY),0);
  assert.equal(observed.observationMode,'delta');assert.equal(observed.text,undefined);
  assert.ok(!JSON.stringify(observed).includes('Country 229'));assert.ok(wireBytes<7000);
  console.log('JEV_MODAL_THREE_CALLS_NO_MODEL_PASS',JSON.stringify({operationCalls:3,modelCalls,elapsedMs:Date.now()-start,initialBytes,resultBytes:wireBytes}));
  // Correct container is also used by the compatibility next/act flow.
  observed=await reset();let decision=await call('browser_jev_next',{tabId,goal:'scroll'});
  assert.equal(decision.elements,undefined);
  let result=await call('browser_jev_act',{tabId,decisionId:decision.decisionId});
  assert.equal(result.progress,true);assert.ok(await page.locator('#pane').evaluate(e=>e.scrollTop)>0);assert.equal(await page.evaluate(()=>scrollY),0);
  // No-progress guard survives fresh observations and reworded goals.
  await page.locator('#pane').evaluate(e=>e.scrollTop=e.scrollHeight);
  observed=await call('browser_jev_observe',{tabId});
  result=await call('browser_jev_scroll',{tabId,controlId:observed.scrollTargets[0].controlId,direction:'down'});
  assert.equal(result.status,'no_progress');
  result=await call('browser_jev_scroll',{tabId,controlId:result.scrollTargets[0].controlId,direction:'down'});
  assert.equal(result.status,'no_progress');assert.equal(result.executed,false);
  // A non-changing click can focus the button once, then one failed action is
  // enough to lock identical repeats; it never becomes an automatic loop.
  await page.locator('#inertButton').focus();
  decision=await call('browser_jev_next',{tabId,goal:'No effect'});
  result=await call('browser_jev_act',{tabId,decisionId:decision.decisionId});assert.equal(result.status,'uncertain');assert.equal(result.retryBlocked,true);
  decision=await call('browser_jev_next',{tabId,goal:'No effect'});
  assert.equal(decision.status,'no_progress');assert.equal(decision.decisionId,undefined);assert.equal(await page.evaluate(()=>window.clicks),1);
  // IDs are session scoped, and semantic target/option changes reject stale work.
  observed=await reset();let country=observed.controls.find(c=>c.label==='Country').controlId;
  await assert.rejects(()=>call('browser_jev_select_option',{tabId,controlId:country,option:'Germany'},'other'),/oturuma/);
  result=await call('browser_jev_select_option',{tabId,controlId:'guessed',option:'Germany'});assert.equal(result.status,'stale');assert.equal(result.executed,false);assert.ok(result.controls.length);
  country=result.controls.find(c=>c.label==='Country').controlId;
  await page.locator('#country').evaluate(e=>e.replaceWith(e.cloneNode(true)));
  result=await call('browser_jev_select_option',{tabId,controlId:country,option:'Germany'});assert.equal(result.status,'stale');assert.equal(await page.locator('#country').inputValue(),'');
  observed=await call('browser_jev_observe',{tabId});country=observed.controls.find(c=>c.label==='Country').controlId;
  result=await call('browser_jev_select_option',{tabId,controlId:country,option:'Germ'});assert.equal(result.status,'needs_selection');assert.equal(result.executed,false);assert.equal(result.reason,'no_match');assert.match(result.message,/browser_jev_list_options/);
  country=result.controls.find(c=>c.label==='Country').controlId;
  await page.locator('#country').evaluate(e=>e.insertAdjacentHTML('beforeend','<option value="other">Germany</option>'));
  observed=await call('browser_jev_observe',{tabId});country=observed.controls.find(c=>c.label==='Country').controlId;
  result=await call('browser_jev_select_option',{tabId,controlId:country,option:'Germany'});assert.equal(result.status,'needs_selection');assert.equal(result.reason,'ambiguous');assert.equal(result.executed,false);
  // An overlay cannot be bypassed by the direct selection tool.
  observed=await reset();country=observed.controls.find(c=>c.label==='Country').controlId;
  await page.evaluate(()=>{const cover=document.createElement('div');cover.style='position:fixed;inset:0;z-index:999';document.body.append(cover);});
  result=await call('browser_jev_select_option',{tabId,controlId:country,option:'Germany'});assert.equal(result.status,'stale');assert.equal(await page.locator('#country').inputValue(),'');
  // Removing a modal never redirects its old scroll ID to the background page.
  observed=await reset();const modalScroll=observed.scrollTargets[0].controlId;
  await page.locator('[role=dialog]').evaluate(e=>e.remove());
  result=await call('browser_jev_scroll',{tabId,controlId:modalScroll,direction:'down'});
  assert.equal(result.status,'stale');assert.equal(await page.evaluate(()=>scrollY),0);
  // The same tools also work on an ordinary page, without dialog-specific code.
  observed=await call('browser_jev_observe',{tabId});
  assert.equal(observed.scrollTargets[0].label,'Page');
  result=await call('browser_jev_scroll',{tabId,controlId:observed.scrollTargets[0].controlId,direction:'down'});
  assert.equal(result.progress,true);assert.ok(await page.evaluate(()=>scrollY)>0);
  await page.evaluate(()=>scrollTo(0,0));
  // A site's change handler can reject selection: don't report false success.
  observed=await reset();country=observed.controls.find(c=>c.label==='Country').controlId;
  await page.locator('#country').evaluate(e=>e.addEventListener('change',()=>{e.value='';}));
  result=await call('browser_jev_select_option',{tabId,controlId:country,option:'Germany'});
  assert.equal(result.status,'uncertain');assert.equal(result.selection.verified,false);
  result=await call('browser_jev_select_option',{tabId,controlId:result.controls.find(c=>c.label==='Country').controlId,option:'Germany'});
  assert.equal(result.status,'no_progress');assert.equal(result.executed,false);
  console.log('JEV_MODAL_SCOPE_STALE_OPTION_AND_NO_PROGRESS_GUARDS_PASS');
}finally{await client.close();await rm(directory,{recursive:true,force:true});}
