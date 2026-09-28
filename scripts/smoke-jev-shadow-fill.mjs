import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-shadow-fill-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({})});
const call=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args},'test')).content[0].text);
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await page.setContent('<div id="host"></div>');
 await page.evaluate(()=>{const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML='<label>Confirm your email<input type="email" required></label>';});
 let observation=await call('browser_jev_observe',{tabId,full:true});
 const field=observation.fillFields.find(f=>f.type==='email');assert.ok(field,'Shadow email must be writable');
 const form=await call('browser_jev_inspect_form',{tabId});assert.ok(form.fields.some(f=>f.type==='email'),'Preflight must see shadow fields');
 const filled=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:field.fieldId,text:'candidate@example.test'}]});
 assert.equal(filled.results[0].status,'filled');
 assert.equal(await page.evaluate(()=>document.querySelector('#host').shadowRoot.querySelector('input').value),'candidate@example.test');
 await page.evaluate(()=>{const overlay=document.createElement('div');overlay.style='position:fixed;inset:0;background:white;z-index:999';document.body.append(overlay);});
 observation=await call('browser_jev_observe',{tabId,full:true});assert.equal(observation.fillFields.length,0,'Overlay must still block writes');
 // React-style full form node replacement on blur must not lose verified values.
 await page.setContent('<form id="form"><label>First<input id="first"></label><label>City<input id="city"></label><label>Phone<input id="phone" type="tel"></label></form>');
 await page.evaluate(()=>{
  const bind=()=>document.querySelectorAll('input').forEach(e=>e.onblur=()=>{const f=document.querySelector('form');f.replaceWith(f.cloneNode(true));bind();});bind();
 });
 observation=await call('browser_jev_observe',{tabId,full:true});
 let batch=await call('browser_jev_fill_fields',{tabId,fields:observation.fillFields.map((f,i)=>({fieldId:f.fieldId,text:['Test','Berlin','123456'][i]}))});
 assert.equal(batch.status,'ready');assert.equal(batch.verifiedCount,3);
 assert.deepEqual(await page.locator('input').evaluateAll(es=>es.map(e=>e.value)),['Test','Berlin','123456']);
 // A handler modifying a different field must stop the batch, never overwrite it.
 await page.setContent('<label>First<input id="first"></label><label>City<input id="city"></label>');
 await page.evaluate(()=>document.querySelector('#first').onblur=()=>document.querySelector('#city').value='External edit');
 observation=await call('browser_jev_observe',{tabId,full:true});
 batch=await call('browser_jev_fill_fields',{tabId,fields:observation.fillFields.map((f,i)=>({fieldId:f.fieldId,text:['Test','Berlin'][i]}))});
 assert.equal(batch.status,'stale');assert.equal(await page.locator('#city').inputValue(),'External edit');
 console.log('RERENDER_BATCH_AND_EXTERNAL_EDIT_GUARD_PASS');
 await page.setContent('<label>When are you available?<input id="start" type="date" required min="2026-09-28" max="2027-12-31"></label>');
 observation=await call('browser_jev_observe',{tabId,full:true});
 const date=observation.fillFields.find(f=>f.type==='date');assert.ok(date);assert.equal(date.format,'YYYY-MM-DD');
 for(const text of ['28.11.2026','2026-02-30','2025-11-28'])await assert.rejects(()=>call('browser_jev_fill_fields',{tabId,fields:[{fieldId:date.fieldId,text}]}));
 assert.equal(await page.locator('#start').inputValue(),'');
 batch=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:date.fieldId,text:'2026-11-28'}]});
 assert.equal(batch.verifiedCount,1);assert.equal(await page.locator('#start').inputValue(),'2026-11-28');
 console.log('NATIVE_DATE_VALIDATION_FILL_PASS');
 await context.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html',body:'<label>Email<input type="email"></label>'}));
 const job={id:'resume-job',status:'blocked',url:'https://fixture.test/listing',resumeContext:{browser:'Jev Chrome',tabId:'closed-tab',url:'https://fixture.test/application'}};
 const resume=async()=>JSON.parse((await client.callTool({name:'browser_jev_open',arguments:{url:job.url}},'test',{activeJobId:job.id,jobs:[job]})).content[0].text);
 const reopened=await resume();assert.equal(reopened.url,job.resumeContext.url,'Recover exact form URL');
 const reused=await resume();assert.equal(reused.tabId,reopened.tabId);assert.equal(reused.reused,true);
 await client.tabs.get(reopened.tabId).page.close();job.status='uncertain';
 const uncertain=await resume();assert.equal(uncertain.status,'verification_required','Never reopen an uncertain submission');
 console.log('SHADOW_FILL_AND_RESUME_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
