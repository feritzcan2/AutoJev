import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'question-custom-')),store=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(store);
const a=db.create('custom',{title:'Custom answers',goal:'Check mixed replies',sources:['https://example.test/list']});
const q=db.askQuestion(a.id,{text:'Tercihlerini belirt.',fields:[{id:'city',label:'Şehir',type:'select',options:['Berlin','Frankfurt']},{id:'permit',label:'Çalışma izni',type:'boolean'},{id:'salary',label:'Maaş',type:'number'}]});db.put({...db.get(a.id),status:'paused'});store.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
try{
 const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const open=async()=>{await page.locator('aside nav [data-view=agent]').click();await page.locator(`[data-issue-id="${q.id}"]`).waitFor();};await open();
 const card=page.locator(`[data-issue-id="${q.id}"]`),city=card.getByLabel('Şehir',{exact:true}),custom=card.getByLabel('Şehir — kendi yanıtın',{exact:true}),permit=card.getByLabel('Çalışma izni',{exact:true}),send=card.getByRole('button',{name:'Yanıtları gönder',exact:true});
 assert.equal(await custom.isVisible(),false);await city.selectOption({label:'Kendim yazacağım'});assert.equal(await custom.isVisible(),true);await permit.selectOption('false');await card.getByLabel('Maaş',{exact:true}).fill('95000');
 await custom.fill('   ');assert.equal(await custom.evaluate(e=>e.checkValidity()),false);await send.click();assert.equal((await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id)).automation.questions[0].answer,null);
 await custom.fill('Yalnızca Berlin’den uzaktan çalışabilirim.');await page.reload();await open();assert.equal(await custom.inputValue(),'Yalnızca Berlin’den uzaktan çalışabilirim.');assert.equal(await permit.inputValue(),'false');
 await city.selectOption('Berlin');assert.equal(await custom.isVisible(),false);assert.equal(await custom.isDisabled(),true);await city.selectOption({label:'Kendim yazacağım'});assert.equal(await custom.inputValue(),'Yalnızca Berlin’den uzaktan çalışabilirim.');
 await permit.selectOption({label:'Kendim yazacağım'});const customPermit=card.getByLabel('Çalışma izni — kendi yanıtın',{exact:true});await customPermit.fill('İzin yenilemem sürüyor.');
 await card.getByRole('button',{name:'Yazarak yanıtla',exact:true}).click();await card.getByRole('button',{name:'Formu doldur',exact:true}).click();assert.equal(await customPermit.inputValue(),'İzin yenilemem sürüyor.');
 await page.screenshot({path:path.join(data,'custom-answers.png')});await send.click();await card.waitFor({state:'detached'});
 const saved=(await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id)).automation.questions.find(item=>item.id===q.id);
 assert.equal(saved.answerValues,null);assert.equal(saved.answer,'Şehir: Yalnızca Berlin’den uzaktan çalışabilirim.\nÇalışma izni: İzin yenilemem sürüyor.\nMaaş: 95000');
 await page.waitForFunction(({id,qid})=>localStorage.getItem(`jobloop-question:${id}:${qid}:custom`)===null,{id:a.id,qid:q.id});assert.deepEqual(errors,[]);
 console.log('QUESTION_CUSTOM_ANSWERS_DRAFT_VALIDATION_AND_SUBMISSION_PASS',data);
}finally{await app.close();}
