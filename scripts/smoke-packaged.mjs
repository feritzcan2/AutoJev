import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=process.cwd(),platform=process.platform;
const executable=process.env.JOBLOOP_PACKAGED_BINARY||path.join(root,platform==='darwin'?'release/mac-universal/AutoJev.app/Contents/MacOS/AutoJev':platform==='win32'?'release/win-unpacked/AutoJev.exe':'release/linux-unpacked/jobloop');
const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-packaged-')),working=await mkdtemp(path.join(os.tmpdir(),'jobloop-cwd-'));
let application,archiveName='app.asar';
async function bounded(promise,label,timeout=20000){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>{application?.process().kill('SIGKILL');reject(Error(`${label} timed out after ${timeout}ms`));},timeout);})]);}
 finally{clearTimeout(timer);}
}
async function closeApplication(){
 if(!application)return;
 try{await bounded(application.close(),'Packaged application shutdown');}finally{application=null;}
}
async function launch(){
 application=await electron.launch({executablePath:executable,args:platform==='linux'?['--no-sandbox']:[],cwd:working,env:{...process.env,JOBLOOP_DATA_DIR:data}});
 const page=await application.firstWindow({timeout:30000}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.jobloop),{timeout:30000});
 const packaged=await application.evaluate(({app})=>({packaged:app.isPackaged,path:app.getAppPath()}));assert.equal(packaged.packaged,true);archiveName=path.basename(packaged.path);
 const catalog=await page.evaluate(()=>window.jobloop.catalog());assert.ok(catalog.some(provider=>provider.id==='codex'));
 return {page,errors};
}
async function onboarding(page){
 // Keep packaged IPC, filesystem, engine catalog and validation real; intercept
 // only provider process operations so this smoke makes no paid model calls.
 await bounded(application.evaluate(({app})=>{
  const path=process.getBuiltinModule('node:path'),fs=process.getBuiltinModule('node:fs/promises'),assert=process.getBuiltinModule('node:assert/strict');
  const require=process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
  const {Engine}=require('./app/engine.mjs'),request=Engine.prototype.request,started=new WeakSet();
  const fixture=globalThis.packagedSetupFixture={workspaceId:null,starts:[],realRequests:[]};
  Engine.prototype.request=async function(op,args={}){
   if(op==='start'){
    assert.ok(fixture.workspaceId);assert.equal(await fs.realpath(args.cwd),await fs.realpath(path.join(app.getPath('userData'),'automations','workspaces',fixture.workspaceId)));
    assert.equal(args.taskType,'automation');assert.ok(args.approvedTools.includes('ask_workspace_question'));
    assert.match(await fs.readFile(path.join(args.cwd,'AGENTS.md'),'utf8'),/get_automation_context/);
    assert.equal(await fs.readFile(path.join(args.cwd,'CLAUDE.md'),'utf8'),'@AGENTS.md\n\n');
    assert.equal((await fs.stat(path.join(args.cwd,'documents'))).isDirectory(),true);assert.equal((await fs.stat(args.runtimeDirectory)).isDirectory(),true);
    fixture.starts.push({cwd:args.cwd});started.add(this);return {started:true};
   }
   if(['resize','stop','input','message'].includes(op)&&started.has(this))return {};
   const result=await request.call(this,op,args);fixture.realRequests.push(op);return result;
  };
 }),'Install packaged setup fixture');
 await bounded(page.evaluate(()=>window.jobloop.catalog()),'Real engine catalog');
 const workspace=await bounded(page.evaluate(()=>window.jobloop.workspaceCreate('job-search',{title:'Packaged setup',agentSettings:{provider:'codex',model:'default',permission:'default',reasoning:'default',network:null}})),'Create packaged workspace');
 await application.evaluate((_,id)=>{globalThis.packagedSetupFixture.workspaceId=id;},workspace.id);
 const document=path.join(working,'packaged-CV.txt');await writeFile(document,'Synthetic packaged setup document.');
 await application.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},document);
 const copied=await page.evaluate(id=>window.jobloop.pickDocument(id),workspace.id);assert.equal(await readFile(copied,'utf8'),await readFile(document,'utf8'));
 await bounded(page.evaluate(id=>window.jobloop.automationSetup(id),workspace.id),'Begin packaged setup');
 let fixture;
 for(let attempt=0;attempt<100;attempt++){
  fixture=await application.evaluate(()=>globalThis.packagedSetupFixture);if(fixture.starts.length)break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.equal(fixture.starts.length,1);assert.ok(fixture.realRequests.includes('catalog')&&fixture.realRequests.includes('validate'));
 await bounded(page.evaluate(id=>window.jobloop.deleteWorkspace(id),workspace.id),'Remove setup fixture');
}

try{
 let {page,errors}=await launch();
 const candidate=await page.evaluate(()=>window.jobloop.workspaceCreate('job-search',{title:'Release fixture',goal:'Remote'}));
 const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),candidate.id);assert.equal(snapshot.automation.title,'Release fixture');
 const source=snapshot.sources.find(source=>source.url==='https://www.linkedin.com/jobs/');assert.ok(source);
 await onboarding(page);
 assert.deepEqual(errors,[]);await closeApplication();
 ({page,errors}=await launch());
 const persisted=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),candidate.id);assert.equal(persisted.automation.title,'Release fixture');assert.deepEqual(errors,[]);
 await closeApplication();
 const resources=platform==='darwin'?path.resolve(executable,'../../Resources'):path.join(path.dirname(executable),'resources');
 const engine=path.join(resources,'engine',platform==='win32'?'jobloop-engine.exe':'jobloop-engine');
 const reply=execFileSync(engine,[path.join(data,'engine-smoke')],{input:'{"id":"ci","op":"catalog"}\n',timeout:20000,encoding:'utf8'});assert.ok(JSON.parse(reply.trim().split('\n').find(line=>line.includes('"ci"'))).result.length>0);
 const packageBytes=await readFile(path.join(resources,archiveName));assert.ok(packageBytes.length>10000);
 if(platform==='darwin')execFileSync('lipo',[engine,'-verify_arch','arm64','x86_64']);
 console.log('PACKAGED_SMOKE_PASS: independent working directory, bundled engine, shared setup workspace, database restart');
}finally{await closeApplication().catch(error=>console.error(error.message));await rm(data,{recursive:true,force:true});await rm(working,{recursive:true,force:true});}
