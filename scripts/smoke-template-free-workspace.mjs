import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Store} from '../app/store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=await mkdtemp(path.join(os.tmpdir(),'loop-template-free-'));
const store=new Store(path.join(data,'jobloop.sqlite')),candidate=store.saveProfile({name:'İş arama',preferences:'Remote engineering'});store.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(id=>document.querySelector('#candidates').value===id,candidate.id);
 await page.locator('#new').click();await page.locator('#automation-overview').waitFor();
 const id=await page.evaluate(()=>localStorage.getItem('selected-automation'));
 assert.equal(await page.locator('[data-view=board]').getAttribute('class'),'selected');
 assert.equal(await page.locator('[data-view=board] span').first().textContent(),'Takip tablosu');
 assert.deepEqual(await page.locator('.automation-results-table th').allTextContents(),['Son aktivite ↓','Kaynak','Kayıt','Durum']);
 await page.getByText('Henüz kayıt yok',{exact:true}).waitFor();
 assert.equal(await page.locator('#start').isVisible(),true);
 for(const view of ['board','sources','profile','agent','files','background'])assert.equal(await page.locator(`[data-view=${view}]`).evaluate(node=>getComputedStyle(node).opacity),'1');
 await page.screenshot({path:path.join(data,'blank-board.png'),fullPage:true});
 // The shared shell is present before any setup message, and navigation never launches work.
 await page.locator('[data-overview-view=profile]').click();await page.locator('#automation-plan-form').waitFor();assert.equal(await page.locator('#automation-plan-form [name=maxActionsPerDay], #automation-plan-form [name=maxActionsTotal], #automation-plan-form [name=endAt], #automation-plan-form [name=intervalMinutes]').count(),0);
 await page.locator('[data-view=sources]').click();await page.locator('[data-source-discover]').click();await page.locator('#automation-message').waitFor();
 assert.match(await page.locator('#automation-message').inputValue(),/kaynakları araştırıp öner/);
 assert.equal(await page.locator('#agent-settings').isVisible(),true);
 assert.equal((await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),id)).activeRun,null);
 await page.locator('#automation-message').fill('');
 await page.locator('[data-view=board]').click();await page.locator('[data-overview-action=message]').click();await page.locator('.workspace-intro').waitFor();
 await page.screenshot({path:path.join(data,'setup-agent.png'),fullPage:true});
 // Save a custom plan through the same profile and source controls used by template workspaces.
 await page.locator('[data-view=profile]').click();
 for(const [name,value] of Object.entries({title:'Berlin ev takibi',goal:'Berlin’de uygun kiralık evleri takip et','criteria-outcome':'Uygun evleri listele','criteria-rules':'En fazla 1500 EUR, en az iki oda','criteria-completion':'Ev bulduğumda dur',sources:'https://example.com/homes',instructions:'Yeni ilanları kaydet ve uygun olanlar için taslak hazırla.'}))await page.locator(`#automation-plan-form [name="${name}"]`).fill(value);
 await page.locator('#automation-plan-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#automation-save-state').textContent==='Kurulum kaydedildi');
 await page.locator('[data-view=board]').click();await page.locator('[data-overview-action=trial]').waitFor();
 const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),id);assert.equal(snapshot.automation.templateId,'custom');assert.equal(snapshot.sources.length,1);assert.equal(snapshot.automation.status,'ready');assert.equal(snapshot.automation.mode,'observe');assert.equal(snapshot.activeRun,null);assert.equal(snapshot.definition.workflow.length>0,true);
 await page.locator('[data-overview-view=sources]').click();await page.locator('[data-automation-pane=sources] .source-row').first().waitFor();
 await page.screenshot({path:path.join(data,'sources.png'),fullPage:true});
 await page.locator('[data-view=board]').click();await page.reload();await page.locator('#automation-overview').waitFor();assert.equal(await page.locator('#heading').textContent(),'Berlin ev takibi');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,740));
 await page.screenshot({path:path.join(data,'configured-board-compact.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('#candidates').selectOption(candidate.id);await page.locator('#board').waitFor();assert.equal(await page.locator('[data-view=board] span').first().textContent(),'Başvurular');
 await page.locator('#candidates').selectOption('automation:'+id);await page.locator('#automation-overview').waitFor();assert.equal(await page.locator('[data-view=board] span').first().textContent(),'Takip tablosu');
 // A preset opens the same board and keeps its domain-specific columns.
 await page.locator('[data-view=templates]').click();await page.locator('[data-template=housing]').click();await page.locator('#automation-overview').waitFor();
 assert.ok((await page.locator('.automation-results-table th').allTextContents()).includes('Kira (€)'));
 assert.deepEqual(errors,[]);console.log('TEMPLATE_FREE_WORKSPACE_PASS',data);
}finally{await app.close();}
