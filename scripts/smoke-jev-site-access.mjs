import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {SiteAccess} from '../app/site-access.mjs';

const directory=await mkdtemp(path.join(os.tmpdir(),'jev-site-access-')),db=new DatabaseSync(':memory:');
let now=Date.now(),blocked=false,limited=false;const hits=new Map();
const server=createServer((req,res)=>{
 if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(req.url.startsWith('/broken-transport')){req.socket.destroy();return;}
 const key=req.headers.host+req.url;hits.set(key,(hits.get(key)??0)+1);
 if(limited&&req.url==='/limited'){res.writeHead(429,{'Retry-After':'180'});res.end();return;}
 if(blocked&&req.url==='/blocked'){res.writeHead(403,{'Content-Type':'text/html; charset=utf-8'});res.end('<h1>Your IP address has been temporarily blocked.</h1>');return;}
 res.writeHead(req.url==='/forbidden'?403:200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"script-src 'self'"});
 res.end(`<h1>${req.url==='/forbidden'?'Forbidden':'Listings'}</h1><label>Name<input></label><a href='/detail'>Detail</a>`);
});
await new Promise(resolve=>server.listen(0,resolve));const port=server.address().port,a=`http://127.0.0.1:${port}/list`,b=`http://localhost:${port}/list`;
const browsers=new BrowserTools(directory,()=>({connection:'separate',headless:true}));browsers.siteAccess=new SiteAccess(db,{now:()=>now});
for(const id of ['one','two'])browsers.status(id);
const adapter=id=>automationBrowser(browsers,{mode:'jev',sourceUrls:[a,b],readTabKey:'read:main'}),browser=adapter('one');
const open=(adapter,id,url)=>adapter.call(id,'browser_navigate',{url},'trial');
const count=url=>hits.get(new URL(url).host+new URL(url).pathname)??0;
try{
 const first=await open(browser,'one',a),second=await open(browser,'one',b),back=await open(browser,'one',a);
 assert.notEqual(first.pageContext.tabId,second.pageContext.tabId);assert.equal(back.pageContext.tabId,first.pageContext.tabId);assert.equal(count(a),1,JSON.stringify({first,second,back,hits:[...hits]}));
 const resumed=adapter('one');assert.equal((await open(resumed,'one',a)).pageContext.tabId,first.pageContext.tabId);assert.equal(count(a),1);
 const client=(await browsers.connect('one')).client,slot=client.tab(first.pageContext.tabId),raw=(await client.context()).pages().find(p=>p.url()===a);
 assert.deepEqual(await raw.evaluate(()=>({cache:typeof window.__jevFast,form:typeof window.__jobloopFieldContext,popup:!!window[Symbol.for('jobloop.tabPopups')],nativeOpen:window.open.toString().includes('[native code]')})),{cache:'undefined',form:'undefined',popup:false,nativeOpen:true});
 const observation=await client.observe(slot);assert.equal(observation.fillFields.length,1);
 const filled=JSON.parse((await client.callTool({name:'browser_jev_fill_fields',arguments:{tabId:slot.id,fields:[{fieldId:observation.fillFields[0].fieldId,text:'Local fixture'}]}},'trial',{automationWorkspaceId:'one',automationSourceUrl:a,automationTabKey:`source:${a}`})).content[0].text);
 assert.equal(filled.results[0].status,'filled');assert.equal(await raw.locator('input').inputValue(),'Local fixture');
 await open(browser,'one',a.replace('/list','/forbidden'));assert.equal(browsers.siteAccess.status(a),null);
 blocked=true;const blockedUrl=a.replace('/list','/blocked'),barrier=await open(browser,'one',blockedUrl);assert.equal(barrier.siteWait.retryAt,now+5*60000);assert.equal(barrier.siteWait?.reason,'ip_block',JSON.stringify(barrier).slice(0,2000));assert.equal(count(blockedUrl),1);
 const other=adapter('two'),deferred=await open(other,'two',blockedUrl);assert.equal(deferred.siteWait.site,'127.0.0.1');assert.equal(count(blockedUrl),1);
 const deadline=barrier.siteWait.retryAt;await open(browser,'one',blockedUrl);assert.equal(browsers.siteAccess.status(a).retryAt,deadline);
 assert.ok(!(await open(browser,'one',b)).siteWait);assert.equal(count(b),1);
 now=deadline;const again=await open(browser,'one',blockedUrl);assert.equal(again.siteWait.attempts,2);assert.equal(again.siteWait.retryAt,now+10*60000);assert.equal(count(blockedUrl),2);
 blocked=false;now=again.siteWait.retryAt;assert.ok(!(await browser.call('one','browser_snapshot',{},'trial')).siteWait);assert.equal(browsers.siteAccess.status(a),null);assert.equal(count(blockedUrl),3);
 limited=true;const limitedResult=await open(browser,'one',a.replace('/list','/limited'));assert.equal(limitedResult.siteWait.reason,'rate_limit');assert.equal(limitedResult.siteWait.retryAt,null);assert.equal(limitedResult.siteWait.exhausted,true);assert.equal(limitedResult.siteWait.attempts,3);now+=86400000;const limitedUrl=a.replace('/list','/limited'),attempts=count(limitedUrl);await open(other,'two',limitedUrl);assert.equal(count(limitedUrl),attempts);assert.equal(browsers.siteAccess.status(a).exhausted,true);
 const failedUrl=b.replace('/list','/broken');
 const navigate=client.navigate.bind(client);
 client.navigate=async(slot,url)=>{if(url===failedUrl)throw Error('net::ERR_HTTP2_PROTOCOL_ERROR');return navigate(slot,url);};
 await assert.rejects(open(browser,'one',failedUrl),/net::ERR_HTTP2_PROTOCOL_ERROR/,'Original navigation error survives Jev and the automation adapter');
 client.navigate=navigate;
 assert.ok((await open(browser,'one',b)).pageContext,'The owned source tab remains usable after a navigation failure');
 const retryBrowser=automationBrowser(browsers,{mode:'jev',sourceUrl:b,readTabKey:'source:'+b});
 for(let i=0;i<4;i++){
  await assert.rejects(retryBrowser.call('one','browser_reopen_readonly',{url:b.replace('/list','/broken-transport')+'?detail='+i},'retry-run'),/net::ERR_/);
  const failed=[...client.tabs.values()].filter(s=>client.automationRuns.get(s.id)==='retry-run');
  assert.equal(failed.length,1,'Fresh retries must not accumulate Chrome error tabs');
  await failed[0].page.waitForURL('chrome-error://chromewebdata/',{timeout:3000});
 }
 assert.ok(client.tabs.has(first.pageContext.tabId),'Another source tab must survive retry cleanup');
 console.log('JEV_SOURCE_TABS_PRIVATE_STATE_SHARED_WAIT_RECOVERY_PASS');
}finally{await browsers.close();db.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
