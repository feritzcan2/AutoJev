import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(import.meta.dirname,'..'),data=await mkdtemp(path.join(tmpdir(),'jobloop-limit-'));
const store=new Store(path.join(data,'jobloop.sqlite'));
const profile=store.saveProfile({name:'Limit test',preferences:'Remote',authorization:'research',browserMode:'existing'});
const cv=path.join(data,'cv.txt');await writeFile(cv,'Synthetic candidate');store.setCv(profile.id,cv);
for(let i=0;i<2;i++){
 const job=store.addJob(profile.id,{company:`Employer ${i}`,role:'Engineer',location:'Remote',fit:'Synthetic',url:`https://example.test/job/${i}`}).job;
 store.setManualJobStatus(profile.id,job.id,'manual_submitted');
}
store.saveCampaign(profile.id,{status:'complete',target:1,intervalMinutes:30,task:null,attempts:{},note:'Başvuru hedefine ulaşıldı'});
store.saveConversation(profile.id,'codex','existing-conversation',store.profile(profile.id).agentSettings);store.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await app.evaluate(async(_,url)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {Engine}=await load(url),request=Engine.prototype.request;globalThis.agentStarts=0;
  Engine.prototype.request=function(op,args={}){if(op==='start')globalThis.agentStarts++;if(['start','message','resize'].includes(op))return Promise.resolve({});return request.call(this,op,args);};
 },pathToFileURL(path.join(root,'app/engine.mjs')).href);
 const warning=page.locator('#campaign-limit-warning');await warning.waitFor({state:'visible'});
 assert.equal(await page.locator('#campaign-limit-title').textContent(),'Başvuru limiti aşıldı');
 assert.equal(await page.locator('#campaign-limit-counts').textContent(),'2 başvuru gönderildi · Mevcut limit: 1');
 await page.locator('button[data-view=agent]').click();await warning.waitFor({state:'visible'});
 for(const button of ['#start','#restart-agent']){
  await page.locator(button).click();
  await page.waitForFunction(()=>!document.querySelector('#campaign-limit-warning').hidden&&!document.querySelector('#start').disabled&&document.activeElement.id==='campaign-limit-warning');
  assert.equal(await page.locator('#notice').isVisible(),false);
  assert.equal(await page.locator('#agent').isVisible(),true);assert.equal(await warning.isVisible(),true);
  const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),profile.id);
  assert.equal(snapshot.active,null);assert.equal(snapshot.campaign.status,'complete');
 }
 assert.equal(await app.evaluate(()=>globalThis.agentStarts),0);
 const saved=new Store(path.join(data,'jobloop.sqlite'));assert.equal(saved.conversation(profile.id,'codex'),'existing-conversation');saved.close();
 await page.screenshot({path:path.join(data,'limit-warning.png'),fullPage:true});
 await page.getByRole('button',{name:'Limiti düzenle',exact:true}).click();
 assert.equal(await page.locator('#board').isVisible(),true);
 assert.equal(await page.locator('#campaign-target').evaluate(el=>el===document.activeElement),true);
 await page.locator('#campaign-target').fill('3');await page.locator('#start').click();
 await page.waitForFunction(()=>document.querySelector('#campaign-status').textContent.includes('Görev kuyrukta'));
 await warning.waitFor({state:'hidden'});
 const started=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),profile.id);
 assert.equal(started.campaign.target,3);assert.equal(started.campaign.status,'running');assert.ok(started.active);
 assert.equal(await app.evaluate(()=>globalThis.agentStarts),1);assert.deepEqual(errors,[]);
 console.log('CAMPAIGN_LIMIT_UI_PASS',path.join(data,'limit-warning.png'));
}finally{await app.close();}
