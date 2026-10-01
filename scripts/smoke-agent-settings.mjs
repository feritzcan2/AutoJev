import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url);
const {_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-agent-settings-'));
const store=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(store);
const owner=db.create('custom',{title:'Settings test'});store.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('[data-view=agent]').click();
 const form=page.locator('#agent-settings-form'),field=form.locator('[name=contextCompactPercent]'),save=form.getByRole('button',{name:'Kaydet',exact:true});
 const snapshot=()=>page.evaluate(id=>window.jobloop.workspaceSnapshot(id),owner.id);
 const initial=await snapshot();
 // Periodic snapshots must not overwrite the draft, and editing must not save it.
 await field.fill('60');await field.press('Tab');
 assert.equal((await snapshot()).workspace.agentSettings.contextCompactPercent,0);
 await app.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('changed',{candidateId:id}),owner.id);
 assert.equal(await field.inputValue(),'60');
 await save.click();await page.waitForFunction(()=>document.querySelector('#agent-settings-status').textContent.startsWith('Kaydedildi.'));
 assert.equal((await snapshot()).workspace.agentSettings.contextCompactPercent,60);
 assert.equal(await page.locator('#agent-settings-restart-dialog').isVisible(),false);
 await form.locator('[name=provider]').selectOption('opencode');
 assert.deepEqual(await form.locator('[name=permission] option').evaluateAll(options=>options.map(option=>option.value)),['default','plan','bypassPermissions']);
 await form.locator('[name=model]').selectOption('opencode-go/kimi-k2.7-code');
 assert.equal(await field.isDisabled(),true);
 assert.equal(await form.locator('[name=network]').isDisabled(),true);
 await save.click();await page.waitForFunction(()=>document.querySelector('#agent-settings-status').textContent.startsWith('Kaydedildi.'));
 assert.equal((await snapshot()).workspace.agentSettings.provider,'opencode');
 await page.reload();await page.locator('[data-view=agent]').click();
 assert.equal(await form.locator('[name=provider]').inputValue(),'opencode');
 assert.equal(await form.locator('[name=model]').inputValue(),'opencode-go/kimi-k2.7-code');
 console.log('OPENCODE_SETTINGS_UI_PASS');
 // Simulate active workers without launching any provider or touching real workspaces.
 await app.evaluate(({ipcMain},{initial})=>{
  globalThis.settingsTest={restarts:[],failSave:false,failRestart:false,input:null};
  ipcMain.removeHandler('workspace-snapshot');ipcMain.handle('workspace-snapshot',()=>{
   const s=globalThis.settingsTest;return {...initial,workspace:{...initial.workspace,...s.input},workers:[{...initial.workers[0],active:{sessionId:'settings-main',state:'Idle'}},{...initial.workers[0],id:'second',name:'Worker 2',active:{sessionId:'settings-second',state:'Idle'}},{...initial.workers[0],id:'stopped',name:'Stopped',active:null,execution:{status:'paused',task:null}}]};
  });
  ipcMain.removeHandler('workspace-settings');ipcMain.handle('workspace-settings',(_event,id,input)=>{const s=globalThis.settingsTest;if(s.failSave)throw Error('Test save failure');s.input=input;return input;});
  ipcMain.removeHandler('worker-restart');ipcMain.handle('worker-restart',(_event,id,worker)=>{const s=globalThis.settingsTest;s.restarts.push({id,worker});if(s.failRestart&&worker==='main')throw Error('Test restart failure');return {};});
 },{initial});
 await page.reload();await page.locator('[data-view=agent]').click();
 const dialog=page.locator('#agent-settings-restart-dialog');
 await field.fill('55');await save.click();await dialog.waitFor();
 await page.screenshot({path:path.join(data,'restart-dialog.png')});
 assert.equal((await app.evaluate(()=>globalThis.settingsTest)).input.agentSettings.contextCompactPercent,55);
 await dialog.getByRole('button',{name:'Daha sonra',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#agent-settings-status').textContent.startsWith('Kaydedildi.'));
 assert.deepEqual((await app.evaluate(()=>globalThis.settingsTest)).restarts,[]);
 await field.fill('50');await save.click();await dialog.getByRole('button',{name:'Yeniden başlat',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#agent-settings-status').textContent.includes('2 agent yeniden başlatıldı'));
 assert.deepEqual((await app.evaluate(()=>globalThis.settingsTest)).restarts,[{id:owner.id,worker:'main'},{id:owner.id,worker:'second'}]);
 await app.evaluate(()=>{globalThis.settingsTest.failSave=true;});
 await field.fill('45');await save.click();await page.waitForFunction(()=>document.querySelector('#agent-settings-status').textContent.startsWith('Kaydedilemedi:'));
 assert.equal(await dialog.isVisible(),false);assert.equal(await field.inputValue(),'45');
 await app.evaluate(()=>{globalThis.settingsTest.failSave=false;globalThis.settingsTest.failRestart=true;globalThis.settingsTest.restarts=[];});
 await save.click();await dialog.getByRole('button',{name:'Yeniden başlat',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#agent-settings-status').textContent.includes('Yeniden başlatılamayan'));
 assert.equal((await app.evaluate(()=>globalThis.settingsTest)).restarts.length,2,'a failed worker must not skip the next worker');
 await page.screenshot({path:path.join(data,'agent-settings.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log('AGENT_SETTINGS_UI_PASS',data);
}finally{await app.close();}
