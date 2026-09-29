import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {BrowserTools} from '../app/browser.mjs';

const require=createRequire(import.meta.url),directory=await mkdtemp(path.join(tmpdir(),'loop-browse-'));
let sent=0;const requests=[];
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');requests.push(url.pathname+url.search);
 if(['/send','/signup','/pay'].includes(url.pathname))sent++;
 res.setHeader('Content-Type','text/html; charset=utf-8');
 if(url.pathname==='/framed'){res.end(`<h1>Framed cookie notice</h1><iframe title="Cookie consent" srcdoc="<div id='cookie-consent'><p>Cookie preferences</p><button onclick='frameElement.remove()'>Reject all</button></div>"></iframe>`);return;}
 res.end(`<!doctype html><title>Browsing fixture</title><style>body{font:16px sans-serif}input,select,button{padding:10px;margin:5px}dialog{position:fixed;inset:0;z-index:9;background:white}</style>
 <h1>Results page ${url.searchParams.get('page')??'1'}</h1>
 <form role="search" action="/list"><label>Search city<input name="query" type="search" value="${url.searchParams.get('query')??''}"></label><button>Search</button></form>
 <form id="search-filters" action="/list"><label>Rooms<select name="rooms"><option value="1">1 room</option><option value="2">2 rooms</option></select></label><button>Apply filters</button></form>
 <div id="location-filter"><label>Search region<input name="region" role="combobox" aria-autocomplete="list" aria-controls="regions"></label><div id="regions" role="listbox" hidden></div></div>
 <button onclick="location.href='/list?page=2'">Next page</button>
 <form action="/send" method="post"><label>Message<textarea name="message"></textarea></label><button>Send message</button></form>
 <form action="/signup" method="post"><label>Email<input type="email" name="email"></label><button>Create account</button></form>
 <form action="/pay" method="post"><button>Pay</button></form>
 <dialog id="cookie-consent"><p>Cookie preferences</p><button onclick="sessionStorage.setItem('cookies','rejected');this.closest('dialog').close()">Reject optional cookies</button></dialog>
 <script>if(!sessionStorage.getItem('cookies'))document.querySelector('dialog').showModal();
 const region=document.querySelector('[name=region]'),regions=document.querySelector('#regions');region.oninput=()=>{regions.innerHTML='<div role="option">Berlin Mitte</div>';regions.hidden=false;regions.firstChild.onclick=()=>{region.value='Berlin Mitte';regions.hidden=true}};</script>`);
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`,url=base+'/list';

class TestBrowsers extends BrowserTools{
 async open(id,mode,options){
  if(mode==='jev')return super.open(id,mode,options);
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(path.dirname(require.resolve('@playwright/mcp/package.json')),'cli.js'),'--browser','chrome','--headless','--isolated'],stderr:'pipe'});
  const client=new Client({name:'browsing-test',version:'1.0.0'});await client.connect(transport);
  return {client,tools:(await client.listTools()).tools,directory,workspace:directory};
 }
}
const pageOf=result=>JSON.parse(result.content.find(c=>c.type==='text').text.replace(/^Page URL: [^\n]+\n/,''));
try{
 for(const mode of ['jev','separate']){
  const store=new Store(':memory:'),db=new AutomationStore(store),browsers=new TestBrowsers(directory,()=>mode,()=>({connection:'separate',headless:true}));
  try{
   const a=db.create('housing',{goal:'Read listings',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[url]});db.save(a.id,{browserMode:mode,mode:'observe',maxBrowserSteps:50});db.review(a.id);
   const run=db.begin(a.id,'trial'),flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:automationBrowser(browsers,{mode}),report:()=>{}});
   const call=(name,args={})=>flow.call(a.id,run.id,name,args);let last=await call('browser_open',{url});
   const ref=(label,kind='click')=>{
    if(mode==='jev'){
     const page=pageOf(last),items=kind==='type'?page.fillFields:kind==='select'?page.controls:page.clickTargets;
     const found=items.find(x=>x.label===label);assert.ok(found,`${mode}: missing ${label}: ${JSON.stringify(items)}`);return found.targetId??found.fieldId??found.controlId;
    }
    const text=last.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'),line=text.split('\n').find(l=>l.includes('"'+label+'"')&&l.includes('[ref='));
    assert.ok(line,`${mode}: missing ${label}: ${text}`);return line.match(/\[ref=([^\]]+)/)[1];
   };
   const interact=async(operation,label,extra={})=>{last=await call('browser_interact',{operation,ref:ref(label,operation==='press'?'type':operation),...extra});};
   await interact('click','Reject optional cookies');
   await interact('type','Search city',{text:'Berlin'});
   await interact('press','Search city',{key:'Enter'});assert.ok(requests.includes('/list?query=Berlin'));
   await interact('select','Rooms',{text:'2'});await interact('click','Apply filters');assert.ok(requests.includes('/list?rooms=2'));
   if(mode==='jev'){
    last=await call('browser_interact',{operation:'autocomplete',ref:ref('Search region','select'),text:'Berlin'});
    assert.match(JSON.stringify(pageOf(last)),/Berlin Mitte/);
    last=await call('browser_interact',{operation:'autocomplete',ref:ref('Search region','select'),option:'Berlin Mitte'});
    assert.equal(pageOf(last).controls.find(c=>c.label==='Search region').value,'Berlin Mitte');
   }
   await interact('click','Next page');assert.match(last.url,/page=2/);
   // On this local fixture, even a send-labelled button works without a
   // result/proposal/reservation. The app no longer decides action authority.
   await interact('type','Message',{text:'Synthetic local message'});
   const before=sent;await interact('click','Send message');assert.equal(sent,before+1);
   assert.equal(db.results(a.id).length,0);assert.equal(db.run(run.id).actionId,null);
   last=await call('browser_open',{url:base+'/framed'});await interact('click','Reject all');
   console.log(`${mode}: cookies, search+Enter, filters, next page and local send passed without reservation`);
  }finally{await browsers.close();store.close();}
 }
 console.log('AUTOMATION_INTERACTIONS_PASS');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
