import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-question-actions-')),db=path.join(data,'jobloop.sqlite'),store=new Store(db);
const profile=store.saveProfile({name:'Question Candidate',preferences:'Remote'});
const addJob=company=>store.addJob(profile.id,{company,role:'Engineer',location:'Remote',fit:'Fixture',url:`https://example.test/${company}`}).job;
const job=addJob('Answer'),cancelJob=addJob('Cancel');
const plain=store.ask(profile.id,{jobId:job.id,question:'Başlangıç tarihi?',resumeContext:{browser:'Jev Chrome',tabId:'fixture',url:job.url,step:'Availability',nextAction:'Review form'}});
const structured=store.ask(profile.id,{jobId:job.id,question:'Başvuru bilgileri',fields:[{id:'consent',label:'İzin veriyor musun?',type:'boolean'},{id:'amount',label:'Beklenen tutar',type:'number'}]});
const written=store.ask(profile.id,{question:'Yazılı yanıt',fields:[{id:'years',label:'Deneyim yılı',type:'number'}]});
store.ask(profile.id,{question:'Profil notun?'});
store.ask(profile.id,{jobId:cancelJob.id,question:'İptal sorusu?'});
store.ask(profile.id,{jobId:cancelJob.id,question:'Diğer iptal sorusu?'});store.close();

const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 // Delay persistence through fixture IPC handlers; use real Store validation and snapshots.
 await app.evaluate(async({BrowserWindow,ipcMain},{db,url})=>{
  for(const window of BrowserWindow.getAllWindows())window.hide();
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {Store}=await load(url),store=new Store(db);globalThis.questionActionCalls=[];
  for(const [channel,method] of [['answer','answer'],['set-manual-job-status','setManualJobStatus']]){
   ipcMain.removeHandler(channel);ipcMain.handle(channel,async(event,...args)=>{
    globalThis.questionActionCalls.push({channel,args});
    await new Promise((resolve,reject)=>{globalThis.releaseQuestionAction=resolve;globalThis.rejectQuestionAction=()=>reject(Error('Synthetic action failure'));});
    const result=store[method](...args);event.sender.send('changed',{candidateId:args[0]});return result;
   });
  }
  ipcMain.removeHandler('open-question-tab');ipcMain.handle('open-question-tab',(_,id,questionId)=>{globalThis.openedQuestion={id,questionId};return{message:'Sekme açıldı.'};});
  ipcMain.removeHandler('open-link');ipcMain.handle('open-link',(_,url)=>{globalThis.openedLink=url;});
 },{db,url:pathToFileURL(path.resolve('app/store.mjs')).href});
 await page.locator('#candidates').selectOption(profile.id);
 const card=question=>page.locator('#questions .question').filter({hasText:question});
 const note=page.getByLabel('Profil notun?',{exact:true});await note.fill('Korunan taslak');
 const badge=()=>page.locator('#question-badge').textContent();
 const snapshot=()=>page.evaluate(id=>window.jobloop.workspaceSnapshot(id),profile.id);

 await card(plain.question).getByRole('button',{name:'Sekmeye git ↗',exact:true}).click();
 await card(plain.question).getByRole('status').filter({hasText:'Sekme açıldı.'}).waitFor();
 assert.deepEqual(await app.evaluate(()=>globalThis.openedQuestion),{id:profile.id,questionId:plain.id});
 await card(plain.question).getByRole('button',{name:'İlan bağlantısını aç ↗',exact:true}).click();
 assert.equal(await app.evaluate(()=>globalThis.openedLink),job.url);assert.equal(await badge(),'6');
 // An invalid form must stay visible and must not dispatch an answer.
 await card(plain.question).getByRole('button',{name:'Yanıtla',exact:true}).click();
 assert.equal(await card(plain.question).count(),1);assert.equal(await app.evaluate(()=>globalThis.questionActionCalls.length),0);

 async function answerWithRecovery(question,button,fill,verifyDraft){
  const before=Number(await badge());await fill();
  await card(question.question).getByRole('button',{name:button,exact:true}).click();
  await card(question.question).waitFor({state:'detached',timeout:2000});assert.equal(await badge(),String(before-1));
  await app.evaluate(()=>{globalThis.rejectQuestionAction();});
  await card(question.question).waitFor();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Synthetic action failure'));
  await verifyDraft();assert.equal(await badge(),String(before));
  assert.equal(await card(question.question).getByRole('button',{name:button,exact:true}).isEnabled(),true);
  await card(question.question).getByRole('button',{name:button,exact:true}).click();
  await card(question.question).waitFor({state:'detached',timeout:2000});
  await app.evaluate(()=>{globalThis.releaseQuestionAction();});
  await page.waitForFunction(()=>document.querySelector('#notice').textContent==='Yanıt kaydedildi.');
  assert.equal(await card(question.question).count(),0);assert.equal(await badge(),String(before-1));
  assert.equal(await note.inputValue(),'Korunan taslak');
 }
 await answerWithRecovery(plain,'Yanıtla',()=>page.getByLabel(plain.question,{exact:true}).fill('Ekim ayında'),async()=>assert.equal(await page.getByLabel(plain.question,{exact:true}).inputValue(),'Ekim ayında'));
 assert.equal((await snapshot()).questions.find(q=>q.id===plain.id).answer,'Ekim ayında');
 assert.equal(await card(structured.question).count(),1,'Answering one question keeps the other question for the same job');
 await answerWithRecovery(structured,'Yanıtları gönder',async()=>{await page.getByLabel('İzin veriyor musun?',{exact:true}).selectOption('false');await page.getByLabel('Beklenen tutar',{exact:true}).fill('0');},async()=>{assert.equal(await page.getByLabel('İzin veriyor musun?',{exact:true}).inputValue(),'false');assert.equal(await page.getByLabel('Beklenen tutar',{exact:true}).inputValue(),'0');});
 assert.deepEqual((await snapshot()).questions.find(q=>q.id===structured.id).answerValues,{consent:false,amount:0});
 await answerWithRecovery(written,'Yanıtı gönder',async()=>{await card(written.question).getByRole('button',{name:'Yazarak yanıtla',exact:true}).click();await page.getByLabel('Yanıtını yazarak ver',{exact:true}).fill('Henüz belli değil');},async()=>assert.equal(await page.getByLabel('Yanıtını yazarak ver',{exact:true}).inputValue(),'Henüz belli değil'));
 assert.equal((await snapshot()).questions.find(q=>q.id===written.id).answer,'Henüz belli değil');

 const cancelled=page.locator('#questions .question').filter({hasText:'Cancel'});
 await page.getByLabel('İptal sorusu?',{exact:true}).fill('İptal taslağı');
 for(const fail of [true,false]){
  await cancelled.first().getByRole('button',{name:'Başvuruyu iptal et',exact:true}).click();
  await cancelled.waitFor({state:'detached',timeout:2000});assert.equal(await badge(),'1');
  await app.evaluate((_,fail)=>{if(fail)globalThis.rejectQuestionAction();else globalThis.releaseQuestionAction();},fail);
  if(fail){await cancelled.first().waitFor();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Synthetic action failure'));assert.equal(await cancelled.count(),2);assert.equal(await page.getByLabel('İptal sorusu?',{exact:true}).inputValue(),'İptal taslağı');assert.equal(await badge(),'3');}
  else await page.waitForFunction(()=>document.querySelector('#notice').textContent==='Başvuru Vazgeçildi olarak kaydedildi.');
 }
 assert.equal((await snapshot()).jobs.find(j=>j.id===cancelJob.id).manualOutcome,'withdrawn');
 assert.equal(await cancelled.count(),0);assert.equal(await badge(),'1');assert.equal(await note.inputValue(),'Korunan taslak');
 assert.equal(await app.evaluate(()=>globalThis.questionActionCalls.length),8);assert.deepEqual(errors,[]);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].showInactive());
 await page.screenshot({path:path.join(data,'question-actions.png'),fullPage:true});
 console.log('QUESTION_ACTIONS_UI_PASS',data);
}finally{await app.close();}
