import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-embedded-recovery-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({})});
const state={taskKind:'application',activeJobId:'job',jobs:[{id:'job',status:'working'}]};
const call=async(name,args,owner='test',s=state)=>JSON.parse((await client.callTool({name,arguments:args},owner,s)).content[0].text);
try{
 const context=await client.context();
 await context.route('https://frames.test/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().endsWith('/outer')?'<iframe src="https://frames.test/middle" style="width:800px;height:500px"></iframe>':route.request().url().endsWith('/middle')?'<iframe src="https://frames.test/inner" style="width:700px;height:400px"></iframe>':'<form onsubmit="event.preventDefault()"><label>Email<input id="email" type="email"></label><label><input id="privacy" type="checkbox">Privacy</label><button type="button" onclick="document.querySelector(\'h1\').textContent=\'Next step\'">Next</button><button type="submit">Submit application</button><h1>Start</h1></form>'}));
 const page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;client.tabJobs.set(tabId,'job');
 await page.goto('https://frames.test/outer');await page.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('iframe')?.contentDocument?.querySelector('#email'));
 const count=context.pages().length;
 let o=await call('browser_jev_observe',{tabId,full:true});const frameId=o.embeddedForms.find(f=>f.url.endsWith('/inner')).frameId;
 o=await call('browser_jev_frame_observe',{tabId,frameId});
 await assert.rejects(()=>call('browser_jev_frame_act',{tabId,frameId,targetId:o.controls.find(c=>c.kind==='fill').targetId,action:'fill',text:'x@test.example'},'foreign'));
 o=await call('browser_jev_frame_observe',{tabId,frameId});
 o=await call('browser_jev_frame_act',{tabId,frameId,targetId:o.controls.find(c=>c.kind==='fill').targetId,action:'fill',text:'x@test.example'});assert.equal(o.verified,true);
 o=await call('browser_jev_frame_act',{tabId,frameId,targetId:o.controls.find(c=>c.kind==='choice').targetId,action:'choice',checked:true});assert.equal(o.verified,true);
 o=await call('browser_jev_frame_act',{tabId,frameId,targetId:o.controls.find(c=>c.label==='Next').targetId,action:'click'});assert.ok(o.text.includes('Next step'));assert.equal(context.pages().length,count);
 await assert.rejects(()=>call('browser_jev_frame_act',{tabId,frameId,targetId:o.controls.find(c=>c.label==='Submit application').targetId,action:'click'}),/submission_not_started/);
 // Non-native ARIA comboboxes in nested forms expose visible options after opening.
 const inner=page.frames().find(f=>f.url().endsWith('/inner'));
 await inner.locator('body').evaluate(e=>e.innerHTML=`<a role="combobox" aria-label="Country" aria-expanded="false" tabindex="0" onclick="this.setAttribute('aria-expanded','true');document.querySelector('[role=listbox]').hidden=false">Select</a><div role="listbox" hidden><div role="option" tabindex="0" onclick="document.querySelector('[role=combobox]').textContent='Germany';this.parentElement.hidden=true">Germany</div></div><label>Resume<input type="file"></label>`);
 o=await call('browser_jev_frame_observe',{tabId,frameId});
 assert.equal(o.controls.filter(c=>c.label==='Germany').length,0);
 o=await call('browser_jev_frame_act',{tabId,frameId,targetId:o.controls.find(c=>c.label==='Country').targetId,action:'click'});
 assert.ok(o.controls.some(c=>c.label==='Germany'));
 o=await call('browser_jev_frame_act',{tabId,frameId,targetId:o.controls.find(c=>c.label==='Germany').targetId,action:'click'});
 assert.ok(o.text.includes('Germany'));
 o=await call('browser_jev_observe',{tabId,full:true});assert.equal(o.uploads.length,1);
 const embeddedCv=path.join(dir,'embedded.txt');await writeFile(embeddedCv,'Synthetic embedded fixture');
 o=await call('browser_jev_upload',{tabId,uploadId:o.uploads[0].uploadId,filePath:embeddedCv});assert.equal(o.executed,true);
 assert.equal(await inner.locator('input').evaluate(e=>e.files[0].name),'embedded.txt');
 // A React-style location combobox must retain focus and expose observed suggestions.
 await inner.locator('body').evaluate(e=>e.innerHTML=`<input id="city" type="text" role="combobox" aria-autocomplete="list" aria-label="Location (City)" oninput="document.querySelector('[role=listbox]').hidden=false" onblur="if(!document.querySelector('[role=option]').dataset.selected)this.value='' "><div role="listbox" hidden><div role="option" tabindex="0" onmousedown="this.dataset.selected='yes'" onclick="document.querySelector('#city').value=this.textContent;this.parentElement.hidden=true">Berlin, Germany</div></div>`);
 o=await call('browser_jev_frame_observe',{tabId,frameId});
 o=await call('browser_jev_frame_act',{tabId,frameId,targetId:o.controls.find(c=>c.label==='Location (City)').targetId,action:'fill',text:'Berlin'});
 assert.equal(o.status,'needs_selection');assert.ok(o.controls.some(c=>c.label==='Berlin, Germany'));
 o=await call('browser_jev_frame_act',{tabId,frameId,targetId:o.controls.find(c=>c.label==='Berlin, Germany').targetId,action:'click'});
 assert.ok(o.controls.some(c=>c.label==='Location (City)'&&c.value==='Berlin, Germany'));
 // SuccessFactors-style transparent input bound to a visible span, no label.
 await page.setContent('<div role="dialog"><span id="upload-text">Upload from Device</span><input type="file" style="opacity:0" aria-labelledby="upload-text"></div>');
 o=await call('browser_jev_observe',{tabId,full:true});assert.equal(o.uploads.length,1);assert.equal(o.uploads[0].label,'Upload from Device');
 const cv=path.join(dir,'synthetic.txt');await writeFile(cv,'Synthetic fixture only');
 o=await call('browser_jev_upload',{tabId,uploadId:o.uploads[0].uploadId,filePath:cv});assert.equal(o.executed,true);assert.equal(await page.locator('input').evaluate(e=>e.files[0].name),'synthetic.txt');
 // Disabled final send reports the actual missing required fields, including custom JS forms.
 await page.setContent('<form><label>Email *<input type="email" id="mail"></label><label>Phone *<input type="tel" id="phone"></label><button type="submit" disabled>Submit Application</button></form>');
 o=await call('browser_jev_inspect_form',{tabId});
 assert.deepEqual(o.missingRequired.map(f=>f.label),['Email *','Phone *']);
 assert.ok(o.submitControls.some(c=>c.label==='Submit Application'&&c.disabled));
 // Local intercepted verification fixture; no real CAPTCHA service is contacted.
 await context.route('https://www.google.com/recaptcha/api2/anchor*',route=>route.fulfill({contentType:'text/html',body:'<div role="checkbox" tabindex="0" aria-label="I am not a robot" aria-checked="false" style="width:180px;height:50px" onclick="this.setAttribute(\'aria-checked\',\'true\')">I am not a robot</div>'}));
 await page.setContent('<p>The captcha is required.</p><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?fixture=1" style="width:300px;height:100px"></iframe>');
 await page.frames()[1].waitForLoadState();o=await call('browser_jev_observe',{tabId,full:true});
 assert.equal(o.verification.capability,'supported');const verify=o.clickTargets.find(c=>c.verification);assert.ok(verify);
 o=await call('browser_jev_click',{tabId,targetId:verify.targetId});assert.equal(o.executed,true);
 o=await call('browser_jev_observe',{tabId});assert.equal(o.verification.state,'cleared');assert.equal(slot.verification,undefined);
 assert.equal(context.pages().length,count);
 // An image challenge stays manual even if an anchor checkbox is present.
 await context.route('https://www.google.com/recaptcha/api2/bframe*',route=>route.fulfill({contentType:'text/html',body:'<p>Select pictures</p>'}));
 await page.evaluate(()=>{const f=document.createElement('iframe');f.src='https://www.google.com/recaptcha/api2/bframe?fixture=1';f.title='recaptcha challenge';f.style='width:300px;height:200px';document.body.append(f);});
 o=await call('browser_jev_observe',{tabId});assert.equal(o.verification.capability,'not_exposed');assert.equal(o.verification.handoff,true);
 delete slot.verification;delete slot.verificationCheckboxAttempt;
 await page.setContent('<iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?fixture=2" style="width:300px;height:100px"></iframe>');await page.frames()[1].waitForLoadState();
 await page.frames()[1].locator('[role=checkbox]').evaluate(e=>e.onclick=null);
 o=await call('browser_jev_observe',{tabId,full:true});
 o=await call('browser_jev_click',{tabId,targetId:o.clickTargets.find(c=>c.verification).targetId});
 o=await call('browser_jev_observe',{tabId});assert.equal(o.verification.handoff,true);
 const again=await call('browser_jev_click',{tabId,targetId:o.clickTargets.find(c=>c.verification).targetId});assert.equal(again.executed,false);
 console.log('EMBEDDED_FORM_NATIVE_UPLOAD_VERIFICATION_CHECKBOX_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
