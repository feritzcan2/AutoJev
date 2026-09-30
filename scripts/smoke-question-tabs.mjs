import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'question-tabs-')),store=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(store);
const a=db.create('custom',{title:'Question tab test',goal:'Check login',sources:['https://example.test/list']}),run=db.begin(a.id,'interview');
db.observe(a.id,run.id,'https://example.test/login','Login required',[],{tabId:'exact'});
const q=db.askQuestion(a.id,{text:'Did you sign in?',fields:[{id:'ready',label:'Signed in?',type:'boolean',required:true}]},{runId:run.id});db.finish(a.id,run.id,'completed','Waiting');db.put({...db.get(a.id),status:'paused'});store.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
try{
 const page=await app.firstWindow();
 await app.evaluate(({ipcMain})=>{
  globalThis.tabFocus=[];globalThis.testTabs=[{tabId:'other',url:'https://example.test/login'},{tabId:'exact',url:'https://example.test/application'}];
  ipcMain.removeHandler('workspace-tabs');ipcMain.handle('workspace-tabs',()=>globalThis.testTabs);
  ipcMain.removeHandler('focus-workspace-tab');ipcMain.handle('focus-workspace-tab',(_,id,tabId)=>{globalThis.tabFocus.push({id,tabId});return {focused:true};});
 });
 await page.locator('aside nav [data-view=agent]').click();
 const card=page.locator(`[data-issue-id="${q.id}"]`),open=card.getByRole('button',{name:'Sekmeyi göster ↗',exact:true});
 await open.click();assert.deepEqual(await app.evaluate(()=>globalThis.tabFocus),[{id:a.id,tabId:'exact'}]);
 assert.equal(await card.locator('select').inputValue(),'');
 await app.evaluate(()=>{globalThis.testTabs=[];});await open.click();await card.getByText(/İlgili açık sekme bulunamadı/).waitFor();
 assert.equal(await card.locator('select').inputValue(),'');assert.equal(await open.isEnabled(),true);
 await app.evaluate(()=>{globalThis.testTabs=[{tabId:'a',url:'https://example.test/login'},{tabId:'b',url:'https://example.test/login'}];});
 await open.click();assert.equal(await app.evaluate(()=>globalThis.tabFocus.length),1,'Never guess among matching tabs');
 await card.locator('.automation-help-tabs button').nth(1).click();assert.equal(await app.evaluate(()=>globalThis.tabFocus.at(-1).tabId),'b');
 const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id);assert.equal(snapshot.automation.questions[0].answer,null);
 console.log('QUESTION_TAB_EXACT_REDIRECT_CHOOSER_MISSING_TAB_PASS');
}finally{await app.close();}
