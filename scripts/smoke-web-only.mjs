import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'loop-web-only-'));
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/page/2'?'<h1>Second page</h1><a href="/home/2">Home Two</a>':req.url.startsWith('/home/')?`<h1>Observed home ${req.url.endsWith('2')?'Two':'One'}</h1><p>Berlin, two rooms, total rent 1200 EUR.</p>`:'<h1>Homes</h1><a href="/home/1">Home One</a><a href="/page/2">Next page</a>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
let application;
try{
 application=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data,LOOP_EXTENSIONS:''}});
 const page=await application.firstWindow(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>Boolean(window.jobloop)&&document.querySelector('#setup-provider').options.length>0);
 const catalog=await page.evaluate(()=>window.jobloop.automationTemplates());assert.ok(catalog.some(t=>t.id==='housing'));assert.ok(catalog.every(t=>t.execution.driver!=='applications'));
 await application.evaluate(async(_,moduleUrl)=>{const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}),{Engine}=await load(moduleUrl),original=Engine.prototype.request;Engine.prototype.request=function(op,args){if(op==='start'){globalThis.webOnlyLaunch=args;return Promise.resolve({});}if(op==='resize')return Promise.resolve({});return original.call(this,op,args);};},pathToFileURL(path.join(process.cwd(),'app/engine.mjs')).href);
 const workspace=await page.evaluate(url=>window.jobloop.workspaceCreate('housing',{title:'Web-only homes',goal:'Find matching homes',criteria:{location:'Berlin',budget:'1500',requirements:'Two rooms'},sources:[url]}),url);
 await page.locator('#candidates').selectOption(workspace.id);await page.locator('[data-view=agent]').click();
 const snapshot=()=>page.evaluate(id=>window.jobloop.workspaceSnapshot(id),workspace.id);
 const initial=await snapshot();assert.equal(initial.workspace.id,workspace.id);assert.equal(initial.profile,undefined);assert.equal(initial.campaign,undefined);assert.ok(initial.workers.every(worker=>worker.execution&&!worker.campaign));
 await page.evaluate(id=>window.jobloop.automationReview(id),workspace.id);await page.evaluate(id=>window.jobloop.workspaceStart(id),workspace.id);
 const call=async(name,args={})=>{const launch=await application.evaluate(()=>globalThis.webOnlyLaunch);assert.ok(launch);const response=await fetch(launch.endpoint,{method:'POST',headers:{Authorization:'Bearer '+launch.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const value=(await response.json()).result;assert.ok(!value.isError,JSON.stringify(value));return JSON.parse(value.content[0].text);};
 const launch=await application.evaluate(()=>globalThis.webOnlyLaunch),listed=await fetch(launch.endpoint,{method:'POST',headers:{Authorization:'Bearer '+launch.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
 const names=(await listed.json()).result.tools.map(tool=>tool.name);assert.ok(names.includes('browser_interact'));assert.ok(!names.includes('get_candidate_profile'));assert.ok(!names.includes('record_submission'));
 await call('browser_open',{url:url+'/home/1'});await call('record_automation_result',{key:'one',url:url+'/home/1',title:'Home One',summary:'Observed two-room home at 1200 EUR.'});await call('finish_automation_run',{status:'completed',summary:'The source and a matching detail were observed.'});
 await page.waitForFunction(async id=>(await window.jobloop.workspaceSnapshot(id)).activeRuns.length===0,workspace.id);assert.equal((await snapshot()).automation.trial.status,'passed');
 await page.evaluate(id=>window.jobloop.workspaceStart(id),workspace.id);
 for(let attempt=0;attempt<100&&(await application.evaluate(()=>globalThis.webOnlyLaunch.sessionId))===launch.sessionId;attempt++)await new Promise(resolve=>setTimeout(resolve,100));
 assert.notEqual((await application.evaluate(()=>globalThis.webOnlyLaunch.sessionId)),launch.sessionId);
 const first=await call('browser_open',{url}),content=first.content.map(part=>part.text??'').join('\n');
 const ref=content.split('\n').find(line=>line.includes('Next page')&&line.includes('[ref='))?.match(/\[ref=([^\]]+)\]/)?.[1];assert.ok(ref);
 const second=await call('browser_interact',{operation:'click',ref});assert.equal(second.url,url+'/page/2');
 for(const [number,title] of [[1,'Home One'],[2,'Home Two']]){await call('browser_open',{url:url+'/home/'+number});await call('record_automation_result',{key:String(number),url:url+'/home/'+number,title,summary:'Observed Berlin home, two rooms, total rent 1200 EUR.'});}
 await call('finish_automation_run',{status:'completed',summary:'Both pages and both matching home details were processed.',scan:{complete:true,pendingUrls:[],reason:'Both fixture pages were inspected; both detail pages were recorded.',evidenceUrl:url+'/home/2'}});
 await page.waitForFunction(async id=>(await window.jobloop.workspaceSnapshot(id)).activeRuns.length===0,workspace.id);await page.evaluate(id=>window.jobloop.workspaceStop(id),workspace.id);
 const done=await snapshot();assert.equal(done.results.length,2);assert.equal(done.workspace.id,workspace.id);assert.equal(done.profile,undefined);
 const status=await page.evaluate(()=>window.jobloop.dataStatus());assert.equal(status.prompts,0);
 const sqlite=new DatabaseSync(path.join(data,'jobloop.sqlite'),{readOnly:true});try{const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name);for(const name of ['candidates','campaigns','sources','questions','job_members','background_tasks'])assert.ok(!tables.includes(name),name+' must not be created');assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workspace_records').get().n,2);}finally{sqlite.close();}
 assert.deepEqual(errors,[]);console.log('WEB_ONLY_SMOKE_PASS',data);
}finally{await application?.close();await new Promise(resolve=>server.close(resolve));}
