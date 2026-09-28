import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-verification-'));let modelCalls=0;
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{modelCalls++;throw Error('No model call expected for unsupported verification');}});
const call=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args},'test')).content[0].text);
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await page.setContent('<iframe title="hCaptcha challenge" style="width:300px;height:250px"></iframe><button onclick="window.sent=true">Submit application</button>');
 let result=await call('browser_jev_observe',{tabId});assert.equal(result.verification.capability,'not_exposed');assert.equal(result.verification.handoff,true);
 result=await call('browser_jev_next',{tabId,goal:'Solve challenge'});assert.equal(result.status,'verification_handoff');assert.equal(modelCalls,0);
 const submit=(await client.observe(slot)).clickTargets.find(c=>c.label==='Submit application');
 result=await call('browser_jev_click',{tabId,targetId:submit.targetId});assert.equal(result.executed,false);assert.equal(await page.evaluate(()=>Boolean(window.sent)),false);
 const first=await client.callTool({name:'browser_jev_screenshot',arguments:{tabId}},'test');assert.ok(first.content.some(p=>p.type==='image'));
 const second=await client.callTool({name:'browser_jev_screenshot',arguments:{tabId}},'test');assert.ok(!second.content.some(p=>p.type==='image'));
 // A passive/hidden provider widget is not evidence of an unresolved challenge.
 await page.setContent('<iframe title="reCAPTCHA"></iframe><iframe title="hCaptcha challenge" hidden></iframe><label>Name<input></label>');
 result=await call('browser_jev_observe',{tabId});assert.equal(result.verification,null);assert.equal(slot.verification,undefined);
 // A generic verification error is not mislabeled as a proven CAPTCHA.
 await page.setContent('<p>There was an error verifying your application. Please try again.</p>');
 result=await call('browser_jev_observe',{tabId});assert.equal(result.verification.state,'verification_error');assert.equal(result.verification.capability,'unknown');
 slot.verification.startedAt=Date.now()-61000;
 result=await call('browser_jev_next',{tabId,goal:'Inspect error'});assert.equal(result.status,'verification_handoff');assert.match(result.message,/does not prove/);assert.equal(modelCalls,0);
 // Preserve the separately authorized one-step continuation flow after a reply.
 await page.setContent('<iframe title="hCaptcha challenge" style="width:300px;height:250px"></iframe><button onclick="window.continued=(window.continued||0)+1">Continue verification</button>');
 const job={id:'job',status:'uncertain',verificationContinuation:{reservedAt:new Date().toISOString(),actionLabel:'Continue verification'}};client.tabJobs.set(tabId,job.id);
 const reservedCall=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args},'test',{jobs:[job]})).content[0].text);
 result=await reservedCall('browser_jev_next',{tabId,goal:'Complete the reserved step once'});assert.equal(result.status,'verification_continuation_reserved');
 result=await reservedCall('browser_jev_click',{tabId,targetId:result.clickTargets[0].targetId});assert.equal(result.executed,true);assert.equal(await page.evaluate(()=>window.continued),1);
 result=await reservedCall('browser_jev_next',{tabId,goal:'Try again'});assert.equal(result.status,'verification_handoff');assert.equal(await page.evaluate(()=>window.continued),1);
 console.log('PASS: unsupported iframe stops without model call, no resubmit, screenshot bounded, passive widget ignored, generic error not asserted as CAPTCHA, 60-second budget enforced');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
