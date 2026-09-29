import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {createServer} from 'node:http';
import {Store} from '../app/store.mjs';import {AutomationStore} from '../app/automation-store.mjs';import {BrowserTools} from '../app/browser.mjs';import {automationBrowser} from '../app/automation-browser.mjs';import {automationWorkflow} from '../app/automation-worker.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'loop-pagination-')),store=new Store(':memory:'),db=new AutomationStore(store);
const server=createServer((req,res)=>{const u=new URL(req.url,'http://localhost');res.setHeader('Content-Type','text/html');if(u.searchParams.get('page')==='2')return res.end('<h1>Amsterdam page two</h1><nav aria-label="Pagination"><button aria-current="page">2</button><button disabled>Volgende</button></nav>');res.end(`<!doctype html><h1>780 results</h1>${Array.from({length:17},(_,n)=>`<article style="height:340px"><a href="/home/${n}">Home ${n}</a></article>`).join('')}<div id="pager"></div><script>addEventListener('scroll',()=>{if(scrollY+innerHeight>=document.documentElement.scrollHeight-650&&!document.querySelector('nav')){document.querySelector('#pager').innerHTML='<nav aria-label="Pagination"><button aria-current="page">1</button><button id="next">Volgende</button></nav>';document.querySelector('#next').onclick=()=>{const next=new URL(location.href);next.searchParams.set('page','2');location.href=next;};}});</script>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/search?selected_area=amsterdam`;
const a=db.create('housing',{goal:'Read all results',criteria:{location:'Amsterdam',budget:'2000',requirements:'2 rooms'},sources:[url]});db.save(a.id,{browserMode:'jev'});db.review(a.id);const run=db.begin(a.id,'trial');
const browsers=new BrowserTools(directory,()=> 'jev',()=>({connection:'separate',headless:true,choose:()=>{throw Error('No model needed');}})),browser=automationBrowser(browsers,{mode:'jev',readTabKey:'read:main'});
const flow=automationWorkflow({db,run,signal:new AbortController().signal,browser,report:()=>{}}),call=(name,args={})=>flow.call(a.id,run.id,name,args);
try{
 let page=await call('browser_open',{url}),scrolls=0;
 while(!page.pageNavigation.pagination.some(p=>p.text==='Volgende'&&p.targetId)&&scrolls<15){
  const target=page.pageNavigation.scrollTargets.find(s=>!s.atBottom);assert.ok(target,'Do not invent pagination: there must be remaining observed scroll space');
  page=await call('browser_jev_scroll',{controlId:target.controlId,direction:'down'});scrolls++;
  if(scrolls===3){assert.ok(page.pageNavigation.scrollTargets[0].remainingDown>2500);assert.equal(page.pageNavigation.pagination.length,0);}
 }
 const next=page.pageNavigation.pagination.find(p=>p.text==='Volgende'&&p.targetId);assert.ok(next);assert.ok(scrolls>3);
 page=await call('browser_interact',{operation:'click',ref:next.targetId});assert.equal(new URL(page.url).searchParams.get('page'),'2');assert.equal(new URL(page.url).searchParams.get('selected_area'),'amsterdam');assert.equal(page.pageNavigation.pagination.find(p=>p.text==='Volgende').disabled,true);
 const {client}=await browsers.connect(a.id);assert.equal(client.automationTabs.size,1);
 console.log('PAGINATION_SMOKE_PASS',JSON.stringify({scrolls,url:page.url,singleTab:true,directory}));
}finally{await browsers.close();store.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
