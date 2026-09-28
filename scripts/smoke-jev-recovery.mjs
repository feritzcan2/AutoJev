import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';
const remember=controlState();

const directory=await mkdtemp(path.join(os.tmpdir(),'jev-recovery-'));
let modelCalls=0;
const browser=new JevBrowser(directory,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{modelCalls++;return {operation:'BLOCKED',action:null,confidence:1};}});
const call=async(name,args,owner='owner')=>remember(JSON.parse((await browser.callTool({name,arguments:args},owner)).content[0].text));
try{
  const context=await browser.context(),page=await context.newPage(),slot=await browser.track(context,page),tabId=slot.id;
  await page.setContent('<button id="apply" type="button">Apply</button><form hidden><label>Name<input></label><button>Submit application</button></form>');
  await page.evaluate(()=>{
    window.clicks=0;window.submits=0;
    document.querySelector('#apply').onclick=()=>{window.clicks++;document.querySelector('form').hidden=false;};
    document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++;};
  });
  let observed=await call('browser_jev_observe',{tabId}),apply=observed.clickTargets.find(t=>t.label==='Apply');assert.ok(apply);
  // A consent overlay arrives after the first snapshot, as in the Zalando trace.
  await page.evaluate(()=>{
    const host=document.createElement('div');host.id='consent';document.body.append(host);
    host.attachShadow({mode:'open'}).innerHTML='<style>[role=dialog]{position:fixed;inset:0;background:white;z-index:9999;padding:30px}button{padding:20px}</style><section role="dialog" aria-modal="true" aria-label="Cookie preferences"><p>Choose cookie preferences</p><button type="button" id="deny">Reject optional cookies</button><button type="button">Accept all cookies</button></section>';
    host.shadowRoot.querySelector('#deny').onclick=()=>host.remove();
  });
  let result=await call('browser_jev_click',{tabId,targetId:apply.targetId});assert.equal(result.status,'stale');assert.equal(await page.evaluate(()=>window.clicks),0);
  const blocked=await call('browser_jev_next',{tabId,goal:'Open the application form'});
  assert.equal(blocked.operation,'BLOCKED');assert.match(blocked.textExcerpt,/cookie preferences/);
  assert.equal(blocked.clickTargets.some(t=>t.label==='Apply'),false,'background controls are not offered through a modal');
  const deny=blocked.clickTargets.find(t=>t.label==='Reject optional cookies');assert.ok(deny);
  await assert.rejects(()=>call('browser_jev_click',{tabId,targetId:deny.targetId},'different-session'),/oturuma/);
  result=await call('browser_jev_click',{tabId,targetId:deny.targetId});assert.equal(result.executed,true);
  apply=result.clickTargets.find(t=>t.label==='Apply');assert.ok(apply);
  result=await call('browser_jev_click',{tabId,targetId:apply.targetId});assert.equal(result.executed,true);
  assert.equal(await page.locator('form').isVisible(),true);assert.equal(await page.evaluate(()=>window.submits),0);assert.equal(modelCalls,1);
  // An old one-shot ID cannot execute again, and uncertain clicks cannot loop.
  assert.equal((await call('browser_jev_click',{tabId,targetId:apply.targetId})).executed,false);
  await page.setContent('<button type="button" onclick="window.clicks++">No effect</button>');await page.evaluate(()=>window.clicks=0);
  observed=await call('browser_jev_observe',{tabId});
  result=await call('browser_jev_click',{tabId,targetId:observed.clickTargets[0].targetId});assert.equal(result.status,'uncertain');
  result=await call('browser_jev_click',{tabId,targetId:result.clickTargets[0].targetId});assert.equal(result.status,'no_progress');assert.equal(await page.evaluate(()=>window.clicks),1);
  // Observed buttons below the fold can be revealed without clicking them.
  await page.setContent('<div style="height:1200px"></div><button id="below" type="button" onclick="this.textContent=\'Opened\'">Apply below</button>');
  observed=await call('browser_jev_observe',{tabId});const control=observed.controls.find(c=>c.label==='Apply below');assert.equal(control.visible,false);
  result=await call('browser_jev_reveal',{tabId,controlId:control.controlId});assert.equal(result.visible,true);
  result=await call('browser_jev_click',{tabId,targetId:result.clickTargets.find(t=>t.label==='Apply below').targetId});assert.equal(result.executed,true);assert.equal(await page.locator('#below').innerText(),'Opened');
  // Replacing a node or changing the meaning of a link invalidates the target.
  await page.setContent('<a href="https://example.test/apply">Apply</a>');observed=await call('browser_jev_observe',{tabId});
  await page.locator('a').evaluate(e=>e.href='https://example.test/other');
  result=await call('browser_jev_click',{tabId,targetId:observed.clickTargets[0].targetId});assert.equal(result.status,'stale');assert.equal(page.url(),'about:blank');
  // Read a custom dropdown after an unmatched query, without guessing an enum.
  await page.setContent('<label>Disclosure<input id="choice" role="combobox" aria-controls="choices" aria-expanded="false" autocomplete="off"></label><div id="choices" role="listbox" hidden></div>');
  await page.evaluate(()=>{
    const input=document.querySelector('#choice'),list=document.querySelector('#choices');window.selections=0;
    const render=()=>{
      list.replaceChildren();list.hidden=false;input.setAttribute('aria-expanded','true');
      for(const label of ['No answer','Option A','Option B'].filter(s=>s.toLowerCase().includes(input.value.toLowerCase()))){
        const option=document.createElement('div');option.role='option';option.textContent=label;option.style='padding:12px;cursor:pointer';
        option.onclick=()=>{input.value=label;input.setAttribute('aria-expanded','false');list.hidden=true;window.selections++;};list.append(option);
      }
    };input.oninput=render;input.onclick=render;
  });
  observed=await call('browser_jev_observe',{tabId});
  result=await call('browser_jev_autocomplete',{tabId,controlId:observed.controls.find(c=>c.label==='Disclosure').controlId,text:'Prefer not to say',option:'Prefer not to say'});
  assert.equal(result.status,'needs_selection');assert.deepEqual(result.suggestions,[]);assert.equal(await page.evaluate(()=>window.selections),0);
  result=await call('browser_jev_list_suggestions',{tabId,controlId:result.controls.find(c=>c.label==='Disclosure').controlId,text:''});
  assert.deepEqual(result.suggestions,['No answer','Option A','Option B']);assert.equal(result.selected,false);assert.equal(await page.evaluate(()=>window.selections),0);
  result=await call('browser_jev_autocomplete',{tabId,controlId:result.controls.find(c=>c.label==='Disclosure').controlId,option:'No answer'});
  assert.equal(result.selection.verified,true);assert.equal(await page.evaluate(()=>window.selections),1);assert.equal(modelCalls,1);
  await page.setContent('<div id="host"></div>');
  await page.evaluate(()=>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>');
  observed=await call('browser_jev_observe',{tabId});const shadow=observed.clickTargets.find(t=>t.label==='Shadow action');assert.ok(shadow);
  await page.locator('#host').evaluate(e=>e.setAttribute('aria-disabled','true'));
  result=await call('browser_jev_click',{tabId,targetId:shadow.targetId});assert.equal(result.status,'stale');assert.equal(result.executed,false);assert.equal(result.clickTargets.length,0);
  // Reading/querying suggestions also respects an active verification handoff.
  await page.setContent('<p>Drag the puzzle piece to complete verification</p><input role="combobox" aria-controls="items"><div role="listbox" id="items"></div>');
  observed=await call('browser_jev_observe',{tabId});
  result=await call('browser_jev_list_suggestions',{tabId,controlId:observed.controls[0].controlId,text:'query'});
  assert.equal(result.status,'verification_handoff');assert.equal(await page.locator('input').inputValue(),'');
  console.log('JEV_BLOCKED_SHADOW_OVERLAY_RECOVERY_PASS');
}finally{await browser.close();await rm(directory,{recursive:true,force:true});}
