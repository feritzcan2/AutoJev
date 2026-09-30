import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'loop-setup-conversation-'));
const store=new Store(path.join(data,'jobloop.sqlite'));store.saveProfile({name:'UI fixture',preferences:'Remote'});store.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
let page;
try{
 page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Keep the real workspace, IPC, persistence and terminal. Replace only provider execution.
 await app.evaluate(async(_,url)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {Engine}=await load(url),original=Engine.prototype.request;
  globalThis.setupStarts=[];globalThis.setupTyped='';
  Engine.prototype.request=function(op,args={}){
   if(op==='start'&&args.cwd.includes('/automations/')){if(globalThis.failSetupStart){globalThis.failSetupStart=false;return Promise.reject(Error('Test: başlatılamadı'));}globalThis.setupEngine=this;globalThis.setupStarts.push(args);return Promise.resolve({});}
   if(op==='input'&&this===globalThis.setupEngine){globalThis.setupTyped+=args.text;return Promise.resolve({});}
   if(op==='resize')return Promise.resolve({});
   return original.call(this,op,args);
  };
 },pathToFileURL(path.resolve('app/engine.mjs')).href);
 await page.locator('#new').click();await page.locator('[data-overview-action=message]').click();await page.locator('.workspace-intro').waitFor({state:'visible'});
 const id=await page.evaluate(()=>localStorage.getItem('selected-automation'));
 assert.equal(await page.locator('#now-panel #automation-message').isVisible(),true);
 await page.locator('#terminal .xterm').waitFor({state:'visible'});
 assert.equal(await page.locator('.worker-pane').getAttribute('data-view'),'terminal');
 assert.equal(await page.locator('.worker-view-switch').isVisible(),false);
 // An old saved chat preference must not reintroduce a second composer.
 await page.evaluate(id=>localStorage.setItem(`worker-view:${id}:main`,'chat'),id);
 await page.reload();await page.locator('#terminal .xterm').waitFor({state:'visible'});
 assert.equal(await page.locator('.worker-pane').getAttribute('data-view'),'terminal');
 await page.locator('#automation-message').fill('Berlin’de kiralık ev arıyorum.');await page.locator('#automation-send').click();
 await page.waitForFunction(()=>document.querySelector('#now-title').textContent==='Agent kurulumu hazırlıyor');
 assert.equal(await page.locator('#automation-message').isVisible(),false);
 assert.equal(await page.locator('.automation-compose').isVisible(),false);
 assert.equal(await page.locator('#automation-chat-feedback').isVisible(),false);
 await page.locator('#terminal .xterm').waitFor({state:'visible'});
 const emit=event=>app.evaluate((_,event)=>globalThis.setupEngine.child.stdout.emit('data',Buffer.from(JSON.stringify(event)+'\n')),event);
 await emit({event:'state',state:'Working'});
 await emit({event:'output',bytes:[...Buffer.from('Do you want to allow this command?\r\nYes / No\r\nPress Enter to confirm, Esc to cancel\r\n')]});
 await page.locator('.worker-attention').waitFor({state:'visible'});
 assert.match(await page.locator('.worker-attention-title').textContent(),/onay bekliyor/);
 await page.locator('.worker-attention-button').click();
 await page.keyboard.press('Enter');assert.match(await app.evaluate(()=>globalThis.setupTyped),/\r/);
 await emit({event:'output',bytes:[...Buffer.from('\x1b[2J\x1b[HÇalışma devam ediyor\r\n')]});
 await page.locator('.worker-attention').waitFor({state:'hidden'});
 await emit({event:'state',state:'AwaitingInput'});
 await page.locator('[data-progress-action=terminal]').waitFor({state:'visible'});
 await page.locator('[data-progress-action=terminal]').click();
 assert.equal(await page.locator('#terminal .xterm-helper-textarea').evaluate(e=>document.activeElement===e),true);
 await emit({event:'state',state:'Working'});
 let rpcId=0;
 const tool=async(name,args)=>{
  const run=await app.evaluate(()=>globalThis.setupStarts.at(-1));
  const response=await fetch(run.endpoint,{method:'POST',headers:{Authorization:'Bearer '+run.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})});
  const body=await response.json();assert.ok(!body.result?.isError,JSON.stringify(body));
 };
 await tool('reply_to_user',{message:'Berlin için iki kaynak buldum.\n\n1. **En fazla ne kadar kira ödemek istersin?**\n2. **Kaç oda arıyorsun?**\n\nÖrnek: `1.300 € ve 2 oda`. <img src=x onerror=alert(1)>'});
 await tool('finish_automation_run',{status:'completed',summary:'Interview turn: internal setup summary.'});
 await page.locator('#automation-message').waitFor({state:'visible'});
 assert.equal(await page.locator('#automation-send').isEnabled(),true);
 assert.equal(await page.locator('#now-detail strong').count(),2);
 assert.equal(await page.locator('#now-detail code').textContent(),'1.300 € ve 2 oda');
 assert.equal(await page.locator('#now-detail img').count(),0);
 assert.equal(await page.locator('#now-panel #automation-message').count(),1);
 assert.equal(await page.locator('#automation-next-step').isVisible(),false);
 assert.equal(await page.locator('[data-progress-action=message]').count(),0);
 assert.equal(await page.locator('#agent .worker-chat').isVisible(),false);
 assert.equal(await page.locator('#agent .worker-outcome').isVisible(),false);
 assert.equal(await page.locator('#agent .worker-task').isVisible(),false);
 assert.equal(await page.locator('#automation-chat-feedback').isVisible(),false);
 assert.equal(await page.locator('#start').isVisible(),true);
 assert.equal(await page.locator('#terminal').isVisible(),true);
 await page.locator('#now-panel').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(data,'setup-question.png'),fullPage:true});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,850));
 await page.screenshot({path:path.join(data,'setup-compact.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 // Failed sends preserve the answer and leave a usable retry action.
 await app.evaluate(()=>{globalThis.failSetupStart=true;});
 await page.locator('#automation-message').fill('En fazla 1.300 €; en az 2 oda.');await page.locator('#automation-send').click();
 await page.locator('#automation-chat-feedback.error').waitFor({state:'visible'});
 assert.equal(await page.locator('#automation-message').inputValue(),'En fazla 1.300 €; en az 2 oda.');
 assert.equal(await page.locator('#automation-send').isEnabled(),true);
 await page.locator('#automation-send').click();await page.locator('#automation-message').waitFor({state:'hidden'});
 await page.locator('#terminal .xterm-helper-textarea').focus();await page.keyboard.type('LIVE_INPUT');
 assert.match(await app.evaluate(()=>globalThis.setupTyped),/LIVE_INPUT/);
 await page.evaluate(id=>window.jobloop.workspaceStop(id),id);
 assert.deepEqual(errors,[]);console.log('SETUP_CONVERSATION_TERMINAL_APPROVAL_RETRY_PASS',data);
}catch(error){if(page)await page.screenshot({path:path.join(data,'failure.png'),fullPage:true}).catch(()=>{});console.error('SCREENSHOTS',data);throw error;}
finally{await app.close();}
