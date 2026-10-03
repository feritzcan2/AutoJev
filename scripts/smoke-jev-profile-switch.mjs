import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';
import {JevTabs} from '../app/jev-tabs.mjs';
import {startJevFixture} from './jev-demo.mjs';

const require=createRequire(import.meta.url),{chromium}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const directory=await mkdtemp(path.join(os.tmpdir(),'jev-profile-switch-')),fixture=await startJevFixture();
const context=await chromium.launchPersistentContext(directory,{channel:'chrome',headless:true,args:['--remote-debugging-port=0']});
const browser=context.browser(),root=await browser.newBrowserCDPSession(),other=await browser.newContext();
const [port,route]=(await readFile(path.join(directory,'DevToolsActivePort'),'utf8')).trim().split('\n');
const endpoint=`ws://127.0.0.1:${port}${route}`,contexts=new Map([['Default',context],['Profile 2',other]]),contextIds=new Map();
for(const [profile,ctx] of contexts){
 await ctx.addCookies([{name:'test_login',value:profile==='Default'?'personal':'work',url:fixture.url}]);
 const page=await ctx.newPage(),cdp=await ctx.newCDPSession(page),{targetInfo}=await cdp.send('Target.getTargetInfo');
 contextIds.set(profile,targetInfo.browserContextId);await page.close();
}
let selected='Default';
const tools=new BrowserTools(directory,id=>({
 profile:{directory:id==='other-workspace'?'Default':selected},endpoint:async()=>endpoint,
 openWindow:async(url,profile)=>root.send('Target.createTarget',{url,newWindow:true,browserContextId:contextIds.get(profile.directory)})
}));
const open=async(id,worker='main')=>{
 tools.prepare(id);await tools.connections.pending.get(id);assert.equal(tools.status(id).ready,true,JSON.stringify(tools.status(id)));
 const response=await tools.forWorker(worker).call(id,'browser_jev_open',{url:fixture.url},worker);
 assert.ok(!response.isError);const result=JSON.parse(response.content[0].text),{client}=await tools.connect(id);
 return client.tab(result.tabId);
};
try{
 const personal=await open('candidate'),unrelated=await open('other-workspace');
 await personal.page.locator('#query').fill('keep personal draft');
 assert.equal(await personal.page.evaluate(()=>document.cookie),'test_login=personal');
 const oldRegistry=(await tools.connect('candidate')).client.registry;
 await tools.resetCandidate('candidate');selected='Profile 2';
 // A stale registry must not make the previous profile's live window proof
 // that it belongs to the newly selected profile.
 const saved=await oldRegistry.read();
 const registry=new JevTabs(path.join(directory,'browsers','candidate','jev-profile'),selected);
 await registry.save(endpoint,saved.contextId,saved.targets,{homeId:saved.homeId,windowId:saved.windowId});
 const work=await open('candidate','worker-two');
 assert.equal(await work.page.evaluate(()=>document.cookie),'test_login=work','new worker must use the selected Chrome login');
 assert.equal((await tools.connect('candidate')).client.tabs.has(personal.id),false);
 assert.equal(await unrelated.page.evaluate(()=>document.cookie),'test_login=personal');
 assert.equal(unrelated.page.isClosed(),false);
 await work.page.locator('#query').fill('keep work draft');
 await tools.resetCandidate('candidate');
 const reopened=await open('candidate');
 const workClient=(await tools.connect('candidate')).client;
 assert.equal(await reopened.page.evaluate(()=>document.cookie),'test_login=work');
 assert.equal(await workClient.tab(work.id).page.locator('#query').inputValue(),'keep work draft');
 await tools.resetCandidate('candidate');selected='Default';
 const returned=await open('candidate','worker-three'),personalClient=(await tools.connect('candidate')).client;
 assert.equal(await returned.page.evaluate(()=>document.cookie),'test_login=personal');
 assert.equal(await personalClient.tab(personal.id).page.locator('#query').inputValue(),'keep personal draft');
 assert.equal(personalClient.tabs.has(work.id),false);
 console.log('JEV_PROFILE_SWITCH_LOGIN_RESTORE_WORKER_ISOLATION_PASS');
}finally{await tools.close();await other.close();await context.close();await fixture.close();await rm(directory,{recursive:true,force:true});}
