// Existing Chrome contract: shared login, separate windows, scoped tabs, safe disconnect.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {JevTabs} from '../app/jev-tabs.mjs';
import {startJevFixture} from './jev-demo.mjs';
const require=createRequire(import.meta.url),{chromium}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const directory=await mkdtemp(path.join(os.tmpdir(),'jev-existing-test-')),fixture=await startJevFixture();
const context=await chromium.launchPersistentContext(directory,{channel:'chrome',headless:true,args:['--remote-debugging-port=0']});
const browser=context.browser(),root=await browser.newBrowserCDPSession(),personal=context.pages()[0];
await personal.goto(fixture.url);await context.addCookies([{name:'test_login',value:'existing-session',url:fixture.url}]);
const session=await context.newCDPSession(personal),{targetInfo}=await session.send('Target.getTargetInfo');
const [port,route]=(await readFile(path.join(directory,'DevToolsActivePort'),'utf8')).trim().split('\n');
const endpoint=async()=>`ws://127.0.0.1:${port}${route}`;
const openWindow=async url=>root.send('Target.createTarget',{url,newWindow:true,browserContextId:targetInfo.browserContextId});
const client=new JevBrowser(path.join(directory,'candidate'),{profile:{directory:'Test'},endpoint,openWindow});
try{
 await context.route('https://portal.test/**',r=>r.fulfill({contentType:'text/html',body:'<iframe title="reCAPTCHA" src="https://recaptcha.net/recaptcha/api2/anchor?fixture=1" style="width:304px;height:150px"></iframe>'}));
 await context.route('https://recaptcha.net/recaptcha/api2/anchor*',r=>r.fulfill({contentType:'text/html',body:'<span id="recaptcha-anchor" role="checkbox" aria-checked="false" style="display:inline-block;width:28px;height:28px">✓</span>'}));
 const o=JSON.parse((await client.callTool({name:'browser_jev_open',arguments:{url:'https://portal.test/register'}},'local',{})).content[0].text);
 const slot=client.tab(o.tabId);await slot.page.frames()[1].waitForLoadState();
 const obs=await client.observe(slot);
 assert.ok(obs.clickTargets.some(t=>t.verification));
 assert.equal(obs.verification.checkbox,true);
 console.log('SCOPED_CDP_CROSS_ORIGIN_CHECKBOX_DISCOVERY_PASS');
}finally{await client.close();await context.close();await fixture.close();await rm(directory,{recursive:true,force:true});}
