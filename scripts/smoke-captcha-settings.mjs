import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-captcha-ui-'));
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>Boolean(window.jobloop));
 await app.evaluate(({ipcMain,safeStorage})=>{
  safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=> 'fixture';safeStorage.encryptString=s=>Buffer.from(s).reverse();safeStorage.decryptString=s=>Buffer.from(s).reverse().toString();
  ipcMain.removeHandler('captcha-settings-test');ipcMain.handle('captcha-settings-test',()=>({ok:true,balance:12.5,message:'Bağlantı doğrulandı. Bakiye: $12.50'}));
 });
 await page.evaluate(()=>window.jobloop.workspaceCreate('custom',{title:'CAPTCHA test',goal:'Synthetic UI test'}));await page.reload();
 await page.locator('[data-view=config]').click();await page.locator('a[href="#config-captcha"]').click();
 const panel=page.locator('#config-captcha');await panel.locator('input[name=apiKey]').fill('synthetic-captcha-key');await panel.locator('select[name=enabled]').selectOption('true');await panel.locator('input[name=dailyLimit]').fill('25');await panel.locator('button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#config-captcha [data-state]').textContent==='Otomatik çözüm açık');
 const saved=await page.evaluate(()=>window.jobloop.captchaSettingsStatus());assert.equal(saved.enabled,true);assert.equal(saved.dailyLimit,25);assert.doesNotMatch(JSON.stringify(saved),/synthetic-captcha-key|ciphertext|apiKey/);assert.equal(await panel.locator('input[name=apiKey]').inputValue(),'');
 await panel.locator('[data-test]').click();await panel.locator('[data-message]').filter({hasText:'$12.50'}).waitFor();
 await page.screenshot({path:path.join(data,'captcha-settings.png')});
 const bytes=await readFile(path.join(data,'jobloop.sqlite'));assert.equal(bytes.includes(Buffer.from('synthetic-captcha-key')),false);
 await panel.locator('[data-remove]').click();await page.waitForFunction(async()=>!(await window.jobloop.captchaSettingsStatus()).saved);assert.equal(await panel.locator('[data-test]').isDisabled(),true);
 assert.deepEqual(errors,[]);console.log('CAPTCHA_SETTINGS_UI_PASS',path.join(data,'captcha-settings.png'));
}finally{await app.close();}
