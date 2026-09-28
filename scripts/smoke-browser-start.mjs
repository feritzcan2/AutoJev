import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url);
const {_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-browser-start-'));
const store=new Store(path.join(data,'jobloop.sqlite'));
const profile=store.saveProfile({name:'Deniz Test',preferences:'Remote backend',browserMode:'jev'});
const cv=path.join(data,'CV.txt');await writeFile(cv,'Test CV');store.setCv(profile.id,cv);
// Initial ranking used to bypass the Chrome launch gate.
store.addJob(profile.id,{company:'Example',role:'Backend Engineer',url:'https://example.test/job',location:'Remote',fit:'Backend'});
store.close();
const application=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await application.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 // Real scheduling, IPC and UI; isolated data with no provider or personal Chrome.
 await application.evaluate(async(_,urls)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {Engine}=await load(urls.engine),{BrowserTools}=await load(urls.browser),request=Engine.prototype.request;
  globalThis.agentStarts=0;globalThis.chromeState={state:'idle',ready:false};
  Engine.prototype.request=function(op,args={}){if(op==='start')globalThis.agentStarts++;if(['start','message','resize'].includes(op))return Promise.resolve({});return request.call(this,op,args);};
  BrowserTools.prototype.status=()=>globalThis.chromeState;
  BrowserTools.prototype.prepare=function(id){globalThis.fixtureBrowser=this;if(globalThis.chromeState.state==='idle'){globalThis.chromeState={state:'connecting',ready:false};this.onStatus?.(id,globalThis.chromeState);}return globalThis.chromeState;};
 },{engine:pathToFileURL(path.join(root,'app/engine.mjs')).href,browser:pathToFileURL(path.join(root,'app/browser.mjs')).href});
 const setChrome=async state=>application.evaluate((_,{state,id})=>{globalThis.chromeState=state;globalThis.fixtureBrowser?.onStatus?.(id,state);},{state,id:profile.id});
 const snapshot=()=>page.evaluate(id=>window.jobloop.snapshot(id),profile.id);
 const starts=()=>application.evaluate(()=>globalThis.agentStarts);
 const banner=page.getByRole('dialog',{name:'Chrome izni bekleniyor'}),modal=page.locator('dialog.chrome-approval'),reminder=page.locator('.chrome-approval-reminder');
 await page.locator('#start').click();await banner.waitFor({state:'visible'});
 assert.match(await banner.innerText(),/Agent henüz başlatılmadı/);assert.match(await banner.innerText(),/Allow remote debugging/);
 assert.equal(await page.locator('#restart-agent').isDisabled(),true);
 assert.equal(await page.locator('#now-title').textContent(),'Chrome izni bekleniyor');
 assert.equal(await page.locator('#agent-nav-status').textContent(),'Chrome bekliyor');
 assert.equal(await modal.evaluate(el=>el.matches(':modal')),true);
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('dialog.chrome-approval'))),true,'keyboard focus stays inside the modal');
 await page.locator('.chrome-prompt-allow').click();assert.equal((await snapshot()).active,null,'the illustration cannot grant permission');
 await page.waitForTimeout(2200);assert.equal(await starts(),0);assert.equal((await snapshot()).active,null);
 await page.screenshot({path:path.join(data,'approval-wait.png'),animations:'disabled'});
 const centered=await modal.evaluate(el=>{const r=el.getBoundingClientRect();return Math.abs(r.x+r.width/2-innerWidth/2)<2&&Math.abs(r.y+r.height/2-innerHeight/2)<2;});assert.equal(centered,true);
 await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});await reminder.waitFor({state:'visible'});
 await setChrome({state:'connecting',ready:false});await page.waitForTimeout(1200);assert.equal(await modal.isVisible(),false,'refreshes do not reopen a dismissed popup');
 await page.locator('button[data-view=sources]').click();assert.equal(await reminder.isVisible(),true);
 await reminder.getByRole('button').click();await modal.waitFor({state:'visible'});
 await modal.getByRole('button',{name:'Başlatmayı iptal et'}).click();await modal.waitFor({state:'hidden'});assert.equal(await reminder.isVisible(),false);
 await setChrome({state:'ready',ready:true});await page.waitForTimeout(1200);assert.equal(await starts(),0);

 await setChrome({state:'waiting',ready:false,message:'Chrome bağlantısı reddedildi. Chrome’da izin ver.'});
 await page.locator('#start').click();await modal.waitFor({state:'visible'});
 assert.match(await modal.innerText(),/reddedildi/);assert.equal(await modal.getByRole('button',{name:'Yeniden bağlan'}).isVisible(),true);
 assert.equal(await starts(),0);
 await setChrome({state:'ready',ready:true});
 await page.waitForFunction(async id=>Boolean((await window.jobloop.snapshot(id)).active),profile.id);
 await modal.waitFor({state:'hidden'});await page.waitForTimeout(1200);assert.equal(await starts(),1);
 await page.locator('#restart-agent').click();
 await page.waitForFunction(()=>!document.querySelector('#restart-agent').disabled);
 assert.equal(await starts(),2);assert.equal(await banner.isVisible(),false);

 await page.locator('#stop').click();await page.locator('#start').waitFor({state:'visible'});
 await setChrome({state:'connecting',ready:false});
 await page.locator('button[data-view=profile]').click();await page.locator('#improve-profile').click();
 const setupBanner=modal;await setupBanner.waitFor({state:'visible'});
 assert.equal(await starts(),2);assert.equal((await snapshot()).active,null);assert.equal(await page.locator('#setup-retry').isVisible(),false);
 await page.screenshot({path:path.join(data,'profile-approval-wait.png'),animations:'disabled'});
 await setChrome({state:'ready',ready:true});
 await page.waitForFunction(async id=>Boolean((await window.jobloop.snapshot(id)).active),profile.id);
 await setupBanner.waitFor({state:'hidden'});await page.waitForTimeout(1200);assert.equal(await starts(),3);
 await page.locator('#setup-back').click();await page.locator('#onboarding').waitFor({state:'hidden'});
 await setChrome({state:'connecting',ready:false});await page.locator('#improve-profile').click();await modal.waitFor({state:'visible'});
 await modal.getByRole('button',{name:'Profile dön',exact:true}).click();await modal.waitFor({state:'hidden'});
 await page.locator('#onboarding').waitFor({state:'hidden'});await setChrome({state:'ready',ready:true});await page.waitForTimeout(1200);assert.equal(await starts(),3);
 assert.deepEqual(errors,[]);
 console.log('BROWSER_START_GATE_UI_PASS',data);
}finally{await application.close();}
