import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=process.cwd(),platform=process.platform;
const executable=process.env.JOBLOOP_PACKAGED_BINARY||path.join(root,platform==='darwin'?'release/mac-universal/JobLoop.app/Contents/MacOS/JobLoop':platform==='win32'?'release/win-unpacked/JobLoop.exe':'release/linux-unpacked/jobloop');
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
 // Keep real preload IPC, setup scheduling, packaged filesystem and Rust
 // catalog/validation. Only provider start is replaced, plus resize on that
 // same instance because the fixture deliberately creates no paid-provider PTY.
 await bounded(application.evaluate(({app})=>{
  const path=process.getBuiltinModule('node:path'),fs=process.getBuiltinModule('node:fs/promises');
  const assert=process.getBuiltinModule('node:assert/strict'),{createHash}=process.getBuiltinModule('node:crypto');
  const require=process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
  const {Engine}=require('./app/engine.mjs'),{AGENTS_MD}=require('./app/prompts.mjs'),request=Engine.prototype.request,started=new WeakSet();
  const fixture=globalThis.packagedSetupFixture={candidateId:null,starts:[],realRequests:[]};
  async function inventory(directory,prefix=''){
   const result=[];
   for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name),relative=prefix+entry.name;
    if(entry.isDirectory())result.push(...await inventory(file,relative+'/'));
    else{assert.equal(entry.isFile(),true,`Unexpected skill entry: ${relative}`);result.push([relative,createHash('sha256').update(await fs.readFile(file)).digest('hex')]);}
   }
   return result.sort(([left],[right])=>left.localeCompare(right));
  }
  Engine.prototype.request=async function(op,args={}){
   if(op==='start'){
    assert.ok(fixture.candidateId,'Unexpected agent start before the setup fixture');
    assert.equal(args.cwd,path.join(app.getPath('userData'),'candidates',fixture.candidateId));
    assert.match(args.prompt,/JobLoop onboarding/);
    const expected=await inventory(path.join(app.getAppPath(),'skills'));
    assert.ok(expected.some(([file])=>file==='setup-profile/SKILL.md'));
    assert.ok(expected.some(([file])=>file==='apply-to-jobs/references/recovery.md'));
    assert.deepEqual(await inventory(path.join(args.cwd,'.agents/skills')),expected,'Every packaged skill, reference and license must reach the candidate workspace');
    assert.equal(await fs.readFile(path.join(args.cwd,'AGENTS.md'),'utf8'),AGENTS_MD);
    assert.equal(await fs.readFile(path.join(args.cwd,'CLAUDE.md'),'utf8'),'@AGENTS.md\n\n');
    for(const name of ['runtime','documents'])assert.equal((await fs.stat(path.join(args.cwd,name))).isDirectory(),true);
    fixture.starts.push({cwd:args.cwd,skillFiles:expected.length});started.add(this);
    return {started:true};
   }
   if(op==='resize'&&started.has(this))return {};
   const result=await request.call(this,op,args);fixture.realRequests.push(op);return result;
  };
 }),'Install packaged onboarding fixture');
 const settings={provider:'codex',model:'default',permission:'default',reasoning:'default',network:null};
 await bounded(page.evaluate(()=>window.jobloop.catalog()),'Real engine catalog');
 const candidate=await bounded(page.evaluate(settings=>window.jobloop.createSetup(settings),settings),'Create packaged setup');
 await bounded(application.evaluate((_,id)=>{globalThis.packagedSetupFixture.candidateId=id;},candidate.id),'Select setup fixture');
 const cv=path.join(working,'packaged-setup-CV.txt');await writeFile(cv,'Release fixture candidate. Synthetic CV for packaged onboarding.');
 // A real OS-backed File is required by preload webUtils.getPathForFile.
 await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='packaged-setup-cv-fixture';document.body.append(input);});
 await page.locator('#packaged-setup-cv-fixture').setInputFiles(cv);
 const copiedCv=await bounded(page.evaluate(id=>window.jobloop.importSetupCv(id,document.querySelector('#packaged-setup-cv-fixture').files[0]),candidate.id),'Import setup CV');
 assert.equal(await readFile(copiedCv,'utf8'),await readFile(cv,'utf8'));
 const before=await page.evaluate(id=>window.jobloop.snapshot(id),candidate.id);
 assert.deepEqual(before.browserStatus,{state:'unmanaged',ready:true});
 await bounded(page.evaluate(id=>window.jobloop.beginSetup(id),candidate.id),'Begin packaged onboarding');
 let snapshot,fixture;
 for(let attempt=0;attempt<100;attempt++){
  snapshot=await page.evaluate(id=>window.jobloop.snapshot(id),candidate.id);
  fixture=await bounded(application.evaluate(()=>globalThis.packagedSetupFixture),'Read onboarding result');
  if(snapshot.setup?.error||fixture.starts.length)break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.equal(snapshot.setup?.error??null,null,`Packaged onboarding failed before provider start: ${snapshot.setup?.error}`);
 assert.equal(fixture.starts.length,1,'Packaged onboarding must reach the provider start boundary once');
 assert.ok(fixture.starts[0].skillFiles>10,'Nested skill references must be included');
 assert.ok(fixture.realRequests.includes('catalog')&&fixture.realRequests.includes('validate'),'Catalog and configuration validation must use the real bundled engine');
 assert.equal(snapshot.setup.status,'running');
 await bounded(page.evaluate(id=>window.jobloop.deleteWorkspace(id),candidate.id),'Remove setup fixture');
 await page.locator('#packaged-setup-cv-fixture').evaluate(input=>input.remove());
}
try{
 let {page,errors}=await launch();
 const candidate=await page.evaluate(()=>window.jobloop.saveProfile({name:'Release fixture',preferences:'Remote',authorization:'research'}));
 const snapshot=await page.evaluate(id=>window.jobloop.snapshot(id),candidate.id);assert.equal(snapshot.profile.name,'Release fixture');
 const source=await page.evaluate(id=>window.jobloop.saveSource(id,{name:'LinkedIn',url:'https://www.linkedin.com/jobs/',kind:'linkedin',integrationId:'linkedin',query:'Fixture source',intervalMinutes:30,enabled:false,applyMode:'find_only'}),candidate.id);
 const instructions=await page.evaluate(({id,sourceId})=>window.jobloop.sourceInstructions(id,sourceId),{id:candidate.id,sourceId:source.id});assert.ok(instructions.skillText.length>100);
 await onboarding(page);
 assert.deepEqual(errors,[]);await closeApplication();
 ({page,errors}=await launch());
 const persisted=await page.evaluate(id=>window.jobloop.snapshot(id),candidate.id);assert.equal(persisted.profile.name,'Release fixture');assert.deepEqual(errors,[]);
 await closeApplication();
 const resources=platform==='darwin'?path.resolve(executable,'../../Resources'):path.join(path.dirname(executable),'resources');
 const engine=path.join(resources,'engine',platform==='win32'?'jobloop-engine.exe':'jobloop-engine');
 const reply=execFileSync(engine,[path.join(data,'engine-smoke')],{input:'{"id":"ci","op":"catalog"}\n',timeout:20000,encoding:'utf8'});assert.ok(JSON.parse(reply.trim().split('\n').find(line=>line.includes('"ci"'))).result.length>0);
 const packageBytes=await readFile(path.join(resources,archiveName));assert.ok(packageBytes.length>10000);
 const mcp=path.join(resources,archiveName+'.unpacked/node_modules/@playwright/mcp/cli.js');
 const mcpVersion=execFileSync(executable,[mcp,'--version'],{cwd:working,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:20000});assert.match(mcpVersion,/0\.0\.82/);
 for(const name of ['linkedin','freehire','jobindex','jobnet','jobdanmark','jobbank']){
  const result=spawnSync(process.env.JOBLOOP_BUN||'bun',[path.join(resources,archiveName+'.unpacked/dist/source-tools',name+'.mjs'),'--help'],{cwd:working,encoding:'utf8',timeout:20000});
  assert.ok([0,1].includes(result.status)&&!result.error&&!result.stderr.trim()&&/usage|commands|options/i.test(result.stdout),`Packaged source tool failed: ${name}: ${result.error??result.stderr}`);
 }
 if(platform==='darwin')execFileSync('lipo',[engine,'-verify_arch','arm64','x86_64']);
 console.log('PACKAGED_SMOKE_PASS: independent working directory, bundled engine/skills, real onboarding workspace, database restart');
}finally{await closeApplication().catch(error=>console.error(error.message));await rm(data,{recursive:true,force:true});await rm(working,{recursive:true,force:true});}
