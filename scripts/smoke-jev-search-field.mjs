import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'jev-search-field-'));
const client=new JevBrowser(directory,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('No model required');}});
const call=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args},'test')).content[0].text);
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 for(const field of [
  '<textarea name="q" role="combobox" aria-label="Search" aria-autocomplete="both" aria-controls="suggestions"></textarea>',
  '<input name="q" role="combobox" aria-label="Search" aria-autocomplete="list" aria-controls="suggestions">',
  '<input type="search" aria-label="Search" list="suggestions">',
 ]){
  await page.setContent(`<form role="search" onsubmit="event.preventDefault();window.searches++;document.querySelector('#result').textContent=this.elements[0].value">${field}<div id="suggestions" role="listbox"><div role="option">Unrelated suggestion</div></div><button>Search now</button></form><div id="result"></div>`);
  await page.evaluate(()=>{window.searches=0;window.selections=0;document.querySelector('[role=option]').onclick=()=>window.selections++;});
  let observed=await call('browser_jev_observe',{tabId});
  const query=observed.fillFields.find(f=>f.label==='Search');assert.ok(query,'Search combobox must expose a writable field');
  const text='AI governance Berlin Germany';
  const filled=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:query.fieldId,text}]});
  assert.equal(filled.status,'ready');assert.equal(await page.locator('textarea,input').inputValue(),text);
  assert.equal(await page.evaluate(()=>window.searches+window.selections),0,'Typing must not select a suggestion or submit');
  const stale=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:query.fieldId,text:'Wrong query'}]});
  assert.equal(stale.status,'stale');assert.equal(await page.locator('textarea,input').inputValue(),text);
  observed=await call('browser_jev_observe',{tabId});
  await call('browser_jev_click',{tabId,targetId:observed.clickTargets.find(t=>t.label==='Search now').targetId});
  assert.equal(await page.locator('#result').textContent(),text);assert.equal(await page.evaluate(()=>window.searches),1);
 }
 // Application choices must still use the exact-option tool, and disabled,
 // readonly and covered search inputs must remain unwritable.
 await page.setContent('<label>Country<input role="combobox" aria-autocomplete="list"></label><form role="search"><input aria-label="Readonly" readonly><input aria-label="Disabled" disabled></form>');
 assert.equal((await call('browser_jev_observe',{tabId})).fillFields.length,0);
 await page.setContent('<form role="search"><textarea role="combobox" aria-label="Search"></textarea></form><div style="position:fixed;inset:0;z-index:99"></div>');
 assert.equal((await call('browser_jev_observe',{tabId})).fillFields.length,0);
 console.log('JEV_SEARCH_COMBOBOX_FILL_AND_SUBMIT_PASS');
}finally{await client.close();await rm(directory,{recursive:true,force:true});}
