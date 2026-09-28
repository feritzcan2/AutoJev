import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const require=createRequire(import.meta.url);
const {_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-source-tabs-'));
const store=new Store(path.join(data,'jobloop.sqlite'));
const profile=store.saveProfile({name:'Source tabs test',preferences:'Remote',browserMode:'jev'}),source=store.sources(profile.id)[0];
store.close();
const application=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 // Real UI and IPC, synthetic browser pages; no personal Chrome or live agents.
 await application.evaluate(async(_,args)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {BrowserTools}=await load(args.url);
  globalThis.sourceTabOpen=false;globalThis.sourceTabFocused=null;
  BrowserTools.prototype.sourceTabs=async id=>globalThis.sourceTabOpen&&id===args.candidateId?{[args.sourceId]:{browser:'Jev Chrome',tabId:'fixture-source',url:'https://example.test/search'}}:{};
  BrowserTools.prototype.focusSource=async(id,source)=>{globalThis.sourceTabFocused={candidateId:id,sourceId:source.id};return {focused:true};};
 },{url:pathToFileURL(path.join(root,'app/browser.mjs')).href,candidateId:profile.id,sourceId:source.id});
 const page=await application.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.locator('button[data-view=sources]').click();
 await page.locator('.source-row').first().waitFor();
 assert.equal(await page.locator('.source-open-tab').count(),0);
 await application.evaluate(()=>globalThis.sourceTabOpen=true);
 const tab=page.getByRole('button',{name:`${source.name} sekmesine git`,exact:true});
 await tab.waitFor({state:'visible'});assert.equal(await page.locator('.source-open-tab').count(),1);
 await tab.click();
 assert.deepEqual(await application.evaluate(()=>globalThis.sourceTabFocused),{candidateId:profile.id,sourceId:source.id});
 await page.screenshot({path:path.join(data,'sources-tab.png')});
 await application.evaluate(()=>globalThis.sourceTabOpen=false);
 await tab.waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);
 console.log('SOURCE_TAB_UI_PASS',data);
}finally{await application.close();}
