import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'jev-form-upload-'));
const client=new JevBrowser(directory,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('No model required');}});
const call=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args},'test')).content[0].text);
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await writeFile(path.join(directory,'CV.pdf'),'Synthetic test document');
 await page.setContent(`<form onsubmit="event.preventDefault();window.sends++"><section><h3>Resume/CV</h3><div><div style="display:none"><input type="file" id="cv" accept=".pdf"></div><button type="button" onclick="document.querySelector('#cv').click()">Select files</button></div></section><button type="button" id="ordinary">Continue</button><div style="margin-top:1800px"><label>Start month<input role="spinbutton" name="month" value="08"></label><label>Start year<input role="spinbutton" name="year" value="2025"></label></div></form>`);
 await page.evaluate(()=>{window.sends=0;window.fileClicks=0;document.querySelector('#cv').addEventListener('click',()=>window.fileClicks++);});
 let observed=await call('browser_jev_observe',{tabId});assert.equal(observed.uploads.length,1);assert.match(observed.uploads[0].label,/Resume\/CV/);
 const target=observed.clickTargets.find(t=>t.label==='Select files');assert.ok(target);
 const blocked=await call('browser_jev_click',{tabId,targetId:target.targetId});assert.equal(blocked.status,'upload_required');assert.equal(blocked.executed,false);assert.equal(await page.evaluate(()=>window.fileClicks),0);
 const form=await call('browser_jev_inspect_form',{tabId});assert.equal(form.uploads.length,1);
 const year=form.fields.find(f=>f.label==='Start year');assert.ok(year.controlId);assert.equal(year.fieldId,undefined);
 const reveal=await call('browser_jev_reveal',{tabId,controlId:year.controlId});
 const field=reveal.fillFields.find(f=>f.label==='Start year');assert.ok(field);
 await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:field.fieldId,text:'2024'}]});assert.equal(await page.locator('[name=year]').inputValue(),'2024');
 const latest=await call('browser_jev_inspect_form',{tabId});
 const uploaded=await call('browser_jev_upload',{tabId,uploadId:latest.uploads[0].uploadId,filePath:path.join(directory,'CV.pdf')});assert.equal(uploaded.executed,true);
 assert.deepEqual(await page.locator('#cv').evaluate(e=>[...e.files].map(f=>f.name)),['CV.pdf']);assert.equal(await page.evaluate(()=>window.sends),0);
 // Hidden sections and unrelated buttons must not become upload targets.
 await page.setContent('<section hidden><input type="file"><button>Select files</button></section><button>Continue</button>');
 observed=await call('browser_jev_observe',{tabId});assert.equal(observed.uploads.length,0);
 console.log('JEV_FORM_REVEAL_AND_UPLOAD_PASS');
}finally{await client.close();await rm(directory,{recursive:true,force:true});}
