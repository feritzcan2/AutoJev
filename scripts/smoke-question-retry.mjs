import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';
import {addRankedJob} from '../tests/rank-fixture.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=process.cwd(),data=await mkdtemp(path.join(tmpdir(),'jobloop-question-retry-'));
const store=new Store(path.join(data,'jobloop.sqlite'));
const profile=store.saveProfile({name:'Retry Candidate',preferences:'Remote',authorization:'prepare'});
const other=store.saveProfile({name:'Other Candidate',preferences:'Remote'});
const cv=path.join(data,'cv.txt');await writeFile(cv,'Synthetic candidate');store.setCv(profile.id,cv);
for(const source of store.sources(profile.id))store.saveSource(profile.id,{...source,enabled:false});
const job=addRankedJob(store,profile.id,{company:'Retry Company',role:'Engineer',location:'Remote',fit:'Fixture',url:'https://example.test/retry'}).job;
store.updateJob(profile.id,job.id,'working','Form','fixture');store.updateJob(profile.id,job.id,'blocked','Needs an answer','fixture');
const question=store.ask(profile.id,{jobId:job.id,question:'Başlangıç tarihi?'});
store.ask(profile.id,{question:'Profil notun?'});store.close();

const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 // Keep the real IPC and campaign behavior, but delay retries and never launch a provider.
 await app.evaluate(async({BrowserWindow},urls)=>{
  for(const window of BrowserWindow.getAllWindows())window.hide();
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {Engine}=await load(urls.engine),{BrowserTools}=await load(urls.browser),{WorkerCampaigns}=await load(urls.campaigns);
  const request=Engine.prototype.request,retry=WorkerCampaigns.prototype.retryQuestion;
  Engine.prototype.request=function(op,args={}){if(['start','message','resize'].includes(op))return Promise.resolve({});return request.call(this,op,args);};
  BrowserTools.prototype.prepare=()=>({state:'ready',ready:true});
  WorkerCampaigns.prototype.retryQuestion=async function(...args){
   globalThis.retryCalls=(globalThis.retryCalls??0)+1;
   await new Promise((resolve,reject)=>{globalThis.releaseRetry=resolve;globalThis.rejectRetry=()=>reject(Error('Synthetic retry failure'));});
   return retry.apply(this,args);
  };
 },Object.fromEntries([['engine','engine'],['browser','browser'],['campaigns','worker-campaigns']].map(([key,file])=>[key,pathToFileURL(path.join(root,`app/${file}.mjs`)).href])));
 await page.locator('#candidates').selectOption(profile.id);
 const card=page.locator('#questions .question').filter({hasText:'Retry Company'});
 const note=page.getByLabel('Profil notun?',{exact:true});await note.fill('Saklanacak taslak');
 await card.getByRole('button',{name:'Tekrar dene',exact:true}).click();
 await card.waitFor({state:'detached',timeout:2000});
 assert.equal(await page.locator('#question-badge').textContent(),'1');
 assert.equal(await note.inputValue(),'Saklanacak taslak');
 await page.locator('#candidates').selectOption(other.id);
 await page.locator('#questions .question').waitFor({state:'detached'});
 await page.locator('#candidates').selectOption(profile.id);
 await note.waitFor();assert.equal(await card.count(),0);
 assert.equal(await app.evaluate(()=>globalThis.retryCalls),1);
 await app.evaluate(()=>{globalThis.releaseRetry();});
 await page.waitForFunction(()=>document.querySelector('#notice').textContent==='Agent başvuruyu yeniden kontrol ediyor.');
 assert.equal(await card.count(),0);
 const saved=await page.evaluate(id=>window.jobloop.snapshot(id),profile.id);
 assert.equal(saved.questions.find(q=>q.id===question.id).answer,null);
 assert.equal(saved.campaign.pendingRecoveries[job.id],question.id);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
 await page.screenshot({path:path.join(data,'question-retry-pending.png'),fullPage:true});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
 await page.evaluate(id=>window.jobloop.stop(id),profile.id);
 await card.waitFor();
 await page.getByLabel('Başlangıç tarihi?',{exact:true}).fill('Saklanan tarih taslağı');
 await card.getByRole('button',{name:'Tekrar dene',exact:true}).click();
 await card.waitFor({state:'detached',timeout:2000});
 await app.evaluate(()=>{globalThis.rejectRetry();});
 await card.waitFor();
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Synthetic retry failure'));
 assert.equal(await page.getByLabel('Başlangıç tarihi?',{exact:true}).inputValue(),'Saklanan tarih taslağı');
 assert.equal(await card.getByRole('button',{name:'Tekrar dene',exact:true}).isEnabled(),true);
 assert.equal(await page.locator('#question-badge').textContent(),'2');
 assert.equal(await note.inputValue(),'Saklanacak taslak');
 assert.equal(errors.length,0,errors.join('\n'));
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
 await page.screenshot({path:path.join(data,'question-retry.png'),fullPage:true});
 console.log('QUESTION_RETRY_UI_PASS',data);
}finally{await app.close();}
