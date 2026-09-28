import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';
import {savePreparation,preparationProfileKey} from '../app/preparation.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(import.meta.dirname,'..'),data=await mkdtemp(path.join(tmpdir(),'jobloop-preparation-ui-'));
const store=new Store(path.join(data,'jobloop.sqlite')),p=store.saveProfile({name:'Demo Candidate',preferences:'Remote software engineering',facts:'Five years building backend services',authorization:'submit'});
for(const source of store.sources(p.id))store.saveSource(p.id,{...source,enabled:false});
const cv=path.join(data,'cv.txt');await writeFile(cv,'Synthetic candidate CV');store.setCv(p.id,cv);
const job=store.addJob(p.id,{company:'Northstar',role:'Senior Software Engineer',location:'Remote · Europe',fit:'Backend services and product engineering',url:'https://example.test/jobs/preparation'}).job;
const application=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await application.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 // Exercise real IPC and scheduler while preventing provider/browser launches.
 await application.evaluate(async(_,urls)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {Engine}=await load(urls.engine),{BrowserTools}=await load(urls.browser),request=Engine.prototype.request;
  Engine.prototype.request=function(op,args={}){if(['start','message','resize'].includes(op))return Promise.resolve({});return request.call(this,op,args);};
  BrowserTools.prototype.prepare=()=>({state:'ready',ready:true});
 },{engine:pathToFileURL(path.join(root,'app/engine.mjs')).href,browser:pathToFileURL(path.join(root,'app/browser.mjs')).href});
 await page.getByRole('button',{name:'Northstar başvurusunu hazırla',exact:true}).click();
 await page.waitForFunction(async id=>(await window.jobloop.snapshot(id)).campaign?.task?.kind==='preparation',p.id);
 const snapshot=await page.evaluate(id=>window.jobloop.snapshot(id),p.id),session=snapshot.active?.sessionId??'ui-fixture';
 assert.equal(snapshot.jobs[0].preparation.hold,true);
 store.updateJob(p.id,job.id,'working','Başvuru formu inceleniyor',session);
 const folder=path.join(store.candidateDirectory(p.id),'documents',job.id);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'cover-letter.md'),'Dear Northstar team,\n\nI build reliable backend services.');
 await savePreparation(store,p.id,{jobId:job.id,revision:store.job(p.id,job.id).preparation.revision,profileKey:preparationProfileKey(store.profile(p.id)),status:'ready',coverage:'complete',formUrl:job.url,coverageNote:'Belgeler ve başvuru soruları kontrol edildi.',note:'Cover letter ve başvuru cevabı hazır.',requirements:[
  {id:'letter',label:'Cover letter',kind:'document',required:'required',status:'ready',evidence:'Cover letter *',documentPath:`documents/${job.id}/cover-letter.md`,format:'Markdown',language:'İngilizce'},
  {id:'motivation',label:'Why Northstar?',kind:'answer',required:'required',status:'ready',evidence:'Why Northstar? *',answer:'I enjoy building reliable backend services.',maxLength:500}
 ]},session);
 const c=store.campaign(p.id);store.saveCampaign(p.id,{...c,task:null,status:'paused'});
 await page.reload();await page.getByRole('button',{name:'Hazırlık',exact:true}).click();
 const panel=page.locator('#preparation-dialog');await panel.getByText('Hazırlık tamamlandı',{exact:true}).waitFor();
 await panel.getByRole('button',{name:'Önizle',exact:true}).click();await panel.getByText('Dear Northstar team,',{exact:false}).waitFor();
 await panel.getByRole('button',{name:'Düzenle',exact:true}).last().click();await panel.locator('textarea').fill('My own answer, preserved for the application.');await panel.getByRole('button',{name:'Kaydet',exact:true}).click();
 await panel.getByText('My own answer, preserved for the application.',{exact:true}).waitFor();
 assert.equal(store.job(p.id,job.id).preparation.requirements[1].userEdited,true);
 await application.evaluate(({BrowserWindow},file)=>BrowserWindow.getAllWindows()[0].webContents.session.once('will-download',(_,item)=>item.setSavePath(file)),path.join(data,'package.zip'));
 await panel.getByRole('button',{name:'Dosyaları indir',exact:true}).click();
 await page.screenshot({path:path.join(data,'preparation-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(data,'preparation-mobile.png'),fullPage:true});
 const overflow=await panel.evaluate(e=>e.scrollWidth>e.clientWidth+1);assert.equal(overflow,false);
 await panel.getByRole('button',{name:'Başvur',exact:true}).click();
 await page.waitForFunction(async id=>(await window.jobloop.snapshot(id)).campaign?.task?.kind==='application',p.id);
 assert.equal(store.job(p.id,job.id).preparation.hold,false);assert.equal(store.job(p.id,job.id).preparation.requirements[1].answer,'My own answer, preserved for the application.');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,data,checks:['prepare IPC and scheduler','package panel','preview','edit retention','ZIP export','narrow layout','explicit application handoff']}));
}finally{
 // Provider launches are stubbed; exit this isolated test app without waiting
 // for a provider lifecycle that was intentionally never started.
 await application.evaluate(({app})=>app.exit(0)).catch(()=>{});
 await application.close().catch(()=>{});store.close();
}
