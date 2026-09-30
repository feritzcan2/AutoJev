import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';

const require=createRequire(import.meta.url);
const {_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-deletion-'));
const store=new Store(path.join(data,'jobloop.sqlite'));
const keeper=store.saveProfile({name:'Keep me',preferences:'Remote'});store.close();
const app=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>Boolean(document.querySelector('#candidates').value));
 await app.evaluate(async(_,urls)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {Workspaces}=await load(urls.workspaces),{BrowserTools}=await load(urls.browser),remove=Workspaces.prototype.remove,snapshot=Workspaces.prototype.snapshot;
  BrowserTools.prototype.prepare=()=>({state:'ready',ready:true});
  globalThis.deletions=0;
  Workspaces.prototype.snapshot=function(id){
   if(globalThis.delaySnapshot===id){globalThis.delaySnapshot=null;return new Promise((_,reject)=>{globalThis.rejectSnapshot=()=>reject(Error('Stale workspace snapshot'));});}
   return snapshot.call(this,id);
  };
  Workspaces.prototype.remove=async function(id){
   globalThis.deletions++;globalThis.deletionWaiting=false;
   const gate=new Promise(resolve=>{globalThis.releaseDeletion=resolve;});
   if(globalThis.failDeletion){globalThis.failDeletion=false;throw Error('Deletion test: worker could not stop');}
   const result=await remove.call(this,id);globalThis.deletionWaiting=true;
   await gate;return result;
  };
 },{workspaces:pathToFileURL(path.join(root,'app/workspaces.mjs')).href,browser:pathToFileURL(path.join(root,'app/browser.mjs')).href});
 for(const button of ['#delete-workspace','#automation-delete']){
  const workspace=await page.evaluate(()=>window.jobloop.workspaceCreate('custom',{title:'Delete this workspace'}));
  const directory=path.join(data,'automations','workspaces',workspace.id);
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'note.txt'),'Temporary');
  await page.reload();await page.locator('#candidates').selectOption('automation:'+workspace.id);
  await page.waitForFunction(()=>document.querySelector('#heading').textContent==='Delete this workspace');
  await page.locator('[data-view=profile]').click();
  page.once('dialog',dialog=>dialog.dismiss());await page.locator(button).click();
  assert.ok((await page.evaluate(()=>window.jobloop.workspaces())).some(w=>w.id===workspace.id));
  assert.equal(await app.evaluate(()=>globalThis.deletions),button==='#delete-workspace'?0:2);
  // A real failure leaves the workspace selected and permits a retry.
  await app.evaluate(()=>{globalThis.failDeletion=true;});
  page.once('dialog',dialog=>dialog.accept());await page.locator(button).click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('worker could not stop'));
  assert.equal(await page.locator('#delete-workspace').isDisabled(),false);
  // Hold an older refresh until after deletion to exercise late IPC failures.
  await app.evaluate((_,id)=>{globalThis.delaySnapshot=id;globalThis.rejectSnapshot=null;},workspace.id);
  await page.evaluate(id=>window.jobloop.renameWorkspace(id,'Delete this workspace'),workspace.id);
  for(let i=0;i<100&&!await app.evaluate(()=>Boolean(globalThis.rejectSnapshot));i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(await app.evaluate(()=>Boolean(globalThis.rejectSnapshot)),true);
  page.once('dialog',dialog=>dialog.accept());await page.locator(button).click();
  // The DB change emits refresh events before the delete IPC reply arrives.
  for(let i=0;i<100&&!await app.evaluate(()=>globalThis.deletionWaiting);i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(await app.evaluate(()=>globalThis.deletionWaiting),true);
  for(const selector of ['#delete-workspace','#automation-delete','#candidates','.workspace-switcher-trigger','#new'])assert.equal(await page.locator(selector).isDisabled(),true,selector+' must stay disabled during deletion');
  assert.match(await page.locator('#notice').textContent(),/siliniyor/);
  const count=await app.evaluate(()=>globalThis.deletions);
  await page.evaluate(()=>{document.querySelector('#delete-workspace').onclick();document.querySelector('#automation-delete').onclick();});
  assert.equal(await app.evaluate(()=>globalThis.deletions),count);
  await app.evaluate(()=>globalThis.releaseDeletion());
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('çalışma alanı silindi.'));
  await app.evaluate(()=>globalThis.rejectSnapshot());
  // Flush the late renderer promise before checking the final message.
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,100)));
  assert.match(await page.locator('#notice').textContent(),/çalışma alanı silindi\./);
  await page.waitForFunction(id=>![...document.querySelector('#candidates').options].some(o=>o.value==='automation:'+id),workspace.id);
  assert.equal(await stat(directory).then(()=>true,()=>false),false);
  await page.reload();await page.waitForFunction(id=>document.querySelector('#candidates').value===id,keeper.id);
  assert.equal((await page.evaluate(()=>window.jobloop.workspaces())).some(w=>w.id===workspace.id),false);
 }
 assert.deepEqual(errors,[]);console.log('Workspace deletion OK: cancel, failure/retry, concurrent refresh, both buttons, files, reload.');
}finally{await app.close();await rm(data,{recursive:true,force:true});}
