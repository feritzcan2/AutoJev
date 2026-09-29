import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {BrowserSnapshot,BROWSER_RESPONSE_BYTES} from '../app/browser-snapshot.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {startMcp} from '../app/mcp.mjs';

// Optional reproduction using a provider's saved oversized tool result. Never
// copy a real page or personal browser data into repository test fixtures.
if(process.argv[2]){
 const saved=JSON.parse(await readFile(process.argv[2],'utf8')),reader=new BrowserSnapshot();
 let page=reader.capture(saved),recovered='',parts=0,maxBytes=0;
 do{parts++;maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(page)));recovered+=page.content.map(p=>p.text??'').join('\n');if(page.snapshot.nextOffset===null)break;page=reader.read({snapshotId:page.snapshot.id,offset:page.snapshot.nextOffset});}while(true);
 assert.equal(recovered,saved.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'));
 assert.ok(maxBytes<=BROWSER_RESPONSE_BYTES);
 console.log('CAPTURED_PAGE_PASS',JSON.stringify({characters:recovered.length,parts,maxBytes}));
}

const directory=await mkdtemp(path.join(tmpdir(),'loop-browser-snapshot-')),store=new Store(':memory:'),db=new AutomationStore(store);
let requests=0;
const server=createServer((req,res)=>{
 requests++;res.setHeader('Content-Type','text/html; charset=utf-8');
 res.end('<!doctype html><title>Large listing fixture</title><h1>Apartments</h1>'+Array.from({length:1600},(_,i)=>`<article><a href="/listing/${i}">Apartment ${i}: 2 rooms, 110 m², 1500 €</a><p>Local fixture listing description for ${i}. Actual links and complete listing text must remain readable.</p></article>`).join('')+'<article><a href="/last">TAIL_LISTING_1600: 120 m², 2 rooms</a></article>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/`;
const a=db.create('custom',{goal:'Read the last listing of a large page',sources:[url],criteria:{outcome:'Last listing',rules:'Read only',completion:'One scan'}});db.review(a.id);
const run=db.begin(a.id,'trial'),controller=new AbortController(),browser=new BrowserTools(directory,()=> 'separate');
const flow=automationWorkflow({db,run,signal:controller.signal,browser,report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
const mcp=await startMcp(store,()=>{},async()=>({}),null,null,flow),token=mcp.grant(a.id,run.id);let seq=0,maxBytes=0;
const call=async(name,args={})=>{
 const r=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method:'tools/call',params:{name,arguments:args}})}),rpc=await r.json();
 assert.equal(rpc.result?.isError,undefined,JSON.stringify(rpc));
 const result=JSON.parse(rpc.result.content[0].text),bytes=Buffer.byteLength(JSON.stringify(result));maxBytes=Math.max(bytes,maxBytes);assert.ok(bytes<=BROWSER_RESPONSE_BYTES);
 return result;
};
try{
 const first=await call('browser_open',{url});assert.ok(first.snapshot.totalCharacters>156000);assert.equal(first.snapshot.complete,false);
 const before=db.run(run.id),found=await call('browser_search',{snapshotId:first.snapshot.id,query:'TAIL_LISTING_1600'});
 assert.equal(found.matches.length,1);
 const tail=await call('browser_read_part',{snapshotId:first.snapshot.id,offset:found.matches[0].contextOffset});assert.match(tail.content[0].text,/\/last/);
 assert.deepEqual(db.run(run.id).observations,before.observations);assert.equal(db.run(run.id).browserSteps,before.browserSteps);
 const item=await call('record_automation_result',{key:url+'last',url:url+'last',title:'TAIL_LISTING_1600',summary:'Observed 120 m², 2 rooms at the bottom of the actual browser snapshot.'});assert.equal(item.trial,true);
 await call('finish_automation_run',{status:'completed',summary:'Read the source and saved its final listing through paged browser output.'});
 assert.equal(db.get(a.id).trial.status,'passed');
 console.log('LARGE_BROWSER_PAGE_PASS',JSON.stringify({snapshotCharacters:first.snapshot.totalCharacters,maxBytes,recordedTail:true,browserSteps:before.browserSteps,requests,directory}));
}finally{controller.abort();await mcp.close();await browser.close();store.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
