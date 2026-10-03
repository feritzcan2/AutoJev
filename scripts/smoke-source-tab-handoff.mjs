import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';

const require=createRequire(import.meta.url),{chromium}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const directory=await mkdtemp(path.join(tmpdir(),'loop-source-handoff-')),requests=[];
const server=createServer((req,res)=>{requests.push(req.url);res.setHeader('Content-Type','text/html');res.end(`<title>Results ${req.url}</title><h1>Results ${req.url}</h1><input aria-label="Search" type="search"><div style="height:2400px">Listings</div>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,legacySource=base.replace('127.0.0.1','localhost')+'/legacy',sources=[base+'/source-a',base+'/source-b',legacySource];
const chromeDir=path.join(directory,'chrome'),context=await chromium.launchPersistentContext(chromeDir,{channel:'chrome',headless:true,args:['--remote-debugging-port=0']});
const personal=context.pages()[0];await personal.goto(base+'/personal');
const root=await context.browser().newBrowserCDPSession(),cdp=await context.newCDPSession(personal),{targetInfo}=await cdp.send('Target.getTargetInfo');
const [port,route]=(await readFile(path.join(chromeDir,'DevToolsActivePort'),'utf8')).trim().split('\n');
const options=()=>({profile:{directory:'Test'},endpoint:async()=>`ws://127.0.0.1:${port}${route}`,openWindow:url=>root.send('Target.createTarget',{url,newWindow:true,browserContextId:targetInfo.browserContextId}),lifecycle:{multiWorker:true}});
let browsers=new BrowserTools(directory,options);
const unpack=result=>JSON.parse(result.content.find(p=>p.type==='text').text.replace(/^Page URL: [^\n]+\n/,''));
const adapter=(worker,source)=>automationBrowser(browsers.forWorker(worker),{mode:'jev',readTabKey:`source:${source}`,sourceUrl:source,sourceUrls:sources});
const call=(browser,session,name,args={})=>browser.call('workspace',name,args,session);
try{
 const first=adapter('main',sources[0]);
 const opened=unpack(await call(first,'old-run','browser_navigate',{url:sources[0]+'?page=32'}));
 let {client}=await browsers.connect('workspace');
 await client.tab(opened.tabId).page.getByRole('searchbox').fill('retained filter');
 await client.tab(opened.tabId).page.evaluate(()=>window.scrollTo(0,700));
 const duplicate=unpack(await browsers.forWorker('main').call('workspace','browser_jev_open',{url:base+'/finished-detail'},'old-run',{automationWorkspaceId:'workspace',automationSourceUrl:sources[0]}));
 const second=adapter('second',sources[1]),other=unpack(await call(second,'other-run','browser_navigate',{url:sources[1]}));
 const successor=adapter('third',sources[0]);
 const tabs=await call(successor,'new-run','browser_jev_tabs');
 assert.deepEqual(new Set(tabs.tabs.map(t=>t.tabId)),new Set([opened.tabId,duplicate.tabId]));
 const before=requests.length;
 const resumed=unpack(await call(successor,'new-run','browser_jev_use_tab',{tabId:opened.tabId}));
 assert.equal(resumed.url,opened.url);assert.equal(requests.length,before,'Taking over a tab must not navigate');
 assert.equal(await client.tab(opened.tabId).page.getByRole('searchbox').inputValue(),'retained filter');
 assert.equal(await client.tab(opened.tabId).page.evaluate(()=>scrollY),700);
 assert.equal(unpack(await call(successor,'new-run','browser_navigate',{url:opened.url})).tabId,opened.tabId);
 assert.equal((await call(successor,'new-run','browser_jev_close_tab',{tabId:duplicate.tabId})).closed,true);
 await assert.rejects(call(successor,'new-run','browser_jev_use_tab',{tabId:other.tabId}),/başka bir worker/);
 await assert.rejects(call(successor,'new-run','browser_jev_close_tab',{tabId:other.tabId}),/kaynağın/);
 // A user navigation must be inspected before a retained tab can be discarded.
 await client.tab(opened.tabId).page.goto(base+'/manual-change');
 await assert.rejects(call(successor,'new-run','browser_jev_close_tab',{tabId:opened.tabId}),/Sekme değişti/);
 await call(successor,'new-run','browser_jev_use_tab',{tabId:opened.tabId});
 // Earlier versions stored owned target IDs and URL hashes but no source labels.
 const legacy=unpack(await browsers.call('workspace','browser_jev_open',{url:legacySource+'?page=7'},'legacy-run',{automationTabKey:'read:legacy'}));
 const ambiguous=unpack(await browsers.call('workspace','browser_jev_open',{url:base+'/unassigned'},'legacy-other',{automationTabKey:'read:unassigned'}));
 // Simulate an app restart, preserving Chrome and its exact owned targets.
 await browsers.close();browsers=new BrowserTools(directory,options);
 const restarted=adapter('fourth',sources[0]);
 const restored=await call(restarted,'restart-run','browser_jev_tabs');
 assert.deepEqual(restored.tabs.map(t=>t.tabId),[opened.tabId]);
 assert.equal(unpack(await call(restarted,'restart-run','browser_jev_use_tab',{tabId:opened.tabId})).url,base+'/manual-change');
 ({client}=await browsers.connect('workspace'));
 assert.equal(client.tab(other.tabId).page.url(),sources[1]);
 const legacySuccessor=adapter('legacy-successor',legacySource),legacyTabs=await call(legacySuccessor,'legacy-next','browser_jev_tabs');
 assert.deepEqual(legacyTabs.tabs.map(t=>t.tabId),[legacy.tabId]);
 assert.equal(client.automationSources.get(legacy.tabId),legacySource);
 assert.equal(client.automationSources.has(ambiguous.tabId),false,'Ambiguous legacy host must not be assigned to either source');
 assert.equal(unpack(await call(legacySuccessor,'legacy-next','browser_jev_use_tab',{tabId:legacy.tabId})).url,legacySource+'?page=7');
 assert.equal((await call(restarted,'restart-run','browser_jev_close_tab',{tabId:opened.tabId})).closed,true);
 assert.deepEqual((await call(restarted,'restart-run','browser_jev_tabs')).tabs,[]);
 await assert.rejects(call(restarted,'restart-run','browser_snapshot'),/Önce/);
 assert.equal(personal.url(),base+'/personal');assert.equal(personal.isClosed(),false);
 console.log('SOURCE_TAB_HANDOFF_PASS: different worker and app restart retain tab, form and scroll; unused source tabs close; other sources and personal tabs survive');
}finally{
 await browsers.close();await context.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
}
