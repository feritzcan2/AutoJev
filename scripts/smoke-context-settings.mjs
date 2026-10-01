import {AutomationStore} from '../app/automation-store.mjs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
const require=createRequire(import.meta.url);
const {_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-context-ui-'));
const store=new WorkspaceDatabase(path.join(data,'jobloop.sqlite'));
const profile=new AutomationStore(store).create('job-search',{title:'Context Settings',goal:'Local UI test',mode:'observe'});store.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const snapshot=()=>page.evaluate(id=>window.jobloop.workspaceSnapshot(id),profile.id);
 await page.locator('button[data-view=agent]').click();
 const compact=page.locator('[name=contextCompactPercent]');assert.equal(await compact.inputValue(),'0');
 const field=page.locator('[name=contextRestartPercent]');assert.equal(await field.inputValue(),'0');
 for(const provider of ['codex','claude']){
  await page.locator('#provider').selectOption(provider);
  await compact.fill(provider==='codex'?'60':'55');await compact.press('Tab');await page.locator('#agent-settings-save').click();
  await page.waitForFunction(({id,percent})=>window.jobloop.workspaceSnapshot(id).then(s=>s.workspace.agentSettings.contextCompactPercent===percent),{id:profile.id,percent:provider==='codex'?60:55});
  await field.fill(provider==='codex'?'16':'20');await field.press('Tab');await page.locator('#agent-settings-save').click();
  await page.waitForFunction(({id,provider,percent})=>window.jobloop.workspaceSnapshot(id).then(s=>s.workspace.agentSettings.provider===provider&&s.workspace.agentSettings.contextRestartPercent===percent),{id:profile.id,provider,percent:provider==='codex'?16:20});
  await page.reload();await page.locator('button[data-view=agent]').click();
  assert.equal(await compact.inputValue(),provider==='codex'?'60':'55');
  assert.equal(await field.inputValue(),provider==='codex'?'16':'20');
  assert.equal((await snapshot()).active,null,'settings must never start an agent');
 }
 await compact.fill('101');await compact.press('Tab');await page.locator('#agent-settings-save').click();
 assert.equal(await page.locator('#agent-settings-form').evaluate(form=>form.checkValidity()),false);
 assert.equal((await snapshot()).workspace.agentSettings.contextCompactPercent,55);
 await compact.fill('0');await compact.press('Tab');await page.locator('#agent-settings-save').click();
 await page.waitForFunction(id=>window.jobloop.workspaceSnapshot(id).then(s=>s.workspace.agentSettings.contextCompactPercent===0),profile.id);
 await field.fill('500');await field.press('Tab');await page.locator('#agent-settings-save').click();
 assert.equal(await page.locator('#agent-settings-form').evaluate(form=>form.checkValidity()),false);
 assert.equal((await snapshot()).workspace.agentSettings.contextRestartPercent,20);
 await field.fill('0');await field.press('Tab');await page.locator('#agent-settings-save').click();
 await page.waitForFunction(id=>window.jobloop.workspaceSnapshot(id).then(s=>s.workspace.agentSettings.contextRestartPercent===0),profile.id);
 await page.reload();await page.locator('button[data-view=agent]').click();assert.equal(await field.inputValue(),'0');
 // Show measured usage and pending reset while keeping the test entirely local.
 const before=await snapshot();
 await app.evaluate(({ipcMain},{before})=>{
  ipcMain.removeHandler('workspace-snapshot');ipcMain.handle('workspace-snapshot',()=>({...before,workspace:{...before.workspace,agentSettings:{...before.workspace.agentSettings,contextRestartPercent:16}},active:{candidateId:before.workspace.id,sessionId:'ui-context-session',state:'Working',compaction:{state:'submitted'},contextUsage:{percent:18,peakPercent:18}}}));
 },{before});
 await page.reload();await page.locator('button[data-view=agent]').click();
 await page.getByText('Context kullanımı: %18. Eşik aşıldı; görev tamamlanınca yenilenecek.',{exact:true}).waitFor();
 await page.getByText('/compact gönderildi; sağlayıcıdan compaction bekleniyor.',{exact:true}).waitFor();
 await page.screenshot({path:path.join(data,'context-settings.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log('CONTEXT_SETTINGS_UI_PASS',data);
}finally{await app.close();}
