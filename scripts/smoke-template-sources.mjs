import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'template-sources-')),env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite'));new AutomationStore(core);core.close();
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
app.process().stderr.on('data',data=>process.stderr.write(data));
try{
 const page=await app.firstWindow();
 page.setDefaultTimeout(15000);
 await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('automation-setup');ipcMain.handle('automation-setup',()=>({test:true}));});
 await page.locator('[data-template="job-search"]').click();
 await page.waitForFunction(()=>document.querySelector('#candidates')?.value);
 const snapshot=await page.evaluate(()=>window.jobloop.workspaceSnapshot(document.querySelector('#candidates').value));
 assert.equal(snapshot.automation.templateId,'job-search');assert.equal(snapshot.sources.length,14);assert.equal(snapshot.sources.filter(s=>s.enabled).length,10);
 await page.locator('aside nav [data-view=agent].selected').waitFor();
 await page.locator('aside nav [data-view=sources]').click();
 await page.locator('.source-name').filter({hasText:'LinkedIn'}).waitFor();await page.locator('.source-name').filter({hasText:'FreeHire'}).waitFor();
 assert.equal(await page.locator('.source-list .source-name').count(),14);
 assert.equal(snapshot.runs.length,0,'Template selection does not start a scan');
 console.log('TEMPLATE_SELECTION_SEEDS_14_SOURCES_UI_PASS');
}catch(error){console.error(error);throw error;}finally{await app.close();}
