import {AutomationStore} from '../app/automation-store.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(import.meta.dirname,'..'),data=await mkdtemp(path.join(tmpdir(),'jobloop-sources-'));
const seed=new WorkspaceDatabase(path.join(data,'jobloop.sqlite'));new AutomationStore(seed).create('job-search',{title:'Sources test',goal:'Berlin remote',mode:'observe'});seed.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('button[data-view=sources]').click();
 await page.locator('.source-row').first().waitFor();assert.equal(await page.locator('.source-row').count(),14);
 const row=page.locator('.source-row').filter({has:page.locator('.source-name', {hasText:'LinkedIn'})});
 await row.getByRole('button',{name:'Rehber ve araçlar'}).click();
 const dialog=page.locator('.source-skill-dialog');await dialog.waitFor();
 assert.equal(await dialog.locator('[name=integrationId]').inputValue(),'linkedin');
 await dialog.getByRole('button',{name:'Kaydedilmiş aracı test et'}).click();await page.waitForFunction(()=>document.querySelector('[data-result]')?.textContent.includes('Araç çalıştırılabiliyor'));
 await dialog.locator('[name=skillText]').fill('Search backend roles only; follow saved candidate location.');
 await dialog.locator('[name=searchMethod]').selectOption('browser');
 await dialog.getByRole('button',{name:'Kaydet',exact:true}).click();await dialog.waitFor({state:'detached'});
 await row.getByRole('button',{name:'Rehber ve araçlar'}).click();assert.equal(await dialog.locator('[name=skillText]').inputValue(),'Search backend roles only; follow saved candidate location.');assert.equal(await dialog.locator('[name=searchMethod]').inputValue(),'browser');
 await page.screenshot({path:path.join(data,'source-settings.png')});assert.deepEqual(errors,[]);console.log('Source UI passed: 14 defaults, CLI test, skill edit and saved method; screenshot:',path.join(data,'source-settings.png'));
}finally{await app.close();}
