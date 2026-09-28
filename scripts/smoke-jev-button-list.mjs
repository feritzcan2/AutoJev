import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-button-list-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('No model needed');}});
const remember=controlState();
const call=async(name,args,owner='test')=>remember(JSON.parse((await client.callTool({name,arguments:args},owner)).content[0].text));
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await page.setContent('<div id="fields"></div>');
 await page.evaluate(()=>{
  window.picks=[];
  for(const question of ['Land*','Nationalität']){
   const host=document.createElement('fixture-picklist');document.querySelector('#fields').append(host);
   const root=host.attachShadow({mode:'open'});
   root.innerHTML=`<style>:host{display:block}button{padding:12px}.dropdown{height:0;overflow:hidden}ul{margin:0;max-height:120px;overflow:auto}li{cursor:pointer;height:30px}.open .dropdown{height:auto}</style><div class="container"><label>${question}<button type="button"><span class="value">Auswählen</span></button></label><div class="dropdown"><ul tabindex="-1">${[...Array.from({length:60},(_,i)=>'Country '+i),'Deutschland'].map(v=>'<li tabindex="-1"><svg width="12" height="12"></svg>'+v+'</li>').join('')}</ul></div></div>`;
   root.querySelector('button').onclick=()=>root.querySelector('.container').classList.toggle('open');
   for(const li of root.querySelectorAll('li'))li.onclick=()=>{window.picks.push(question);root.querySelector('.value').textContent=li.textContent;root.querySelector('.container').classList.remove('open');};
  }
 });
 let o=await call('browser_jev_observe',{tabId,full:true});
 let field=o.controls.find(c=>c.label==='Land*');assert.ok(field?.autocomplete);
 await assert.rejects(()=>call('browser_jev_list_suggestions',{tabId,controlId:field.controlId},'other'),/oturuma/);
 let r=await call('browser_jev_autocomplete',{tabId,controlId:field.controlId,text:'Deutschland',option:'Deutschland'});
 assert.equal(r.status,'unsupported');assert.deepEqual(await page.evaluate(()=>window.picks),[]);
 r=await call('browser_jev_list_suggestions',{tabId,controlId:field.controlId});
 assert.equal(r.optionCount,61);assert.ok(r.suggestions.includes('Deutschland'));
 field=r.controls.find(c=>c.label==='Land*');
 r=await call('browser_jev_autocomplete',{tabId,controlId:field.controlId,option:'Deutschland'});
 assert.equal(r.selection?.verified,true,JSON.stringify({status:r.status,message:r.message,selection:r.selection}));assert.equal(r.selection.actual,'Deutschland');
 assert.deepEqual(await page.evaluate(()=>window.picks),['Land*']);
 assert.equal(await page.locator('fixture-picklist').nth(1).locator('.value').textContent(),'Auswählen');
 // Real overlay prevents opening a different dropdown; never dispatch through it.
 await page.evaluate(()=>{const e=document.createElement('div');e.style='position:fixed;inset:0;z-index:999;background:white';document.body.append(e);});
 o=await call('browser_jev_observe',{tabId,full:true});
 field=o.controls.find(c=>c.label==='Nationalität');
 r=await call('browser_jev_autocomplete',{tabId,controlId:field.controlId,option:'Deutschland'});
 assert.equal(r.executed,false);assert.deepEqual(await page.evaluate(()=>window.picks),['Land*']);
 console.log('BUTTON_LIST_FULL_OPTIONS_EXACT_SELECTION_SCROLL_SCOPE_OVERLAY_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
