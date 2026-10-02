import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-source-trial-'));
let hamburgAccessible=false;
const server=createServer((req,res)=>{
 const request=new URL(req.url,'http://localhost'),second=request.searchParams.get('page')==='2';
 res.setHeader('Content-Type','text/html; charset=utf-8');
 if(request.pathname==='/hamburg'&&!hamburgAccessible){res.end('<h1>Access denied</h1><p>Access to Hamburg homes is blocked.</p>');return;}
 if(request.pathname==='/home/one'){res.end('<h1>Rental detail</h1><p>Two rooms, 1400 EUR, available now. No pets.</p>');return;}
 res.end(`<h1>Rental listings</h1><p>${second?'Page two: Garden home, 1450 EUR.':'Page one: City home, 1400 EUR.'}</p><p>Filter: two rooms</p><a href="/home/one">View home</a>${second?'<p>End of results</p>':`<a href="${request.pathname}?page=2">Next page</a>`}`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,sources=[base+'/berlin',base+'/hamburg'];
const core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(core);
const owner=db.create('housing',{title:'Kaynak bazında deneme',goal:'Berlin ve Hamburg evleri',criteria:{location:'Germany',budget:'1500 EUR',requirements:'2 oda'},sources});
db.review(owner.id);core.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 // Real IPC, queue, MCP and local browser; replace provider execution only.
 await app.evaluate(async(_,url)=>{const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}),{Engine}=await load(url),request=Engine.prototype.request;globalThis.trialStarts=[];Engine.prototype.request=function(op,args={}){if(op==='start'&&args.cwd.includes('/automations/')){globalThis.trialStarts.push(args);return Promise.resolve({});}if(op==='resize')return Promise.resolve({});return request.call(this,op,args);};},pathToFileURL(path.join(process.cwd(),'app/engine.mjs')).href);
 const snapshot=()=>page.evaluate(id=>window.jobloop.workspaceSnapshot(id),owner.id);
 const wait=async predicate=>{for(let n=0;n<400;n++){const state=await snapshot();if(predicate(state))return state;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Workspace state did not settle: '+predicate);};
 let rpcId=0;
 const tool=async(name,args={})=>{const id=(await snapshot()).activeRun.id,run=await app.evaluate(async(_,id)=>{for(let n=0;n<400;n++){const run=globalThis.trialStarts.find(run=>run.sessionId===id);if(run)return run;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Provider launch was not captured');},id),response=await fetch(run.endpoint,{method:'POST',headers:{Authorization:'Bearer '+run.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})}),body=await response.json();assert.ok(!body.result?.isError,JSON.stringify(body));return JSON.parse(body.result.content[0].text);};
 const click=async(observation,label)=>{const line=observation.content.map(c=>c.text??'').join('\n').split('\n').find(line=>line.includes(`link "${label}"`)),ref=line?.match(/\[ref=([^\]]+)\]/)?.[1];assert.ok(ref,JSON.stringify(observation));return tool('browser_interact',{operation:'click',ref});};
 const inspect=async source=>{
  const first=await tool('browser_open',{url:source});
  const second=await click(first,'Next page');
  const detail=await click(second,'View home');
  assert.match(JSON.stringify(detail),/1400 EUR/);
 };
 await page.locator('[data-view=agent]').click();await page.getByRole('button',{name:'Düzenli takibi başlat',exact:true}).first().waitFor();
 assert.equal(await page.locator('#automation-trial,[data-progress-action=skip-trial]').count(),0);
 assert.equal((await snapshot()).runs.length,0);
 await page.screenshot({path:path.join(data,'setup-ready.png'),fullPage:true});
 await page.locator('#start').click();await wait(s=>s.activeRun?.kind==='trial');
 let state=await snapshot();assert.equal(state.activeRun.sourceUrl,sources[0]);assert.equal(state.automation.status,'enabled');assert.equal(state.automation.trial,null);
 await inspect(sources[0]);await tool('finish_automation_run',{status:'completed',summary:'Berlin kaynağı okunabiliyor.'});
 await wait(s=>s.activeRun?.sourceUrl.endsWith('/hamburg')&&s.activeRun.kind==='trial');
 await page.locator('[data-view=sources]').click();await page.locator('.source-trial-status[data-status=running]').waitFor();
 assert.equal(await page.locator('.source-trial-status[data-status=passed]').count(),1);
 assert.equal(await page.locator('.source-trial-status[data-status=running]').count(),1);
 await page.screenshot({path:path.join(data,'independent-source-trials.png'),fullPage:true});
 await tool('browser_open',{url:sources[1]});await tool('finish_automation_run',{status:'blocked',summary:'Hamburg kaynağına erişim engellendi.',stop:{kind:'access',evidence:'Access to Hamburg homes is blocked.'}});
 await wait(s=>!s.activeRun&&s.sources[1].blocked);
 state=await snapshot();assert.equal(state.automation.status,'enabled');assert.equal(state.sources[0].trial.status,'passed');assert.equal(state.sources[1].trial.status,'failed');
 hamburgAccessible=true;
 await page.locator('.source-row').nth(1).getByRole('button',{name:'Tekrar dene',exact:true}).click();await wait(s=>s.activeRun?.kind==='trial');
 assert.equal((await snapshot()).activeRun.sourceUrl,sources[1]);
 await inspect(sources[1]);await tool('finish_automation_run',{status:'completed',summary:'Hamburg kaynağı okunabiliyor.'});await wait(s=>!s.activeRun&&s.sources[1].trial?.status==='passed');
 await page.locator('.source-row').first().getByRole('button',{name:'Şimdi tara',exact:true}).click();await wait(s=>s.activeRun?.kind==='run');
 assert.equal((await snapshot()).activeRun.sourceUrl,sources[0]);await page.evaluate(id=>window.jobloop.workspaceStop(id),owner.id);await wait(s=>!s.activeRun);
 await page.screenshot({path:path.join(data,'source-trials-passed.png'),fullPage:true});
 await page.reload();await page.locator('[data-view=sources]').click();await page.locator('.source-trial-status[data-status=passed]').first().waitFor();assert.equal(await page.locator('.source-trial-status[data-status=passed]').count(),2);
 assert.equal(await page.getByRole('button',{name:'Rehber ve araçlar',exact:true}).count(),0);
 assert.deepEqual(errors,[]);console.log('SOURCE_TRIAL_UI_PASS',data);
}finally{await app.close();await new Promise(resolve=>server.close(resolve));}
