import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {detectCaptcha} from '../app/captcha-detection.mjs';
import {captureCaptcha,applyCaptcha,verifyCaptchaGrid} from '../app/captcha-browser.mjs';
import {CaptchaSettings} from '../app/captcha-settings.mjs';
import {CaptchaCoordinator} from '../app/captcha-coordinator.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

const require=createRequire(import.meta.url),{chromium}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const directory=await mkdtemp(path.join(tmpdir(),'jobloop-captcha-browser-'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext(),page=await context.newPage();
const svg=color=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${color}"/><circle cx="48" cy="48" r="25" fill="white"/></svg>`).toString('base64');
let checked=false,challenge=true,question='bicycles',late=null;
let turnstileAuto=false;
const turnstile='https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/abc';
const anchor='https://www.google.com/recaptcha/api2/anchor?k=synthetic-key';
const bframe='https://www.google.com/recaptcha/api2/bframe?k=synthetic-key';
const widget=()=>`<div data-sitekey="synthetic-key" data-callback="sendForm"><iframe id="anchor" src="${anchor}" style="width:300px;height:70px"></iframe><iframe id="challenge" src="${bframe}" style="width:360px;height:470px;${challenge?'':'display:none'}"></iframe><textarea name="g-recaptcha-response" hidden></textarea></div><script>window.sent=0;window.sendForm=()=>window.sent++;window.addEventListener('message',e=>{if(e.data==='done'){document.querySelector('#challenge').style.display='none';document.querySelector('textarea').value='accepted-synthetic-token';document.querySelector('#anchor').contentWindow.postMessage('done','*');}});</script>`;
let main=widget();
async function route(route){
 const url=new URL(route.request().url());
 if(url.hostname==='challenges.cloudflare.com')return route.fulfill({contentType:'text/html',body:`<label>Verify you are human<input type="checkbox" onclick="${turnstileAuto?'this.checked=true':'this.checked=false'}"></label>`});
 if(url.pathname.endsWith('/anchor'))return route.fulfill({contentType:'text/html',body:`<div role="checkbox" aria-label="I'm not a robot" aria-checked="${checked}">Verification</div><script>addEventListener('message',e=>{if(e.data==='done')document.querySelector('[role=checkbox]').setAttribute('aria-checked','true')});</script>`});
 if(url.pathname.endsWith('/bframe')){
  if(late)await late;
  return route.fulfill({contentType:'text/html',body:`<style>td{padding:0;width:96px;height:96px}img{display:block;width:96px;height:96px}.rc-imageselect-tileselected{outline:3px solid blue}</style><div class="rc-imageselect-desc-wrapper">Select all images with <strong>${question}</strong></div><table class="rc-imageselect-table-33">${Array.from({length:3},(_,r)=>'<tr>'+Array.from({length:3},(_,c)=>`<td onclick="this.classList.toggle('rc-imageselect-tileselected')"><img src="${svg((r+c)%2?'red':'green')}"></td>`).join('')+'</tr>').join('')}</table><button id="recaptcha-verify-button" onclick="parent.postMessage('done','*')">Verify</button>`});
 }
 return route.fulfill({contentType:'text/html',body:`<!doctype html><title>Fixture</title><h1>Local test</h1>${main}`});
}
await context.route('**/*',route);
const open=async(url='https://example.test/a')=>{await page.goto(url);await page.waitForLoadState('load');};
try{
 console.log('CAPTCHA fixture: idle and grid');
 challenge=false;main=widget();await open();assert.equal((await detectCaptcha(page)).state,'idle');
 checked=true;challenge=true;main=widget();await open('https://another.test/detail?id=42');let evidence=await detectCaptcha(page);
 assert.equal(evidence.state,'active');assert.equal(evidence.target.questionId,'/m/0199g');
 const capture=await captureCaptcha(page,evidence.target);assert.equal(capture.kind,'grid');
 await applyCaptcha(page,evidence.target,capture,{type:'multi',size:3,objects:[0,3]});await verifyCaptchaGrid(page,evidence.target);
 await page.waitForFunction(()=>document.querySelector('#challenge').style.display==='none');assert.equal((await detectCaptcha(page)).state,'cleared');
 assert.equal(await page.evaluate(()=>window.sent),0);
 console.log('CAPTCHA fixture: stale image');
 // Stale image responses never click a replacement puzzle.
 checked=false;main=widget();await open();evidence=await detectCaptcha(page);const stale=await captureCaptcha(page,evidence.target);
 await evidence.target.frame.locator('img').first().evaluate((img,src)=>img.src=src,svg('black'));
 await assert.rejects(()=>applyCaptcha(page,evidence.target,stale,{type:'multi',size:3,objects:[0]}),/değişti/);
 assert.equal(await evidence.target.frame.locator('.rc-imageselect-tileselected').count(),0);
 console.log('CAPTCHA fixture: token');
 // Unknown category uses the token protocol; a site's submit callback is not invoked.
 question='unknown category';main=widget();await open();evidence=await detectCaptcha(page);const token=await captureCaptcha(page,evidence.target);assert.equal(token.kind,'token');
 const applied=await applyCaptcha(page,evidence.target,token,{gRecaptchaResponse:'synthetic-response-token-123456789'});assert.equal(applied.state,'answer_applied');assert.equal(await page.evaluate(()=>window.sent),0);
 console.log('CAPTCHA fixture: negative cases');
 // Mere text, unrelated image grids and OTP fields do not become paid CAPTCHA.
 for(const body of ['<p>OK</p>','<p>Example: CAPTCHA failed</p>','<label>Choose your favorite picture</label>'+Array(9).fill(`<img src="${svg('red')}">`).join(''),`<label>CAPTCHA email OTP <img src="${svg('red')}"><input autocomplete="one-time-code"></label>`]){
  main=body;await open();assert.notEqual((await detectCaptcha(page)).state,'active');
 }
 console.log('CAPTCHA fixture: OCR');
 // OCR requires explicit label/description association, not adjacency to an image.
 main=`<label>CAPTCHA <img src="${svg('red')}"><input type="text"></label>`;await open();evidence=await detectCaptcha(page);assert.equal(evidence.target.provider,'image');
 const ocr=await captureCaptcha(page,evidence.target);await applyCaptcha(page,evidence.target,ocr,{text:'12345'});assert.equal(await page.locator('input').inputValue(),'12345');
 main=`<img src="${svg('red')}"><label>CAPTCHA<input></label>`;await open();assert.notEqual((await detectCaptcha(page)).state,'active');
 console.log('CAPTCHA fixture: delayed frame');
 // A provider frame which has not loaded is unknown, never absent/cleared.
 let finish;late=new Promise(r=>finish=r);question='bicycles';main=widget();
 await page.goto('https://example.test/late',{waitUntil:'domcontentloaded'});assert.equal((await detectCaptcha(page)).state,'unknown');finish();late=null;await page.waitForLoadState('load');for(let n=0;n<5;n++){evidence=await detectCaptcha(page);if(evidence.state==='active')break;await delay(100);}assert.equal(evidence.state,'active');
 console.log('CAPTCHA fixture: BrowserTools');
 // Exercise the real BrowserTools wrapper and Jev observation path, not just adapters.
 const client=new JevBrowser(path.join(directory,'profile'),{connection:'separate',headless:true,config:async()=>({})});
 const db=new DatabaseSync(':memory:');
 try{
  const c=await client.context();await c.route('**/*',route);
  const target=await c.newPage(),slot=await client.track(c,target);main=widget();await target.goto('https://example.test/flow');slot.owner='owner';
  let requests=0;const settings=new CaptchaSettings(db,{encrypt:x=>x,decrypt:x=>x,client:{solve:async(_key,task)=>{requests++;return task.type==='AntiTurnstileTaskProxyLess'?{token:'synthetic-turnstile-token-123456789'}:{type:'multi',size:3,objects:[0]};}}});settings.save({apiKey:'synthetic-key',enabled:true});
  const tools=new BrowserTools(directory);tools.clients.set('workspace',{client,pending:Promise.resolve({client})});tools.captcha=new CaptchaCoordinator(settings,{settleMs:50});
  tools.prepare=()=>({ready:true});tools.connect=async()=>({client});
  const response=await tools.call('workspace','browser_jev_observe',{tabId:slot.id},'owner');const value=JSON.parse(response.content[0].text);
  assert.equal(requests,1);assert.equal(value.captcha.state,'cleared');assert.equal(value.verification.state,'cleared');
  assert.equal(await target.evaluate(()=>window.sent),0);
  // Turnstile first uses its visible checkbox, then solves only a remaining
  // active control. A noninteractive frame with no readable state stays unknown.
  main=`<div data-sitekey="synthetic-turnstile-key"><iframe src="${turnstile}" style="width:300px;height:90px"></iframe><input name="cf-turnstile-response" type="hidden"></div>`;
  await target.goto('https://different.test/turnstile?query=1');
  let v=JSON.parse((await tools.call('workspace','browser_jev_observe',{tabId:slot.id},'owner')).content[0].text);assert.equal(requests,1);
  const checkbox=v.clickTargets.find(t=>t.verification);assert.ok(checkbox);
  v=JSON.parse((await tools.call('workspace','browser_jev_click',{tabId:slot.id,targetId:checkbox.targetId},'owner')).content[0].text);
  assert.equal(requests,2);assert.equal(v.captcha.state,'answer_applied');assert.equal(v.verification.state,'answer_applied');
  // Record forms require an existing reservation, before any paid request.
  main='<form><label>Name<input value="Synthetic person"></label>'+widget()+'</form>';await target.goto('https://different.test/apply');
  v=JSON.parse((await tools.call('workspace','browser_jev_observe',{tabId:slot.id},'owner')).content[0].text);
  assert.equal(requests,2);assert.equal(v.status,'verification_handoff');assert.match(v.captcha.message,/yetkisi/);
 }finally{await client.close();db.close();}
 console.log('CAPTCHA_BROWSER_PASS');
}finally{await browser.close();await rm(directory,{recursive:true,force:true});}
