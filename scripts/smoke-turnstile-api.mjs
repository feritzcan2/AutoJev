import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {CaptchaSettings} from '../app/captcha-settings.mjs';
import {CaptchaCoordinator} from '../app/captcha-coordinator.mjs';
import {CapsolverClient} from '../app/capsolver-client.mjs';
import {SiteAccess} from '../app/site-access.mjs';
import {detectCaptcha} from '../app/captcha-detection.mjs';
import {captureCaptcha,applyCaptcha} from '../app/captcha-browser.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'turnstile-api-')),db=new DatabaseSync(':memory:');
const browsers=new BrowserTools(directory,()=>({connection:'separate',headless:true}));
let tasks=0,polls=0,callbacks=0,hold=null,start,apiError=null,now=Date.now();
const token='synthetic-turnstile-answer-123456789';
const settings=new CaptchaSettings(db,{encrypt:x=>x,decrypt:x=>x,client:new CapsolverClient({pollMs:5,fetchImpl:async(url,request)=>{
 const payload=JSON.parse(request.body);
 if(url.endsWith('/createTask')){
  tasks++;assert.equal(payload.task.type,'AntiTurnstileTaskProxyLess');assert.equal(payload.task.websiteKey,'synthetic-sitekey');
  assert.deepEqual(payload.task.metadata,{action:'read',cdata:'synthetic-context'});start?.();
  if(apiError)return new Response(JSON.stringify({errorId:1,errorCode:apiError}));
  return new Response(JSON.stringify({errorId:0,taskId:'synthetic-'+tasks,status:'processing'}));
 }
 polls++;if(hold)await hold;
 return new Response(JSON.stringify({errorId:0,status:'ready',solution:{token}}));
}})});
settings.save({apiKey:'synthetic-api-key',enabled:true});browsers.captcha=new CaptchaCoordinator(settings,{settleMs:30});
browsers.siteAccess=new SiteAccess(db,{now:()=>now});
const {client}=await browsers.connect('workspace'),context=await client.context();
const provider='https://challenges.cloudflare.com',widget=provider+'/cdn-cgi/challenge-platform/h/b/turnstile/fixture';
await context.route('https://**/*',async route=>{
 const request=route.request(),url=new URL(request.url());
 if(url.origin===provider&&url.pathname.endsWith('/api.js'))return route.fulfill({contentType:'text/javascript',body:`window.turnstile={render(container,options){const host=document.querySelector(container);const root=host.attachShadow({mode:'closed'});root.innerHTML='<iframe title="Cloudflare security challenge" src="${widget}" style="border:0;width:300px;height:70px"></iframe>';return 'widget';},reset(){},remove(){}};`});
 if(url.origin===provider)return route.fulfill({contentType:'text/html',body:`<div id="host"></div><script>const root=document.getElementById('host').attachShadow({mode:'closed'});root.innerHTML='<style>label{position:relative;display:flex;padding:10px;gap:8px}label:before{content:"";width:20px;height:20px;border:1px solid}input{position:absolute;width:24px;height:24px;opacity:0}</style><label><input type="checkbox">Verify you are human</label>';</script>`});
 if(url.pathname==='/token'){
  callbacks++;assert.equal(request.method(),'POST');assert.equal(request.postData(),token);
  return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:!url.searchParams.has('reject')})});
 }
 if(url.pathname==='/done')return route.fulfill({contentType:'text/html',body:'<title>Results</title><h1>Current results</h1><article>The requested page content is available and ready to read.</article>'});
 if(url.pathname==='/implicit')return route.fulfill({status:403,contentType:'text/html',body:`<title>Just a moment...</title><h1>Additional Verification Required</h1><p>Cloudflare — Your Ray ID: fixture</p><div id="widget" data-sitekey="synthetic-sitekey" data-action="read" data-cdata="synthetic-context" data-callback="acceptToken"><iframe src="${widget}" style="width:300px;height:70px"></iframe></div><script>window.callbackCalls=0;window.acceptToken=async token=>{window.callbackCalls++;const r=await fetch('/token',{method:'POST',body:token});if((await r.json()).ok)location.href='/done';};</script>`});
 const form=url.pathname==='/form',hidden=url.pathname==='/hidden',managed=url.pathname==='/managed',noCallback=url.pathname==='/no-callback';
 return route.fulfill({status:url.pathname==='/429'?429:form?200:403,contentType:'text/html',body:`<title>${form?'Form':'Just a moment...'}</title>${form?'<form><label>Name<input value="Synthetic person"></label>':'<h1>Additional Verification Required</h1><p>Cloudflare — Your Ray ID: fixture</p>'}<div id="widget" ${hidden?'hidden':''}></div>${form?'<input type="hidden" name="cf-turnstile-response"></form>':''}<script src="${provider}/turnstile/v0/api.js?render=explicit"></script><script>window.callbackCalls=0;turnstile.render('#widget',{sitekey:'synthetic-sitekey',action:'read',cData:'synthetic-context',${managed?"chlPageData:'managed-payload',":''}${noCallback?'':`callback:async token=>{window.callbackCalls++;const reply=await fetch('/token${url.pathname==='/reject'?'?reject=1':''}',{method:'POST',body:token});if((await reply.json()).ok)location.href='/done';}`} });</script>`});
});
const adapter=(url,worker=browsers,extra={})=>automationBrowser(worker,{sourceUrl:url,readTabKey:'source:'+url,...extra});
const open=(url,worker=browsers,extra)=> (extra?.recordId?automationBrowser(worker,extra):adapter(url,worker,extra)).call('workspace','browser_navigate',{url},'run');
try{
 console.log('Turnstile API: full-page, closed shadow root, callback, content acceptance');
 for(const url of ['https://first.test/item/1','https://second.test/?item=abc','https://third.test/#/details','https://fourth.test/429','https://implicit.test/implicit']){
  const before=tasks,response=await open(url);
  assert.equal(tasks,before+1);assert.equal(response.siteWait,undefined,JSON.stringify(response));
  assert.match(response.jevPage.text,/requested page content/);assert.equal(client.tab(response.pageContext.tabId).turnstileBarrier.phase,'cleared');
  assert.equal(browsers.siteAccess.status(url),null);
 }
 assert.equal(callbacks,5);assert.equal(polls,5);assert.equal(settings.used(),5);
 console.log('Turnstile API: source probe and record guard');
 const retry='https://retry-api.test/check';browsers.siteAccess.block(retry,'verification');now+=5*60000;
 assert.equal((await open(retry)).siteWait,undefined);assert.equal(browsers.siteAccess.status(retry),null);
 const beforeRecord=tasks;
 assert.ok((await open('https://record-api.test/check',browsers,{readTabKey:'record:fixture',recordId:'fixture'})).siteWait);assert.equal(tasks,beforeRecord);
 console.log('Turnstile API: API ready is not accepted, no duplicate callback/task');
 const reject='https://rejected.test/reject',rejected=await open(reject),after=tasks;
 assert.equal(rejected.siteWait.reason,'verification');assert.equal(rejected.jevPage.captcha.state,'handoff');
 assert.match(rejected.jevPage.captcha.message,/engeli kalkmadı/);
 const repeat=await browsers.call('workspace','browser_jev_observe',{tabId:rejected.pageContext.tabId},'run');assert.ok(JSON.parse(repeat.content[0].text).siteWait);assert.equal(tasks,after);
 console.log('Turnstile API: provider failure appears in the wait card');
 apiError='ERROR_ZERO_BALANCE';const beforeError=tasks,error=await open('https://api-error.test/check');apiError=null;
 assert.equal(tasks,beforeError+1);assert.equal(error.jevPage.captcha.state,'handoff');assert.match(error.siteWait.message,/bakiye/i);
 console.log('Turnstile API: hidden, missing callback, managed payload and ordinary form');
 const page=await context.newPage(),slot=await client.track(context,page);slot.owner='run';
 for(const name of ['hidden','no-callback','managed']){
  await page.goto('https://negative.test/'+name);await page.waitForLoadState('load');
  const detection=await detectCaptcha(slot.page);assert.notEqual(detection.state,'active',name);
 }
 await page.goto('https://negative.test/form');await page.waitForLoadState('load');
 const form=await detectCaptcha(slot.page);assert.equal(form.state,'active');assert.equal(form.target.requiresSubmissionPermission,true);
 const captured=await captureCaptcha(slot.page,form.target);assert.equal(captured.kind,'token');
 await applyCaptcha(slot.page,form.target,captured,{token});assert.equal(await page.evaluate(()=>window.callbackCalls),0);
 // A reset invalidates the old capture before any callback or paid application.
 await page.goto('https://negative.test/reset');await page.waitForLoadState('load');
 const first=await detectCaptcha(slot.page),old=await captureCaptcha(slot.page,first.target);
 await page.evaluate(()=>turnstile.reset('widget'));
 assert.notEqual((await detectCaptcha(slot.page)).target.identity,first.target.identity);
 await assert.rejects(()=>applyCaptcha(slot.page,first.target,old,{token},{allowBarrierCallback:true}),/değişti/);
 assert.equal(await page.evaluate(()=>window.callbackCalls),0);
 // Callback exceptions do not allow a second delivery of the same token.
 await page.goto('https://negative.test/throw');await page.waitForLoadState('load');
 // Use a fresh container so the provider can create its closed root again.
 await page.evaluate(()=>{const e=document.createElement('div');e.id='replacement';document.body.append(e);turnstile.render('#replacement',{sitekey:'synthetic-sitekey',callback:()=>{window.callbackCalls++;throw Error('fixture callback failure');}});document.getElementById('widget').remove();});
 let throwing;
 for(let n=0;n<30;n++){throwing=await detectCaptcha(slot.page);if(throwing.state==='active')break;await delay(50);}
 assert.equal(throwing.state,'active',throwing.reason);
 const throwCapture=await captureCaptcha(slot.page,throwing.target);
 await assert.rejects(()=>applyCaptcha(slot.page,throwing.target,throwCapture,{token},{allowBarrierCallback:true}),/fixture callback failure/);
 await assert.rejects(()=>applyCaptcha(slot.page,throwing.target,throwCapture,{token},{allowBarrierCallback:true}));assert.equal(await page.evaluate(()=>window.callbackCalls),1);
 await page.goto('https://negative.test/implicit');await page.waitForLoadState('load');
 const implicit=await detectCaptcha(slot.page),implicitCapture=await captureCaptcha(slot.page,implicit.target);
 await page.locator('#widget').evaluate(e=>e.setAttribute('data-cdata','replacement-context'));
 assert.notEqual((await detectCaptcha(slot.page)).target.identity,implicit.target.identity);
 await assert.rejects(()=>applyCaptcha(slot.page,implicit.target,implicitCapture,{token},{allowBarrierCallback:true}),/değişti/);assert.equal(await page.evaluate(()=>window.callbackCalls),0);
 console.log('Turnstile API: navigation during solver, queue remains available');
 let release;hold=new Promise(r=>release=r);const started=new Promise(r=>start=r),changed='https://changed.test/check';
 const solving=open(changed);const cancelled=assert.rejects(solving);
 await started;start=null;
 let available=false;await browsers.enqueue('workspace',()=>{available=true;});assert.equal(available,true);
 const inFlight=[...client.tabs.values()].find(s=>s.page.url()===changed);const beforeCallbacks=callbacks;
 await inFlight.page.goto('https://changed.test/done');release();hold=null;await cancelled;assert.equal(callbacks,beforeCallbacks);
 console.log('TURNSTILE_API_PASS');
}finally{await browsers.close();db.close();await rm(directory,{recursive:true,force:true});}
