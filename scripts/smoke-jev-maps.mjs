// Synthetic Chrome form: actual wire savings plus execution/ownership guards.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-map-deltas-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('No model calls expected');}});
const remember=controlState();
const call=async(name,args,owner='first')=>{
 const response=await client.callTool({name,arguments:args},owner),text=response.content[0].text,wire=JSON.parse(text);
 return {wire,page:remember(wire),bytes:Buffer.byteLength(text)};
};
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await page.setContent(`<style>form{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}label,input{display:block}button{height:24px}</style><form onsubmit="event.preventDefault();window.submits++">${Array.from({length:20},(_,i)=>`<label>Application field ${i}<input id="f${i}"></label><button type="button" id="b${i}" onclick="window.clicks++">Application action ${i}</button>`).join('')}<button>Submit application</button></form>`);
 await page.evaluate(()=>{window.submits=0;window.clicks=0;});
 const first=await call('browser_jev_observe',{tabId});assert.equal(first.wire.fillFields.length,20);
 const field=first.page.fillFields.find(f=>f.label==='Application field 0'),retained=first.page.fillFields.find(f=>f.label==='Application field 1');
 const untouchedButton=first.page.clickTargets.find(t=>t.label==='Application action 1');
 const second=await call('browser_jev_observe',{tabId});
 for(const key of ['controls','clickTargets','fillFields','scrollTargets'])assert.deepEqual(second.wire[key],[]);
 assert.ok(second.bytes<first.bytes*.15);
 assert.equal(second.page.fillFields.find(f=>f.label===retained.label).fieldId,retained.fieldId);
 const filled=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:field.fieldId,text:'Supported value'}]});
 assert.equal(filled.wire.status,'ready');assert.ok(filled.wire.removedFillFields.includes(field.fieldId));
 assert.ok(!filled.wire.fillFields.some(f=>f.fieldId===retained.fieldId));assert.ok(!filled.wire.clickTargets.some(t=>t.targetId===untouchedButton.targetId));
 const oldField=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:field.fieldId,text:'Do not write'}]});assert.equal(oldField.wire.status,'stale');assert.equal(await page.locator('#f0').inputValue(),'Supported value');
 const nextFill=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:retained.fieldId,text:'Another value'}]});assert.equal(nextFill.wire.status,'ready');
 const click=await call('browser_jev_click',{tabId,targetId:untouchedButton.targetId});assert.equal(click.wire.executed,true);assert.ok(click.wire.removedClickTargets.includes(untouchedButton.targetId));
 const repeated=await call('browser_jev_click',{tabId,targetId:untouchedButton.targetId});assert.equal(repeated.wire.executed,false);assert.equal(await page.evaluate(()=>window.clicks),1);
 // Even a retained ID cannot act against a DOM change not yet observed.
 const oldButton=repeated.page.clickTargets.find(t=>t.label==='Application action 2');
 await page.locator('#b2').evaluate(e=>e.replaceWith(e.cloneNode(true)));
 const replaced=await call('browser_jev_click',{tabId,targetId:oldButton.targetId});assert.equal(replaced.wire.executed,false);assert.ok(replaced.wire.removedClickTargets.includes(oldButton.targetId));
 const field2=replaced.page.fillFields.find(f=>f.label==='Application field 2');
 await page.locator('#f2').evaluate(e=>e.replaceWith(e.cloneNode(true)));
 const staleFill=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:field2.fieldId,text:'Do not write'}]});assert.equal(staleFill.wire.status,'stale');assert.equal(await page.locator('#f2').inputValue(),'');
 const guarded=staleFill.page.clickTargets.find(t=>t.label==='Application action 3');
 await page.locator('#f4').evaluate(e=>e.value='External edit');
 const changedForm=await call('browser_jev_click',{tabId,targetId:guarded.targetId});assert.equal(changedForm.wire.executed,false);assert.equal(await page.evaluate(()=>window.clicks),1);
 const foreignField=changedForm.page.fillFields.find(f=>f.label==='Application field 3');
 await assert.rejects(()=>call('browser_jev_fill_fields',{tabId,fields:[{fieldId:foreignField.fieldId,text:'Foreign'}]},'other'),/oturuma/);
 const full=await call('browser_jev_observe',{tabId,full:true});assert.equal(full.wire.fillFields.length,20);assert.equal(full.wire.observationMode,'full');
 const oldIds=new Set(full.page.fillFields.map(f=>f.fieldId));
 const owner=await call('browser_jev_observe',{tabId},'new-owner');assert.equal(owner.wire.observationMode,'full');assert.ok(owner.page.fillFields.every(f=>!oldIds.has(f.fieldId)));
 await page.setContent('<h1>Application received</h1>');
 const cleared=await call('browser_jev_observe',{tabId},'new-owner');assert.equal(cleared.wire.removedFillFields.length,20);assert.deepEqual(cleared.page.fillFields,[]);assert.deepEqual(cleared.page.clickTargets,[]);
 console.log('JEV_MAP_DELTAS_PASS',JSON.stringify({fullBytes:first.bytes,unchangedBytes:second.bytes,fillBytes:filled.bytes,reductionPercent:Math.round((1-second.bytes/first.bytes)*100),retainedIdsUsable:true,consumedAndReplacedIdsRejected:true,ownerIsolated:true,submissions:0}));
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
