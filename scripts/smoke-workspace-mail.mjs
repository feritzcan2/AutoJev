import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WorkspaceSupport} from '../app/workspace-support.mjs';
import {BackgroundStore} from '../app/background-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'loop-workspace-mail-ui-')),core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(core),support=new WorkspaceSupport(db,{slots:()=>[]}),background=new BackgroundStore(support);
const custom=db.saveTemplate({...db.template('appointment'),title:'Tarih takibi',mail:{instructions:'Track booking reschedules.',outcomes:[{id:'rescheduled',label:'Tarih değişti'}]}});
const ids=[];
for(const [template,outcome,label] of [['housing','reply','Yanıt'],['job-search','interview','Mülakat daveti'],[custom.id,'rescheduled','Tarih değişti']]){
 const definition=db.template(template),a=db.create(template,{title:definition.title,goal:'Sentetik posta eşleştirme testi',sources:['https://example.test'],criteria:Object.fromEntries(definition.fields.filter(f=>f.required).map(f=>[f.id,'Test'])),facts:'E-posta: synthetic@example.test'});db.review(a.id);db.skipTrial(a.id);ids.push({id:a.id,outcome,label});
 const record=db.putResult({id:a.id+'-record',automationId:a.id,key:'record',url:'https://example.test/record',title:'Sentetik kayıt',summary:'Test sonucu',status:'completed',trial:false,createdAt:Date.now(),updatedAt:Date.now()});
 for(const pending of [false,true])background.record(a.id,'synthetic@example.test',{id:'message-'+pending,threadId:'thread-'+pending,subject:pending?'Eşleştirilecek mesaj':'Kayıt yanıtı',date:new Date().toISOString()},{...(pending?{}:{jobId:record.id}),outcome:pending?'unmatched':outcome,summary:pending?'İlgili kaydı seç.':'Kaydedilmiş örnek yanıt.'});
}
core.close();
const application=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await application.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.stack||error.message));
 await page.waitForFunction(()=>document.querySelectorAll('#candidates option').length>=4);
 for(const {id,outcome,label} of ids){
  await page.evaluate(async id=>{const select=document.getElementById('candidates');select.value=id;await select.onchange();},id);await page.locator('[data-view=background]').click();
  await page.locator('.mail-signal[data-review=accepted] .mail-signal-head b').filter({hasText:label}).waitFor();
  const select=page.locator('.signal-review select');await select.waitFor();
  assert.ok((await select.locator('option').evaluateAll(options=>options.map(o=>o.value))).includes(outcome));
  if(outcome!=='interview')assert.equal(await select.locator('option[value=interview]').count(),0);
  await page.locator('.signal-review input[type=search]').fill('Sentetik');await page.locator('.app-picker-option').first().click();await select.selectOption(outcome);await page.getByRole('button',{name:'Eşleştir',exact:true}).click();
  await page.locator('.signal-review').waitFor({state:'hidden'});
  const snapshot=await page.evaluate(id=>window.jobloop.backgroundSnapshot(id),id);assert.ok(snapshot.signals.every(signal=>signal.review==='accepted'&&signal.outcome===outcome));
  await page.screenshot({path:path.join(data,outcome+'.png'),fullPage:true});
 }
 assert.deepEqual(errors,[]);console.log('WORKSPACE_MAIL_UI_PASS',data);
}finally{await application.close();}
