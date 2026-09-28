// Isolated Chrome fixtures matching the observed segmented-button markup.
// No live application mutations or model/API calls.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';
const remember=controlState();
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-choice-'));
let modelCalls=0;
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({}),choose:async snapshot=>{
  modelCalls++;
  const action=snapshot.actions.find(a=>a.choice?.question==='Work authorization?'&&a.choice.option==='No');
  assert.ok(action);return {operation:'CLICK',action,confidence:1};
}});
const call=async(name,args,owner='test')=>remember(JSON.parse((await client.callTool({name,arguments:args},owner)).content[0].text));
try{
  const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
  const group=(id,question)=>`<div id="${id}"><label for="${id}-missing">${question}</label><div><button aria-pressed="false" data-option="yes">Yes</button><button aria-pressed="false" data-option="no">No</button><input type="checkbox" name="${id}" style="display:none"></div></div>`;
  const reset=async({reject=false,delay=0}={})=>{
    await page.setContent(`<style>button{padding:12px}label{display:block}#spacer{height:900px}</style>${group('work','Work authorization?')}<div id="spacer"></div>${group('city','Live here?')}${group('remote','Remote experience?')}<form onsubmit="event.preventDefault();window.submits++"><button>Submit</button></form>`);
    await page.evaluate(({reject,delay})=>{
      window.clicks=0;window.submits=0;
      for(const button of document.querySelectorAll('[aria-pressed]'))button.onclick=()=>{
        window.clicks++;
        if(!reject)setTimeout(()=>{for(const b of button.parentElement.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b===button));},delay);
      };
    },{reject,delay});
    return call('browser_jev_observe',{tabId});
  };
  const answer=(o,q,v)=>o.controls.find(c=>c.choice?.question===q&&c.choice.option===v);
  let observed=await reset(),control=answer(observed,'Live here?','No');
  assert.equal(control.visible,false);assert.equal(control.choice.selected,false);
  assert.ok(observed.elements.some(e=>e.label==='Work authorization? → No'&&e.pressed==='false'&&e.choice.question==='Work authorization?'));
  const start=Date.now();
  let result=await call('browser_jev_select_choice',{tabId,controlId:control.controlId});
  assert.equal(result.status,'ready');assert.equal(result.selection.verified,true);assert.equal(result.selection.option,'No');
  assert.equal(await page.locator('#city [data-option=no]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#work [data-option=no]').getAttribute('aria-pressed'),'false');
  assert.equal(answer(result,'Live here?','No').choice.selected,true);
  assert.equal(modelCalls,0);assert.equal(await page.evaluate(()=>window.submits),0);
  console.log('JEV_CHOICE_ONE_CALL_PASS',JSON.stringify({elapsedMs:Date.now()-start,modelCalls,operationCalls:1}));
  result=await call('browser_jev_select_choice',{tabId,controlId:answer(result,'Live here?','No').controlId});
  assert.equal(result.executed,false);assert.equal(result.selection.verified,true);assert.equal(await page.evaluate(()=>window.clicks),1);
  // Owner, semantic label and DOM identity must remain the observed ones.
  observed=await reset();control=answer(observed,'Work authorization?','No');
  await assert.rejects(()=>call('browser_jev_select_choice',{tabId,controlId:control.controlId},'other'),/oturuma/);
  await page.locator('#work label').evaluate(e=>e.textContent='Different consent?');
  result=await call('browser_jev_select_choice',{tabId,controlId:control.controlId});assert.equal(result.status,'stale');assert.equal(await page.evaluate(()=>window.clicks),0);
  observed=await reset();control=answer(observed,'Work authorization?','No');
  await page.locator('#work [data-option=no]').evaluate(e=>e.replaceWith(e.cloneNode(true)));
  result=await call('browser_jev_select_choice',{tabId,controlId:control.controlId});assert.equal(result.status,'stale');
  // No hit-test bypass, even with a valid semantic ID.
  observed=await reset();control=answer(observed,'Work authorization?','No');
  await page.evaluate(()=>{const e=document.createElement('div');e.style='position:fixed;inset:0;z-index:999';document.body.append(e);});
  result=await call('browser_jev_select_choice',{tabId,controlId:control.controlId});assert.equal(result.status,'blocked');assert.equal(result.reason,'no_safe_click_point');assert.equal(result.observationMode,'full');assert.ok(result.controls.length);assert.equal(await page.evaluate(()=>window.clicks),0);
  // Focus changes are not proof; failed choices cannot be retried via either tool.
  observed=await reset({reject:true});control=answer(observed,'Work authorization?','No');
  result=await call('browser_jev_select_choice',{tabId,controlId:control.controlId});
  assert.equal(result.status,'uncertain');assert.equal(result.selection.verified,false);
  result=await call('browser_jev_select_choice',{tabId,controlId:answer(result,'Work authorization?','No').controlId});assert.equal(result.status,'no_progress');
  let decision=await call('browser_jev_next',{tabId,goal:'Select the No answer'});assert.equal(decision.operation,'BLOCKED');assert.equal(await page.evaluate(()=>window.clicks),1);
  // The compatibility next/act flow returns the same question and verified state.
  observed=await reset({delay:250});
  decision=await call('browser_jev_next',{tabId,goal:'Select No for work authorization'});
  assert.equal(decision.action.choice.question,'Work authorization?');assert.equal(decision.action.pressed,'false');
  result=await call('browser_jev_act',{tabId,decisionId:decision.decisionId});assert.equal(result.controlState.verified,true);assert.equal(result.controlState.actual,true);
  observed=await reset({reject:true});decision=await call('browser_jev_next',{tabId,goal:'Select No'});
  result=await call('browser_jev_act',{tabId,decisionId:decision.decisionId});assert.equal(result.status,'uncertain');assert.equal(result.controlState.verified,false);assert.equal(result.retryBlocked,true);
  result=await call('browser_jev_select_choice',{tabId,controlId:answer(result,'Work authorization?','No').controlId});assert.equal(result.status,'no_progress');assert.equal(await page.evaluate(()=>window.clicks),1);
  // Selected state changing externally invalidates a pending Jev decision.
  observed=await reset();decision=await call('browser_jev_next',{tabId,goal:'Select No'});
  await page.locator('#work [data-option=no]').evaluate(e=>e.setAttribute('aria-pressed','true'));
  result=await call('browser_jev_act',{tabId,decisionId:decision.decisionId});assert.equal(result.status,'stale');assert.equal(await page.evaluate(()=>window.clicks),0);
  // Other sites: fieldset native radios and labelled ARIA radiogroups.
  await page.setContent('<fieldset><legend>Schedule?</legend><label><input type="radio" name="schedule">Full time</label><label><input type="radio" name="schedule">Part time</label></fieldset><div role="radiogroup" aria-label="Travel?"><button type="button" role="radio" aria-checked="false" onclick="this.setAttribute(\'aria-checked\',\'true\')">No</button></div>');
  observed=await call('browser_jev_observe',{tabId});
  result=await call('browser_jev_select_choice',{tabId,controlId:answer(observed,'Schedule?','Full time').controlId});assert.equal(result.selection.verified,true);
  result=await call('browser_jev_select_choice',{tabId,controlId:answer(result,'Travel?','No').controlId});assert.equal(result.selection.verified,true);
  // No whole-form label guessing, mixed state guessing or disguised submission.
  await page.setContent('<form onsubmit="event.preventDefault();window.submits++"><label>Unrelated<input></label><button aria-pressed="false">Yes</button><fieldset><legend>Consent?</legend><button aria-pressed="false">Accept</button><button type="button" aria-pressed="mixed">Mixed</button><input type="submit" role="radio" aria-checked="false" value="Disguised submit"><a href="#navigate"><span role="radio" aria-checked="false">Disguised link</span></a></fieldset></form>');
  await page.evaluate(()=>window.submits=0);observed=await call('browser_jev_observe',{tabId});
  for(const control of observed.controls.filter(c=>c.choice)){
    result=await call('browser_jev_select_choice',{tabId,controlId:control.controlId});assert.equal(result.status,'unsupported');
  }
  assert.equal(await page.evaluate(()=>window.submits),0);
  // Riverty-style native radios: same undefined value, visual span over the
  // input, inside a shadow root. Include hidden/offscreen inputs and ensure
  // exact question + option identity, not the unusable value, drives selection.
  await page.setContent('<div id="host"></div>');
  await page.evaluate(()=>{
    const root=document.querySelector('#host').attachShadow({mode:'open'});
    root.innerHTML=`<style>label{display:block;position:relative;width:500px;height:20px;margin:20px}input{position:absolute;width:18px;height:18px;margin:0}.state{position:relative;display:inline-block;width:18px;height:18px;background:#ccc}.text{margin-left:8px}.spacer{height:1100px}</style>
      <div class="spacer"></div><fieldset><legend>Sponsorship?</legend>
      <label><input type="radio" name="visa" value="undefined"><span class="state"></span><span class="text">Yes</span></label>
      <label><input type="radio" name="visa" value="undefined"><span class="state"></span><span class="text">No</span></label></fieldset>
      <div class="spacer"></div><fieldset><legend>Relocation?</legend>
      <label><input type="radio" name="move" style="display:none"><span class="state"></span><span class="text">No</span></label></fieldset>`;
    window.clicks=0;root.addEventListener('change',()=>window.clicks++);
  });
  observed=await call('browser_jev_observe',{tabId,full:true});
  for(const question of ['Sponsorship?','Relocation?']){
    control=answer(observed,question,'No');assert.ok(control);assert.equal(control.visible,false);
    result=await call('browser_jev_select_choice',{tabId,controlId:control.controlId});
    assert.equal(result.status,'ready');assert.equal(result.selection.verified,true);
    assert.equal(result.selection.question,question);observed=result;
  }
  assert.equal(await page.locator('input[name=visa]').first().isChecked(),false);
  assert.equal(await page.evaluate(()=>window.clicks),2);
  console.log('JEV_SHADOW_DECORATED_OFFSCREEN_RADIOS_PASS');
  console.log('JEV_CHOICE_CONTEXT_VERIFICATION_STALE_AND_RETRY_GUARDS_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
