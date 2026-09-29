import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../app/store.mjs';

const require=createRequire(import.meta.url);
const {_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-permissions-'));
const store=new Store(path.join(data,'jobloop.sqlite'));
const candidate=store.saveProfile({name:'Permission Test',preferences:'Remote',authorization:'research'});
store.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.locator('button[data-view=agent]').click();
 await page.locator('#provider').selectOption('claude');
 for(const permission of ['acceptEdits','auto']){
  await page.locator('#permission').selectOption(permission);
  await page.waitForFunction(async({id,permission})=>(await window.jobloop.workspaceSnapshot(id)).workspace.agentSettings.permission===permission,{id:candidate.id,permission});
  await page.reload();await page.locator('button[data-view=agent]').click();
  assert.equal(await page.locator('#permission').inputValue(),permission);
 }
 await page.locator('button[data-view=background]').click();
 await page.locator('#background-settings').click();
 await page.locator('#background-form [name=inheritAgent]').uncheck();
 await page.locator('#background-form [name=provider]').selectOption('claude');
 await page.locator('#background-form [name=permission]').selectOption('auto');
 await page.locator('#background-form button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#notice').textContent==='Arka plan görevi kaydedildi.');
 await page.reload();await page.locator('button[data-view=background]').click();
 await page.locator('#background-settings').click();
 assert.equal(await page.locator('#background-form [name=permission]').inputValue(),'auto');
 assert.equal(await page.locator('#background-form [name=inheritAgent]').isChecked(),false);
 await page.locator('button[data-view=templates]').click();await page.locator('[data-template=job-search]').click();
 await page.locator('#setup-begin').click();
 await page.locator('#setup-settings summary').click();
 await page.locator('#setup-provider').selectOption('codex');
 assert.equal(await page.locator('#setup-permission option[value=auto]').count(),0);
 await page.locator('#setup-provider').selectOption('claude');
 await page.locator('#setup-permission').selectOption('auto');
 const setup=await page.evaluate(()=>window.jobloop.workspaceCreate('job-search',{intake:true,agentSettings:{provider:document.querySelector('#setup-provider').value,model:document.querySelector('#setup-model').value,permission:document.querySelector('#setup-permission').value,reasoning:document.querySelector('#setup-reasoning').value,network:null}}));
 assert.equal((await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),setup.id)).workspace.agentSettings.permission,'auto');
 assert.deepEqual(errors,[]);
 console.log('PERMISSIONS_UI_PASS',data);
}finally{await app.close();}
