import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'loop-no-quotas-')),core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(core);
const a=db.create('custom',{title:'Limit kaldırma testi',goal:'Test kayıtlarını izle',sources:['https://example.test'],criteria:{outcome:'Kayıtları izle',rules:'Uygun kayıtlar',completion:'Kullanıcı durdurduğunda'}});
db.review(a.id);db.skipTrial(a.id);core.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('[data-view=profile]').click();await page.locator('#automation-plan-form').waitFor();
 assert.equal(await page.locator('#automation-plan-form [name=maxActionsPerDay], #automation-plan-form [name=maxActionsTotal], #automation-plan-form [name=endAt], #automation-plan-form [name=intervalMinutes]').count(),0);
 await page.locator('#automation-plan-form [name=title]').fill('Profil kaydı çalışıyor');
 await page.locator('#automation-plan-form button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#automation-save-state').textContent==='Kurulum kaydedildi');
 const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id);
 assert.equal(snapshot.automation.title,'Profil kaydı çalışıyor');
 for(const key of ['maxActionsTotal','maxActionsPerDay','endAt'])assert.equal(key in snapshot.automation,false);
 await page.locator('[data-view=sources]').click();await page.locator('.source-row').first().waitFor();assert.ok((await page.locator('[data-automation-pane=sources]').innerText()).includes('Tarama aralığı (dk)'));
 assert.deepEqual(errors,[]);console.log('PROFILE_NO_QUOTAS_PASS');
}finally{await app.close();}
