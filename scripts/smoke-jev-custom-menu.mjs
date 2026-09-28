// Isolated reproduction of Personio's role-less React multiselect trigger.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';
const remember=controlState();
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-custom-menu-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('No model needed');}});
const call=async(name,args)=>remember(JSON.parse((await client.callTool({name,arguments:args},'test')).content[0].text));
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await page.setContent(`<style>#trigger{padding:16px;width:400px}label{display:block;padding:10px}#overlay{position:fixed;inset:0;background:white;z-index:999}</style><form><div id="container"><div><div id="trigger">Preferred Work Location*</div><svg></svg></div><div id="options" hidden><label><input type="checkbox" name="location" value="Amsterdam">Amsterdam</label><label><input type="checkbox" name="location" value="Berlin">Berlin</label></div></div><div id="plain">Unrelated text</div><div id="hidden" hidden>Hidden trigger</div><button type="submit">Apply</button></form>`);
 await page.evaluate(()=>{
  window.submits=0;window.toggles=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++;};
  const trigger=document.querySelector('#trigger');
  const handler=()=>{window.toggles++;document.querySelector('#options').hidden=!document.querySelector('#options').hidden;};
  trigger.__reactProps$fixture={onClick:handler};trigger.addEventListener('click',handler);
  document.querySelector('#container').__reactProps$fixture={onClick:()=>{}};
  document.querySelector('#hidden').__reactProps$fixture={onClick:()=>{}};
 });
 let observation=await call('browser_jev_observe',{tabId});
 assert.equal(observation.controls.filter(c=>c.label==='Preferred Work Location*').length,1);
 assert.ok(!observation.clickTargets.some(c=>['Unrelated text','Hidden trigger'].includes(c.label)));
 let trigger=observation.clickTargets.find(c=>c.label==='Preferred Work Location*');assert.ok(trigger);
 let result=await call('browser_jev_click',{tabId,targetId:trigger.targetId});
 assert.equal(await page.locator('#options').isVisible(),true);
 const berlin=result.controls.find(c=>c.role==='checkbox'&&(c.choice?.option==='Berlin'||c.label==='Berlin'));assert.ok(berlin,JSON.stringify(result.controls));
 const berlinTarget=result.clickTargets.find(c=>c.role==='checkbox'&&c.label==='Berlin');assert.ok(berlinTarget);
 result=await call('browser_jev_click',{tabId,targetId:berlinTarget.targetId});
 assert.equal(result.clickTargets.find(c=>c.role==='checkbox'&&c.label==='Berlin').checked,'true');
 assert.equal(await page.locator('input[value=Berlin]').isChecked(),true);
 assert.equal(await page.locator('input[value=Amsterdam]').isChecked(),false);
 assert.equal(await page.evaluate(()=>window.submits),0);
 // An overlay must suppress the trigger, even though its handler is known.
 await page.evaluate(()=>{const overlay=document.createElement('div');overlay.id='overlay';document.body.append(overlay);});
 observation=await call('browser_jev_observe',{tabId});assert.ok(!observation.clickTargets.some(c=>c.label==='Preferred Work Location*'));
 console.log('CUSTOM_MENU_OPEN_SELECT_VERIFY_OVERLAY_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
