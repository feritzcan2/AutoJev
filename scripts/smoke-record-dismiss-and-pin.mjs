import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'dismiss-pin-')),core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(core),a=db.create('job-search',{title:'Dismiss and pin test'}),run=db.begin(a.id,'interview');
db.observe(a.id,run.id,'https://example.test/target','Observed target listing');db.observe(a.id,run.id,'https://example.test/other','Observed other listing');
const item=db.record(a.id,run.id,{key:'target',url:'https://example.test/target',title:'Target application',summary:'Observed'});
const other=db.record(a.id,run.id,{key:'other',url:'https://example.test/other',title:'Other application',summary:'Observed'});
const q=db.askQuestion(a.id,{recordId:item.id,text:'Required details?',fields:[{id:'answer',label:'Answer',type:'text',required:true}]}),otherQ=db.askQuestion(a.id,{recordId:other.id,text:'Other details?'});
db.finish(a.id,run.id,'completed','Waiting');db.put({...db.get(a.id),status:'paused'});core.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
try{
 const page=await app.firstWindow();await page.locator('aside nav [data-view=board]').click();await page.locator(`[data-record-question="${q.id}"]`).click();
 const card=page.locator('dialog.record-question-dialog');await card.getByRole('button',{name:'Atla',exact:true}).click();await card.waitFor({state:'hidden'});
 assert.equal(await page.locator(`[data-record-question="${otherQ.id}"]`).isVisible(),true);
 const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id);assert.equal(snapshot.results.find(r=>r.id===item.id).status,'dismissed');assert.equal(snapshot.automation.questions.find(v=>v.id===q.id).resolution,'record_dismissed');
 // Exercise the actual table renderer with old active records and more than a
 // page of newer idle records, without starting external agents.
 await page.evaluate(async()=>{
  const {automationResultsTable}=await import('../src/automation-results.js');
  const host=document.createElement('section'),head=document.createElement('div'),root=document.createElement('div');host.style.cssText='grid-column:1 / -1;min-width:0;padding:24px';host.append(head,root);document.body.replaceChildren(host);
  const button=(text,click)=>{const e=document.createElement('button');e.textContent=text;e.onclick=click;return e;};
  const table=automationResultsTable(root,{button,badge:()=>document.createElement('span'),time:String,api:{workspaceTabs:async()=>window.pinFixture.tabs,automationRecordRun:async(...args)=>{window.pinFixture.calls.push(args);}},refresh:()=>{}});
  const record=(id,title,at,state)=>({id,title,url:'https://example.test/'+id,status:'found',updatedAt:at,recordAction:state?{task:{state,kind:'prepare',at}}:{}});
  const records=[record('working','Zulu working',1,'running'),record('reporting','Alpha reporting',2,'reported'),{...record('waiting','A waiting',0),recordAction:{question:{id:'q',text:'A pending question'}}},...Array.from({length:14},(_,i)=>record('idle-'+i,'Idle '+i,1000+i))];
  window.pinFixture={table,tabs:[],snapshot:{automation:{id:'test',browserMode:'jev',table:{columns:[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'Pozisyon',type:'text'}]}},definition:{records:{states:[],actions:[]}},results:records}};
  table.update(window.pinFixture.snapshot,false);
 });
 const ids=()=>page.locator('tr[data-result-id]').evaluateAll(rows=>rows.map(r=>r.dataset.resultId));
 assert.deepEqual((await ids()).slice(0,3),['waiting','reporting','working']);
 await page.evaluate(()=>{window.pinFixture.tabs=[{tabId:'live',recordId:'idle-13',url:'https://example.test/form'}];});
 await page.waitForFunction(()=>document.querySelector('tr[data-result-id="idle-13"]')?.dataset.openTab==='true');
 assert.deepEqual((await ids()).slice(0,4),['waiting','idle-13','reporting','working']);
 const openColor=await page.locator('tr[data-result-id="idle-13"] td').first().evaluate(el=>getComputedStyle(el).backgroundColor);
 const idleColor=await page.locator('tr[data-result-id="idle-12"] td').first().evaluate(el=>getComputedStyle(el).backgroundColor).catch(()=>null);
 assert.notEqual(openColor,idleColor);
 await page.evaluate(()=>{window.pinFixture.tabs.push({tabId:'question',recordId:'waiting',url:'https://example.test/waiting'});});
 await page.waitForFunction(()=>document.querySelector('tr[data-result-id="waiting"]')?.dataset.openTab==='true');
 assert.equal((await ids())[0],'waiting');
 const openTitleColor=await page.locator('tr[data-result-id="idle-13"] .role-cell strong').evaluate(el=>getComputedStyle(el).color);
 const waitingTitleColor=await page.locator('tr[data-result-id="waiting"] .role-cell strong').evaluate(el=>getComputedStyle(el).color);
 assert.equal(openTitleColor,waitingTitleColor,'Open tabs keep their accent even when a record is waiting');
 await page.evaluate(()=>{window.pinFixture.tabs=[];});
 await page.waitForFunction(()=>document.querySelector('tr[data-result-id="idle-13"]')?.dataset.openTab==='false');
 assert.deepEqual((await ids()).slice(0,3),['waiting','reporting','working']);
 assert.equal(await page.locator('[data-record-tab="idle-13"]').count(),0);
 await page.setViewportSize({width:1040,height:700});
 const workingRow=page.locator('tr[data-result-id=working]');
 assert.equal((await ids())[0],'waiting','Unanswered questions stay ahead of other records');
 assert.equal(await workingRow.locator('.record-working-badge').innerText(),'Agent çalışıyor');
 assert.equal(await workingRow.locator('td').first().evaluate(el=>getComputedStyle(el).position),'static');
 assert.equal(await page.locator('.jobs-table-wrap').evaluate(el=>getComputedStyle(el).maxHeight),'none');
 const before=await workingRow.locator('td').first().boundingBox();await page.evaluate(()=>window.scrollTo(0,250));
 const after=await workingRow.locator('td').first().boundingBox();assert.ok(after.y<before.y-50,'Active row scrolls normally with the page');
 await page.getByRole('button',{name:'Sonraki',exact:true}).click();assert.equal((await ids()).includes('working'),false,'Active records are sorted first, not repeated on every page');
 await page.getByRole('button',{name:'Önceki',exact:true}).click();
 await page.screenshot({path:path.join(data,'working-first.png')});
 await page.locator('[data-result-sort=updatedAt]').click();assert.deepEqual((await ids()).slice(0,3),['waiting','working','reporting']);
 await page.locator('[data-result-sort=title]').click();assert.deepEqual((await ids()).slice(0,3),['waiting','reporting','working']);
 await page.locator('[data-result-sort=title]').click();assert.deepEqual((await ids()).slice(0,3),['waiting','working','reporting']);
 await page.evaluate(()=>{for(const r of window.pinFixture.snapshot.results)r.recordAction={};window.pinFixture.table.update(window.pinFixture.snapshot,false);});
 assert.equal((await ids())[1],'idle-13','Completed work returns to the chosen sort order');
 await page.evaluate(()=>{
  const f=window.pinFixture;f.calls=[];
  f.snapshot.results=['prepare','execute','verify'].map((kind,i)=>({id:kind,title:kind,url:'https://example.test/'+kind,status:kind==='verify'?'uncertain':'prepared',updatedAt:i+1,recordAction:{lastTask:{kind,state:'blocked',at:i+2,summary:'Stopped'},retryOperation:{kind,direct:kind==='execute',disabled:false}}}));
  f.table.update(f.snapshot,false);
 });
 for(const kind of ['prepare','execute','verify']){
  const retry=page.locator(`[data-record-retry="${kind}"]`);
  assert.equal(await retry.isVisible(),true,'Retry is visible without opening the row menu');
  await retry.click();
 }
 assert.deepEqual(await page.evaluate(()=>window.pinFixture.calls),[['test','prepare','prepare',{}],['test','execute','execute',{direct:true}],['test','verify','verify',{}]]);
 await page.evaluate(()=>{const f=window.pinFixture;f.snapshot.results[0].recordAction.retryOperation.disabled=true;f.snapshot.results[0].recordAction.retryOperation.reason='Önce soruyu yanıtla';f.table.update(f.snapshot,false);});
 assert.equal(await page.locator('[data-record-retry="prepare"]').isDisabled(),true);
 console.log('RECORD_DISMISS_AND_WAITING_FIRST_UI_PASS',data);
}finally{await app.close();}
