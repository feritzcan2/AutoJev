import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {BrowserTools} from '../app/browser.mjs';
import {workerTabs} from '../src/workspace-tabs.js';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const directory=await mkdtemp(path.join(tmpdir(),'worker-tabs-'));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/form'?'<title>Application form</title><h1>Application form</h1>':'<title>Listing</title><h1>Listing</h1><a href="/form" target="_blank">Open application</a>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/`;
const browsers=new BrowserTools(directory,()=>({connection:'separate',headless:true}));
const scope={automationWorkspaceId:'workspace',automationTabKey:'record:item'},decode=result=>JSON.parse(result.content.find(p=>p.type==='text').text);
let app;
try{
 browsers.prepare('workspace');await browsers.connections.pending.get('workspace');assert.equal(browsers.status('workspace').ready,true,JSON.stringify(browsers.status('workspace')));
 const listing=decode(await browsers.call('workspace','browser_jev_open',{url},'run',scope));
 const link=listing.clickTargets.find(t=>t.label==='Open application');assert.ok(link,JSON.stringify(listing.clickTargets));
 await browsers.call('workspace','browser_jev_click',{tabId:listing.tabId,targetId:link.targetId},'run',scope);
 let tabs;
 for(let i=0;i<30;i++){tabs=(await browsers.workspaceTabs('workspace')).filter(t=>t.runId==='run');if(tabs.length===2&&tabs.some(t=>t.url.endsWith('/form')))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(tabs.length,2);assert.ok(tabs.every(t=>t.runId==='run'&&t.recordId==='item'),JSON.stringify(tabs));
 const snapshot={automation:{browserMode:'jev'},workers:[{id:'main',name:'Worker 1',active:{sessionId:'provider'},execution:{task:{id:'run'}}}],runs:[{id:'run',workerId:'main',recordId:'item',status:'running',resumeContext:{tabId:listing.tabId}}]};
 assert.equal(workerTabs(snapshot,'main',tabs).length,2);
 const env={...process.env,JOBLOOP_DATA_DIR:path.join(directory,'ui')};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
 const page=await app.firstWindow();
 await page.evaluate(async({snapshot,tabs})=>{
  const {workerPane}=await import('../src/worker-pane.js'),{workerTabControls}=await import('../src/worker-tabs.js');
  const host=document.createElement('main');host.style.width='420px';document.body.replaceChildren(host);
  window.current=snapshot;window.openTabs=[...tabs,{tabId:'unrelated',url:'https://other.test',runId:'other-run'}];window.focused=[];window.notices=[];
  const api={workspaceTabs:async()=>window.openTabs,workspaceSnapshot:async()=>window.current,focusWorkspaceTab:async(id,tabId)=>window.focused.push({id,tabId})};
  const controls=workerTabControls(api,{notice:text=>window.notices.push(text)});
  const pane={id:'main',candidate:'workspace',worker:snapshot.workers[0],...workerPane({id:'main',name:'Worker 1',showChat:false,actions:{tab:()=>controls.toggle(pane)}})};
  pane.host.hidden=true;host.append(pane.card);window.pane=pane;window.controls=controls;window.render=()=>controls.update('workspace',window.current,new Map([['main',pane]]));window.render();
 },{snapshot,tabs});
 const toggle=page.locator('[data-worker-tab="main"]');await page.waitForFunction(()=>document.querySelector('[data-worker-tab="main"]').textContent==='Sekmeler (2)');
 await toggle.click();assert.equal(await page.locator('.worker-tab-link').count(),2);
 await page.locator(`[data-tab-id="${listing.tabId}"]`).click();assert.deepEqual(await page.evaluate(()=>window.focused),[{id:'workspace',tabId:listing.tabId}]);
 // A task switch after rendering must be revalidated before focus.
 await page.evaluate(()=>window.current.runs[0].status='completed');
 await page.locator('.worker-tab-link').last().click();assert.equal((await page.evaluate(()=>window.focused)).length,1);assert.match((await page.evaluate(()=>window.notices))[0],/aktif işine ait değil/);
 await page.evaluate(()=>{window.current.runs[0].status='running';window.openTabs=window.openTabs.filter(t=>t.url.endsWith('/form'));});
 await toggle.click();await toggle.click();await page.waitForFunction(()=>document.querySelector('[data-worker-tab="main"]').textContent==='Sekmeler (1)');assert.equal(await page.locator('.worker-tab-link').count(),1);
 await page.screenshot({path:'/tmp/worker-tabs-menu.png'});
 await page.evaluate(()=>{window.current.runs[0].status='completed';window.pane.worker.active=null;window.render();});assert.equal(await toggle.isDisabled(),true);assert.equal(await page.locator('.worker-tabs').isHidden(),true);
 console.log('WORKER_TABS_POPUP_OWNERSHIP_MENU_FOCUS_CLOSED_AND_TASK_CHANGE_PASS');
}finally{if(app)await app.close();await browsers.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
