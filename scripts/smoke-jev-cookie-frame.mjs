import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-cookie-frame-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({})});
const call=async(name,args,owner='test')=>JSON.parse((await client.callTool({name,arguments:args},owner)).content[0].text);
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 const setup=async(extra='')=>{
  await page.setContent('<h1>Application draft</h1><iframe title="Cookie Banner" '+extra+' style="width:650px;height:300px"></iframe>');
  await page.locator('iframe').evaluate(e=>{e.srcdoc='<p>We use cookies. Choose your privacy preferences.</p><button onclick="parent.postMessage(\'declined\',\'*\')">Decline</button><button>Accept</button>';});
  await page.frames()[1].waitForLoadState();
  await page.evaluate(()=>{window.consentClicks=0;window.onmessage=e=>{if(e.data==='declined'){window.consentClicks++;document.querySelector('iframe').remove();}};});
  return call('browser_jev_observe',{tabId,full:true});
 };
 const initialPages=context.pages().length;
 let o=await setup();let target=o.clickTargets.find(t=>t.label==='Decline');assert.ok(target);assert.equal(target.frameUrl,'about:srcdoc');
 o=await call('browser_jev_observe',{tabId});assert.ok(o.clickTargets.some(t=>t.targetId===target.targetId));
 await assert.rejects(()=>call('browser_jev_click',{tabId,targetId:target.targetId},'foreign'),/oturuma/);
 o=await call('browser_jev_click',{tabId,targetId:target.targetId});assert.equal(o.executed,true);await page.waitForFunction(()=>window.consentClicks===1);assert.equal(await page.evaluate(()=>window.consentClicks),1);assert.equal(await page.locator('iframe').count(),0);assert.equal(context.pages().length,initialPages);
 o=await call('browser_jev_observe',{tabId});assert.ok(!o.clickTargets.some(t=>t.frameUrl==='about:srcdoc'));
 o=await setup();target=o.clickTargets.find(t=>t.label==='Accept');
 await page.frames()[1].locator('button').last().evaluate(e=>e.textContent='Submit application');
 o=await call('browser_jev_click',{tabId,targetId:target.targetId});assert.equal(o.executed,false);assert.equal(o.status,'stale');
 o=await setup('sandbox="allow-scripts"');assert.ok(!o.clickTargets.some(t=>t.frameUrl==='about:srcdoc'));
 o=await setup('id="captcha-challenge"');assert.ok(!o.clickTargets.some(t=>t.frameUrl==='about:srcdoc'));
 o=await setup();target=o.clickTargets.find(t=>t.label==='Decline');
 await page.evaluate(()=>{const cover=document.createElement('div');cover.style='position:fixed;inset:0;background:white;z-index:9999';document.body.append(cover);});
 o=await call('browser_jev_click',{tabId,targetId:target.targetId});assert.equal(o.status,'uncertain');assert.equal(await page.evaluate(()=>window.consentClicks),0);
 console.log('SRCDOC_COOKIE_IN_PLACE_OWNER_STALE_SANDBOX_OVERLAY_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
