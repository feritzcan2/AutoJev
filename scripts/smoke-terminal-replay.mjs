import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'loop-terminal-replay-')),store=new Store(path.join(data,'jobloop.sqlite'));
const candidate=store.saveProfile({name:'Terminal fixture',preferences:'Remote'});store.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
let page;
try{
 page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(id=>document.querySelector('#candidates').value===id,candidate.id);
 await app.evaluate(async(_,url)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}),{Engine}=await load(url),original=Engine.prototype.request;
  globalThis.terminalCalls=[];
  Engine.prototype.request=function(op,args={}){
   if(['start','resize','input'].includes(op)){globalThis.terminalCalls.push({op,args});if(op==='start')globalThis.terminalEngine=this;return Promise.resolve({});}
   return original.call(this,op,args);
  };
 },pathToFileURL(path.resolve('app/engine.mjs')).href);
 await page.locator('#new').click();await page.locator('[data-view=agent]').click();await page.locator('.worker-idle').waitFor({state:'visible'});
 assert.equal(await page.locator('#terminal').isVisible(),false);
 await page.locator('.worker-idle').screenshot({path:path.join(data,'agent-closed.png')});
 const id=await page.evaluate(()=>localStorage.getItem('selected-automation'));
 await page.locator('#automation-message').fill('Synthetic terminal check');await page.locator('#automation-send').click();await page.locator('#automation-message').waitFor({state:'hidden'});
 const launch=await app.evaluate(()=>globalThis.terminalCalls.find(c=>c.op==='start').args);
 assert.ok(launch.cols>80,'use the visible pane grid on the first provider frame');
 const emit=text=>app.evaluate((_,bytes)=>globalThis.terminalEngine.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'output',bytes})+'\n')),[...Buffer.from(text)]);
 const lines=()=>page.locator('#terminal .xterm-rows').innerText();
 await emit('\x1bc'+'A'.repeat(launch.cols+10)+'\r\n\x1b[1APASS\x1b[K\r\n');
 await page.waitForFunction(()=>document.querySelector('#terminal .xterm-rows').textContent.includes('PASS'));
 assert.ok((await lines()).includes('A'.repeat(launch.cols)));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1000));
 await page.waitForFunction(cols=>window.jobloop.terminalOutput(localStorage.getItem('selected-automation'),'main').then(s=>s.cols>cols),launch.cols);
 await page.waitForFunction(count=>document.querySelector('#terminal .xterm-rows').innerText.includes('A'.repeat(count)+'PASS'),launch.cols);
 const before=await lines();
 await page.reload();await page.locator('[data-view=agent]').click();await page.locator('#terminal .xterm').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('#terminal .xterm-rows').textContent.includes('PASS'));
 assert.equal(await lines(),before,'reload preserves the resized screen and cursor edits');
 await emit('\r\nCanlı çıktı: İstanbul ✓');await page.waitForFunction(()=>document.querySelector('#terminal .xterm-rows').textContent.includes('İstanbul ✓'));
 const live=await lines();
 await page.locator('#candidates').selectOption(candidate.id);await page.locator('#candidates').selectOption('automation:'+id);await page.locator('[data-view=agent]').click();
 await page.waitForFunction(()=>document.querySelector('#terminal .xterm-rows').textContent.includes('İstanbul ✓'));
 assert.equal(await lines(),live,'workspace return preserves live text');
 // Updates buffered during restoration must appear once, after the snapshot.
 await page.reload();await emit('\r\nAFTER_RELOAD');await page.locator('[data-view=agent]').click();
 await page.waitForFunction(()=>document.querySelector('#terminal .xterm-rows').textContent.includes('AFTER_RELOAD'));
 assert.equal((await lines()).split('AFTER_RELOAD').length-1,1);
 await page.locator('#terminal .xterm-helper-textarea').focus();await page.keyboard.type('USER_INPUT');
 assert.match(await app.evaluate(()=>globalThis.terminalCalls.filter(c=>c.op==='input').map(c=>c.args.text).join('')),/USER_INPUT/);
 await page.locator('#terminal').screenshot({path:path.join(data,'terminal.png')});assert.deepEqual(errors,[]);
 await page.evaluate(id=>window.jobloop.workspaceStop(id),id);
 await page.locator('.worker-idle').waitFor({state:'visible'});assert.equal(await page.locator('#terminal').isVisible(),false);
 await page.locator('.worker-idle-history').click();await page.locator('#terminal').waitFor({state:'visible'});assert.match(await lines(),/AFTER_RELOAD/);
 await page.locator('.worker-idle-history').click();assert.equal(await page.locator('#terminal').isVisible(),false);
 console.log('TERMINAL_REPLAY_PASS',data);
}catch(error){if(page)await page.screenshot({path:path.join(data,'failure.png'),fullPage:true}).catch(()=>{});console.error('SCREENSHOTS',data);throw error;}
finally{await app.close();}
