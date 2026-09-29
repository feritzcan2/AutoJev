import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserSnapshot,BROWSER_RESPONSE_BYTES,browserSnapshotTools} from '../app/browser-snapshot.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {startMcp,validate} from '../app/mcp.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';

const url='https://homes.example/search';
const wireSize=result=>Buffer.byteLength(JSON.stringify(result),'utf8');
const textOf=result=>result.content.map(p=>p.text??'').join('\n');
const largePage=`### Page\n- Page URL: ${url}\n### Snapshot\n`+
 Array.from({length:1600},(_,i)=>`- link "Wohnung ${i}: 110 m², 2 Zimmer, 1500 €" [ref=e${i}]:\n  - /url: https://homes.example/listing/${i}\n`).join('')+
 '- link "SON İLAN: Şişli + Berlin [2]" [ref=final]:\n  - /url: https://homes.example/last\n';

test('a page larger than the reported failure is completely recoverable through bounded parts',()=>{
 assert.ok(largePage.length>156000);
 const reader=new BrowserSnapshot();let page=reader.capture({url,content:[{type:'text',text:largePage}]}),restored='';
 assert.equal(page.snapshot.complete,false);
 for(;;){
  assert.ok(wireSize(page)<=BROWSER_RESPONSE_BYTES);assert.equal(page.snapshot.offset,restored.length);
  restored+=textOf(page);
  if(page.snapshot.nextOffset===null)break;
  page=reader.read({snapshotId:page.snapshot.id,offset:page.snapshot.nextOffset});
 }
 assert.equal(restored,largePage);assert.match(restored,/https:\/\/homes.example\/last/);
});

test('literal search reaches tail results, preserves Unicode offsets, and paginates matches',()=>{
 const reader=new BrowserSnapshot(),page=reader.capture({url,content:[{type:'text',text:largePage}]}),snapshotId=page.snapshot.id;
 const found=reader.search({snapshotId,query:'Şişli + Berlin [2]'});
 assert.equal(found.matches.length,1);assert.equal(found.matches[0].offset,largePage.indexOf('Şişli + Berlin [2]'));
 assert.match(textOf(reader.read({snapshotId,offset:found.matches[0].contextOffset})),/homes.example\/last/);
 let offset=0,total=0;
 do{const result=reader.search({snapshotId,query:'WOHNUNG',offset});assert.ok(wireSize(result)<=BROWSER_RESPONSE_BYTES);total+=result.matches.length;offset=result.nextOffset;}while(offset!==null);
 assert.equal(total,1600);
 assert.equal(reader.search({snapshotId,query:'.*'}).matches.length,0);
 assert.equal(reader.search({snapshotId,query:'missing'}).nextOffset,null);
});

test('escaped and multi-byte single-line content obeys the serialized budget without losing text',()=>{
 for(const source of ['"\\\n\t'.repeat(12000),'\u0001'.repeat(40000),'房子🏠'.repeat(18000)]){
  const reader=new BrowserSnapshot();let result=reader.capture({url,content:[{type:'text',text:source}]}),restored='';
  do{assert.ok(wireSize(result)<=BROWSER_RESPONSE_BYTES);restored+=textOf(result);const offset=result.snapshot.nextOffset;if(offset===null)break;result=reader.read({snapshotId:result.snapshot.id,offset});}while(true);
  assert.equal(restored,source);
 }
});

test('small structured Jev replies remain intact; cache IDs and input bounds are enforced',()=>{
 const reader=new BrowserSnapshot(),content=[{type:'text',text:'Page URL: '+url+'\n'+JSON.stringify({url,controls:[{controlId:'c1',label:'Visit'}],decisionId:'decision-1'})}];
 const first=reader.capture({url,content});assert.deepEqual(first.content,content);assert.equal(first.snapshot.complete,true);
 const next=reader.capture({url,content});assert.throws(()=>reader.read({snapshotId:first.snapshot.id}),/eski/);
 assert.throws(()=>new BrowserSnapshot().read({snapshotId:next.snapshot.id}),/bu çalışmaya/);
 for(const args of [{offset:-1},{offset:1.5},{offset:1e9},{limit:0},{limit:8001}])assert.throws(()=>reader.read({snapshotId:next.snapshot.id,...args}),/aralığı/);
 for(const args of [{query:''},{query:'x'.repeat(201)},{query:'x',limit:6}])assert.throws(()=>reader.search({snapshotId:next.snapshot.id,...args}),/araması/);
 for(const tool of browserSnapshotTools)assert.throws(()=>validate(tool.inputSchema,{snapshotId:next.snapshot.id,query:'x',path:'/etc/passwd'}));
 reader.invalidate();assert.throws(()=>reader.search({snapshotId:next.snapshot.id,query:'Visit'}),/eski/);
});

function workflowFixture(t){
 const store=new Store(':memory:');t.after(()=>store.close());const db=new AutomationStore(store);
 const a=db.create('custom',{goal:'Find actual listings',sources:[url],criteria:{outcome:'Listings',rules:'Match facts',completion:'One scan'}});
 const run=db.begin(a.id,'interview'),controller=new AbortController();let calls=0,fail=false;
 const browser={async call(){calls++;if(fail)throw Error('Navigation failed');return {content:[{type:'text',text:largePage}]};}};
 const flow=automationWorkflow({db,run,signal:controller.signal,browser,report:()=>{}});
 return {store,db,a,run,controller,flow,call:(name,args={})=>flow.call(a.id,run.id,name,args),calls:()=>calls,fail:()=>{fail=true;}};
}

test('MCP returns small readable page parts and searches without spending browser steps or minting proof',async t=>{
 const f=workflowFixture(t),mcp=await startMcp(f.store,()=>{},async()=>({}),null,null,f.flow);t.after(()=>mcp.close());
 const token=mcp.grant(f.a.id,f.run.id);
 const rpc=async(name,args={})=>{
  const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  const raw=await response.text();assert.ok(Buffer.byteLength(raw)<BROWSER_RESPONSE_BYTES*2+1000);
  const result=JSON.parse(raw).result;assert.equal(result.isError,undefined,result.content?.[0]?.text);return JSON.parse(result.content[0].text);
 };
 const page=await rpc('research_automation_source',{url}),before=f.db.run(f.run.id),browserCalls=f.calls();
 const found=await rpc('browser_search',{snapshotId:page.snapshot.id,query:'SON İLAN'});
 const tail=await rpc('browser_read_part',{snapshotId:page.snapshot.id,offset:found.matches[0].contextOffset});
 assert.match(textOf(tail),/https:\/\/homes.example\/last/);assert.equal(f.calls(),browserCalls);
 assert.deepEqual(f.db.run(f.run.id).observations,before.observations);assert.equal(f.db.run(f.run.id).browserSteps,before.browserSteps);
 await f.call('browser_interact',{operation:'click',ref:'final'});assert.equal(f.calls(),browserCalls+3);await assert.rejects(f.call('browser_read_part',{snapshotId:page.snapshot.id}),/eski/);
 await assert.rejects(f.flow.call('other',f.run.id,'browser_read_part',{snapshotId:page.snapshot.id}),/geçersiz/);
 await assert.rejects(f.flow.call(f.a.id,'other','browser_search',{snapshotId:page.snapshot.id,query:'Wohnung'}),/geçersiz/);
 f.controller.abort();await assert.rejects(f.call('browser_read_part',{snapshotId:page.snapshot.id}),/geçersiz/);
});

test('new observations and failed navigation invalidate old parts; finished runs cannot read cached pages',async t=>{
 const f=workflowFixture(t),first=await f.call('research_automation_source',{url}),next=await f.call('browser_read');
 await assert.rejects(f.call('browser_search',{snapshotId:first.snapshot.id,query:'Wohnung'}),/eski/);
 f.fail();await assert.rejects(f.call('research_automation_source',{url}),/Navigation failed/);
 await assert.rejects(f.call('browser_read_part',{snapshotId:next.snapshot.id}),/eski/);
 f.db.finish(f.a.id,f.run.id,'completed','Done');await assert.rejects(f.call('browser_search',{snapshotId:next.snapshot.id,query:'Wohnung'}),/geçersiz/);
});

test('paged callers get complete approved snapshot artifacts; legacy limits and directory isolation remain',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'loop-snapshot-artifact-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const artifacts=path.join(directory,'artifacts'),file=path.join(artifacts,'snapshot.yml'),foreign=path.join(directory,'foreign.yml');
 await mkdir(artifacts);await writeFile(file,largePage);await writeFile(foreign,'PRIVATE_OTHER_WORKSPACE');
 const browser=new BrowserTools(directory,()=> 'separate');t.after(()=>browser.close());
 browser.connect=async()=>({directory,workspace:directory,tools:[{name:'browser_snapshot'}],client:{callTool:async()=>({content:[{type:'text',text:`Page URL: ${url}\n[Snapshot](${file})\n[Snapshot](${foreign})`}]})}});
 const legacy=await browser.call('workspace','browser_snapshot',{},'run');assert.equal(legacy.content.length,2);assert.equal(legacy.content[1].text.length,100000);
 const complete=await browser.call('workspace','browser_snapshot',{},'run',{completeSnapshot:true});assert.equal(complete.content.length,2);assert.equal(complete.content[1].text,largePage);
 assert.ok(!complete.content.some(p=>p.text.includes('PRIVATE_OTHER_WORKSPACE')));
});
