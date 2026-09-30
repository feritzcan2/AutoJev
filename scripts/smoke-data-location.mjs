import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=await realpath(await mkdtemp(path.join(tmpdir(),'loop-storage-ui-'))),bootstrap=path.join(root,'bootstrap'),destination=path.join(root,'desktop'),marker=path.join(root,'restarted.json');
await mkdir(bootstrap);await mkdir(destination);
const store=new Store(path.join(bootstrap,'jobloop.sqlite'));
const profile=store.saveProfile({name:'Storage fixture',preferences:'Synthetic data only',authorization:'research'});
const cv=path.join(bootstrap,'candidates',profile.id,'CV.txt');await mkdir(path.dirname(cv),{recursive:true});await writeFile(cv,'Synthetic CV');store.setCv(profile.id,cv);
const job=store.addJob(profile.id,{url:'https://example.test/job/123',company:'Fixture',role:'Test',location:'Remote',fit:'Fixture'}).job;
store.db.prepare('UPDATE workspace_records SET data=? WHERE id=?').run(JSON.stringify({...job,status:'submitted',proof:'Synthetic confirmation'}),job.id);store.close();
let app,page;const errors=[];
async function launch(){
 const env={...process.env,JOBLOOP_DATA_DIR:bootstrap};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>Boolean(window.jobloop));
}
try{
 await launch();
 assert.equal((await page.evaluate(()=>window.jobloop.dataStatus())).directory,bootstrap);
 await page.locator('[data-view=config]').click();
 await page.locator('a[href="#config-data"]').click();
 await page.locator('[data-directory]').waitFor({state:'visible'});
 assert.equal(await page.locator('[data-directory]').textContent(),bootstrap);
 await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
 assert.equal(await page.evaluate(()=>window.jobloop.dataChangeDirectory()),null);
 await app.evaluate(({app,dialog},{destination,marker})=>{
  dialog.showOpenDialog=async()=>({canceled:false,filePaths:[destination]});
  app.relaunch=()=>process.getBuiltinModule('node:fs').writeFileSync(marker,JSON.stringify({relaunch:true}));
 },{destination,marker});
 const closed=app.waitForEvent('close');
 await page.locator('[data-change-directory]').click().catch(error=>{if(!/closed/.test(error.message))throw error;});
 await closed;app=null;assert.equal(JSON.parse(await readFile(marker,'utf8')).relaunch,true);
 await launch();
 const status=await page.evaluate(()=>window.jobloop.dataStatus());assert.equal(status.directory,destination);
 const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),profile.id);
 assert.equal(snapshot.jobs[0].status,'submitted');assert.equal(snapshot.jobs[0].proof,'Synthetic confirmation');
 assert.equal(snapshot.profile.cvPath,path.join(destination,'candidates',profile.id,'CV.txt'));assert.equal(await readFile(snapshot.profile.cvPath,'utf8'),'Synthetic CV');
 assert.equal(await readFile(cv,'utf8'),'Synthetic CV');assert.deepEqual(errors,[]);
 await app.close();app=null;await launch();assert.equal((await page.evaluate(()=>window.jobloop.dataStatus())).directory,destination);
 // Open an independent existing workspace through the new UI and real IPC.
 const existing=path.join(root,'existing');await mkdir(existing);
 const previous=new Store(path.join(existing,'jobloop.sqlite'));
 const existingProfile=previous.saveProfile({name:'Existing folder fixture',preferences:'Keep existing records',authorization:'research'});
 const existingCv=path.join(existing,'candidates',existingProfile.id,'CV.txt');await mkdir(path.dirname(existingCv),{recursive:true});await writeFile(existingCv,'Existing folder CV');previous.setCv(existingProfile.id,existingCv);previous.close();
 await page.locator('[data-view=config]').click();await page.locator('a[href="#config-data"]').click();
 await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
 await page.locator('[data-use-directory]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-use-directory]').disabled);
 assert.equal((await page.evaluate(()=>window.jobloop.dataStatus())).directory,destination);
 await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},root);
 await page.locator('[data-use-directory]').click();await page.locator('.data-status').filter({hasText:'jobloop.sqlite bulunamadı'}).waitFor();
 assert.equal((await page.evaluate(()=>window.jobloop.dataStatus())).directory,destination);
 await app.evaluate(({app,dialog},{existing,marker})=>{
  dialog.showOpenDialog=async(_window,options)=>{
   if(options.buttonLabel!=='Aç ve yeniden başlat'||options.properties.join(',')!=='openDirectory')throw Error('Unexpected folder dialog');
   return {canceled:false,filePaths:[existing]};
  };
  app.relaunch=()=>process.getBuiltinModule('node:fs').writeFileSync(marker,JSON.stringify({existing}));
 },{existing,marker});
 const switched=app.waitForEvent('close');
 await page.locator('[data-use-directory]').click().catch(error=>{if(!/closed/.test(error.message))throw error;});
 await switched;app=null;assert.equal(JSON.parse(await readFile(marker,'utf8')).existing,existing);
 await launch();assert.equal((await page.evaluate(()=>window.jobloop.dataStatus())).directory,existing);
 const existingSnapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),existingProfile.id);
 assert.equal(existingSnapshot.profile.name,'Existing folder fixture');assert.equal(existingSnapshot.profile.cvPath,existingCv);
 assert.equal(await readFile(existingCv,'utf8'),'Existing folder CV');assert.equal(await readFile(cv,'utf8'),'Synthetic CV');
 await app.close();app=null;await launch();assert.equal((await page.evaluate(()=>window.jobloop.dataStatus())).directory,existing);
 assert.deepEqual(errors,[]);
 console.log('DATA_LOCATION_UI_PASS '+root);
}finally{if(app)await app.close();}
