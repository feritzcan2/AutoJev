import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {SiteAccess} from '../app/site-access.mjs';

const directory=await mkdtemp(path.join(os.tmpdir(),'cloudflare-checkbox-')),db=new DatabaseSync(':memory:');
let enabled=true,clicks=0,paid=0,now=Date.now();const hits=new Map();
const browsers=new BrowserTools(directory,()=>({connection:'separate',headless:true}));
browsers.siteAccess=new SiteAccess(db,{now:()=>now});
browsers.captcha={settings:{status:()=>({enabled})},wait(){},run(){paid++;throw Error('No paid task for a managed Cloudflare checkbox');}};
const {client}=await browsers.connect('workspace'),context=await client.context();
const widget='https://challenges.cloudflare.com/cdn-cgi/challenge-platform/test/turnstile';
await context.route('https://**/*',async route=>{
 const request=route.request(),url=new URL(request.url());
 if(url.hostname==='challenges.cloudflare.com')return route.fulfill({contentType:'text/html',body:`<style>body{margin:0}</style><div id="host"></div><script>const s=document.getElementById('host').attachShadow({mode:'closed'});s.innerHTML='<style>label{display:flex;padding:12px;align-items:center;gap:8px}input{width:24px;height:24px}</style><label><input type="checkbox">Verify human</label>';s.querySelector('input').onclick=()=>parent.postMessage('verified','*');${url.searchParams.has('late')?"s.querySelector('label').style.display='none';setTimeout(()=>s.querySelector('label').style.display='',2500);":''}</script>`});
 if(url.pathname==='/count'){clicks++;return route.fulfill({body:'ok'});}
 const key=url.origin+url.pathname;hits.set(key,(hits.get(key)??0)+1);
 if(url.pathname==='/done')return route.fulfill({contentType:'text/html',body:'<h1>Visible results</h1><article>Real content is now available.</article>'});
 const hidden=url.pathname==='/hidden',fake=url.pathname==='/fake',status=url.pathname==='/limited'?429:403;
 const iframe=`<iframe src="${fake?'https://unrelated.test/widget':widget+(url.pathname==='/delayed-checkbox'?'?late=1':'')}" style="position:absolute;left:250px;top:140px;width:300px;height:65px;${hidden?'display:none':''}"></iframe>`;
 const frameMarkup=url.pathname==='/delayed-frame'?`<div id="later"></div><script>setTimeout(()=>document.getElementById('later').attachShadow({mode:'closed'}).innerHTML=${JSON.stringify(iframe)},1500);</script>`:iframe;
 return route.fulfill({status,contentType:'text/html',body:`<title>Just a moment...</title><h1>Additional Verification Required</h1><p>Cloudflare — Your Ray ID: synthetic</p>${frameMarkup}<script>addEventListener('message',async e=>{if(e.origin!=='https://challenges.cloudflare.com'||e.data!=='verified')return;await fetch('/count');${url.pathname==='/never'?'':url.pathname==='/replaced'?"location.href='/never';":"location.href='/done';"}});</script>`});
});
const adapter=(source,worker=browsers,extra={})=>automationBrowser(worker,{sourceUrl:source,readTabKey:'source:'+source,...extra});
const open=(a,url)=>a.call('workspace','browser_navigate',{url},'run');
try{
 for(const url of ['https://one.test/123','https://two.test/offers/title','https://three.test/?item=a','https://four.test/#/entry']){
  const a=adapter(url),page=await open(a,url);
  assert.equal(page.siteWait,undefined,JSON.stringify({page:page.jevPage,clicks,attempt:client.tab(page.pageContext.tabId).cloudflareAttempt}));assert.match(page.jevPage.text,/Real content is now available/);
  assert.equal(page.siteWait,undefined);assert.equal(browsers.siteAccess.status(url),null);
 }
 assert.equal(clicks,4,'A genuine checkbox in a closed shadow root is clicked once');assert.equal(paid,0);
 // An expired site wait belongs to one probe. That probe may try the checkbox
 // before counting another access failure; a still-active cooldown may not.
 const retry='https://retry.test/check';browsers.siteAccess.block(retry,'verification');now+=5*60000;
 assert.equal((await open(adapter(retry),retry)).siteWait,undefined);assert.equal(clicks,5);
 for(const url of ['https://hidden.test/hidden','https://limited.test/limited']){
  const page=await open(adapter(url),url);assert.ok(page.siteWait);assert.equal(clicks,5);
 }
 enabled=false;const off='https://disabled.test/check';assert.ok((await open(adapter(off),off)).siteWait);assert.equal(clicks,5);enabled=true;
 const record='https://record.test/check';
 assert.ok((await open(automationBrowser(browsers,{readTabKey:'record:fixture',recordId:'fixture'}),record)).siteWait);assert.equal(clicks,5);
 // The long post-click wait is cancellable and does not occupy the queue.
 const controller=new AbortController(),worker=browsers.forWorker('second',()=>true,{signal:controller.signal}),waiting='https://waiting.test/never';
 const pending=open(adapter(waiting,worker),waiting);const rejection=assert.rejects(pending,{name:'AbortError'});
 for(let i=0;i<50&&clicks===5;i++)await new Promise(r=>setTimeout(r,50));assert.equal(clicks,6);
 let otherRead=false;await browsers.enqueue('workspace',async()=>{otherRead=true;});assert.equal(otherRead,true);
 controller.abort();await rejection;
 // A failure stays a site barrier and repeated reads never click it again.
 const never='https://never.test/never',a=adapter(never);const blocked=await open(a,never);
 assert.equal(blocked.siteWait.reason,'verification');assert.equal(clicks,7);assert.equal(hits.get(never),1);
 assert.equal(blocked.jevPage.captcha.clicked,true);assert.equal(blocked.jevPage.captcha.reason,'barrier_after_click');
 assert.ok((await a.call('workspace','browser_snapshot',{},'run')).siteWait);assert.equal(clicks,7);assert.equal(paid,0);
 for(const url of ['https://late-widget.test/delayed-checkbox','https://late-frame.test/delayed-frame']){
  const before=clicks,pending=open(adapter(url),url);
  await new Promise(r=>setTimeout(r,500));
  assert.equal(clicks,before,'A loading widget is not treated as an active checkbox');
  let free=false;await browsers.enqueue('workspace',()=>{free=true;});assert.equal(free,true);
  const ready=await pending;assert.equal(ready.siteWait,undefined);assert.match(ready.jevPage.text,/Real content is now available/);assert.equal(clicks,before+1);
 }
 const beforeReplacement=clicks,replaced='https://replacement.test/replaced';
 const changed=await open(adapter(replaced),replaced);
 assert.equal(changed.siteWait.reason,'verification');assert.equal(changed.jevPage.captcha.reason,'document_changed');assert.equal(clicks,beforeReplacement+1,'A replacement barrier is not clicked again by the same attempt');
 const beforeProbe=clicks;now+=5*60000;
 const retried=await a.call('workspace','browser_snapshot',{},'run');
 assert.ok(retried.siteWait);assert.equal(clicks,beforeProbe+1,'A later site probe uses the new document rather than the expired target');
 console.log('CLOUDFLARE_CHECKBOX_PASS: closed shadow root, late checkbox/frame, one click, document replacement, diagnostic evidence, cancellation, queue isolation, cooldown and record guard');
}finally{await browsers.close();db.close();await rm(directory,{recursive:true,force:true});}
