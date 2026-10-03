import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-readiness-ui-'));
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.jobloop));
 // Fixed local fixtures replace only status probes. No provider session, browser
 // connection, paid API request or actual application is started by this smoke.
 await app.evaluate(({ipcMain,safeStorage})=>{
  globalThis.readinessFixtureReady=false;globalThis.readinessFixtureInputs=[];globalThis.jevFixtureTests=0;
  ipcMain.removeHandler('readiness');ipcMain.handle('readiness',(_event,input)=>{globalThis.readinessFixtureInputs.push(input);return {ready:globalThis.readinessFixtureReady,checks:[{id:'agent',label:'Codex',state:globalThis.readinessFixtureReady?'ready':'error',detail:globalThis.readinessFixtureReady?'Agent komutu bulundu.':'Codex CLI’ını kur ve tekrar kontrol et.'}],checkedAt:Date.now()};});
  ipcMain.removeHandler('jev-settings-test');ipcMain.handle('jev-settings-test',()=>{globalThis.jevFixtureTests++;return {ok:true,modelListed:true,checkedAt:Date.now(),message:'Bağlantı ve anahtar doğrulandı. Seçili model kullanılabilir.'};});
  // Keep save/status/remove IPC and the real encrypted-store code in this test.
  // A synthetic OS adapter allows the same fixture on CI without a keychain.
  safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=> 'fixture';
  safeStorage.encryptString=value=>Buffer.from(value).reverse();safeStorage.decryptString=value=>Buffer.from(value).reverse().toString();
 });
 const workspace=await page.evaluate(()=>window.jobloop.workspaceCreate('custom',{title:'Readiness Fixture',goal:'Synthetic UI fixture'}));
 const blocked=await page.evaluate(()=>window.jobloop.readiness({provider:'codex'}));assert.equal(blocked.ready,false);
 assert.equal((await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),workspace.id)).activeRun,null);
 await app.evaluate(()=>{globalThis.readinessFixtureReady=true;});await page.reload();
 await page.locator('[data-view=config]').click();
 await page.locator('a[href="#config-readiness"]').click();await page.locator('#config-readiness li[data-state=ready]').waitFor({state:'visible'});
 assert.ok((await app.evaluate(()=>globalThis.readinessFixtureInputs)).some(input=>input.provider==='codex'));
 await page.locator('a[href="#config-jev"]').click();
 await page.locator('#config-jev input[name=apiKey]').fill('synthetic-ui-test-key');
 await page.locator('#config-jev input[name=model]').fill('jev-latest');
 await page.locator('#config-jev button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#config-jev [data-state]').textContent==='Anahtar yapılandırıldı'&&document.querySelector('#config-jev input[name=apiKey]').value==='');
 const saved=await page.evaluate(()=>window.jobloop.jevSettingsStatus());assert.equal(saved.saved,true);assert.doesNotMatch(JSON.stringify(saved),/synthetic-ui-test-key|ciphertext|apiKey/);
 await page.locator('#config-jev [data-test]').click();await page.waitForFunction(()=>document.querySelector('#config-jev [data-message]').textContent.includes('anahtar doğrulandı'));
 assert.equal(await app.evaluate(()=>globalThis.jevFixtureTests),1);
 await page.locator('#config-jev input[name=model]').fill('jev-preview');await page.locator('#config-jev button[type=submit]').click();
 await page.waitForFunction(async()=>(await window.jobloop.jevSettingsStatus()).model==='jev-preview');
 await page.screenshot({path:path.join(data,'jev-settings.png')});
 const database=await readFile(path.join(data,'jobloop.sqlite'));assert.equal(database.includes(Buffer.from('synthetic-ui-test-key')),false);
 await page.locator('#config-jev [data-remove]').click();await page.waitForFunction(async()=>(await window.jobloop.jevSettingsStatus()).saved===false);
 await page.locator('a[href="#config-privacy"]').click();await page.locator('#config-privacy').waitFor({state:'visible'});
 const disclosure=await page.locator('#config-privacy').innerText();for(const label of ['AI sağlayıcısında','TypeSafe / Jev','Telegram','form alanlarının mevcut değerleri'])assert.ok(disclosure.includes(label));
 assert.equal((await page.locator('aside .sidebar-bottom').innerText()).includes('Veriler bu bilgisayarda kalır'),false);
 await page.screenshot({path:path.join(data,'data-disclosure.png')});
 await page.locator('a[href="#config-data"]').click();await page.locator('#config-data').waitFor({state:'visible'});
 const dataStatus=await page.evaluate(()=>window.jobloop.dataStatus());
 await page.waitForFunction(()=>document.querySelector('#config-data .data-status').textContent.includes('prompt kaydı'));
 const dataText=await page.locator('#config-data').innerText();assert.ok(dataText.includes(`${dataStatus.retention.days} gün`));assert.ok(dataText.includes('Başvuru geçmişi, otomasyon konuşmaları ve sonuçlar bu temizliğe dahil değildir'));assert.ok(dataText.includes('Jev anahtarı'));assert.ok(dataText.includes('şifrelenmez'));
 for(const action of ['backup','restore','open','clear','open-directory','use-directory','change-directory'])assert.equal(await page.locator(`#config-data [data-${action}]`).isEnabled(),true,action);await page.screenshot({path:path.join(data,'data-management.png')});
 await page.locator('a[href="#config-updates"]').click();await page.locator('#config-updates').waitFor({state:'visible'});
 const updateStatus=await page.evaluate(()=>window.jobloop.updateStatus());assert.equal(updateStatus.enabled,false,'Development smoke must not enable a release updater');
 await page.waitForFunction(()=>document.querySelector('#config-updates [data-status]').textContent.includes('desteklenmiyor'));
 assert.equal(await page.locator('#config-updates [data-check]').isVisible(),false);assert.equal(await page.locator('#config-updates [data-download]').isVisible(),false);assert.equal(await page.locator('#config-updates [data-install]').isVisible(),false);assert.equal(await page.locator('#config-updates [data-releases]').isVisible(),true);
 await page.screenshot({path:path.join(data,'updates.png')});
 assert.deepEqual(errors,[]);console.log('READINESS_UI_PASS',data);
}finally{await app.close();}
