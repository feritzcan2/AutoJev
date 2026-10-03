// Use regular Chrome: Playwright launch defaults hide background frame stalls.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {setTimeout as sleep} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {findChrome} from '../app/chrome-installation.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

const require=createRequire(import.meta.url),{chromium}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const directory=await mkdtemp(path.join(os.tmpdir(),'jev-background-form-'));
const server=createServer((req,res)=>{
 res.setHeader('Content-Type','text/html');
 res.end('<title>Form fixture</title><h1>Form</h1><form onsubmit="event.preventDefault();window.sends++"><div style="height:1800px"></div><label>Contact<input name="contact"></label><label hidden>Hidden<input name="hidden"></label><label>Disabled<input name="disabled" disabled></label><button type="submit">Submit</button></form><script>window.sends=0</script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const child=spawn(await findChrome(),[`--user-data-dir=${directory}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
const exited=new Promise(resolve=>child.once('exit',resolve));let browser,client;
try{
 let endpoint;
 for(let i=0;i<100;i++){
  try{const [port,route]=(await readFile(path.join(directory,'DevToolsActivePort'),'utf8')).trim().split('\n');endpoint=`ws://127.0.0.1:${port}${route}`;break;}catch{await sleep(100);}
 }
 assert.ok(endpoint);
 browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});
 const context=browser.contexts()[0],page=context.pages()[0],other=await context.newPage(),front=await context.newPage();
 client=new JevBrowser(path.join(directory,'jev'),{connection:'separate',launch:async()=>context});
 await client.context();const slot=await client.track(context,page),tabId=slot.id;
 const call=async(name,args)=>JSON.parse((await client.callTool({name,arguments:{tabId,...args}},'fixture')).content[0].text);
 await other.setContent('<h1>Other worker</h1>');
 await front.setContent('<label>Personal draft<input value="UNSENT_DRAFT"></label>');await front.bringToFront();
 await other.evaluate(()=>{window.rendered=false;requestAnimationFrame(()=>window.rendered=true);});
 for(const route of ['/123','/offers/title','/?item=abc','/#/detail/1']){
  await page.goto(url+route,{waitUntil:'domcontentloaded'});await sleep(100);
  if(route==='/offers/title')await page.evaluate(()=>{
   const form=document.querySelector('form');form.setAttribute('role','dialog');form.style='height:300px;overflow:auto';
  });
  if(route==='/?item=abc')await page.evaluate(()=>{
   const form=document.querySelector('form'),host=document.createElement('section');form.replaceWith(host);host.attachShadow({mode:'open'}).append(form);
  });
  assert.equal(await page.evaluate(()=>document.visibilityState),'hidden');
  const observed=await call('browser_jev_observe');
  const target=observed.controls.find(c=>c.label==='Contact');assert.ok(target);assert.equal(target.visible,false);
  assert.equal(observed.fillFields.length,0);
  const revealed=await call('browser_jev_reveal',{controlId:target.controlId});
  assert.equal(revealed.status,'ready',revealed.message);
  const field=revealed.fillFields.find(f=>f.label==='Contact');assert.ok(field);
  const filled=await call('browser_jev_fill_fields',{fields:[{fieldId:field.fieldId,text:'Synthetic answer'}]});
  assert.equal(filled.status,'ready',JSON.stringify(filled.results));
  assert.equal(await page.locator('[name=contact]').inputValue(),'Synthetic answer');
  assert.equal(await page.evaluate(()=>window.sends),0);
  assert.ok(!filled.fillFields.some(f=>['Hidden','Disabled'].includes(f.label)));
  assert.equal(await page.evaluate(()=>document.visibilityState),'hidden');
  assert.equal(await front.evaluate(()=>document.visibilityState),'visible','The personal tab remains selected');
  assert.equal(await front.locator('input').inputValue(),'UNSENT_DRAFT');
  assert.equal(await other.evaluate(()=>window.rendered),false,'Another worker remains untouched');
 }
 // Resuming rendering must never make an occluded field writable.
 await page.setContent('<label>Covered<input name="covered"></label><div style="position:fixed;inset:0;background:white;z-index:10">Overlay</div>');
 let observed=await call('browser_jev_observe');
 assert.equal(observed.fillFields.length,0);
 const covered=observed.controls.find(c=>c.label==='Covered');assert.equal(covered.visible,false);
 const blocked=await call('browser_jev_reveal',{controlId:covered.controlId});
 assert.equal(blocked.status,'no_progress');assert.equal(blocked.fillFields.length,0);
 assert.equal(await page.locator('input').inputValue(),'');
 // Cancellation cannot start a form mutation or leave the tab emulated.
 await page.setContent('<label>Ready<input name="ready"></label>');observed=await call('browser_jev_observe');
 const abort=new AbortController();abort.abort();
 await assert.rejects(client.callTool({name:'browser_jev_fill_fields',arguments:{tabId,fields:[{fieldId:observed.fillFields[0].fieldId,text:'Must not be written'}]}},'fixture',{signal:abort.signal}),{name:'AbortError'});
 assert.equal(await page.locator('input').inputValue(),'');
 assert.equal(await page.evaluate(()=>document.visibilityState),'hidden');
 assert.equal(await front.evaluate(()=>document.visibilityState),'visible');
 console.log('JEV_BACKGROUND_FORM_REVEAL_FILL_FOUR_URLS_NO_FOCUS_THEFT_PASS');
}finally{
 await client?.close();await browser?.close();child.kill();await exited;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
}
