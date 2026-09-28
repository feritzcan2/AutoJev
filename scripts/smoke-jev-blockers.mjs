import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-blockers-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({})});
const remember=controlState();
const call=async(name,args,state={})=>remember(JSON.parse((await client.callTool({name,arguments:args},'test',state)).content[0].text));
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await page.setContent('<div id="host"></div>');
 await page.evaluate(()=>{
  const root=document.querySelector('#host').attachShadow({mode:'open'});
  root.innerHTML='<label>City<input role="combobox" aria-controls="cities" aria-expanded="false"></label><div id="cities" role="listbox" hidden><div role="option">Berlin, State of Berlin, Germany</div></div><label><input id="consent" type="checkbox" style="opacity:0;position:absolute;width:1px;height:1px">Privacy Policy</label><fieldset><legend>Sponsorship?</legend><label><input type="radio" name="visa" style="display:none">No</label></fieldset>';
  const input=root.querySelector('input'),list=root.querySelector('#cities');
  input.onfocus=()=>{list.hidden=false;input.setAttribute('aria-expanded','true');};
  list.firstChild.onclick=()=>{input.value=list.firstChild.textContent;list.hidden=true;input.setAttribute('aria-expanded','false');};
 });
 let o=await call('browser_jev_observe',{tabId,full:true});
 const city=o.controls.find(c=>c.role==='combobox');assert.ok(city);
 let options=await call('browser_jev_list_suggestions',{tabId,controlId:city.controlId,text:'Berlin'});
 assert.ok(options.suggestions.includes('Berlin, State of Berlin, Germany'));
 const selected=await call('browser_jev_autocomplete',{tabId,controlId:options.controls.find(c=>c.role==='combobox').controlId,text:'Berlin',option:'Berlin, State of Berlin, Germany'});
 assert.equal(selected.selection.verified,true);
 o=await call('browser_jev_observe',{tabId,full:true});
 const checkbox=o.controls.find(c=>c.role==='checkbox');assert.ok(checkbox?.choice);
 const checked=await call('browser_jev_select_choice',{tabId,controlId:checkbox.controlId});assert.equal(checked.selection.verified,true);
 o=await call('browser_jev_observe',{tabId,full:true});
 const radio=o.controls.find(c=>c.role==='radio');assert.ok(radio?.choice?.question);
 const chosen=await call('browser_jev_select_choice',{tabId,controlId:radio.controlId});assert.equal(chosen.selection.verified,true);
 // SmartRecruiters buttons project light-DOM labels into shadow slots.
 // Their label is the actual hit target, not an unrelated overlay.
 await page.setContent('<div id="buttons"></div>');
 await page.evaluate(()=>{
  window.buttonClicks=[];
  for(const [label,offscreen] of [['Cancel',false],['Next',true],['Fallback',false]]){
   const host=document.createElement('fixture-button');
   if(offscreen){const spacer=document.createElement('div');spacer.style.height='1000px';document.querySelector('#buttons').append(spacer);}
   if(label!=='Fallback')host.innerHTML='<span>'+label+'</span>';
   const root=host.attachShadow({mode:'open'});
   root.innerHTML='<style>button{padding:12px}::slotted(span){display:inline-block;padding:8px}</style><button type="button"><div><slot name="prefix"></slot><slot>Fallback</slot><slot name="suffix"></slot></div></button>';
   root.querySelector('button').onclick=()=>window.buttonClicks.push(label);
   document.querySelector('#buttons').append(host);
  }
 });
 o=await call('browser_jev_observe',{tabId,full:true});
 assert.ok(o.controls.find(c=>c.label==='Next'));
 assert.ok(o.controls.find(c=>c.label==='Fallback'));
 let target=o.clickTargets.find(c=>c.label==='Cancel');assert.ok(target);
 let clicked=await call('browser_jev_click',{tabId,targetId:target.targetId});
 assert.deepEqual(await page.evaluate(()=>window.buttonClicks),['Cancel']);
 const next=clicked.controls.find(c=>c.label==='Next');assert.ok(next);
 o=await call('browser_jev_reveal',{tabId,controlId:next.controlId});
 target=o.clickTargets.find(c=>c.label==='Next');assert.ok(target);
 await call('browser_jev_click',{tabId,targetId:target.targetId});
 assert.deepEqual(await page.evaluate(()=>window.buttonClicks),['Cancel','Next']);
 // A real overlay still blocks clicks; slot support must not bypass it.
 await page.evaluate(()=>{const overlay=document.createElement('div');overlay.style='position:fixed;inset:0;z-index:999;background:white';document.body.append(overlay);});
 o=await call('browser_jev_observe',{tabId,full:true});
 assert.ok(!o.clickTargets.some(c=>['Cancel','Next','Fallback'].includes(c.label)));
 assert.deepEqual(await page.evaluate(()=>window.buttonClicks),['Cancel','Next']);
 console.log('SLOTTED_BUTTON_LABEL_CLICK_REVEAL_OVERLAY_PASS');
 // McKinsey/Avature keeps a closed cookie dialog shell in the DOM.
 await page.setContent('<label>Username<input required></label><button type="button">Without Resume</button><div role="dialog" aria-modal="true" id="cookie-shell"><div style="position:fixed;opacity:0;pointer-events:none"><button>Accept cookies</button><label>Hidden preference<input></label></div></div>');
 o=await call('browser_jev_observe',{tabId,full:true});
 assert.ok(o.clickTargets.some(t=>t.label==='Without Resume'));
 assert.ok(!o.clickTargets.some(t=>t.label==='Accept cookies'));
 let inspected=await call('browser_jev_inspect_form',{tabId});
 assert.ok(inspected.fields.some(f=>f.label==='Username'));
 assert.ok(!inspected.fields.some(f=>f.label==='Hidden preference'));
 // A zero-height shell with a visible positioned panel IS an active modal.
 await page.evaluate(()=>{
  const panel=document.querySelector('#cookie-shell > div');
  panel.style='position:fixed;inset:30px;background:white;z-index:999';
 });
 o=await call('browser_jev_observe',{tabId,full:true});
 assert.ok(o.clickTargets.some(t=>t.label==='Accept cookies'));
 assert.ok(!o.controls.some(t=>t.label==='Without Resume'));
 inspected=await call('browser_jev_inspect_form',{tabId});
 assert.ok(inspected.fields.some(f=>f.label==='Hidden preference'));
 assert.ok(!inspected.fields.some(f=>f.label==='Username'));
 console.log('CLOSED_COOKIE_SHELL_IGNORED_ACTIVE_MODAL_RESPECTED_PASS');
 // Final sends must not reach the browser before the durable checkpoint.
 await page.setContent('<button type="button" onclick="window.sends++">Submit application</button><button type="button" onclick="window.nexts++">Next</button>');
 await page.evaluate(()=>{window.sends=0;window.nexts=0;});
 const sendState=status=>({activeJobId:'send-job',jobs:[{id:'send-job',status}]});
 o=await call('browser_jev_observe',{tabId,full:true});
 for(const status of ['working','prepared','uncertain']){
  const send=o.clickTargets.find(t=>t.label==='Submit application');
  o=await call('browser_jev_click',{tabId,targetId:send.targetId},sendState(status));
  assert.equal(o.status,'submission_not_started');assert.equal(o.executed,false);
  assert.equal(await page.evaluate(()=>window.sends),0);
 }
 o=await call('browser_jev_click',{tabId,targetId:o.clickTargets.find(t=>t.label==='Next').targetId},sendState('working'));
 assert.equal(await page.evaluate(()=>window.nexts),1);
 await call('browser_jev_click',{tabId,targetId:o.clickTargets.find(t=>t.label==='Submit application').targetId},sendState('submitting'));
 assert.equal(await page.evaluate(()=>window.sends),1);
 await page.setContent('<button role="tab" onclick="window.opened=true">Apply</button>');
 await page.evaluate(()=>window.opened=false);
 o=await call('browser_jev_observe',{tabId,full:true});
 await call('browser_jev_click',{tabId,targetId:o.clickTargets.find(t=>t.label==='Apply').targetId},sendState('working'));
 assert.equal(await page.evaluate(()=>window.opened),true);
 await page.setContent('<form><label>Name<input></label><button onclick="window.sent=true">Apply</button></form>');
 await page.evaluate(()=>window.sent=false);
 o=await call('browser_jev_observe',{tabId,full:true});
 o=await call('browser_jev_click',{tabId,targetId:o.clickTargets.find(t=>t.label==='Apply').targetId},sendState('working'));
 assert.equal(o.status,'submission_not_started');assert.equal(o.retryable,false);
 assert.equal(await page.evaluate(()=>window.sent),false);
 // Listing-entry Apply buttons work without pretending the form is prepared.
 await page.setContent('<button type="button" onclick="window.entered=true">Apply</button><div hidden><label>CV<input type="file"></label></div>');
 await page.evaluate(()=>window.entered=false);
 o=await call('browser_jev_observe',{tabId,full:true});assert.equal(o.uploads.length,0);
 await call('browser_jev_click',{tabId,targetId:o.clickTargets.find(t=>t.label==='Apply').targetId},sendState('working'));
 assert.equal(await page.evaluate(()=>window.entered),true);
 // Hidden native upload remains supported behind an explicit visible label.
 await page.setContent('<label for="cv">Upload CV</label><input id="cv" type="file" style="display:none"><section hidden><label for="inactive">Other CV</label><input id="inactive" type="file"></section>');
 o=await call('browser_jev_observe',{tabId,full:true});assert.equal(o.uploads.length,1);assert.equal(o.uploads[0].label,'Upload CV');
 const previousUpload=o.uploads[0].uploadId;
 o=await call('browser_jev_observe',{tabId});assert.equal(o.uploads[0].uploadId,previousUpload);
 // Repeating a rejected dropdown ID is bounded and never dispatches a click.
 o=await call('browser_jev_list_suggestions',{tabId,controlId:'expired-control'});
 assert.equal(o.status,'stale');assert.equal(o.rejectedControlId,'expired-control');
 o=await call('browser_jev_list_suggestions',{tabId,controlId:'expired-control'});
 assert.equal(o.status,'no_progress');assert.equal(o.executed,false);assert.ok(Array.isArray(o.availableTargets));
 console.log('SUBMIT_CHECKPOINT_BEFORE_CLICK_PASS');
 await context.route('https://embedded.test/**',route=>route.fulfill({contentType:'text/html',body:'<label>Email<input type="email"></label>'}));
 await page.setContent('<iframe style="width:600px;height:300px" src="https://embedded.test/form"></iframe><iframe style="width:600px;height:300px" src="https://embedded.test/captcha"></iframe><iframe sandbox style="width:600px;height:300px" src="https://embedded.test/sandbox"></iframe>');
 await page.frames()[1].waitForLoadState();
 o=await call('browser_jev_observe',{tabId,full:true});assert.equal(o.embeddedForms.length,1);
 const frame=o.embeddedForms[0];const child=await call('browser_jev_open_frame',{tabId,frameId:frame.frameId});
 assert.equal(child.url,'https://embedded.test/form');assert.equal(child.parentTabId,tabId);assert.equal(page.isClosed(),false);assert.ok(child.fillFields.some(f=>f.type==='email'));
 const reused=await call('browser_jev_open_frame',{tabId,frameId:frame.frameId});assert.equal(reused.tabId,child.tabId);assert.equal(reused.reused,true);
 client.tabJobs.set(tabId,'uncertain-job');
 await assert.rejects(()=>call('browser_jev_open_frame',{tabId,frameId:frame.frameId},{activeJobId:'uncertain-job',jobs:[{id:'uncertain-job',status:'uncertain'}]}));
 console.log('BLOCKERS_SMOKE_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
