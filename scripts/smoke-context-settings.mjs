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
const profile=new AutomationStore(store).create('custom',{title:'Context Settings',goal:'Local UI test',mode:'observe'});store.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForLoadState('networkidle');
 const snapshot=()=>page.evaluate(id=>window.jobloop.workspaceSnapshot(id),profile.id);
 await page.locator('button[data-view=agent]').click();
 const compact=page.locator('[name=contextCompactTokens]');assert.equal(await compact.inputValue(),'150.000');
 const field=page.locator('[name=contextRestartTokens]');assert.equal(await field.inputValue(),'0');
 for(const provider of ['codex','claude']){
  await page.locator('#provider').selectOption(provider);
  await compact.fill(provider==='codex'?'120000':'55000');await compact.press('Tab');await page.locator('#agent-settings-save').click();
  await page.waitForFunction(({id,tokens})=>window.jobloop.workspaceSnapshot(id).then(s=>s.workspace.agentSettings.contextCompactTokens===tokens),{id:profile.id,tokens:provider==='codex'?120000:55000});
  await field.fill(provider==='codex'?'160000':'200000');await field.press('Tab');await page.locator('#agent-settings-save').click();
  await page.waitForFunction(({id,provider,tokens})=>window.jobloop.workspaceSnapshot(id).then(s=>s.workspace.agentSettings.provider===provider&&s.workspace.agentSettings.contextRestartTokens===tokens),{id:profile.id,provider,tokens:provider==='codex'?160000:200000});
  await page.reload();await page.locator('button[data-view=agent]').click();
  assert.equal(await compact.inputValue(),provider==='codex'?'120.000':'55.000');
  assert.equal(await field.inputValue(),provider==='codex'?'160.000':'200.000');
  assert.equal((await snapshot()).active,null,'settings must never start an agent');
 }
 // Typing, pasted grouping and edits in the middle preserve usable caret positions.
 await compact.fill('');await compact.pressSequentially('1234567');assert.equal(await compact.inputValue(),'1.234.567');
 await compact.evaluate(el=>el.setSelectionRange(2,2));await compact.press('Backspace');assert.equal(await compact.inputValue(),'234.567');
 await compact.fill('123.456');await compact.evaluate(el=>el.setSelectionRange(3,3));await compact.press('Delete');assert.equal(await compact.inputValue(),'12.356');
 await compact.fill('120.000');assert.equal(await compact.inputValue(),'120.000');
 await compact.fill('9007199254740992');assert.equal(await compact.evaluate(el=>el.checkValidity()),false);
 await compact.fill('');assert.equal(await compact.evaluate(el=>el.checkValidity()),false);
 await compact.fill('.');await compact.press('Backspace');assert.equal(await compact.inputValue(),'');
 await compact.fill('-1');await compact.press('Tab');await page.locator('#agent-settings-save').click();
 assert.equal(await page.locator('#agent-settings-form').evaluate(form=>form.checkValidity()),false);
 assert.equal((await snapshot()).workspace.agentSettings.contextCompactTokens,55000);
 await compact.fill('0');await compact.press('Tab');await page.locator('#agent-settings-save').click();
 await page.waitForFunction(id=>window.jobloop.workspaceSnapshot(id).then(s=>s.workspace.agentSettings.contextCompactTokens===0),profile.id);
 await field.fill('1e5');await field.press('Tab');await page.locator('#agent-settings-save').click();
 assert.equal(await page.locator('#agent-settings-form').evaluate(form=>form.checkValidity()),false);
 assert.equal((await snapshot()).workspace.agentSettings.contextRestartTokens,200000);
 await field.fill('0');await field.press('Tab');await page.locator('#agent-settings-save').click();
 await page.waitForFunction(id=>window.jobloop.workspaceSnapshot(id).then(s=>s.workspace.agentSettings.contextRestartTokens===0),profile.id);
 await page.reload();await page.locator('button[data-view=agent]').click();assert.equal(await field.inputValue(),'0');
 // Show measured usage and pending reset while keeping the test entirely local.
 const before=await snapshot();
 await app.evaluate(({ipcMain},{before})=>{
  ipcMain.removeHandler('workspace-snapshot');ipcMain.handle('workspace-snapshot',()=>({...before,workspace:{...before.workspace,agentSettings:{...before.workspace.agentSettings,contextRestartTokens:160000}},active:{candidateId:before.workspace.id,sessionId:'ui-context-session',state:'Working',compaction:{state:'submitted'},contextUsage:{tokens:180000,peakTokens:180000}}}));
 },{before});
 await page.reload();await page.locator('button[data-view=agent]').click();
 await page.getByText('Context kullanımı: 180.000 token. Eşiğe ulaşıldı; görev bitince yeni agent oturumu açılacak.',{exact:true}).waitFor();
 await page.getByText('/compact gönderildi; sağlayıcıdan compaction bekleniyor.',{exact:true}).waitFor();
 await page.screenshot({path:path.join(data,'context-settings.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log('CONTEXT_SETTINGS_UI_PASS',data);
}finally{await app.close();}
