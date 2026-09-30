import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=await mkdtemp(path.join(os.tmpdir(),'generic-workspace-ui-'));
const store=new Store(path.join(data,'jobloop.sqlite')),legacy=store.saveProfile({name:'Job search',preferences:'Remote software engineering',authorization:'research'});
store.sources(legacy.id);store.ask(legacy.id,{question:'When can you start?'});
const db=new AutomationStore(store),housing=db.create('housing',{title:'Housing',goal:'Find a home',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:['https://example.com/homes','https://example.org/homes']});db.askQuestion(housing.id,{text:'Ev tercihleri',fields:[{id:'area',label:'Bölge',type:'select',options:['Ring içi','Ring dışı']},{id:'budget',label:'Bütçe',type:'number'}]});store.close();
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1>Local setup fixture</h1><a href="/listing">Listing</a><p>Berlin, 1500 EUR, 3 rooms. Page 1 of 1</p>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const fixtureUrl=`http://127.0.0.1:${server.address().port}/listing`;
const application=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 application.process().stderr.on('data',bytes=>process.stderr.write(bytes));
 const page=await application.firstWindow({timeout:20000}),errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error('UI_ERROR',error.message);});
 await page.waitForFunction(()=>document.querySelectorAll('#candidates option').length===3);
 // Mock provider decisions only; UI, MCP, sessions, database and browser are real.
 await application.evaluate(async(_,url)=>{const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}),{Engine}=await load(url),request=Engine.prototype.request;globalThis.setupStarts=[];Engine.prototype.request=function(op,args={}){if(op==='start'){globalThis.setupStarts.push(args);return Promise.resolve({});}if(op==='resize')return Promise.resolve({});return request.call(this,op,args);};},pathToFileURL(path.join(root,'app/engine.mjs')).href);
 let rpcId=0;
 const current=()=>application.evaluate(()=>globalThis.setupStarts.at(-1));
 const waitStart=async previous=>{await page.waitForFunction(()=>!document.querySelector('#stop').hidden);await application.evaluate(async(_,previous)=>{for(let i=0;i<100;i++){if(globalThis.setupStarts.at(-1)?.sessionId!==previous&&globalThis.setupStarts.length)return;await new Promise(r=>setTimeout(r,50));}throw Error('Setup did not start');},previous);return current();};
 const tool=async(name,args={})=>{const run=await current(),response=await fetch(run.endpoint,{method:'POST',headers:{Authorization:'Bearer '+run.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})}),body=await response.json();assert.ok(!body.error&&!body.result?.isError,JSON.stringify(body));return JSON.parse(body.result.content[0].text);};
 const finish=async summary=>{await tool('finish_automation_run',{status:'completed',summary});await page.waitForFunction(()=>document.querySelector('#stop').hidden);};

 for(const [id,minutes] of [[legacy.id,555],[housing.id,150]]){
  await page.selectOption('#candidates',id);await page.locator('[data-view=sources]').click();
  const panel=page.locator('[data-automation-pane=sources]'),interval=panel.locator('[name=intervalMinutes]');
  await interval.fill(String(minutes));await panel.getByRole('button',{name:'Tümüne uygula',exact:true}).click();
  await page.waitForFunction(value=>[...document.querySelectorAll('[data-automation-pane=sources] .source-plan b')].every(n=>n.textContent===`Her ${value} dk`),minutes);
  const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),id);assert.equal(snapshot.definition.execution.driver,'browser');assert.ok(snapshot.sources.every(s=>s.intervalMinutes===minutes));assert.equal(snapshot.profile,undefined);assert.equal(snapshot.campaign,undefined);
  await page.screenshot({path:path.join(data,id===legacy.id?'job-sources.png':'housing-sources.png')});
 }
 await page.locator('[data-view=agent]').click();await page.getByLabel('Bölge',{exact:true}).selectOption('Ring içi');await page.getByLabel('Bütçe',{exact:true}).fill('2000');await page.getByRole('button',{name:'Yanıtları gönder',exact:true}).click();await page.locator('.automation-help-card').filter({hasText:'Ev tercihleri'}).waitFor({state:'hidden'});
 await waitStart();await finish('Housing answers saved');
 await page.selectOption('#candidates',legacy.id);assert.equal(await page.locator('#notice').isVisible(),false);
 await page.locator('[data-view=agent]').click();await page.getByLabel('When can you start?',{exact:true}).fill('Next month');await page.getByRole('button',{name:'Yanıtla',exact:true}).click();
 await page.locator('.automation-help-card').filter({hasText:'When can you start?'}).waitFor({state:'hidden'});
 await waitStart();await finish('Job answers saved');
 await page.locator('[data-view=profile]').click();await page.locator('#automation-criteria [name=criteria-preferences]').waitFor({state:'visible'});
 await page.locator('[data-view=notifications]').click();await page.getByRole('heading',{name:'Bildirim ayarları'}).waitFor();
 await page.locator('[data-view=background]').click();await page.locator('#background').waitFor({state:'visible'});
 await page.reload();await page.locator('[data-view=sources]').click();await page.waitForFunction(()=>document.querySelector('#automation-sources-interval')?.value==='555');
 for(const template of ['job-search','housing','appointment','custom']){
  const previous=(await current())?.sessionId;await page.locator('[data-view=templates]').click();await page.locator(`[data-template="${template}"]`).click();
  assert.equal(await page.locator('aside nav [data-view=agent]').evaluate(n=>n.classList.contains('selected')),true);
  if(template==='custom'){await page.locator('#automation-message').waitFor({state:'visible'});assert.equal((await current()).sessionId,previous);continue;}
  const first=await waitStart(previous),context=await tool('get_automation_context');assert.equal(context.template.id,template);assert.equal(context.messages.filter(m=>m.role==='user').length,0);assert.equal(first.resumeId,undefined);
  await tool('ask_workspace_question',{text:'Kurulum tercihin',fields:[{id:'choice',label:'Kurulum seçimi',type:'select',options:['A','B']}]});await finish('Form yanıtı bekleniyor');
  await page.getByLabel('Kurulum seçimi',{exact:true}).selectOption('A');await page.getByRole('button',{name:'Yanıtları gönder',exact:true}).click();const second=await waitStart(first.sessionId);assert.equal(second.resumeId,undefined);
  const resumed=await tool('get_automation_context');assert.equal(resumed.questions[0].answerValues.choice,'A');assert.ok(resumed.messages.some(m=>m.role==='user'&&m.text.includes('Kurulum seçimi: A')));
  await tool('save_automation_plan',{title:template+' setup',goal:'Read local fixture',criteria:context.template.fields.map(f=>({key:f.id,value:'Test criteria'})),sources:[fixtureUrl],instructions:'Only observe the local fixture; no submissions.',facts:''});await tool('reply_to_user',{message:'Kurulum hazır, profili kontrol edip kaydet.'});await finish('Kurulum taslağı hazır');
  await page.locator('[data-view=profile]').click();await page.locator('#automation-plan-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#automation-run')&&!document.querySelector('#automation-run').disabled);
  if(template==='housing'){
   const owner=await page.locator('#candidates').inputValue(),before=(await current()).sessionId;await page.locator('[data-view=board]').click();await page.locator('#automation-run').click();await waitStart(before);await tool('browser_open',{url:fixtureUrl});await tool('save_workspace_source_skill',{baseVersion:0,summary:'Tek sayfalı yerel kaynak okundu.',sections:[{key:'pagination',status:'unverified',instructions:'The fixture has one page; pagination was not exercised.',evidenceIds:[]}]});await finish('Yerel kaynak okunabiliyor');
   const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),owner);assert.equal(snapshot.sources[0].trial.status,'passed');assert.equal(snapshot.automation.mode,'prepare');assert.notEqual(snapshot.automation.status,'enabled');
  }
 }
 const blank=await page.locator('#candidates').inputValue(),before=(await current()).sessionId;await page.locator('.workspace-intro-templates summary').click();await page.locator('[data-intro-template="job-search"]').click();await waitStart(before);await page.waitForFunction(id=>![...document.querySelectorAll('#candidates option')].some(o=>o.value===id),blank);
 await tool('ask_workspace_question',{text:'İş arama tercihlerin',fields:[{id:'role',label:'Hedef rol',type:'text'},{id:'location',label:'Konum',type:'text'}]});await finish('İş arama formu hazır');await page.getByLabel('Hedef rol',{exact:true}).waitFor({state:'visible'});await page.screenshot({path:path.join(data,'job-setup-form.png')});
 assert.deepEqual(errors,[]);console.log('GENERIC_WORKSPACE_UI_PASS',data);
}finally{await application.close();await new Promise(r=>server.close(r));}
