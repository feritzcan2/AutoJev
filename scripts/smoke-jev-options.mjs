// Isolated Chrome: observed Midas university label among 237 native options.
// The live application is never changed by this test.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';
const remember=controlState();
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-options-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('No model call expected');}});
const call=async(name,args,owner='test')=>remember(JSON.parse((await client.callTool({name,arguments:args},owner)).content[0].text));
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 const label='İHSAN DOĞRAMACI BİLKENT ÜNİVERSİTESİ';
 const reset=async()=>{
  const options=['<option value="">Select...</option>',...Array.from({length:235},(_,i)=>`<option value="school-${i}">University ${i}</option>`)];
  options.splice(94,0,`<option value="${label}">${label}</option>`);
  await page.setContent(`<style>body{height:2000px}label{display:block}</style><form onsubmit="event.preventDefault();window.submits++"><label>Unrelated field<input value="Keep me"></label><div style="height:900px"></div><label>University<select id="school" required>${options.join('')}</select></label><button>Submit</button></form>`);
  await page.evaluate(()=>{window.submits=0;window.changes=0;document.querySelector('#school').onchange=()=>window.changes++;window.scrollTo(0,0);});
  return call('browser_jev_observe',{tabId});
 };
 let result=await reset(),controlId=result.controls.find(c=>c.label==='University').controlId;
 assert.equal(result.controls.find(c=>c.label==='University').visible,false);
 const started=Date.now();
 result=await call('browser_jev_list_options',{tabId,controlId});
 assert.equal(result.options.length,237);assert.equal(result.nextOffset,null);
 assert.equal(result.controls.find(c=>c.controlId===controlId).optionsRead.complete,true);assert.equal(result.cached,false);
 const bilkent=result.options.find(o=>o.label===label);assert.ok(bilkent);
 assert.equal(result.status,'ready');assert.equal(result.executed,false);assert.equal(result.optionCount,237);assert.equal(result.matchCount,237);
 assert.equal(bilkent.value,label);assert.equal(bilkent.index,94);assert.equal(bilkent.disabled,false);
 assert.deepEqual(await page.evaluate(()=>[scrollY,window.changes,window.submits,document.querySelector('#school').value,document.querySelector('input').value]),[0,0,0,'','Keep me']);
 result=await call('browser_jev_select_option',{tabId,controlId:result.controlId,option:bilkent.value});
 assert.equal(result.selection.verified,true);assert.equal(result.selection.actual,label);assert.equal(await page.evaluate(()=>window.submits),0);
 console.log('JEV_237_OPTIONS_FULL_LIST_AND_SELECT_PASS',JSON.stringify({operationCalls:2,modelCalls:0,elapsedMs:Date.now()-started}));
 controlId=result.controls.find(c=>c.label==='University').controlId;
 for(const query of ['ihsan dogramaci','BİLKENT','bılkent','  Bilkent  Universitesi  ']){
  result=await call('browser_jev_list_options',{tabId,controlId,query});assert.equal(result.matchCount,1);assert.equal(result.options[0].label,label);assert.equal(result.options[0].selected,true);
 }
 result=await call('browser_jev_list_options',{tabId,controlId,query:'No such institution'});assert.equal(result.matchCount,0);assert.equal(result.nextOffset,null);assert.deepEqual(result.options,[]);
 // Bounded pages expose every option without dumping 237 labels into one response.
 const indices=[];let offset=0;
 do{
  result=await call('browser_jev_list_options',{tabId,controlId,offset,limit:20});assert.ok(result.options.length<=20);assert.equal(result.matchCount,237);
  indices.push(...result.options.map(o=>o.index));offset=result.nextOffset;
 }while(offset!==null);
 assert.equal(result.cached,true);
 assert.equal(new Set(indices).size,237);assert.equal(indices.length,237);
 // A failed exact guess returns a useful next action and fresh IDs, no error loop.
 result=await call('browser_jev_select_option',{tabId,controlId,option:'Bilkent University'});
 assert.equal(result.status,'needs_selection');assert.equal(result.executed,false);assert.match(result.message,/browser_jev_list_options/);assert.equal(result.optionCount,237);
 assert.equal(await page.locator('#school').inputValue(),label);
 // Duplicated labels and disabled optgroups are visible but cannot be selected blindly.
 await page.locator('#school').evaluate(e=>e.insertAdjacentHTML('beforeend','<option value="duplicate">İHSAN DOĞRAMACI BİLKENT ÜNİVERSİTESİ</option><optgroup label="Unavailable" disabled><option value="closed">Closed School</option></optgroup>'));
 result=await call('browser_jev_list_options',{tabId,controlId,query:'Bilkent'});assert.equal(result.status,'stale');
 controlId=result.controls.find(c=>c.label==='University').controlId;
 result=await call('browser_jev_list_options',{tabId,controlId,query:'bilkent'});assert.equal(result.matchCount,2);assert.equal(result.cached,false);
 result=await call('browser_jev_select_option',{tabId,controlId,option:label});assert.equal(result.reason,'ambiguous');assert.equal(result.executed,false);
 result=await call('browser_jev_list_options',{tabId,controlId,query:'Closed'});assert.equal(result.options[0].disabled,true);assert.equal(result.options[0].group,'Unavailable');
 result=await call('browser_jev_select_option',{tabId,controlId,option:'closed'});assert.equal(result.reason,'disabled');assert.equal(result.executed,false);
 // Wrong session and replaced controls cannot reveal stale options or mutate inputs.
 await assert.rejects(()=>call('browser_jev_list_options',{tabId,controlId,query:'Bilkent'},'other'),/oturuma/);
 await page.locator('#school').evaluate(e=>e.replaceWith(e.cloneNode(true)));
 result=await call('browser_jev_list_options',{tabId,controlId,query:'Bilkent'});assert.equal(result.status,'stale');assert.equal(result.options,undefined);assert.ok(result.controls.length);
 result=await call('browser_jev_list_options',{tabId,controlId:'previous-session',query:'Bilkent'});assert.equal(result.status,'stale');assert.equal(result.executed,false);
 const textControl=result.controls.find(c=>c.label==='Unrelated field');
 result=await call('browser_jev_list_options',{tabId,controlId:textControl.controlId});assert.equal(result.status,'unsupported');
 assert.equal(await page.evaluate(()=>window.submits),0);
 console.log('JEV_OPTION_UNICODE_PAGINATION_DISABLED_AMBIGUOUS_SCOPE_AND_STALE_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
