import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-history-ui-')),core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(core);
const sourceUrl='https://listings.test/search',workspace=db.create('custom',{title:'Berlin iPhone takibi',sources:[sourceUrl]}),other=db.create('custom',{title:'Diğer çalışma alanı'});
db.saveSource(workspace.id,sourceUrl,{name:'Berlin ilanları'});
db.putRun({id:'history-fixture',automationId:workspace.id,kind:'run',sourceUrl,status:'completed',startedAt:Date.now()-60000,finishedAt:Date.now(),summary:'Berlin ilanları kontrol edildi.',tokenUsage:{agentTokens:12000,jevTokens:1500,totalTokens:13500}});
for(let n=0;n<3;n++)db.putResult({automationId:workspace.id,key:`listing-${n}`,url:`https://listings.test/${n}`,title:`İlan ${n}`,summary:'Yeni ilan',status:'found',trial:false,runId:'history-fixture',createdAt:Date.now(),updatedAt:Date.now(),cells:{}});
db.putRun({id:'empty-fixture',automationId:workspace.id,kind:'run',sourceUrl,status:'completed',startedAt:Date.now(),finishedAt:Date.now(),summary:'Yeni ilan yok.',tokenUsage:{agentTokens:0,jevTokens:0,totalTokens:0}});
db.putRun({id:'record-fixture',automationId:workspace.id,kind:'run',sourceUrl,recordId:db.results(workspace.id)[0].id,recordOperation:'score',status:'completed',startedAt:Date.now(),finishedAt:Date.now(),summary:'İlan puanlandı.'});
// Old enabled tasks must remain inert after the Gmail feature is removed.
core.db.exec('CREATE TABLE background_tasks(candidate_id TEXT PRIMARY KEY REFERENCES workspaces(id),data TEXT NOT NULL)');
core.db.prepare('INSERT INTO background_tasks VALUES(?,?)').run(workspace.id,JSON.stringify({enabled:true,intervalMinutes:1,nextRunAt:0}));core.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
let page;const errors=[];
try{
 page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(id=>[...document.querySelector('#candidates').options].some(option=>option.value===id),workspace.id);
 await page.locator('#candidates').selectOption(workspace.id);await page.locator('[data-view=background]').click();
 const history=page.locator('[data-automation-pane=background]');await history.waitFor({state:'visible'});
 const found=history.locator('[data-run-id="history-fixture"]');await found.waitFor({state:'visible'});
 assert.deepEqual(await history.locator('h2').allTextContents(),['Çalışma geçmişi']);
 assert.equal(await history.locator('.run-row').count(),3);assert.ok((await history.textContent()).includes('Berlin ilanları kontrol edildi.'));
 assert.equal(await found.locator('.run-found').textContent(),'Bu turda 3 yeni kayıt');assert.equal(await found.locator('.run-source').textContent(),'Berlin ilanları');
 assert.equal(await history.locator('[data-run-id="empty-fixture"] .run-found').textContent(),'Bu turda 0 yeni kayıt');
 assert.equal(await history.locator('[data-run-id="record-fixture"] .run-found').count(),0);
 assert.equal(await found.locator('.run-tokens').textContent(),'Toplam 13.500 token');
 assert.equal(await found.locator('.run-tokens').getAttribute('title'),'Agent: 12.000 · Jev: 1.500');
 assert.equal(await history.locator('[data-run-id="empty-fixture"] .run-tokens').textContent(),'Toplam 0 token');
 assert.equal(await history.locator('[data-run-id="record-fixture"] .run-tokens').textContent(),'Token kullanımı bilinmiyor');
 assert.equal(await history.locator('button,form,textarea').count(),0);
 assert.equal(await page.locator('#background,#background-status,#background-chat,#background-signals,#background-badge').count(),0);
 assert.deepEqual(await page.evaluate(()=>Object.keys(window.jobloop).filter(name=>/background|MailSignal/i.test(name))),[]);
 const configuration=await page.evaluate(id=>window.jobloop.configurationCatalog(id),workspace.id);
 assert.ok(!configuration.instructions.some(part=>/background|gmail-sync/i.test(part.id) || /gmail-sync/.test(part.text??'')));
 const handlers=await app.evaluate(({ipcMain})=>[...ipcMain._invokeHandlers.keys()].filter(name=>/^background-|mail-signal/.test(name)));assert.deepEqual(handlers,[]);
 await page.screenshot({path:path.join(data,'history.png'),fullPage:true});
 await page.locator('#candidates').selectOption(other.id);await page.locator('[data-view=background]').click();
 await history.getByText('Henüz çalışma yok.',{exact:true}).waitFor();assert.equal(await history.locator('.run-row').count(),0);
 await page.locator('#candidates').selectOption(workspace.id);await page.locator('[data-view=background]').click();await page.reload();
 await history.waitFor({state:'visible'});await history.getByText('Berlin ilanları kontrol edildi.',{exact:true}).waitFor();
 assert.equal(await found.locator('.run-tokens').textContent(),'Toplam 13.500 token');
 const sqlite=new DatabaseSync(path.join(data,'jobloop.sqlite'),{readOnly:true});try{
  const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name);
  assert.ok(!tables.includes('background_runs'));assert.ok(!tables.includes('mail_signals'));
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM automation_runs').get().n,3);
 }finally{sqlite.close();}
 assert.deepEqual(errors,[]);console.log('BACKGROUND_HISTORY_UI_PASS',data);
}catch(error){
 if(page){await page.screenshot({path:path.join(data,'failure.png'),fullPage:true}).catch(()=>{});console.error('UI_ERRORS',errors,'PAGE',await page.locator('body').innerText().catch(()=>''));}
 console.error('ARTIFACTS',data);throw error;
}finally{await app.close();}
