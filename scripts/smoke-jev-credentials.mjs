import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-credentials-'));
let configured=false,pending=null,gmailCodes=false;const secret='Fixture-secret-938!';
const vault={status:()=>({configured,email:'candidate@example.com',gmailCodes,pending}),secret:()=>secret,request:r=>pending=r,clearRequest:()=>pending=null};
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({}),accountVault:vault});
const state={activeJobId:'job',taskKind:'application',jobs:[{id:'job',status:'working'}]};
const call=async(name,args,owner='test',s=state)=>JSON.parse((await client.callTool({name,arguments:args},owner,s)).content[0].text);
try{
 const context=await client.context();await context.route('https://portal.test/**',route=>route.fulfill({contentType:'text/html',body:'<label>Email<input type="email" value="candidate@example.com"></label><label>Password<input type="password" autocomplete="new-password"></label><label>Confirm password<input type="password" autocomplete="new-password"></label><button type="button" onclick="window.sends++">Create account</button>'}));
 const page=await context.newPage();await page.goto('https://portal.test/signup');const slot=await client.track(context,page),tabId=slot.id;client.tabJobs.set(tabId,'job');await page.evaluate(()=>window.sends=0);
 let o=await call('browser_jev_observe',{tabId});assert.equal(o.passwordFields.length,2);assert.ok(!o.fillFields.some(f=>/password/i.test(f.label)));
 let args={tabId,email:'candidate@example.com',fieldIds:o.passwordFields.map(f=>f.fieldId)};
 let r=await call('browser_jev_fill_account_password',args);assert.equal(r.status,'credential_required');assert.equal(pending.origin,'https://portal.test');
 configured=true;o=await call('browser_jev_observe',{tabId});args={...args,fieldIds:o.passwordFields.map(f=>f.fieldId)};
 await assert.rejects(()=>call('browser_jev_fill_account_password',{...args,email:'other@example.com'}),/eşleşmiyor/);
 await assert.rejects(()=>call('browser_jev_fill_account_password',args,'other'),/kimlikleri/);
 r=await call('browser_jev_fill_account_password',args);assert.equal(r.passwordFilled,true);assert.ok(!JSON.stringify(r).includes(secret));
 assert.equal(await page.locator('input[type=password]').first().inputValue(),secret);assert.equal(await page.locator('input[type=password]').last().inputValue(),secret);assert.equal(await page.evaluate(()=>window.sends),0);
 const inspect=await call('browser_jev_inspect_form',{tabId});assert.ok(!JSON.stringify(inspect).includes(secret));
 // Saved login exposes only readiness; signup never qualifies.
 assert.equal((await call('browser_jev_observe',{tabId})).savedLogin,null);
 await page.setContent('<form><label>Email Address<input type="text" value="candidate@example.com"></label><label>Password<input type="password" autocomplete="current-password"></label><button type="button" onclick="window.loginClicks=(window.loginClicks||0)+1">Sign In</button></form>');
 o=await call('browser_jev_observe',{tabId});assert.equal(o.savedLogin.ready,false);assert.equal(o.passwordFields[0].filled,false);
 await page.locator('input[type=password]').fill(secret);
 o=await call('browser_jev_observe',{tabId});assert.equal(o.savedLogin.ready,true);assert.equal(o.passwordFields[0].filled,true);assert.ok(!JSON.stringify(o).includes(secret));
 const signIn=o.clickTargets.find(t=>t.label==='Sign In');assert.ok(signIn);
 await call('browser_jev_click',{tabId,targetId:signIn.targetId});assert.equal(await page.evaluate(()=>window.loginClicks),1);
 await page.locator('input[type=text]').fill('');o=await call('browser_jev_observe',{tabId});assert.equal(o.savedLogin.ready,false);
 await page.locator('input[type=text]').fill('candidate@example.com');
 await page.evaluate(()=>{const otp=document.createElement('input');otp.autocomplete='one-time-code';document.querySelector('form').append(otp);});
 o=await call('browser_jev_observe',{tabId});assert.equal(o.savedLogin.ready,false);assert.equal(o.savedLogin.requiresUser,true);
 // Text email fields (Workday-style), including associated labels and shadow roots.
 for(const emailField of ['<label>Email Address<input type="text" value="candidate@example.com"></label>','<span id="email-label">Email address</span><input aria-labelledby="email-label" value="candidate@example.com">']){
  await page.setContent(`<form>${emailField}<input type="password"></form>`);
  o=await call('browser_jev_observe',{tabId});
  r=await call('browser_jev_fill_account_password',{tabId,email:'candidate@example.com',fieldIds:o.passwordFields.map(f=>f.fieldId)});
  assert.equal(r.passwordFilled,true);
 }
 // Password guidance is not a rejection.
 await page.setContent('<form><label>Email<input type="email" value="candidate@example.com"></label><input type="password" aria-describedby="guidance"><p id="guidance">Your password must have at least 12 characters.</p></form>');
 o=await call('browser_jev_observe',{tabId});assert.equal(o.passwordFields[0].validation.siteRejected,false);
 // Transfer success must not conceal a visible site rejection.
 await page.setContent('<form><label>Email<input type="email" value="candidate@example.com"></label><div class="field"><input type="password" aria-describedby="pw-error"><p id="pw-error">The password does not meet security requirements</p></div></form>');
 o=await call('browser_jev_observe',{tabId});
 assert.equal(o.passwordFields[0].validation.siteRejected,true);
 r=await call('browser_jev_fill_account_password',{tabId,email:'candidate@example.com',fieldIds:o.passwordFields.map(f=>f.fieldId)});
 assert.equal(r.status,'credential_invalid');assert.equal(r.passwordAccepted,false);assert.equal(r.retryable,false);
 assert.equal(pending.reason,'password_validation_failed');assert.ok(!JSON.stringify(r).includes(secret));
 // A matching email elsewhere on the page cannot authorize a different form.
 await page.setContent('<label>Email<input type="email" value="candidate@example.com"></label><form><label>Email<input value="other@example.com"></label><input type="password"></form>');
 o=await call('browser_jev_observe',{tabId});
 r=await call('browser_jev_fill_account_password',{tabId,email:'candidate@example.com',fieldIds:o.passwordFields.map(f=>f.fieldId)});
 assert.equal(r.status,'account_email_unverified');assert.equal(r.retryable,false);
 assert.equal(await page.locator('input[type=password]').inputValue(),'');
 // Hidden fields and arbitrary text values must not establish account identity.
 await page.setContent('<input type="email" hidden value="candidate@example.com"><label>Notes<input value="candidate@example.com"></label><input type="password">');
 o=await call('browser_jev_observe',{tabId});
 r=await call('browser_jev_fill_account_password',{tabId,email:'candidate@example.com',fieldIds:o.passwordFields.map(f=>f.fieldId)});
 assert.equal(r.status,'account_email_unverified');
 await page.evaluate(()=>window.sends=0);
 await assert.rejects(()=>call('browser_jev_open_verification_mail',{}),/Gmail izni/);
 await context.route('https://mail.google.com/**',route=>route.fulfill({contentType:'text/html',body:'<h1>candidate@example.com</h1><p>Fixture inbox</p>'}));
 gmailCodes=true;const mail=await call('browser_jev_open_verification_mail',{});
 assert.equal(mail.verificationMail,true);assert.equal(mail.expectedEmail,'candidate@example.com');
 assert.notEqual(mail.tabId,tabId);assert.equal(page.url(),'https://portal.test/signup');
 assert.equal(client.tabJobs.has(mail.tabId),false);
 assert.equal(await page.evaluate(()=>window.sends),0);

 console.log('SECURE_PASSWORD_REQUEST_FILL_REDACTION_SCOPE_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
