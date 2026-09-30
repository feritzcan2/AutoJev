import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'source-stop-')),env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
try{
 const page=await app.firstWindow();await page.evaluate(async()=>{
  const {automationSourcesPanel}=await import('../src/automation-sources.js');const host=document.createElement('section');document.body.replaceChildren(host);window.stopCalls=[];window.runCalls=[];
  const source={url:'https://example.test/jobs',name:'Example',enabled:true,scanning:true,mode:'observe',intervalMinutes:30,resultCount:2,lastResult:'Uygulama kapatıldı.'};
  const snapshot={automation:{id:'owner',mode:'observe',status:'enabled',browserMode:'separate'},sources:[source],progress:{reviewed:true,passed:true}};
  const api={workspaceTabs:async()=>[],automationSourceStop:async(id,url)=>{window.stopCalls.push({id,url});await new Promise(resolve=>{window.finishStop=resolve;});source.scanning=false;source.nextRunAt=Date.now()+1800000;source.lastResult='Tarama kullanıcı tarafından durduruldu.';},automationSourceRun:async(id,url)=>window.runCalls.push({id,url})};
  const panel=automationSourcesPanel(host,api,{notice:text=>{window.lastNotice=text;},refresh:async()=>panel.update(snapshot,'owner')});panel.update(snapshot,'owner');window.sourceFixture={source,snapshot,panel};
 });
 assert.equal(await page.getByText('Uygulama kapatıldı.',{exact:true}).count(),0);
 await page.evaluate(()=>{const {source,snapshot,panel}=window.sourceFixture;source.scanIssue={url:source.url+'?page=8',attempts:2,evidence:'net::ERR_HTTP2_PROTOCOL_ERROR'};panel.update(snapshot,'owner');});
 await page.getByText('Sayfa yüklenemedi',{exact:true}).waitFor();
 assert.match(await page.locator('.source-status').innerText(),/page=8.*2. deneme/);
 await page.evaluate(()=>{const {source,snapshot,panel}=window.sourceFixture;source.scanIssue=null;panel.update(snapshot,'owner');});
 await page.getByRole('button',{name:'Taramayı durdur',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Durduruluyor…',exact:true}).isDisabled(),true);
 assert.deepEqual(await page.evaluate(()=>window.stopCalls),[{id:'owner',url:'https://example.test/jobs'}]);await page.evaluate(()=>window.finishStop());
 await page.getByRole('button',{name:'Şimdi tara',exact:true}).waitFor();assert.match(await page.evaluate(()=>window.lastNotice),/ilerleme korundu/);
 await page.getByRole('button',{name:'Şimdi tara',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.runCalls),[{id:'owner',url:'https://example.test/jobs'}]);
 await page.evaluate(()=>{const {source,snapshot,panel}=window.sourceFixture;Object.assign(source,{blocked:true,nextRunAt:null,recovery:null,blocker:{stop:{kind:'technical',retryExhausted:true}},lastResult:'Erişim sorunu sürüyor. Otomatik deneme durduruldu.'});panel.update(snapshot,'owner');});
 await page.getByText('Erişim sorunu sürüyor',{exact:true}).waitFor();
 await page.getByText('Yeniden başlatılmayı bekliyor',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Tekrar dene',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'Tekrar dene',exact:true}).click();assert.equal(await page.evaluate(()=>window.runCalls.length),2);
 await page.evaluate(()=>{
  const {source,snapshot,panel}=window.sourceFixture,urls=Array.from({length:250},(_,i)=>'https://example.test/item/'+i);
  source.scan={complete:false,pendingUrls:urls,work:{activeSearchId:'north',searches:[{id:'north',label:'North',status:'pending',pendingUrls:urls,pageProgress:{currentPage:7}},{id:'south',label:'South',status:'completed',pendingUrls:[]}]}};
  source.pageProgress={currentPage:7,totalPages:8,url:source.url+'?page=7',evidence:'7 / 8',at:Date.now()};source.observedPage={currentPage:1};panel.update(snapshot,'owner');
 });
 await page.getByRole('button',{name:'Tarama hafızası',exact:true}).click();
 await page.getByText('North · 250 adres bekliyor · 7. sayfa · Seçili arama',{exact:true}).waitFor();
 await page.getByText('1. sayfa. Kayıtlı ilerleme ve kalan adresler korunuyor.',{exact:true}).waitFor();
 await page.locator('.source-progress-pending summary').click();
 assert.equal(await page.locator('.source-progress-pending li').count(),100);
 await page.getByRole('button',{name:'Sonraki 100 adresi göster',exact:true}).click();assert.equal(await page.locator('.source-progress-pending li').count(),200);
 await page.getByRole('button',{name:'Sonraki 100 adresi göster',exact:true}).click();assert.equal(await page.locator('.source-progress-pending li').count(),250);
 assert.equal(await page.getByRole('button',{name:'Sonraki 100 adresi göster',exact:true}).isVisible(),false);
 console.log('SOURCE_STOP_BUTTON_SCOPE_BUSY_AND_RESTART_PASS');
}finally{await app.close();}
