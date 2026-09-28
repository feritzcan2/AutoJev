import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {rankInput} from '../tests/rank-fixture.mjs';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-rank-ui-')),store=new Store(path.join(data,'jobloop.sqlite'));
const p=store.saveProfile({name:'Ranking Demo',preferences:'Remote backend',facts:'Python backend engineer',authorization:'submit'});
const sources=store.sources(p.id);for(const source of sources)store.saveSource(p.id,{...source,enabled:false});
const findOnly=store.saveSource(p.id,{...sources[0],enabled:false,applyMode:'find_only'});
for(const [company,score,sourceId] of [['High',90,null],['Borderline',50,null],['Unknown',undefined,null],['Find only',85,findOnly.id]]){
 const job=store.addJob(p.id,{company,role:'Senior Backend Engineer',location:'Remote',url:`https://example.test/${encodeURIComponent(company)}`,fit:'Synthetic ranking fixture',sourceId}).job;
 if(score!==undefined){
  const input=rankInput(store,p.id,score,{uncertainties:['Remote country eligibility not specified']});
  if(company==='High')for(const [key,value] of Object.entries({technical:100,experience:100,role:80,preferences:50}))input.dimensions[key].score=value;
  store.rankJob(p.id,job.id,input);
 }
}
store.close();const root=path.resolve(import.meta.dirname,'..');
const app=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('columnheader',{name:'Puan',exact:false}).waitFor();
 assert.equal(await page.locator('.jobs-table tbody tr').count(),4);
 assert.equal(await page.locator('.company-cell').first().textContent(),'High');
 const borderline=page.locator('tr',{has:page.getByText('Borderline',{exact:true})});
 await borderline.getByText('50/100',{exact:true}).click();
 await borderline.getByText('Remote country eligibility not specified',{exact:true}).waitFor();
 await page.screenshot({path:path.join(data,'ranking.png'),fullPage:true});
 await page.locator('#filter > summary').click();await page.getByRole('checkbox',{name:'Puan eşiğinin altında',exact:true}).check();await page.locator('#filter > summary').click();assert.equal(await page.locator('.jobs-table tbody tr').count(),1);
 await page.getByRole('button',{name:'Borderline başvurusunu sıraya al'}).click();await page.getByText(/^İlan sıraya alındı/).waitFor();
 await page.locator('#filter > summary').click();await page.getByRole('checkbox',{name:'Tüm ilanlar',exact:true}).check();await page.locator('#filter > summary').click();await page.waitForFunction(id=>window.jobloop.snapshot(id).then(s=>Boolean(s.jobs.find(j=>j.company==='Borderline').manualApplication)),p.id);
 const sourceRow=page.locator('tr',{has:page.getByText('Find only',{exact:true})});await sourceRow.getByText('Kaynak: sadece bul',{exact:true}).waitFor();
 await page.locator('#rank-settings [name=threshold]').fill('95');await page.locator('#rank-settings [type=submit]').click();await page.getByText('Puanlama ayarları kaydedildi.',{exact:true}).waitFor();
 await page.reload();await page.waitForFunction(()=>document.querySelector('#rank-settings [name=threshold]')?.value==='95');
 const snap=await page.evaluate(id=>window.jobloop.snapshot(id),p.id);assert.equal(snap.profile.rankThreshold,95);assert.equal(snap.jobs.find(j=>j.company==='Borderline').manualApplication!==undefined,true);assert.equal(snap.profile.authorization,'submit');
 const form=page.locator('#rank-settings'),save=form.locator('[type=submit]');
 await form.locator('summary').click();
 await form.locator('[name=technicalEnabled]').uncheck();await form.locator('[name=experienceEnabled]').uncheck();
 assert.equal(await save.isDisabled(),true);assert.equal(await form.locator('[name=technical]').isDisabled(),true);
 await form.locator('[name=role]').fill('25');await form.locator('[name=preferences]').fill('75');
 assert.equal(await save.isDisabled(),false);await save.click();
 await page.waitForFunction(id=>window.jobloop.snapshot(id).then(s=>s.profile.rankWeights.preferences===75),p.id);
 await page.getByText('58/100',{exact:true}).waitFor();
 await page.reload();await form.locator('summary').click();
 assert.equal(await form.locator('[name=preferences]').inputValue(),'75');assert.equal(await form.locator('[name=technicalEnabled]').isChecked(),false);
 const high=page.locator('tr',{has:page.getByText('High',{exact:true})});await high.getByText('58/100',{exact:true}).click();
 await high.getByText(/Teknik uyum · %0 \(puanlamaya dahil değil\)/).waitFor();
 await high.getByText(/Çalışma tercihleri · %75/).waitFor();
 // Background/board refreshes must preserve an unfinished edit, including invalid totals.
 await form.locator('[name=role]').fill('24');await page.locator('#filter > summary').click();await page.getByRole('checkbox',{name:'Puan eşiğinin altında',exact:true}).check();await page.locator('#filter > summary').click();
 assert.equal(await form.locator('[name=role]').inputValue(),'24');assert.equal(await save.isDisabled(),true);
 const saved=await page.evaluate(id=>window.jobloop.snapshot(id),p.id);assert.equal(saved.profile.rankWeights.role,25);
 const other=await page.evaluate(()=>window.jobloop.saveProfile({name:'Other Candidate',preferences:'Remote'}));
 await page.waitForFunction(id=>[...document.querySelector('#candidates').options].some(o=>o.value===id),other.id);
 await page.locator('#candidates').selectOption(other.id);await page.waitForFunction(()=>document.querySelector('#rank-settings [name=role]').value==='20');
 await page.locator('#candidates').selectOption(p.id);await page.waitForFunction(()=>document.querySelector('#rank-settings [name=role]').value==='25');
 await page.locator('#filter > summary').click();await page.getByRole('checkbox',{name:'Tüm ilanlar',exact:true}).check();await page.locator('#filter > summary').click();
 await form.screenshot({path:path.join(data,'ranking-settings.png')});
 await form.locator('[data-defaults]').click();assert.equal(await form.locator('[name=technical]').inputValue(),'40');assert.equal(await form.locator('[name=threshold]').inputValue(),'95');
 await save.click();await page.waitForFunction(id=>window.jobloop.snapshot(id).then(s=>s.profile.rankWeights.technical===40),p.id);
 await page.getByText('91/100',{exact:true}).waitFor();assert.equal(errors.length,0,errors.join('\n'));
 console.log('RANK_UI_PASS',data);
}finally{await app.close();}
