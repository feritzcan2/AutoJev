import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'source-controls-')),env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const fixtureModule=path.join(data,'source-panel.mjs');await build({entryPoints:['src/automation-sources.js'],bundle:true,format:'esm',outfile:fixtureModule});
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
try{
 const page=await app.firstWindow();
 const reset=async()=>page.evaluate(async url=>{
  const {automationSourcesPanel}=await import(url),main=document.createElement('main'),host=document.createElement('section');
  main.style.gridColumn='1 / -1';host.id='sources';main.append(host);document.body.replaceChildren(main);
  const sources=['https://one.test/search?q=engineer','https://two.test/catalog','https://three.test/'].map((url,index)=>({url,name:`Kaynak ${index+1}`,enabled:true,scanning:index===1,mode:'observe',intervalMinutes:30}));
  const snapshot={automation:{id:'owner',mode:'observe',status:'enabled',browserMode:'separate',sources:sources.map(s=>s.url)},sources,progress:{reviewed:true}};
  const calls=[],pending=new Map();let owner='owner';
  const request=async(kind,id,url)=>{calls.push({kind,id,url});await new Promise((resolve,reject)=>pending.set(`${id}:${url}`,{resolve,reject}));sources.find(s=>s.url===url).scanning=kind==='start';};
  const api={automationSourceRun:(id,url)=>request('start',id,url),automationSourceStop:(id,url)=>request('stop',id,url),automationSourceExport:()=>new Promise(resolve=>{window.fixture.finishExport=resolve;})};
  const panel=automationSourcesPanel(host,api,{notice:text=>{window.lastNotice=text;},refresh:async()=>panel.update(snapshot,owner)});
  window.fixture={snapshot,panel,calls,pending,update:()=>panel.update(snapshot,owner),select:id=>{owner=id;panel.update(snapshot,id);}};panel.update(snapshot,owner);
 },pathToFileURL(fixtureModule).href);
 const row=index=>page.locator('.source-row').nth(index);
 const refresh=()=>page.evaluate(()=>window.fixture.update());
 const finish=async(index,{id='owner',error}={})=>{
  await page.evaluate(({index,id,error})=>{const f=window.fixture,p=f.pending.get(`${id}:${f.snapshot.sources[index].url}`);if(error)p.reject(Error(error));else p.resolve();},{index,id,error});
 };
 // A real pointer press overlaps an incoming snapshot, as it does while workers report progress.
 for(const [index,label,kind] of [[0,'Şimdi tara','start'],[1,'Taramayı durdur','stop']]){
  await reset();const control=row(index).getByRole('button',{name:label,exact:true});await control.scrollIntoViewIfNeeded();await control.focus();const box=await control.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.evaluate(()=>{window.fixture.snapshot.sources[2].resultCount=17;window.fixture.update();});
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(()=>window.fixture.calls.map(c=>c.kind)),[kind],'snapshot refresh must preserve an in-flight click');
  assert.equal(await row(index).getByRole('button',{name:kind==='start'?'Başlatılıyor…':'Durduruluyor…',exact:true}).isDisabled(),true);
  await finish(index);
 }
 // Space activates on keyup; an incoming snapshot must preserve keyboard focus too.
 await reset();await row(1).getByRole('button',{name:'Taramayı durdur',exact:true}).focus();
 await page.keyboard.down('Space');await refresh();await page.keyboard.up('Space');
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.map(c=>c.kind)),['stop']);await finish(1);
 // A different panel action must not silently swallow either scan control.
 await reset();await page.getByRole('button',{name:'Dışa aktar',exact:true}).click();
 await row(0).getByRole('button',{name:'Şimdi tara',exact:true}).click();await row(1).getByRole('button',{name:'Taramayı durdur',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.map(c=>c.kind)),['start','stop']);
 await finish(0);await finish(1);await page.evaluate(()=>window.fixture.finishExport());
 await reset();
 await row(0).getByRole('button',{name:'Şimdi tara',exact:true}).click();
 await refresh();
 assert.equal(await row(0).getByRole('button',{name:'Başlatılıyor…',exact:true}).isDisabled(),true);
 // Snapshot updates must not erase pending state or allow a duplicate request.
 await row(0).getByRole('button',{name:'Başlatılıyor…',exact:true}).evaluate(button=>button.click());
 await row(1).getByRole('button',{name:'Taramayı durdur',exact:true}).click();
 await row(2).getByRole('button',{name:'Şimdi tara',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.fixture.calls.map(c=>c.kind)),['start','stop','start']);
 await refresh();assert.equal(await row(1).getByRole('button',{name:'Durduruluyor…',exact:true}).isDisabled(),true);
 await page.screenshot({path:path.join(data,'source-controls-pending.png'),fullPage:true});
 await finish(0,{error:'Başlatma başarısız'});await row(0).getByRole('button',{name:'Şimdi tara',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.lastNotice),'Başlatma başarısız');
 await finish(1,{error:'Durdurma başarısız'});await row(1).getByRole('button',{name:'Taramayı durdur',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.lastNotice),'Durdurma başarısız');
 await row(0).getByRole('button',{name:'Şimdi tara',exact:true}).click();await finish(0);await finish(2);
 await row(0).getByRole('button',{name:'Taramayı durdur',exact:true}).waitFor();
 // Old requests must neither lock nor report failures in the newly selected workspace.
 await reset();await row(0).getByRole('button',{name:'Şimdi tara',exact:true}).click();
 await page.evaluate(()=>window.fixture.select('other-owner'));
 await row(0).getByRole('button',{name:'Şimdi tara',exact:true}).click();
 await finish(0,{error:'Eski çalışma alanının hatası'});
 assert.equal(await row(0).getByRole('button',{name:'Başlatılıyor…',exact:true}).isDisabled(),true);
 assert.notEqual(await page.evaluate(()=>window.lastNotice),'Eski çalışma alanının hatası');
 await finish(0,{id:'other-owner'});await row(0).getByRole('button',{name:'Taramayı durdur',exact:true}).waitFor();
 console.log('SOURCE_CONTROLS_CLICK_REFRESH_CONCURRENCY_ERROR_SCOPE_PASS',data);
}finally{await app.close();}
