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
 if(score!==undefined)store.rankJob(p.id,job.id,rankInput(store,p.id,score,{uncertainties:['Remote country eligibility not specified']}));
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
 await page.locator('#filter').selectOption('rank_below_threshold');assert.equal(await page.locator('.jobs-table tbody tr').count(),1);
 await page.getByRole('button',{name:'Yine de sıraya al'}).click();await page.getByText('İlan başvuru sırasına alındı.',{exact:true}).waitFor();
 await page.locator('#filter').selectOption('all');await page.getByText('Kullanıcı sıraya aldı',{exact:true}).first().waitFor();
 const sourceRow=page.locator('tr',{has:page.getByText('Find only',{exact:true})});await sourceRow.getByText('Kaynak: sadece bul',{exact:true}).waitFor();
 await page.locator('#rank-settings input').fill('95');await page.locator('#rank-settings button').click();await page.getByText('Başvuru puan eşiği kaydedildi.',{exact:true}).waitFor();
 await page.reload();await page.waitForFunction(()=>document.querySelector('#rank-settings input')?.value==='95');
 const snap=await page.evaluate(id=>window.jobloop.snapshot(id),p.id);assert.equal(snap.profile.rankThreshold,95);assert.equal(snap.jobs.find(j=>j.company==='Borderline').rankOverride!==undefined,true);assert.equal(snap.profile.authorization,'submit');
 await page.addStyleTag({path:path.join(root,'src/mobile/mobile.css')});await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:path.join(data,'ranking-mobile.png'),fullPage:true});assert.equal(errors.length,0,errors.join('\n'));
 console.log('RANK_UI_PASS',data);
}finally{await app.close();}
