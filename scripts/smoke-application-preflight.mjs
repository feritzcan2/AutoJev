// Isolated synthetic forms only: no credentials, model calls or external sends.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {controlState} from './jev-control-state.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'jobloop-preflight-'));
const client=new JevBrowser(directory,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('Preflight must not call a model');}});
const remember=controlState();
const call=async(name,args)=>remember(JSON.parse((await client.callTool({name,arguments:args},'test')).content[0].text));
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await page.setContent(`<style>.below{margin-top:2000px}label{display:block}</style>
 <form onsubmit="event.preventDefault();window.submits++">
 <label>Email<input name="email" type="email" required></label>
 <label>Unknown optionality<input name="unknown"></label>
 <label>Optional note<input name="note" aria-required="false"></label>
 <label>Password<input name="password" type="password" value="fixture-only-secret"></label>
 <label style="display:none">Hidden<input required></label>
 <div class="below"><label>Permit category *<input name="permit" role="combobox"></label>
 <label>Privacy *<input name="privacy" type="checkbox" aria-required="true"></label></div>
 <button>Submit</button></form><iframe srcdoc='<label>Salary<input type="number" required></label>'></iframe>
 <iframe style="display:none" srcdoc='<label>Invisible frame<input required></label>'></iframe>`);
 await page.evaluate(()=>{window.submits=0;window.invalidEvents=0;document.addEventListener('invalid',()=>window.invalidEvents++,true);});
 await page.locator('[name=email]').focus();
 let result=await call('browser_jev_inspect_form',{tabId});
 const field=label=>result.fields.find(f=>f.label===label);
 assert.equal(field('Email').required,true);assert.equal(field('Email').filled,false);assert.equal(field('Email').invalid,true);
 assert.equal(field('Unknown optionality').required,null);assert.equal(field('Optional note').required,false);
 assert.equal(field('Permit category *').required,true);assert.equal(field('Privacy *').required,true);
  assert.equal(field('Salary').required,true);assert.equal(field('Hidden'),undefined);
 assert.equal(field('Invisible frame'),undefined);assert.equal(result.readOnly,true);
 assert.equal(field('Password').filled,undefined);assert.ok(!JSON.stringify(result).includes('fixture-only-secret'));
 assert.deepEqual(await page.evaluate(()=>({submits:window.submits,invalid:window.invalidEvents,scroll:scrollY,focus:document.activeElement.name})),{submits:0,invalid:0,scroll:0,focus:'email'});
 await page.locator('[name=email]').fill('test@example.test');
 await page.locator('[name=permit]').fill('Known category');
 result=await call('browser_jev_inspect_form',{tabId});
 assert.equal(field('Email').invalid,false);assert.equal(field('Email').filled,true);assert.equal(field('Permit category *').filled,true);
 // Unassociated question headings used by ATS forms must agree across the
 // complete form map and current writable targets, including offscreen fields.
 await page.setContent(`<form onsubmit="event.preventDefault();window.submits++">
 <div><div>Notice period and possible start date *</div><div><textarea name="cards[123][field0]"></textarea></div></div>
 <div><div>Comfortable working UTC+0/+1? *</div><div><label><input type="radio" name="timezone" value="yes">Yes</label><label><input type="radio" name="timezone" value="no">No</label></div></div>
 <div style="margin-top:1800px"><div>Salary expectation *</div><p>Annual gross in EUR</p><div><textarea name="cards[123][field1]"></textarea></div></div>
 <div><h3>Do not borrow this title</h3><input name="unlabelled-one"><input name="unlabelled-two"></div>
 <button type="submit">Submit application</button></form>`);
 await page.evaluate(()=>{window.submits=0;window.scrollTo(0,0);});
 const observed=await call('browser_jev_observe',{tabId});
 result=await call('browser_jev_inspect_form',{tabId});
 const notice=field('Notice period and possible start date *'),salary=field('Salary expectation *');
 assert.equal(notice.required,true);assert.equal(salary.required,true);assert.equal(salary.help,'Annual gross in EUR');
 assert.ok(notice.controlId);assert.ok(notice.fieldId);assert.ok(salary.controlId);assert.equal(salary.fieldId,undefined);
 assert.equal(observed.fillFields.find(f=>f.fieldId===notice.fieldId).label,notice.label);
 assert.equal(result.fields.filter(f=>f.question==='Comfortable working UTC+0/+1? *').length,2);
 assert.deepEqual(result.fields.filter(f=>f.type==='radio').map(f=>f.option),['Yes','No']);
 assert.equal(result.fields.some(f=>f.label==='Do not borrow this title'),false);
 assert.equal(await page.evaluate(()=>scrollY),0);
 const filled=await call('browser_jev_fill_fields',{tabId,fields:[{fieldId:notice.fieldId,text:'Two months after agreement'}]});assert.equal(filled.status,'ready');
 // Both the direct click and model-proposed action paths enforce rank scope.
 const submit=filled.clickTargets.find(t=>t.label==='Submit application');
 // Submit is below the viewport; reveal it using its observed control first.
 let current=filled;
 if(!submit)current=await call('browser_jev_reveal',{tabId,controlId:filled.controls.find(c=>c.label==='Submit application').controlId});
 const target=current.clickTargets.find(t=>t.label==='Submit application');assert.ok(target);
 await assert.rejects(()=>client.callTool({name:'browser_jev_click',arguments:{tabId,targetId:target.targetId}},'test',{taskKind:'rank'}),/Puanlama/);
 await assert.rejects(()=>client.callTool({name:'browser_jev_upload',arguments:{tabId,uploadId:'irrelevant',filePath:'/tmp/fake.pdf'}},'test',{taskKind:'rank'}),/Puanlama/);
 const action=slot.observed.actions.find(a=>a.kind==='click'&&a.label==='Submit application');
 slot.pending={decisionId:'rank-decision',owner:'test',observed:slot.observed,operation:'CLICK',action};
 await assert.rejects(()=>client.callTool({name:'browser_jev_act',arguments:{tabId,decisionId:'rank-decision'}},'test',{taskKind:'rank'}),/Puanlama/);
 client.choose=async observed=>{
  assert.ok(observed.actions.every(a=>!['fill','select'].includes(a.kind)&&!(a.kind==='click'&&a.role==='button')));
  return {operation:'BLOCKED',action:null,confidence:1,latency_ms:0};
 };
 await client.callTool({name:'browser_jev_next',arguments:{tabId,goal:'Read the role'}},'test',{taskKind:'rank'});
 assert.equal(await page.evaluate(()=>window.submits),0);
 // A modal's background fields are not actionable application questions.
 await page.setContent('<label>Background<input required></label><div role="dialog" aria-modal="true"><label>Modal field<input required></label></div>');
 result=await call('browser_jev_inspect_form',{tabId});assert.deepEqual(result.fields.map(f=>f.label),['Modal field']);
 // Preparation discovers native attachment/text constraints and cannot dispatch
 // the final button, even if a stale job record says submitting.
 await page.setContent('<form lang="en" onsubmit="event.preventDefault();window.submits++"><label>CV<input type="file" accept=".pdf,.docx" required></label><label>Cover letter<textarea maxlength="500"></textarea></label><button type="submit">Submit application</button></form>');
 await page.evaluate(()=>{window.submits=0;});
 result=await call('browser_jev_inspect_form',{tabId});assert.equal(field('CV').accept,'.pdf,.docx');assert.equal(field('CV').multiple,false);assert.equal(field('Cover letter').maxLength,500);assert.equal(field('Cover letter').language,'en');
 const preparationPage=await call('browser_jev_observe',{tabId}),send=preparationPage.clickTargets.find(t=>t.label==='Submit application');
 const held=JSON.parse((await client.callTool({name:'browser_jev_click',arguments:{tabId,targetId:send.targetId}},'test',{taskKind:'preparation',activeJobId:'prep-job',jobs:[{id:'prep-job',status:'submitting',preparation:{hold:true}}]})).content[0].text);
 assert.equal(held.blockerOrigin,'jobloop_preparation_hold');assert.equal(held.executed,false);assert.equal(await page.evaluate(()=>window.submits),0);
 console.log('APPLICATION_PREFLIGHT_PASS: native/ARIA/label requirements, offscreen and iframe fields, privacy, password redaction, zero side effects');
}finally{await client.close();await rm(directory,{recursive:true,force:true});}
