// Existing Chrome contract: shared login, separate windows, scoped tabs, safe disconnect.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {JevTabs} from '../app/jev-tabs.mjs';
import {SiteAccess} from '../app/site-access.mjs';
import {clickCloudflareCheckbox} from '../app/cloudflare-checkbox.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {CaptchaSettings} from '../app/captcha-settings.mjs';
import {CaptchaCoordinator} from '../app/captcha-coordinator.mjs';
import {startJevFixture} from './jev-demo.mjs';
const require=createRequire(import.meta.url),{chromium}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const directory=await mkdtemp(path.join(os.tmpdir(),'jev-existing-test-')),fixture=await startJevFixture();
const context=await chromium.launchPersistentContext(directory,{channel:'chrome',headless:true,args:['--remote-debugging-port=0']});
const browser=context.browser(),root=await browser.newBrowserCDPSession(),personal=context.pages()[0];
await personal.goto(fixture.url);await context.addCookies([{name:'test_login',value:'existing-session',url:fixture.url}]);
const session=await context.newCDPSession(personal),{targetInfo}=await session.send('Target.getTargetInfo');
const [port,route]=(await readFile(path.join(directory,'DevToolsActivePort'),'utf8')).trim().split('\n');
const endpoint=async()=>`ws://127.0.0.1:${port}${route}`;
const openWindow=async url=>root.send('Target.createTarget',{url,newWindow:true,browserContextId:targetInfo.browserContextId});
const db=new DatabaseSync(':memory:');
const client=new JevBrowser(path.join(directory,'candidate'),{profile:{directory:'Test'},endpoint,openWindow,siteAccess:new SiteAccess(db),autoVerify:()=>true});
try{
 await context.route('https://portal.test/**',r=>r.fulfill({contentType:'text/html',body:`<iframe title="reCAPTCHA" src="https://recaptcha.net/recaptcha/api2/anchor?fixture=1" style="width:304px;height:150px"></iframe><button onclick="document.body.textContent='Listings'">Absenden</button>`}));
 await context.route('https://recaptcha.net/recaptcha/api2/anchor*',r=>r.fulfill({contentType:'text/html',body:`<span id="recaptcha-anchor" role="checkbox" aria-checked="false" style="display:inline-block;width:28px;height:28px" onclick="this.setAttribute('aria-checked','true')">✓</span>`}));
 const o=JSON.parse((await client.callTool({name:'browser_jev_open',arguments:{url:'https://portal.test/register'}},'local',{})).content[0].text);
 const slot=client.tab(o.tabId);await slot.page.frames()[1].waitForLoadState();
 const obs=await client.observe(slot);
 assert.ok(obs.clickTargets.some(t=>t.verification));
 assert.equal(obs.verification.checkbox,true);
 const call=async(name,args)=>JSON.parse((await client.callTool({name,arguments:args},'local',{})).content[0].text);
 const checked=await call('browser_jev_click',{tabId:o.tabId,targetId:obs.clickTargets.find(t=>t.verification).targetId});
 assert.equal(checked.executed,true);
 assert.equal(checked.verification.state,'cleared');
 const continued=await call('browser_jev_click',{tabId:o.tabId,targetId:checked.clickTargets.find(t=>t.label==='Absenden').targetId});
 assert.equal(continued.executed,true);
 assert.equal(await slot.page.locator('body').innerText(),'Listings');
 // The scoped existing-Chrome transport must expose the real checkbox even
 // when the provider keeps it inside a closed shadow root and cross-origin frame.
 let nativeClicks=0;
 await context.route('https://challenges.cloudflare.com/**',r=>{
  const mode=new URL(r.request().url()).searchParams.get('mode'),tag=mode==='unlabelled'?'div':'label';
  return r.fulfill({contentType:'text/html',body:`<div id="widget"></div><script>const root=document.getElementById('widget').attachShadow({mode:'closed'});root.innerHTML='<${tag} style="position:relative;display:flex;align-items:center;gap:8px;padding:8px;${mode==='hidden'?'opacity:0':''}"><input type="checkbox" ${mode==='disabled'?'disabled':''} style="position:absolute;inset:0;opacity:0;z-index:9999;width:100%;height:100%;margin:0"><span style="width:24px;height:24px;border:2px solid black"></span>Verify human${mode==='covered'?'<span style="position:absolute;inset:0;z-index:10000;background:white"></span>':''}</${tag}>';root.querySelector('input').onclick=()=>parent.postMessage('verified','*');</script>`});
 });
 await context.route('https://barrier.test/**',r=>{
  if(new URL(r.request().url()).pathname==='/done'){nativeClicks++;return r.fulfill({contentType:'text/html',body:'<h1>Actual content</h1><article>Verification completed and the requested content is available.</article>'});}
  const mode=new URL(r.request().url()).pathname.slice(1);
  return r.fulfill({status:403,contentType:'text/html',body:`<title>Just a moment...</title><h1>Additional Verification Required</h1><p>Cloudflare — Your Ray ID: synthetic</p><div id="host"></div><script>document.getElementById('host').attachShadow({mode:'closed'}).innerHTML='<iframe style="position:absolute;left:250px;top:140px;width:300px;height:65px" src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/test/turnstile?mode=${mode}"></iframe>';addEventListener('message',e=>{if(e.origin==='https://challenges.cloudflare.com'&&e.data==='verified')location.href='/done';});</script>`});
 });
 const barrier=await call('browser_jev_open',{url:'https://barrier.test/access'});
 assert.equal(barrier.status,'verification_pending');
 const barrierSlot=client.tab(barrier.tabId);
 assert.equal(await clickCloudflareCheckbox(barrierSlot,()=>{}),true);
 await barrierSlot.page.waitForURL('https://barrier.test/done');
 const recovered=await client.observe(barrierSlot);
 assert.match(recovered.text,/Actual content/);assert.equal(nativeClicks,1);
 assert.equal(await clickCloudflareCheckbox(barrierSlot,()=>{}),false);
 for(const mode of ['hidden','covered','disabled','unlabelled']){
  // Isolate site cooldown state to exercise detection for every negative case.
  db.exec('DELETE FROM browser_site_waits');
  let negative=await call('browser_jev_open',{url:'https://barrier.test/'+mode});
  if(negative.status==='verification_pending'){
   const pending=client.tab(negative.tabId);assert.equal(pending.cloudflareCheckbox,null,mode);
   pending.cloudflareDiscovery.until=Date.now()-1;
   negative=await call('browser_jev_observe',{tabId:negative.tabId});
  }
  assert.equal(negative.status,'site_wait',mode);assert.equal(nativeClicks,1);
 }
 // The API registration bridge must also work through scoped, noDefaults CDP.
 // Nothing is installed into the unrelated personal tab.
 let paid=0,accepted=0;
 const settings=new CaptchaSettings(db,{encrypt:x=>x,decrypt:x=>x,client:{solve:async(_key,task)=>{
  paid++;assert.equal(task.type,'AntiTurnstileTaskProxyLess');assert.equal(task.websiteKey,'synthetic-key');return {token:'synthetic-valid-token-123456789'};
 }}});settings.save({apiKey:'synthetic-key',enabled:true});
 const tools=new BrowserTools(directory);tools.clients.set('scope',{client,pending:Promise.resolve({client})});tools.prepare=()=>({ready:true});tools.connect=async()=>({client});tools.captcha=new CaptchaCoordinator(settings,{settleMs:30});
 await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js*',r=>r.fulfill({contentType:'text/javascript',body:`window.turnstile={render(selector,options){document.querySelector(selector).attachShadow({mode:'closed'}).innerHTML='<iframe style="width:300px;height:65px" src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/test/turnstile"></iframe>';return 'widget';}};`}));
 await context.route('https://api-barrier.test/**',r=>{
  if(new URL(r.request().url()).pathname==='/done'){accepted++;return r.fulfill({contentType:'text/html',body:'<title>Results</title><h1>Requested content</h1><article>The API callback was accepted and content is ready.</article>'});}
  return r.fulfill({status:403,contentType:'text/html',body:`<title>Just a moment...</title><h1>Additional Verification Required</h1><p>Cloudflare — Your Ray ID: synthetic</p><div id="widget"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script><script>turnstile.render('#widget',{sitekey:'synthetic-key',callback:token=>{if(token==='synthetic-valid-token-123456789')location.href='/done';}});</script>`});
 });
 const solved=JSON.parse((await tools.call('scope','browser_jev_open',{url:'https://api-barrier.test/check'},'local')).content[0].text);
 assert.equal(paid,1,JSON.stringify(solved));assert.equal(accepted,1);assert.equal(solved.captcha.state,'cleared');assert.match(solved.text,/API callback was accepted/);
 assert.equal(await personal.evaluate(()=>typeof window.__autoJevTurnstileRegistration),'undefined');
 assert.equal(personal.isClosed(),false);
 assert.equal(personal.url(),fixture.url);
 console.log('SCOPED_CDP_CROSS_ORIGIN_CHECKBOX_CLICK_AND_CONTINUE_PASS: reCAPTCHA, Cloudflare closed shadow root, paid Turnstile callback; personal tab preserved');
}finally{await client.close();await context.close();await fixture.close();db.close();await rm(directory,{recursive:true,force:true});}
