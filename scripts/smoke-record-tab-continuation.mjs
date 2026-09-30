import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';

const directory=await mkdtemp(path.join(os.tmpdir(),'record-tab-resume-'));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<h1>${req.url}</h1><label>Name<input name="name"></label><a target="_blank" href="/apply">Apply</a>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/listing`;
const browsers=new BrowserTools(directory,()=> 'jev',()=>({connection:'separate',headless:true}));
const adapter=(resumeContext,recordId='one')=>automationBrowser(browsers,{mode:'jev',recordId,readTabKey:`record:${recordId}`,resumeContext});
try{
 const first=adapter(),listing=await first.call('workspace','browser_navigate',{url},'first');
 const client=(await browsers.connect('workspace')).client,context=await client.context(),raw=context.pages().find(p=>p.url()===url);
 const popupPromise=context.waitForEvent('page');await raw.locator('a').click();const popup=await popupPromise;await popup.waitForLoadState('domcontentloaded');
 const form=await client.track(context,popup);
 assert.equal(client.automationTabs.get(form.id),'record:one','Popup inherits exact record ownership');
 await first.call('workspace','browser_jev_use_tab',{tabId:form.id},'first');
 await popup.locator('input').fill('Unsaved candidate answer');
 await popup.evaluate(()=>history.pushState({},'', '/apply/after-login'));
 const count=context.pages().length;
 const second=adapter({tabId:form.id,url:url.replace('/listing','/apply')});
 const restored=await second.call('workspace','browser_navigate',{url},'second');
 assert.equal(restored.pageContext.tabId,form.id);assert.equal(context.pages().length,count);
 assert.ok(restored.pageContext.url.endsWith('/apply/after-login'));assert.equal(await popup.locator('input').inputValue(),'Unsaved candidate answer');
 const withoutCheckpoint=await adapter().call('workspace','browser_navigate',{url},'third');
 assert.equal(withoutCheckpoint.pageContext.tabId,form.id);assert.equal(context.pages().length,count);
 const tabs=await second.call('workspace','browser_jev_tabs',{},'second');
 assert.ok(tabs.tabs.every(t=>t.recordId==='one'));assert.equal(tabs.tabs.length,2);
 const foreign=adapter(null,'other');
 await assert.rejects(foreign.call('workspace','browser_jev_use_tab',{tabId:form.id},'other'),/başka bir worker/);
 const other=await foreign.call('workspace','browser_navigate',{url},'other');
 assert.notEqual(other.pageContext.tabId,listing.pageContext.tabId);assert.notEqual(other.pageContext.tabId,form.id);
 assert.equal(await popup.locator('input').inputValue(),'Unsaved candidate answer');
 console.log('RECORD_POPUP_REDIRECT_RESUME_DRAFT_AND_OWNERSHIP_PASS');
}finally{await browsers.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
