import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'loop-workspace-services-ui-')),source=path.join(data,'fixture.txt');await writeFile(source,'Synthetic workspace document');
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.jobloop)&&document.querySelector('#setup-provider').options.length>0);
 await app.evaluate(({dialog,shell},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});shell.openPath=async file=>{globalThis.openedWorkspaceDocument=file;return '';};},source);
 const profiles=await page.evaluate(async()=>[await window.jobloop.workspaceCreate('job-search',{name:'Job fixture',preferences:'Local test'}),await window.jobloop.workspaceCreate('housing',{title:'Housing fixture'})]);
 assert.deepEqual(await page.evaluate(()=>['automationRename','automationDelete','automationPickDocument','automationOpenDocument','pickCv'].filter(key=>key in window.jobloop)),[]);
 for(const [index,profile] of profiles.entries()){
  const value=index?'automation:'+profile.id:profile.id;
  await page.waitForFunction(value=>[...document.querySelector('#candidates').options].some(o=>o.value===value),value);
  await page.locator('#candidates').selectOption(value);
  await page.locator('#rename-workspace').click();await page.locator('#rename-workspace-dialog input').fill(`Renamed ${index}`);await page.locator('#rename-workspace-dialog [type=submit]').click();
  await page.waitForFunction(async({id,title})=>(await window.jobloop.workspaces()).find(w=>w.id===id)?.title===title,{id:profile.id,title:`Renamed ${index}`});
  const imported=await page.evaluate(id=>window.jobloop.pickDocument(id),profile.id),docs=await page.evaluate(id=>window.jobloop.documents(id),profile.id);assert.equal(docs.length,1);
  assert.equal(await page.evaluate(({id,file})=>window.jobloop.readDocument(id,file),{id:profile.id,file:docs[0].path}),'Synthetic workspace document');
  await page.evaluate(({id,file})=>window.jobloop.openDocument(id,file),{id:profile.id,file:docs[0].path});assert.equal(await app.evaluate(()=>globalThis.openedWorkspaceDocument),await realpath(imported));
  const worker=await page.evaluate(id=>window.jobloop.addWorker(id),profile.id);assert.equal((await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),profile.id)).workers.length,2);
  await page.evaluate(({id,worker})=>window.jobloop.removeWorker(id,worker),{id:profile.id,worker:worker.id});assert.equal((await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),profile.id)).workers.length,1);
 }
 const cv=await page.evaluate(id=>window.jobloop.pickDocument(id,{purpose:'cv'}),profiles[0].id);assert.equal((await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),profiles[0].id)).profile.cvPath,cv);
 for(const [index,profile] of [...profiles.entries()].reverse()){
  await page.locator('#candidates').selectOption(index?'automation:'+profile.id:profile.id);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#delete-workspace').click();
  await page.waitForFunction(async id=>!(await window.jobloop.workspaces()).some(w=>w.id===id),profile.id);
 }
 assert.deepEqual(errors,[]);console.log('WORKSPACE_SERVICES_UI_PASS',data);
}finally{await app.close();}
