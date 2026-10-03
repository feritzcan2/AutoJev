import test from 'node:test';
import assert from 'node:assert/strict';
import {documentObservation,documentReadiness,waitForDocument} from '../app/jev-document.mjs';
import {runInNewContext} from 'node:vm';

function fixture(text,viewportText){
 const url='https://jobs.example/role',document={url,text,links:[{text:'Apply',url:url+'/apply'}],pagination:[],readiness:{loading:false,reason:null}};
 const slot={page:{evaluate:async()=>document,frames:()=>[{},{}]}};
 const value={url,text:viewportText,elements:[{index:1,label:'Apply'}],controls:[{controlId:'current-control',label:'Apply'}],clickTargets:[{targetId:'current-target',label:'Apply'}],fillFields:[{fieldId:'current-field',value:'No'}],scrollTargets:[{controlId:'current-scroll'}],uploads:[{uploadId:'current-upload'}],savedLogin:{ready:true},status:'uncertain',verified:false};
 return {slot,value,document};
}

test('document observations omit repeated prose while retaining exact text, links and current guarded action state',async()=>{
 const f=fixture('Senior Engineer\nSalary €100,000\nConsent: No\nMore below the fold','Senior  Engineer\nSalary €100,000\nConsent: No'),before=structuredClone(f.value);
 const result=await documentObservation(f.slot,f.value);
 assert.equal(result.text,f.document.text);assert.equal(result.viewportText,'');assert.equal(result.elements,undefined);
 assert.deepEqual(result.links,f.document.links);assert.equal(result.reading.unreadFrames,1);
 for(const key of ['controls','clickTargets','fillFields','scrollTargets','uploads','savedLogin','status','verified'])assert.deepEqual(result[key],f.value[key]);
 assert.deepEqual(f.value,before,'the browser snapshot remains intact for guarded actions');
});

test('viewport-only facts, frame content and changed consent wording remain verbatim',async()=>{
 for(const viewport of ['Senior Engineer\nForm answer: No','Senior Engineer\nFrame: Application submitted','Consent: Yes','Salary €10,000']){
  const f=fixture('Senior Engineer\nSalary €100,000\nConsent: No',viewport);
  assert.equal((await documentObservation(f.slot,f.value)).viewportText,viewport);
 }
 const f=fixture('','Frame: Not submitted');delete f.value.controls;
 const result=await documentObservation(f.slot,f.value);assert.deepEqual(result.elements,f.value.elements);assert.equal(result.viewportText,f.value.text);
});

test('document reading refuses a redirect rather than combining stale action IDs with another page',async()=>{
 const f=fixture('Role','Role');f.document.url='https://other.example/';
 await assert.rejects(documentObservation(f.slot,f.value),/yönlendi/);
});

test('only visible substantive or unreadable frames count as missing document content',async()=>{
 const f=fixture('Job description','Job description');let disposed=0;
 const frame=(visible,width,height)=>({frameElement:async()=>({evaluate:async fn=>fn({checkVisibility:()=>visible,getBoundingClientRect:()=>({width,height})}),dispose:async()=>{disposed++;}})});
 f.slot.page.frames=()=>[{},frame(false,600,400),frame(true,1,1),frame(true,600,400),{frameElement:async()=>{throw Error('Detached');}}];
 const result=await documentObservation(f.slot,f.value);
 assert.equal(result.reading.unreadFrames,2);assert.equal(disposed,3);assert.equal(result.text,'Job description');
});

test('pagination joins current guarded actions by DOM identity, not identical labels',async()=>{
 const f=fixture('Page 2','Page 2');f.slot.owner='worker';
 f.document.pagination=[{text:'Next',node:2,url:null},{text:'Next',node:3,url:null},{text:'Other worker',node:4},{text:'Expired',node:5}];
 f.slot.clickTargets=new Map([['next',{owner:'worker',action:{node:2}}],['foreign',{owner:'other',action:{node:4}}],['expired',{owner:'worker',action:{node:5}}]]);
 f.slot.controls=new Map([['reveal',{owner:'worker',kind:'control',node:3}]]);
 f.value.clickTargets=[{targetId:'next',label:'Next'},{targetId:'foreign',label:'Other worker'}];f.value.controls=[{controlId:'reveal'}];
 const {pagination}=await documentObservation(f.slot,f.value);
 assert.equal(pagination[0].targetId,'next');assert.equal(pagination[1].controlId,'reveal');
 assert.equal(pagination[1].targetId,undefined);assert.equal(pagination[2].targetId,undefined);assert.equal(pagination[3].targetId,undefined);
 assert.ok(pagination.every(p=>!('node' in p)));
});


test('rendering signals work independently of site, route, language or description markup',()=>{
 const selectors=new Map(),body={querySelector:s=>selectors.get(s)?.[0],querySelectorAll:s=>selectors.get(s)??[]};
 const env={location:{href:''},document:{readyState:'complete',body}};
 const read=()=>runInNewContext('('+documentReadiness.toString()+')()',env);
 const element=visible=>({closest:()=>false,checkVisibility:()=>visible});
 for(const url of ['https://a.test/123','https://b.test/offers/a-title','https://c.test/?item=abc','https://d.test/#/detail/1']){
  env.location.href=url;selectors.clear();
  assert.equal(read().loading,false,'transport readiness alone does not certify substantive content');
  env.document.readyState='loading';assert.equal(read().reason,'document_loading');env.document.readyState='complete';
  selectors.set('[aria-busy="true"]',[element(false)]);assert.equal(read().loading,false);
  selectors.set('[aria-busy="true"]',[element(true)]);assert.equal(read().reason,'aria_busy');
  selectors.clear();selectors.set('[hidden][id^="S:"]',[{}]);assert.equal(read().reason,'stream_pending');
 }
 env.document.body=null;assert.equal(read().reason,'document_loading');
});

test('document waits are bounded, poll without reopening and avoid a second immediate timeout',async()=>{
 let time=0,reads=0,loading=true;
 const slot={page:{evaluate:async()=>{reads++;return {url:'https://example.test',loading,reason:loading?'aria_busy':null};}}};
 const options={attempts:4,delay:250,now:()=>time,wait:async ms=>{time+=ms;}};
 assert.equal((await waitForDocument(slot,options)).timedOut,true);assert.equal(reads,4);assert.equal(time,750);
 assert.equal((await waitForDocument(slot,options)).timedOut,true);assert.equal(reads,5);assert.equal(time,750);
 loading=false;assert.equal((await waitForDocument(slot,options)).loading,false);assert.equal(slot.documentWait,null);
 loading=true;slot.page.evaluate=async()=>({url:'https://other.test',loading:++reads<9});
 assert.equal((await waitForDocument(slot,options)).loading,false);assert.equal(time,1250);
});

test('document observation preserves new busy state and refuses readiness from a different page',async()=>{
 const f=fixture('Original text','Original text');
 f.document.readiness={loading:true,reason:'aria_busy'};
 f.slot.page.evaluate=async fn=>fn===documentReadiness?{url:f.value.url,loading:false}:f.document;
 assert.equal((await documentObservation(f.slot,f.value)).reading.readiness.loading,true);
 f.slot.page.evaluate=async fn=>fn===documentReadiness?{url:'https://different.test',loading:false}:f.document;
 await assert.rejects(documentObservation(f.slot,f.value),/yönlendi/);
});

test('background rendering is scoped to the pending document and restored on timeout, failure or cancellation',async()=>{
 for(const outcome of ['ready','timeout','failure','abort']){
  const commands=[],controller=new AbortController();let reads=0;
  const slot={page:{evaluate:async()=>{
   if(++reads===2&&outcome==='failure')throw Error('Read failed');
   return {url:'https://example.test/task',loading:outcome!=='ready'||reads===1,reason:'stream_pending',hidden:true};
  }},cdp:{send:async(method,args)=>{commands.push([method,args.enabled]);}}};
  const waiting=waitForDocument(slot,{signal:controller.signal,attempts:3,delay:1,wait:async()=>{if(outcome==='abort')controller.abort();}});
  if(outcome==='failure')await assert.rejects(waiting,/Read failed/);
  else if(outcome==='abort')await assert.rejects(waiting,{name:'AbortError'});
  else assert.equal((await waiting).loading,outcome==='timeout');
  assert.deepEqual(commands,[['Emulation.setFocusEmulationEnabled',true],['Emulation.setFocusEmulationEnabled',false]]);
 }
});

test('ready or foreground documents need no emulation, and abort interrupts a long polling delay',async()=>{
 for(const state of [{loading:false,hidden:true},{loading:true,hidden:false}]){
  const slot={page:{evaluate:async()=>({url:'https://example.test',...state})},cdp:{send:async()=>assert.fail('No emulation needed')}};
  await waitForDocument(slot,{attempts:1});
 }
 const controller=new AbortController();let release;
 const started=new Promise(resolve=>release=resolve);
 const slot={page:{evaluate:async()=>{release();return {url:'https://example.test',loading:true,hidden:false};}}};
 const pending=waitForDocument(slot,{signal:controller.signal,delay:60000});
 await started;controller.abort();await assert.rejects(pending,{name:'AbortError'});
});

test('offscreen pagination uses only its current owner-bound scroll ancestor',async()=>{
 const f=fixture('Page 1/40','Page 1/40');f.slot.owner='worker';
 f.document.pagination=[{text:'Sonraki sayfayı görüntüle',scrollNode:7},{text:'Other',scrollNode:8},{text:'Expired',scrollNode:9}];
 f.slot.controls=new Map([['list',{owner:'worker',kind:'scroll',node:7}],['foreign',{owner:'other',kind:'scroll',node:8}],['expired',{owner:'worker',kind:'scroll',node:9}]]);
 f.value.scrollTargets=[{controlId:'list'},{controlId:'foreign'}];
 const {pagination}=await documentObservation(f.slot,f.value);
 assert.equal(pagination[0].scrollControlId,'list');assert.equal(pagination[1].scrollControlId,undefined);assert.equal(pagination[2].scrollControlId,undefined);
 assert.ok(pagination.every(p=>!('scrollNode' in p)));
});
