// Isolated Chrome: measure actual wire output while retaining safe controls.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';
const directory=await mkdtemp(path.join(os.tmpdir(),'jev-context-'));
const client=new JevBrowser(directory,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('No model calls expected');}});
const remember=controlState();
const call=async(name,args,owner='test')=>{
 const result=await client.callTool({name,arguments:args},owner);
 const wire=JSON.parse(result.content[0].text);
 return {wire,page:remember(wire),bytes:Buffer.byteLength(result.content[0].text)};
};
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await page.setContent(`<style>label{display:block;height:80px}</style><form onsubmit="event.preventDefault();window.submits++">${Array.from({length:70},(_,i)=>`<label>Required field ${i}<select id="f${i}" required><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select></label>`).join('')}<button>Submit application</button></form>`);
 await page.evaluate(()=>{window.submits=0;});
 const first=await call('browser_jev_observe',{tabId});
 const original=first.page.controls.find(c=>c.label==='Required field 0'),retained=first.page.controls.find(c=>c.label==='Required field 1');
 const second=await call('browser_jev_select_option',{tabId,controlId:original.controlId,option:'Yes'});
 assert.equal(second.wire.selection.verified,true);
 assert.ok(second.wire.removedControls.includes(original.controlId));
 assert.ok(!second.wire.controls.some(c=>c.controlId===retained.controlId));
 assert.ok(second.page.controls.some(c=>c.controlId===retained.controlId));
 assert.deepEqual(new Map(second.page.controls.map(c=>[c.controlId,c])),new Map(JSON.parse(JSON.stringify(slot.presented.controls)).map(c=>[c.controlId,c])));
 assert.ok(second.bytes<first.bytes*.4,`${second.bytes}/${first.bytes}`);
 // A retained ID is usable, but a removed/replaced/foreign-owner ID cannot act.
 const third=await call('browser_jev_select_option',{tabId,controlId:retained.controlId,option:'No'});
 assert.equal(third.wire.selection.verified,true);assert.equal(await page.locator('#f1').inputValue(),'no');
 // Redundant reads stay small while still inspecting the current live DOM.
 const reread=await call('browser_jev_observe',{tabId});
 assert.equal(reread.wire.observationMode,'delta');assert.deepEqual(reread.wire.controls,[]);assert.equal(reread.wire.text,undefined);
 assert.equal(reread.wire.baseObservationId,third.wire.observationId);assert.ok(reread.bytes<first.bytes*.15);
 await page.evaluate(()=>{document.querySelector('#f1').value='yes';document.body.insertAdjacentHTML('afterbegin','<p role="alert">Please correct the application details.</p>');});
 const error=await call('browser_jev_observe',{tabId});
 assert.equal(error.wire.observationMode,'delta');assert.match(error.wire.text,/Please correct/);
 assert.ok(error.wire.controls.some(c=>c.label==='Required field 1'&&c.value==='yes'));
 const stale=await call('browser_jev_select_option',{tabId,controlId:original.controlId,option:'No'});
 assert.equal(stale.wire.status,'stale');assert.equal(stale.wire.executed,false);assert.equal(await page.locator('#f0').inputValue(),'yes');
 const replacement=stale.page.controls.find(c=>c.label==='Required field 0');
 await page.locator('#f0').evaluate(e=>e.replaceWith(e.cloneNode(true)));
 const replaced=await call('browser_jev_select_option',{tabId,controlId:replacement.controlId,option:'No'});
 assert.equal(replaced.wire.status,'stale');assert.ok(replaced.wire.removedControls.includes(replacement.controlId));
 await assert.rejects(()=>call('browser_jev_select_option',{tabId,controlId:replaced.page.controls.find(c=>c.label==='Required field 0').controlId,option:'Yes'},'other'),/oturuma/);
 assert.equal(await page.evaluate(()=>window.submits),0);
 const full=await call('browser_jev_observe',{tabId,full:true});assert.equal(full.wire.observationMode,'full');assert.equal(full.wire.controls.length,71);assert.match(full.wire.text,/Please correct/);
 const next=await call('browser_jev_observe',{tabId,full:false});assert.equal(next.wire.observationMode,'delta');assert.equal(next.wire.baseObservationId,full.wire.observationId);
 const freshOwner=await call('browser_jev_observe',{tabId},'new-owner');assert.equal(freshOwner.wire.observationMode,'full');assert.equal(freshOwner.wire.controls.length,71);
 assert.ok(!freshOwner.wire.controls.some(c=>full.wire.controls.some(old=>old.controlId===c.controlId)));
 // A late confirmation on the same URL must arrive without requesting full.
 await page.setContent('<h1>Application received</h1><p>Thank you for applying.</p>');
 const confirmation=await call('browser_jev_observe',{tabId},'new-owner');
 assert.equal(confirmation.wire.observationMode,'delta');assert.match(confirmation.wire.text,/Application received/);
 assert.equal(confirmation.wire.removedControls.length,71);assert.deepEqual(confirmation.wire.clickTargets,[]);
 console.log('JEV_CONTEXT_DELTA_PASS',JSON.stringify({initialBytes:first.bytes,actionBytes:second.bytes,rereadBytes:reread.bytes,rereadReductionPercent:Math.round((1-reread.bytes/first.bytes)*100),retainedControlUsable:true,staleHandlesRejected:true,freshErrorAndConfirmation:true,ownerReceivesFull:true,submissions:0}));
}finally{await client.close();await rm(directory,{recursive:true,force:true});}
