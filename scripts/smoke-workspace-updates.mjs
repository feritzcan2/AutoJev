import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'loop-workspace-updates-')),store=new WorkspaceDatabase(path.join(data,'jobloop.sqlite'));
const workspace=new AutomationStore(store).create('custom',{title:'Workspace update fixture'});store.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const application=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env}),errors=[];
application.process().stderr.on('data',bytes=>{const text=bytes.toString();if(/Error occurred in handler for '(terminal-resize|terminal-output|worker-transcript|worker-preview)'/.test(text))errors.push(text);});
let page;
try{
 page=await application.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(id=>document.querySelector('#candidates').value===id,workspace.id);
 await application.evaluate(async(_,urls)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {Engine}=await load(urls.engine),request=Engine.prototype.request;
  Engine.prototype.request=function(op,args={}){if(op==='start'){globalThis.updateEngine=this;globalThis.updateSession=args.sessionId;return Promise.resolve({});}if(['resize','input'].includes(op))return Promise.resolve({});return request.call(this,op,args);};
  const {Workspaces}=await load(urls.workspaces),validate=Workspaces.prototype.validateWorker;
  Workspaces.prototype.validateWorker=function(...args){globalThis.updatingWorkspaces=this;return validate.apply(this,args);};
 },{engine:pathToFileURL(path.resolve('app/engine.mjs')).href,workspaces:pathToFileURL(path.resolve('app/workspaces.mjs')).href});
 await page.locator('[data-view=setup-agent]').click();
 await page.locator('#automation-message').fill('Synthetic terminal update check');await page.locator('#automation-send').click();
 await page.locator('#setup-agent-tab-terminal').click();
 await page.locator('#setup-agent-terminal .xterm').waitFor({state:'visible'});
 await application.evaluate(()=>globalThis.updateEngine.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'output',sessionId:globalThis.updateSession,bytes:[...Buffer.from('UPDATE_RESIZE_OK\r\n')]})+'\n')));
 await page.waitForFunction(()=>document.querySelector('#setup-agent-terminal .xterm-rows').textContent.includes('UPDATE_RESIZE_OK'));
 const before=await page.evaluate(id=>window.jobloop.terminalOutput(id,'conversation'),workspace.id);
 await application.evaluate((_,id)=>globalThis.updatingWorkspaces.changing.add(id),workspace.id);
 try{
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1600,1000));
  await page.waitForFunction(async({id,cols})=>(await window.jobloop.terminalOutput(id,'conversation')).cols>cols,{id:workspace.id,cols:before.cols});
  assert.deepEqual((await page.evaluate(id=>window.jobloop.workerTranscript(id,'conversation'),workspace.id)).messages,[]);
  assert.equal((await page.evaluate(id=>window.jobloop.workerPreview(id,'conversation'),workspace.id)).state,'waiting');
  await page.screenshot({path:path.join(data,'terminal-during-update.png')});
 }finally{await application.evaluate((_,id)=>globalThis.updatingWorkspaces.changing.delete(id),workspace.id);}
 assert.deepEqual(errors,[]);console.log('WORKSPACE_UPDATES_PASS',data);
}catch(error){if(page)await page.screenshot({path:path.join(data,'failure.png'),fullPage:true}).catch(()=>{});console.error('SCREENSHOTS',data);throw error;}
finally{await application.close();}
