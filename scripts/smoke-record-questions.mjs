import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'record-questions-')),core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(core),a=db.create('job-search',{title:'Question pin test'}),run=db.begin(a.id,'interview');
const records=[];
for(let n=0;n<16;n++){
 const url='https://example.test/'+n;db.observe(a.id,run.id,url,'Observed listing');
 const item=db.record(a.id,run.id,{url,title:n===0?'Zulu question':n===1?'Alpha question':'Idle '+n,summary:'Observed'});records.push(db.putResult({...item,trial:false,updatedAt:1000+n}));
}
const questions=records.slice(0,2).map((item,n)=>db.askQuestion(a.id,{recordId:item.id,text:'Required answer '+n,fields:[{id:'answer',label:'Your answer',type:'text',required:true}]}));
// A resolved outcome from older data keeps its proposal timestamp. Its old
// verification failure must not hide the now-prepared record or offer retry.
const resolved=records[2],task=core.workspaces.tasks.enqueue(a.id,{recordId:resolved.id,recordOperation:'verify',operation:'record-verify'});
core.workspaces.tasks.put({...task,state:'blocked',summary:'Old verification could not determine the outcome',finishedAt:2000});
db.putResult({...resolved,status:'prepared',proposal:'Prepared local action',verifiedAt:3000,notSubmitted:{kind:'user',at:3000,digest:resolved.digest}});
db.finish(a.id,run.id,'completed','Waiting');db.put({...db.get(a.id),status:'paused'});core.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.locator('[data-view=board]').click();
 const ids=()=>page.locator('tr[data-result-id]').evaluateAll(rows=>rows.map(r=>r.dataset.resultId));
 await page.locator('[data-record-question]').first().waitFor();
 const resolvedRow=page.locator(`[data-result-id="${resolved.id}"]`);
 assert.equal(await resolvedRow.locator('.automation-badge.blocked').count(),0);
 assert.equal(await resolvedRow.locator('[data-record-retry]').count(),0);
 assert.equal(await resolvedRow.locator('time').getAttribute('datetime'),new Date(3000).toISOString());
 await page.screenshot({path:path.join(data,'resolved-verification.png')});
 assert.equal(await page.locator('#question-badge').innerText(),'2 yanıt');assert.equal(await page.locator('#agent-nav-status').isVisible(),false);
 await page.locator('#question-badge').click();assert.equal(await page.locator('#automation-result-filter').inputValue(),'waiting');await page.selectOption('#automation-result-filter','all');
 assert.deepEqual((await ids()).slice(0,2),[records[1].id,records[0].id]);
 await page.locator('[data-result-sort=updatedAt]').click();assert.deepEqual((await ids()).slice(0,2),[records[0].id,records[1].id]);
 await page.locator('[data-result-sort=title]').click();assert.deepEqual((await ids()).slice(0,2),[records[1].id,records[0].id]);
 await page.locator('[data-result-sort=title]').click();assert.deepEqual((await ids()).slice(0,2),[records[0].id,records[1].id]);
 assert.equal(await page.locator('tr[data-needs-answer=true] .record-question-badge').count(),2);
 await page.selectOption('#automation-result-filter','waiting');assert.equal((await ids()).length,2);
 await page.locator(`[data-record-question="${questions[0].id}"]`).click();
 const card=page.locator('dialog.record-question-dialog');await card.waitFor({state:'visible'});assert.equal(await card.getAttribute('data-question-id'),questions[0].id);
 assert.equal(await page.locator('#agent .candidate-question-form').count(),0);
 await card.getByRole('textbox',{name:'Your answer',exact:true}).fill('Saved draft answer');
 await page.keyboard.press('Escape');await card.waitFor({state:'hidden'});
 await page.locator(`[data-record-question="${questions[0].id}"]`).click();
 assert.equal(await card.getByRole('textbox',{name:'Your answer',exact:true}).inputValue(),'Saved draft answer');
 await page.screenshot({path:path.join(data,'question-dialog.png')});
 assert.equal(await card.evaluate(el=>el.contains(document.activeElement)),true,'The exact question receives focus');
 await card.getByRole('button',{name:'Atla',exact:true}).click();await card.waitFor({state:'hidden'});
 await page.locator('[data-view=board]').click();assert.deepEqual(await ids(),[records[1].id]);
 await page.selectOption('#automation-result-filter','all');assert.equal((await ids())[0],records[1].id);
 await page.screenshot({path:path.join(data,'question-pinned.png')});
 await page.locator('[data-view=agent]').click();assert.equal(await page.locator('#agent .candidate-question-form').count(),0);
 await page.getByRole('button',{name:'Yanıt bekleyenleri göster',exact:true}).click();assert.equal(await page.locator('#automation-result-filter').inputValue(),'waiting');
 await page.locator(`[data-record-question="${questions[1].id}"]`).click();
 await card.getByRole('textbox',{name:'Your answer',exact:true}).fill('Verified answer for the second record');
 await card.getByRole('button',{name:'Yanıtları gönder',exact:true}).click();await card.waitFor({state:'hidden'});
 assert.equal(await page.locator('#question-badge').isVisible(),false);
 const answered=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id);assert.equal(answered.automation.questions.find(q=>q.id===questions[1].id).answerValues.answer,'Verified answer for the second record');
 assert.equal(await page.locator('tr[data-needs-answer=true]').count(),0);assert.deepEqual(errors,[]);
 console.log('RECORD_QUESTIONS_UI_PASS',data);
}finally{await app.close();}
