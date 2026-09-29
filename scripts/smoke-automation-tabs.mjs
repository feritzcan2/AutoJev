import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'loop-scan-tabs-'));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<h1>Listing ${req.url}</h1><a href="/next">Next page</a>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const browsers=new BrowserTools(directory,()=> 'jev',()=>({connection:'separate',headless:true}));
const unpack=r=>JSON.parse(r.content.find(p=>p.type==='text').text.replace(/^Page URL: [^\n]+\n/,''));
try{
 browsers.prepare('workspace');await browsers.connections.pending.get('workspace');
 const {client}=await browsers.connect('workspace');await client.context();
 // A personal tab and a draft share URLs with the scan, but have no read scope.
 const personal=await (await client.context()).newPage();await personal.goto(url+'/0');
 const draft=unpack(await browsers.call('workspace','browser_jev_open',{url:url+'/0'},'draft'));
 assert.ok(draft.tabId);client.tabJobs.set(draft.tabId,'saved-application');
 const initial=client.tabs.size,ids=new Set();
 for(let turn=0;turn<3;turn++){
  const browser=automationBrowser(browsers.forWorker('main'),{mode:'jev',readTabKey:'read:main'});
  for(let n=0;n<10;n++){
   const page=unpack(await browser.call('workspace','browser_navigate',{url:url+'/'+(turn*10+n)},'run-'+turn));
   ids.add(page.tabId);assert.equal(page.url,url+'/'+(turn*10+n));
  }
 }
 assert.equal(ids.size,1);assert.equal(client.tabs.size,initial+1);
 assert.equal(personal.url(),url+'/0');assert.equal(client.tab(draft.tabId).page.url(),url+'/0');
 const other=automationBrowser(browsers.forWorker('second'),{mode:'jev',readTabKey:'read:second'});
 const second=unpack(await other.call('workspace','browser_navigate',{url:url+'/second'},'other'));
 assert.ok(!ids.has(second.tabId));assert.equal(client.tabs.size,initial+2);
 // Simulate user navigating the reading tab away: preserve it and open one replacement.
 const first=client.tab([...ids][0]);await first.page.goto(url+'/personal-change');
 const resumed=automationBrowser(browsers,{mode:'jev',readTabKey:'read:main'});
 const replacement=unpack(await resumed.call('workspace','browser_navigate',{url:url+'/continued'},'next-run'));
 assert.notEqual(replacement.tabId,first.id);assert.equal(first.page.url(),url+'/personal-change');
 await client.tab(replacement.tabId).page.close();
 const reopened=unpack(await resumed.call('workspace','browser_navigate',{url:url+'/recovered'},'next-run'));
 assert.notEqual(reopened.tabId,replacement.tabId);
 console.log('AUTOMATION_TABS_PASS: 30 pages, 3 turns, 1 reading tab; worker isolation and draft/user tab preservation verified');
}finally{await browsers.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
