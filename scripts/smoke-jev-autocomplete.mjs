// Real isolated Chrome, same role-less DOM structure observed on Lever plus ARIA.
// No live form mutations, submission or model/API requests.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-autocomplete-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('Model must not be called');}});
const call=async(name,args,owner='test')=>JSON.parse((await client.callTool({name,arguments:args},owner)).content[0].text);
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 const label='Berlin, Berlin, Stadt, Berlin, DEU';
 const reset=async({aria=false,duplicate=false,reject=false,delay=250}={})=>{
  await page.setContent(`<style>.dropdown-results{cursor:pointer}.dropdown-location{padding:8px}input{display:block} .dropdown-container{display:none}</style>
   <form onsubmit="event.preventDefault();window.submits++"><label>Current location<div class="application-field">
   <input id="location" name="location" required ${aria?'role="combobox" aria-controls="options" aria-autocomplete="list"':''}>
   <input type="hidden" id="selected-location" value="">
   <div class="dropdown-container" id="options" ${aria?'role="listbox"':''}><div class="dropdown-results"></div>
   <div style="display:none">No location found. Loading</div></div></div></label>
   <button>Submit</button></form><button id="unrelated">${label}</button>`);
  await page.evaluate(({aria,duplicate,reject,delay,label})=>{
   window.submits=0;window.selections=0;window.unrelated=0;
   document.querySelector('#unrelated').onclick=()=>window.unrelated++;
   const input=document.querySelector('#location'),list=document.querySelector('#options'),results=list.firstElementChild;
   input.addEventListener('input',()=>{
    list.style.display='none';results.replaceChildren();
    setTimeout(()=>{
     for(const text of ['Berlin, DEU',label,...(duplicate?[label]:[])]){
      const option=document.createElement('div');option.className='dropdown-location';option.textContent=text;if(aria)option.setAttribute('role','option');
      option.onclick=()=>{window.selections++;if(!reject){input.value=text;list.style.display='none';document.querySelector('#selected-location').value='accepted';}};
      results.append(option);
     }
     list.style.display='block';
    },delay);
   });
  },{aria,duplicate,reject,delay,label});
  return call('browser_jev_observe',{tabId});
 };
 let observed=await reset(),control=observed.controls.find(c=>c.label==='Current location');
 assert.equal(control.autocomplete,true);assert.equal(observed.fillFields.length,0);
 const start=Date.now();let result=await call('browser_jev_autocomplete',{tabId,controlId:control.controlId,text:'Berlin',option:label});
 assert.equal(result.status,'ready');assert.equal(result.selection.verified,true);assert.equal(result.selection.actual,label);
 assert.equal(await page.locator('#selected-location').inputValue(),'accepted');
 assert.equal(await page.evaluate(()=>window.submits+window.unrelated),0);
 assert.equal(result.observationMode,'delta');
 console.log('JEV_AUTOCOMPLETE_ONE_CALL_PASS',JSON.stringify({elapsedMs:Date.now()-start,modelCalls:0,operationCalls:1}));
 // Exact matches only; show options without inventing a city or clicking elsewhere.
 observed=await reset({aria:true});control=observed.controls[0];
 result=await call('browser_jev_autocomplete',{tabId,controlId:control.controlId,text:'Berlin',option:'Berlin, Germany'});
 assert.equal(result.status,'needs_selection');assert.ok(result.suggestions.includes(label));assert.equal(await page.evaluate(()=>window.selections+window.unrelated),0);
 // The compatibility action space now includes the actual plain/ARIA options.
 assert.ok(result.elements.some(e=>e.label===label&&e.role==='option'));
 const current=result.controls[0];
 result=await call('browser_jev_autocomplete',{tabId,controlId:current.controlId,text:'Berlin',option:'Berlin, Germany'});
 assert.equal(result.status,'no_progress');assert.equal(result.executed,false);
 result=await call('browser_jev_autocomplete',{tabId,controlId:result.controls[0].controlId,option:label});assert.equal(result.selection.verified,true);
 // A stale ID returns replacement controls directly, without a second observe.
 result=await call('browser_jev_reveal',{tabId,controlId:'previous-process-id'});
 assert.equal(result.status,'stale');assert.equal(result.executed,false);assert.ok(result.controls[0].controlId);
 result=await call('browser_jev_autocomplete',{tabId,controlId:'previous-process-id',option:label});assert.equal(result.status,'stale');assert.ok(result.controls[0].controlId);
 await assert.rejects(()=>call('browser_jev_autocomplete',{tabId,controlId:result.controls[0].controlId,option:label},'other'),/oturuma/);
 // Duplicate labels, covered controls, swapped inputs and rejected clicks never report success.
 observed=await reset({duplicate:true});
 result=await call('browser_jev_autocomplete',{tabId,controlId:observed.controls[0].controlId,text:'Berlin',option:label});
 assert.equal(result.status,'ambiguous');assert.equal(await page.evaluate(()=>window.selections),0);
 observed=await reset();await page.locator('#location').evaluate(e=>e.replaceWith(e.cloneNode(true)));
 result=await call('browser_jev_autocomplete',{tabId,controlId:observed.controls[0].controlId,text:'Berlin',option:label});assert.equal(result.status,'stale');
 observed=await reset();await page.evaluate(()=>{const e=document.createElement('div');e.style='position:fixed;inset:0;z-index:99';document.body.append(e);});
 result=await call('browser_jev_autocomplete',{tabId,controlId:observed.controls[0].controlId,text:'Berlin',option:label});assert.equal(result.status,'stale');assert.equal(await page.locator('#location').inputValue(),'');
 observed=await reset({reject:true});
 result=await call('browser_jev_autocomplete',{tabId,controlId:observed.controls[0].controlId,text:'Berlin',option:label});
 assert.equal(result.status,'uncertain');assert.equal(result.selection.verified,false);assert.equal(await page.evaluate(()=>window.selections),1);
 result=await call('browser_jev_autocomplete',{tabId,controlId:result.controls[0].controlId,text:'Berlin',option:label});assert.equal(result.status,'no_progress');assert.equal(await page.evaluate(()=>window.selections),1);
 // Plain div options must also be surfaced as real click targets, excluding hidden errors.
 observed=await reset();await page.locator('#location').fill('Berlin');await page.locator('.dropdown-location').first().waitFor();
  result=await call('browser_jev_observe',{tabId});assert.ok(result.elements.some(e=>e.label===label&&e.role==='option'));
  assert.equal(result.controls[0].label,'Current location');assert.ok(!result.controls[0].label.includes('Loading'));
  client.choose=async snapshot=>({operation:'CLICK',action:snapshot.actions.find(a=>a.role==='option'&&a.label===label),confidence:1});
  const decision=await call('browser_jev_next',{tabId,goal:'Select the exact city'});
  assert.equal(decision.action.role,'option');
  result=await call('browser_jev_act',{tabId,decisionId:decision.decisionId});
  assert.equal(result.status,'ready');assert.equal(await page.locator('#selected-location').inputValue(),'accepted');
  assert.equal(await page.evaluate(()=>window.submits+window.unrelated),0);
  // A submit button masquerading as an ARIA option is not a selectable result.
  observed=await reset({aria:true});await page.locator('#location').fill('Berlin');await page.locator('.dropdown-location').first().waitFor();
  await page.locator('.dropdown-results').evaluate(e=>{e.innerHTML='<button role="option">Berlin</button>';});
  observed=await call('browser_jev_observe',{tabId});
  result=await call('browser_jev_autocomplete',{tabId,controlId:observed.controls[0].controlId,option:'Berlin'});
  assert.notEqual(result.status,'ready');assert.equal(await page.evaluate(()=>window.submits),0);
 // No association: a nearby unrelated button is never promoted to a suggestion.
 await page.setContent('<label>City<input id="city"></label><button>Berlin</button>');
 observed=await call('browser_jev_observe',{tabId});assert.equal(observed.controls[0].autocomplete,undefined);
 result=await call('browser_jev_autocomplete',{tabId,controlId:observed.controls[0].controlId,text:'Berlin',option:'Berlin'});assert.equal(result.status,'unsupported');assert.equal(await page.locator('#city').inputValue(),'');
 console.log('JEV_AUTOCOMPLETE_SCOPE_EXACT_MATCH_STALE_AND_RETRY_GUARDS_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
