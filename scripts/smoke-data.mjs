import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../app/store.mjs';
import {inspectBackup} from '../app/data-management.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const base=await mkdtemp(path.join(tmpdir(),'jobloop-data-ui-')),data=path.join(base,'data'),exports=path.join(base,'exports'),cvSource=path.join(base,'synthetic-cv.txt'),restartMarker=path.join(base,'restart.json');
await mkdir(data);await mkdir(exports);await writeFile(cvSource,'Synthetic CV for the local backup smoke. No real candidate.\n');
let app=null,page=null;const errors=[];
async function launch(){
 app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
 page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.jobloop)&&document.querySelector('#setup-provider').options.length>0);
}
async function close(){if(app){const current=app;app=null;await current.close();}}
try{
 // Create the candidate and import a CV through real main-process IPC. Only the
 // native file dialog is supplied by the fixture; no agent is ever started.
 await launch();
 const candidate=await page.evaluate(()=>window.jobloop.saveProfile({name:'Backup Fixture',preferences:'Local test only',facts:'Synthetic candidate',authorization:'research'}));
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},cvSource);
 const cv=await page.evaluate(id=>window.jobloop.pickDocument(id,{purpose:'cv'}),candidate.id);assert.equal(await readFile(cv,'utf8'),await readFile(cvSource,'utf8'));
 await close();

 // Seed historical jobs while the app is closed. A paused campaign ensures
 // neither fixture job can dispatch a provider or browser operation on boot.
 const store=new Store(path.join(data,'jobloop.sqlite'));let working,submitting;
 try{
  working=store.addJob(candidate.id,{url:'https://example.test/jobs/draft',company:'Synthetic Employer',role:'Draft fixture',location:'Remote',fit:'Local test'}).job;
  submitting=store.addJob(candidate.id,{url:'https://example.test/jobs/sending',company:'Synthetic Employer',role:'Submission fixture',location:'Remote',fit:'Local test'}).job;
  for(const [job,status] of [[working,'working'],[submitting,'submitting']])store.db.prepare('UPDATE workspace_records SET data=? WHERE id=?').run(JSON.stringify({...job,status,sessionId:null,resumeContext:{browser:'Fixture',tabId:'old-tab',url:job.url}}),job.id);
  store.saveCampaign(candidate.id,{status:'paused',target:10,intervalMinutes:30,task:null,wakeAt:0,nextSearchAt:0,attempts:{},note:'Local smoke fixture'});
 }finally{store.close();}
 const document=path.join(data,'candidates',candidate.id,'documents','cover-letter.txt');await mkdir(path.dirname(document),{recursive:true});await writeFile(document,'Original synthetic cover letter.\n');
 // A prior app-version stamp must cause the real boot path to back up this DB
 // before opening Store, while keeping the candidate files recoverable.
 await writeFile(path.join(data,'data-version.json'),JSON.stringify({appVersion:'0.0.0-smoke',schemaVersion:1}));
 await launch();
 const version=await app.evaluate(({app})=>app.getVersion()),initial=await page.evaluate(()=>window.jobloop.dataStatus());
 const upgrade=initial.backups.find(backup=>backup.kind==='upgrade'&&backup.appVersion==='0.0.0-smoke');assert.ok(upgrade,'Boot must back up a previous application version');
 assert.equal((await inspectBackup(path.join(data,'backups',upgrade.name))).jobs,2);
 assert.equal(JSON.parse(await readFile(path.join(data,'data-version.json'),'utf8')).appVersion,version);

 await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},exports);
 const backup=await page.evaluate(()=>window.jobloop.dataBackup());assert.equal(backup.secrets,'excluded');assert.equal(backup.candidates,1);assert.equal(backup.jobs,2);
 const inspected=await inspectBackup(backup.path);assert.ok(inspected.files>=3);assert.equal(await readFile(path.join(backup.path,'candidates',candidate.id,'CV.txt'),'utf8'),await readFile(cvSource,'utf8'));
 assert.equal(await readFile(path.join(backup.path,'candidates',candidate.id,'documents','cover-letter.txt'),'utf8'),'Original synthetic cover letter.\n');

 await page.evaluate(id=>window.jobloop.saveProfile({id,name:'Changed after backup',preferences:'Changed preferences',facts:'Changed fixture'}),candidate.id);
 await writeFile(document,'Changed after export.\n');
 await writeFile(path.join(data,'candidates',candidate.id,'documents','after-export.txt'),'This must disappear on restore.\n');
 assert.equal((await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),candidate.id)).profile.name,'Changed after backup');

 // Exercise the real restore handler and native confirmation. Suppress only
 // Electron's detached relaunch scheduling so Playwright can launch the next
 // process explicitly. Native app.quit and all graceful shutdown code stay real.
 await app.evaluate(({app,dialog},{directory,marker})=>{
  const fs=process.getBuiltinModule('node:fs');let confirmed=false;
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});
  dialog.showMessageBox=async(_window,options)=>{if(options.title!=='Yedeği geri yükle'||options.buttons[1]!=='Geri yükle ve yeniden başlat')throw Error('Unexpected native confirmation');confirmed=true;return {response:1,checkboxChecked:false};};
  app.relaunch=()=>fs.writeFileSync(marker,JSON.stringify({relaunchCalled:true,confirmed}));
 },{directory:backup.path,marker:restartMarker});
 const closed=app.waitForEvent('close',{timeout:30000});
 const restore=page.evaluate(()=>window.jobloop.dataRestore());
 const [restoredCall,shutdown]=await Promise.allSettled([restore,closed]);
 if(shutdown.status==='rejected')throw shutdown.reason;
 app=null;
 if(restoredCall.status==='fulfilled')assert.equal(restoredCall.value.restartRequired,true);
 else assert.match(String(restoredCall.reason),/closed|destroyed|Target page/i,'Only graceful application shutdown may interrupt the IPC response');
 assert.deepEqual(JSON.parse(await readFile(restartMarker,'utf8')),{relaunchCalled:true,confirmed:true});
 const pending=JSON.parse(await readFile(path.join(data,'pending-restore.json'),'utf8'));assert.match(pending.stageName,/^\.restore-stage-/);
 const before=new DatabaseSync(path.join(data,'jobloop.sqlite'),{readOnly:true});try{assert.equal(JSON.parse(before.prepare('SELECT data FROM candidates WHERE id=?').get(candidate.id).data).name,'Changed after backup','Live records must remain unchanged until restart');}finally{before.close();}

 await launch();
 const restored=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),candidate.id);
 assert.equal(restored.profile.name,'Backup Fixture');assert.equal(restored.profile.preferences,'Local test only');assert.equal(restored.profile.cvPath,cv);
 assert.equal(await readFile(restored.profile.cvPath,'utf8'),await readFile(cvSource,'utf8'));assert.equal(await readFile(document,'utf8'),'Original synthetic cover letter.\n');
 await assert.rejects(()=>stat(path.join(data,'candidates',candidate.id,'documents','after-export.txt')),{code:'ENOENT'});
 assert.equal(restored.campaign.status,'paused');assert.equal(restored.active,null);assert.ok(restored.workers.every(worker=>!worker.active));
 assert.equal(restored.jobs.find(job=>job.id===working.id).status,'blocked');assert.equal(restored.jobs.find(job=>job.id===submitting.id).status,'uncertain');
 for(const job of restored.jobs){assert.equal(job.sessionId,null);assert.equal(job.resumeContext,null);}
 assert.equal((await page.evaluate(id=>window.jobloop.backgroundSnapshot(id),candidate.id)).task.enabled,false);
 const documents=await page.evaluate(id=>window.jobloop.documents(id),candidate.id);assert.ok(documents.some(file=>file.name==='CV.txt'));assert.ok(documents.some(file=>file.name==='cover-letter.txt'));
 await assert.rejects(()=>stat(path.join(data,'pending-restore.json')),{code:'ENOENT'});
 const current=await page.evaluate(()=>window.jobloop.dataStatus()),recovery=current.backups.find(item=>item.kind==='before-restore');assert.ok(recovery,'Restore must keep a recovery backup');
 const recoverDb=new DatabaseSync(path.join(data,'backups',recovery.name,'jobloop.sqlite'),{readOnly:true});try{assert.equal(JSON.parse(recoverDb.prepare('SELECT data FROM candidates WHERE id=?').get(candidate.id).data).name,'Changed after backup');}finally{recoverDb.close();}
 assert.equal(current.pendingRestore,false);assert.deepEqual(errors,[]);
 console.log('DATA_UI_PASS',base);
}finally{await close();}
