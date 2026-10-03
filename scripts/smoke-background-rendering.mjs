// Regular Chrome, without Playwright launch flags or focus defaults. Those
// defaults mask background requestAnimationFrame stalls in normal smoke tests.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {setTimeout as sleep} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {findChrome} from '../app/chrome-installation.mjs';
import {documentReadiness,renderedDocument,waitForDocument} from '../app/jev-document.mjs';

const require=createRequire(import.meta.url),{chromium}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const directory=await mkdtemp(path.join(os.tmpdir(),'jev-background-rendering-'));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Local rendering fixture</title><h1>Shell</h1><div hidden id="S:1"><article>ACTUAL_CONTENT</article></div><div hidden>PRIVATE_HIDDEN_TEXT</div>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const child=spawn(await findChrome(),[`--user-data-dir=${directory}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
const exited=new Promise(resolve=>child.once('exit',resolve));let browser;
try{
 let endpoint;
 for(let i=0;i<100;i++){
  try{const [port,route]=(await readFile(path.join(directory,'DevToolsActivePort'),'utf8')).trim().split('\n');endpoint=`ws://127.0.0.1:${port}${route}`;break;}catch{await sleep(100);}
 }
 assert.ok(endpoint,'Chrome starts with an isolated test profile');
 browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});
 const context=browser.contexts()[0],page=context.pages()[0],other=await context.newPage(),front=await context.newPage();
 const cdp=await context.newCDPSession(page),slot={page,cdp};
 await other.goto(url+'/other-worker');await front.setContent('<h1>Personal fixture tab</h1><input value="UNSENT_DRAFT">');await front.bringToFront();
 await other.evaluate(()=>requestAnimationFrame(()=>document.querySelector('[hidden][id]').hidden=false));
 for(const route of ['/123','/offers/some-title','/?item=abc','/#/detail/1']){
  await page.goto(url+route,{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>requestAnimationFrame(()=>document.querySelector('[hidden][id]').hidden=false));
  await sleep(150);
  assert.equal((await page.evaluate(documentReadiness)).hidden,true);
  assert.equal((await page.evaluate(documentReadiness)).reason,'stream_pending','A background frame is genuinely stalled before the fix');
  const start=Date.now(),ready=await waitForDocument(slot,{attempts:21,delay:50});
  assert.equal(ready.loading,false);assert.ok(Date.now()-start<2000,'Rendering does not exhaust the 20-second wait');
  assert.equal((await page.evaluate(documentReadiness)).hidden,true,'Focus emulation is restored after reading');
  const document=await page.evaluate(renderedDocument);
  assert.match(document.text,/ACTUAL_CONTENT/);assert.doesNotMatch(document.text,/PRIVATE_HIDDEN_TEXT/);
  assert.equal((await other.evaluate(documentReadiness)).loading,true,'The other worker was not emulated or focused');
  assert.equal(await front.locator('input').inputValue(),'UNSENT_DRAFT');
 }
 // A delayed render still waits for real visible content. A stuck document
 // stays incomplete, and a genuinely short ready document remains readable.
 await page.goto(url+'/delayed');
 await page.evaluate(()=>setTimeout(()=>requestAnimationFrame(()=>document.querySelector('[hidden][id]').hidden=false),200));
 assert.equal((await waitForDocument(slot,{attempts:21,delay:50})).loading,false);
 await page.goto(url+'/never');
 const stuck=await waitForDocument(slot,{attempts:3,delay:50});assert.equal(stuck.timedOut,true);assert.equal(stuck.loading,true);
 assert.doesNotMatch((await page.evaluate(renderedDocument)).text,/ACTUAL_CONTENT|PRIVATE_HIDDEN_TEXT/);
 await page.setContent('<p>Short but complete</p>');
 assert.equal((await waitForDocument(slot)).loading,false);
 assert.equal((await page.evaluate(renderedDocument)).text,'Short but complete');
 console.log('BACKGROUND_RENDERING_PASS: stalled frames resume, four URL formats, delayed/short/stuck documents, other worker and draft preserved');
}finally{
 await browser?.close();child.kill();await exited;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
}
