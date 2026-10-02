import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {BrowserTools} from '../app/browser.mjs';
import {workerPreviews} from '../app/worker-preview.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const directory=await mkdtemp(path.join(tmpdir(),'worker-preview-')),root=process.cwd();
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<html><title>Worker ${req.url.slice(1)}</title><body style="background:${req.url==='/one'?'#d9eaff':'#e3f4df'};font:24px system-ui;padding:55px"><h1>Worker ${req.url.slice(1)}</h1><p>Bu sayfa yalnızca önizleme testi içindir.</p><input value="Korunan form taslağı"><p id="tick"></p><script>setInterval(()=>document.querySelector('#tick').textContent=new Date().toLocaleTimeString(),500)</script></body></html>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browsers=new BrowserTools(directory,()=> 'jev',()=>({connection:'separate',headless:true})),sessions=new Map([['main',{sessionId:'run-one'}],['second',{sessionId:'run-two'}]]);
const preview=workerPreviews({browsers,sessionFor:(id,worker)=>sessions.get(worker)}),counts={main:0,second:0};
let app;
try{
 browsers.prepare('workspace');await browsers.connections.pending.get('workspace');assert.equal(browsers.status('workspace').ready,true,JSON.stringify(browsers.status('workspace')));
 for(const [worker,slug] of [['main','one'],['second','two']]){
  const result=await browsers.forWorker(worker).call('workspace','browser_jev_open',{url:base+'/'+slug},sessions.get(worker).sessionId,{automationWorkspaceId:'workspace',automationTabKey:'source:'+slug});
  assert.ok(!result.isError,JSON.stringify(result));
 }
 const first=await preview('workspace','main'),second=await preview('workspace','second');assert.equal(first.state,'ready');assert.equal(second.state,'ready');assert.notEqual(first.tabId,second.tabId);assert.match(first.url,/\/one$/);assert.match(second.url,/\/two$/);assert.ok(first.image.length>1000);
 const client=browsers.clients.get('workspace').client,slot=client.tabs.get(first.tabId);slot.pending={decisionId:'retained'};
 await preview('workspace','main');assert.equal(slot.pending.decisionId,'retained');
 await build({stdin:{contents:`export {workerTerminals} from ${JSON.stringify(path.join(root,'src/worker-terminals.js'))};`,resolveDir:root},bundle:true,format:'esm',outfile:path.join(directory,'fixture.mjs'),loader:{'.woff2':'file','.ttf':'file'}});
 const env={...process.env,JOBLOOP_DATA_DIR:path.join(directory,'ui')};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:require('electron'),args:[root],env});const page=await app.firstWindow(),errors=[];
 await page.waitForLoadState('load');assert.equal(await page.evaluate(()=>typeof window.jobloop.workerPreview),'function');
 // Load an isolated fixture document so the full app's refresh timers do not
 // keep rendering into the replaced DOM during component integration tests.
 const html=path.join(directory,'fixture.html');await writeFile(html,`<!doctype html><html lang="tr"><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(root,'dist/renderer.css')).href}"><body></body></html>`);
 await app.evaluate(({BrowserWindow},html)=>{const window=BrowserWindow.getAllWindows()[0];window.webContents.removeAllListeners('will-navigate');return window.loadFile(html);},html);
 page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('capturePreview',async(id,worker)=>{counts[worker]++;return preview(id,worker);});
 await page.evaluate(async fixture=>{
  const {workerTerminals}=await import(fixture),main=document.createElement('main'),container=document.createElement('section');main.style.cssText='width:100%;padding:24px;max-width:none;margin:0';main.append(container);document.body.replaceChildren(main);
  window.previewFixture={automation:{browserMode:'jev'},capabilities:{maxWorkers:8},workers:[{id:'main',name:'Worker 1',active:{sessionId:'run-one',state:'Working'},execution:{task:{id:'run-one'}}},{id:'second',name:'Worker 2',active:{sessionId:'run-two',state:'Working'},execution:{task:{id:'run-two'}}}],runs:[{id:'run-one',workerId:'main',status:'running'},{id:'run-two',workerId:'second',status:'running'}]};
  const api={workerPreview:window.capturePreview,workspaceTabs:async()=>[],resize:async()=>{},terminalOutput:async(id,worker)=>({bytes:[...new TextEncoder().encode('Terminal '+worker+' · çıktı korunur\r\n')],sequence:0,rows:24,cols:80}),workerTranscript:async()=>({messages:[]})};
  window.terminals=workerTerminals(api,{container,notice:text=>{throw Error(text);},refresh:async()=>{}});window.terminals.update('workspace',window.previewFixture);
 },pathToFileURL(path.join(directory,'fixture.mjs')).href);
 const one=page.locator('.worker-pane[data-worker-id=main]'),two=page.locator('.worker-pane[data-worker-id=second]');
 await one.locator('.xterm-screen').waitFor();assert.equal(counts.main,0);assert.equal(counts.second,0);
 await one.getByRole('tab',{name:'Ekran görüntüsü',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-worker-id=main] img')?.naturalWidth>0);
 assert.equal(await two.getAttribute('data-view'),'terminal');assert.equal(counts.second,0);
 await two.getByRole('tab',{name:'Ekran görüntüsü',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-worker-id=second] img')?.naturalWidth>0);
 assert.match(await one.locator('.worker-screenshot-url').textContent(),/\/one$/);assert.match(await two.locator('.worker-screenshot-url').textContent(),/\/two$/);
 assert.notEqual(await one.locator('img').getAttribute('src'),await two.locator('img').getAttribute('src'));
 await page.screenshot({path:path.join(directory,'worker-previews.png')});
 await one.getByRole('tab',{name:'Terminal',exact:true}).click();await one.locator('.xterm-screen').waitFor({state:'visible'});
 assert.match(await one.locator('.xterm-screen').textContent(),/çıktı korunur/);
 const afterSwitch=counts.main;await new Promise(r=>setTimeout(r,1800));assert.equal(counts.main,afterSwitch);
 // Keyboard navigation and independent persisted preferences.
 await one.getByRole('tab',{name:'Terminal',exact:true}).press('ArrowRight');assert.equal(await one.getAttribute('data-view'),'screenshot');
 assert.equal(await page.evaluate(()=>localStorage.getItem('worker-view:workspace:main')),'screenshot');
 // Closed workers keep a clearly labelled last frame, without polling.
 sessions.delete('second');await page.evaluate(()=>{window.previewFixture.workers[1].active=null;window.terminals.update('workspace',window.previewFixture);});
 assert.match(await two.locator('.worker-screenshot-status').textContent(),/Worker durdu · Son görüntü/);
 const afterStop=counts.second;await new Promise(r=>setTimeout(r,1800));assert.equal(counts.second,afterStop);
 // A new run must immediately clear its predecessor's image.
 sessions.set('second',{sessionId:'new-run'});await page.evaluate(()=>{window.previewFixture.workers[1].active={sessionId:'new-run',state:'Working'};window.terminals.update('workspace',window.previewFixture);});
 assert.equal(await two.locator('img').getAttribute('src'),null);
 // Leaving the Agent page stops all screenshots.
 await page.evaluate(()=>document.querySelector('main').hidden=true);await new Promise(r=>setTimeout(r,300));const hiddenCounts={...counts};await new Promise(r=>setTimeout(r,1800));assert.deepEqual(counts,hiddenCounts);
 await page.evaluate(()=>window.terminals.dispose());assert.deepEqual(errors,[]);
 console.log('WORKER_PREVIEW_ISOLATION_SWITCH_POLLING_TERMINAL_RETENTION_PASS',JSON.stringify({directory,counts}));
}finally{if(app)await app.close();await browsers.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
