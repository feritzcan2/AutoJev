import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=process.cwd(),platform=process.platform;
const executable=process.env.JOBLOOP_PACKAGED_BINARY||path.join(root,platform==='darwin'?'release/mac-universal/JobLoop.app/Contents/MacOS/JobLoop':platform==='win32'?'release/win-unpacked/JobLoop.exe':'release/linux-unpacked/jobloop');
const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-packaged-')),working=await mkdtemp(path.join(os.tmpdir(),'jobloop-cwd-'));
let application;
async function launch(){
 application=await electron.launch({executablePath:executable,args:platform==='linux'?['--no-sandbox']:[],cwd:working,env:{...process.env,JOBLOOP_DATA_DIR:data}});
 const page=await application.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.jobloop),{timeout:30000});
 const packaged=await application.evaluate(({app})=>app.isPackaged);assert.equal(packaged,true);
 const catalog=await page.evaluate(()=>window.jobloop.catalog());assert.ok(catalog.some(provider=>provider.id==='codex'));
 return {page,errors};
}
try{
 let {page,errors}=await launch();
 const candidate=await page.evaluate(()=>window.jobloop.saveProfile({name:'Release fixture',preferences:'Remote',authorization:'research'}));
 const snapshot=await page.evaluate(id=>window.jobloop.snapshot(id),candidate.id);assert.equal(snapshot.profile.name,'Release fixture');
 const source=await page.evaluate(id=>window.jobloop.saveSource(id,{name:'LinkedIn',url:'https://www.linkedin.com/jobs/',kind:'linkedin',integrationId:'linkedin',query:'Fixture source',intervalMinutes:30,enabled:false,applyMode:'find_only'}),candidate.id);
 const instructions=await page.evaluate(({id,sourceId})=>window.jobloop.sourceInstructions(id,sourceId),{id:candidate.id,sourceId:source.id});assert.ok(instructions.skillText.length>100);
 assert.deepEqual(errors,[]);await application.close();application=null;
 ({page,errors}=await launch());
 const persisted=await page.evaluate(id=>window.jobloop.snapshot(id),candidate.id);assert.equal(persisted.profile.name,'Release fixture');assert.deepEqual(errors,[]);
 await application.close();application=null;
 const resources=platform==='darwin'?path.resolve(executable,'../../Resources'):path.join(path.dirname(executable),'resources');
 const engine=path.join(resources,'engine',platform==='win32'?'jobloop-engine.exe':'jobloop-engine');
 const reply=execFileSync(engine,[path.join(data,'engine-smoke')],{input:'{"id":"ci","op":"catalog"}\n',timeout:20000,encoding:'utf8'});assert.ok(JSON.parse(reply.trim().split('\n').find(line=>line.includes('"ci"'))).result.length>0);
 const packageBytes=await readFile(path.join(resources,'app.asar'));assert.ok(packageBytes.length>10000);
 const mcp=path.join(resources,'app.asar.unpacked/node_modules/@playwright/mcp/cli.js');
 const mcpVersion=execFileSync(executable,[mcp,'--version'],{cwd:working,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:20000});assert.match(mcpVersion,/0\.0\.82/);
 for(const name of ['linkedin','freehire','jobindex','jobnet','jobdanmark','jobbank']){
  const result=spawnSync(process.env.JOBLOOP_BUN||'bun',[path.join(resources,'app.asar.unpacked/dist/source-tools',name+'.mjs'),'--help'],{cwd:working,encoding:'utf8',timeout:20000});
  assert.ok([0,1].includes(result.status)&&!result.error&&!result.stderr.trim()&&/usage|commands|options/i.test(result.stdout),`Packaged source tool failed: ${name}: ${result.error??result.stderr}`);
 }
 if(platform==='darwin')execFileSync('lipo',[engine,'-verify_arch','arm64','x86_64']);
 console.log('PACKAGED_SMOKE_PASS: independent working directory, bundled engine/skills, database restart');
}finally{await application?.close();await rm(data,{recursive:true,force:true});await rm(working,{recursive:true,force:true});}
