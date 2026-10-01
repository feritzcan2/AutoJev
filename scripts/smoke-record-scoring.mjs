import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'record-scoring-ui-'));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1>JavaScript Developer</h1><p>Remote work. Five years of JavaScript experience. Salary not disclosed.</p>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/job`;
const core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(core);
const workspace=db.create('job-search',{title:'Puanlama testi',goal:'Uzaktan JavaScript işleri',criteria:{preferences:'Uzaktan JavaScript',ranking:'Yetkinlik %50, deneyim %30, çalışma tercihleri %20.'},sources:[url]});db.review(workspace.id);
const seed=db.begin(workspace.id,'run'),item=db.record(workspace.id,seed.id,{url,title:'JavaScript Developer',summary:'Kayıtlı ilan',proposal:'Mevcut başvuru taslağı'});db.finish(workspace.id,seed.id,'completed','Saved');db.approve(workspace.id,item.id);core.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});let page;
try{
 page=await app.firstWindow();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await app.evaluate(async(_,url)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}),{Engine}=await load(url),original=Engine.prototype.request;
  globalThis.scoringStarts=[];Engine.prototype.request=function(op,args={}){if(op==='start'){globalThis.scoringStarts.push(args);return Promise.resolve({});}if(op==='resize')return Promise.resolve({});return original.call(this,op,args);};
 },pathToFileURL(path.resolve('app/engine.mjs')).href);
 await page.waitForFunction(id=>document.querySelector('#candidates').value===id,workspace.id);
 await page.locator('[data-view=profile]').click();assert.equal(await page.getByLabel('Puanlama kriterleri',{exact:true}).inputValue(),workspace.criteria.ranking);
 await page.locator('[data-view=board]').click();const row=page.locator(`[data-result-id="${item.id}"]`);
 await row.locator('.record-row-menu').click();await row.locator('[data-record-operation=score]').click();
 await page.waitForFunction(async id=>(await window.jobloop.workspaceSnapshot(id)).activeRuns.some(run=>run.recordOperation==='score'),workspace.id);
 await row.locator('[data-column=status] .automation-badge').getByText('Puanlanıyor',{exact:true}).waitFor();
 let rpcId=0;
 const tool=async(name,args={},expectError=false)=>{
  const run=await app.evaluate(()=>globalThis.scoringStarts.at(-1));assert.ok(run,'Scoring agent started');
  const response=await fetch(run.endpoint,{method:'POST',headers:{Authorization:'Bearer '+run.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})}),body=await response.json();
  if(expectError){assert.equal(body.result?.isError,true,JSON.stringify(body));return body.result.content.map(c=>c.text).join('\n');}
  assert.ok(!body.error&&!body.result?.isError,JSON.stringify(body));return JSON.parse(body.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
 };
 const context=await tool('get_automation_context');assert.equal(context.assignedOperation.kind,'score');assert.equal(context.automation.criteria.ranking,workspace.criteria.ranking);
 const scoreInput={itemId:item.id,status:'scored',score:86,summary:'Yetkinlik 90×%50 + deneyim 70×%30 + tercihler 100×%20 = 86.',evidenceUrl:url,evidence:'Remote work. Five years of JavaScript experience.',strengths:['JavaScript ve uzaktan çalışma uyumu'],gaps:[],uncertainties:['Maaş açıklanmamış']};
 for(let i=1;i<=3;i++){
  const error=await tool('record_automation_score',scoreInput,true);
  assert.match(error,i===3?/Puanlama durduruldu.*3 kez/:new RegExp(`${i}/3`));
 }
 await page.waitForFunction(async id=>(await window.jobloop.workspaceSnapshot(id)).activeRuns.length===0,workspace.id);
 await row.locator('[data-column=status]').getByText('İşlem engellendi',{exact:true}).waitFor();
 await page.locator('[data-view=agent]').click();
 const warning=page.locator('[data-issue-id^="tool-failure:"]');await warning.getByText('Tekrarlanan hata · Görev durduruldu',{exact:true}).waitFor();
 assert.match(await warning.textContent(),/gözlemle/);await page.screenshot({path:path.join(data,'repeated-error.png'),fullPage:true});
 await warning.getByRole('button',{name:'Kaydı göster',exact:true}).click();
 await row.locator('[data-record-retry]').click();
 await page.waitForFunction(async id=>(await window.jobloop.workspaceSnapshot(id)).activeRuns.some(run=>run.recordOperation==='score'),workspace.id);
 await page.waitForFunction(()=>!document.querySelector('[data-issue-id^="tool-failure:"]'));
 await tool('browser_open',{url});
 await tool('record_automation_score',scoreInput);
 await tool('finish_automation_run',{status:'completed',summary:'İlan 86/100 puanlandı.'});
 await page.waitForFunction(async id=>(await window.jobloop.workspaceSnapshot(id)).activeRuns.length===0,workspace.id);
 await row.locator('[data-record-score]').getByText('86/100',{exact:true}).waitFor();await row.locator('[data-record-score]').click();
 const detail=page.locator('#automation-result-detail-'+item.id);await detail.getByText('Maaş açıklanmamış',{exact:true}).waitFor();assert.match(await detail.textContent(),/Kullanılan puanlama kriterleri/);
 const saved=(await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),workspace.id)).results.find(r=>r.id===item.id);
 assert.equal(saved.status,'prepared');assert.equal(saved.proposal,item.proposal);assert.equal(saved.digest,item.digest);assert.equal(saved.approvedDigest,item.digest);
 await row.locator('.record-row-menu').click();await row.locator('[data-record-operation=score]').getByText('Yeniden puanla',{exact:true}).waitFor();await row.locator('.record-row-menu').click();
 await page.evaluate(({id,criteria})=>window.jobloop.automationSave(id,{criteria:{...criteria,ranking:'Yetkinlik %70, deneyim %30.'}}),{id:workspace.id,criteria:workspace.criteria});
 await row.getByText('Eski değerlendirme',{exact:true}).waitFor();
 await page.screenshot({path:path.join(data,'scoring.png'),fullPage:true});assert.deepEqual(errors,[]);console.log('RECORD_SCORING_UI_PASS',data);
}catch(error){if(page)await page.screenshot({path:path.join(data,'failure.png'),fullPage:true}).catch(()=>{});console.error('ARTIFACTS',data);throw error;}
finally{await app.close();await new Promise(resolve=>server.close(resolve));}
