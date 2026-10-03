import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {BROWSER_RESPONSE_BYTES} from '../app/browser-snapshot.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'loop-jev-reading-')),store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store);
let submits=0;
const server=createServer((req,res)=>{
 const route=new URL(req.url,'http://localhost').pathname;
 if(route==='/sent')submits++;
 res.setHeader('Content-Type','text/html; charset=utf-8');
 if(route==='/lazy')return res.end(`<!doctype html><h1>Lazy list</h1><div style="height:1800px">Scroll to load the next listing</div><script>addEventListener('scroll',()=>{if(scrollY>200&&!document.querySelector('#loaded')){const card=document.createElement('article');card.id='loaded';card.innerHTML='<a href="/lazy-detail">LAZY_TAIL_LISTING</a><p>Invalidenstraße 7, 10115 Berlin · 120 m²</p>';document.body.append(card);}});</script>`);
 if(route==='/lazy-detail')return res.end('<h1>LAZY_DETAIL</h1><p>Invalidenstraße 7, 10115 Berlin</p>');
 const listings=Array.from({length:1600},(_,i)=>`<article style="min-height:80px"><a href="/listing/${i}">Apartment ${i}: 110 m², 2 rooms, 1500 €</a><p>Rendered address ${i}, 10115 Berlin. This listing is loaded below the viewport and must be readable.</p></article>`).join('');
 res.end(`<!doctype html><title>Jev document reading</title><h1>Berlin apartments</h1><form action="/sent"><label>Password<input type="password" value="PASSWORD_MUST_NOT_LEAK"></label><input value="INPUT_VALUE_MUST_NOT_LEAK"><textarea>TEXTAREA_MUST_NOT_LEAK</textarea><button>Send message</button></form>
 <div hidden>HIDDEN_MUST_NOT_LEAK<a href="/hidden">hidden listing</a></div><div style="display:none">DISPLAY_NONE_MUST_NOT_LEAK</div><div style="opacity:0">OPACITY_MUST_NOT_LEAK</div><div aria-hidden="true">ARIA_HIDDEN_MUST_NOT_LEAK</div><script type="application/json">SCRIPT_STATE_MUST_NOT_LEAK</script>
 <details><summary>More information</summary>COLLAPSED_MUST_NOT_LEAK</details>${listings}
 <article><a href="/last">FINAL_LISTING_1600</a><p>Invalidenstraße 12, 10115 Berlin · 120 m² · 2 rooms · 2100 €</p></article>
 <div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>SHADOW_ADDRESS 10115 Berlin</p><a href="/shadow-listing">SHADOW_LISTING</a><div hidden>SHADOW_HIDDEN_MUST_NOT_LEAK</div>';</script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/`;
const a=db.create('custom',{goal:'Read all loaded rental listings',sources:[url],criteria:{outcome:'Observed addresses and URLs',rules:'Read only',completion:'One scan'}});db.review(a.id);
const run=db.begin(a.id,'trial'),controller=new AbortController();
const browsers=new BrowserTools(directory,()=>({connection:'separate',headless:true,choose:()=>{throw Error('No model should be called');}}));
const adapter=automationBrowser(browsers),flow=automationWorkflow({db,run,signal:controller.signal,browser:adapter,report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
let maxBytes=0;
const call=async(name,args={})=>{const result=await flow.call(a.id,run.id,name,args),bytes=Buffer.byteLength(JSON.stringify(result));maxBytes=Math.max(maxBytes,bytes);assert.ok(bytes<=BROWSER_RESPONSE_BYTES+1000);return result;};
const pageOf=async first=>{
 let result=first,text='';
 do{text+=result.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');if(!result.snapshot?.nextOffset)break;result=await call('browser_read_part',{snapshotId:result.snapshot.id,offset:result.snapshot.nextOffset});}while(true);
 return JSON.parse(text.replace(/^Page URL: [^\n]+\n/,''));
};
try{
 const first=await call('browser_open',{url}),page=await pageOf(first);
 assert.equal(page.reading.scope,'rendered_document');assert.equal(page.reading.truncated,false);assert.ok(page.text.length>156000);
 assert.match(page.text,/FINAL_LISTING_1600/);assert.match(page.text,/Invalidenstraße 12, 10115 Berlin/);assert.match(page.text,/SHADOW_ADDRESS/);
 assert.equal(page.links.find(l=>l.text==='FINAL_LISTING_1600').url,url+'last');assert.ok(page.links.some(l=>l.url===url+'shadow-listing'));
 assert.ok(!page.text.includes('MUST_NOT_LEAK'));assert.ok(!page.links.some(l=>l.url===url+'hidden'));assert.ok(!page.viewportText.includes('FINAL_LISTING_1600'));
 const found=await call('browser_search',{snapshotId:first.snapshot.id,query:'Invalidenstraße 12'});assert.ok(found.matches.length);
 const item=await call('record_automation_result',{key:url+'last',url:url+'last',title:'FINAL_LISTING_1600',summary:'Observed exact address: Invalidenstraße 12, 10115 Berlin. 120 m², 2 rooms, 2100 €.'});assert.equal(item.trial,true);
 await assert.rejects(call('browser_interact',{operation:'click',ref:page.clickTargets.find(c=>c.label==='Send message')?.targetId??'send'}),/taslak ayır/);assert.equal(submits,0);
 const lazyFirst=await call('browser_open',{url:url+'lazy'}),lazy=await pageOf(lazyFirst);assert.ok(!lazy.text.includes('LAZY_TAIL_LISTING'));
 assert.ok(lazy.scrollTargets.length);const scroll=await call('browser_interact',{operation:'scroll',ref:lazy.scrollTargets[0].controlId,direction:'down'});
 assert.equal(scroll.action.executed,true);
 const after=await pageOf(scroll);assert.match(after.text,/LAZY_TAIL_LISTING/);assert.equal(after.links.find(l=>l.text==='LAZY_TAIL_LISTING').url,url+'lazy-detail');
 await assert.rejects(call('browser_read_part',{snapshotId:lazyFirst.snapshot.id}),/eski/);
 const detail=await pageOf(await call('browser_open',{url:after.links.find(l=>l.text==='LAZY_TAIL_LISTING').url}));assert.match(detail.text,/LAZY_DETAIL/);
 assert.equal(submits,0);await call('finish_automation_run',{status:'completed',summary:'Read offscreen text and URLs, loaded another listing through a guarded scroll, and opened its actual detail link.'});assert.equal(db.get(a.id).trial.status,'passed');
 console.log('JEV_DOCUMENT_READING_PASS',JSON.stringify({textCharacters:page.text.length,links:page.links.length,maxBytes,recordedTail:true,lazyScroll:true,submits,directory}));
}finally{controller.abort();await browsers.close();store.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
