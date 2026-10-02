import test from 'node:test';
import assert from 'node:assert/strict';
import {recordReceipt,scanToolOutput,documentToolContent,taskContextOutput} from '../app/automation-tool-output.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow,automationTools} from '../app/automation-worker.mjs';
import {validate} from '../app/tool-schema.mjs';
import {AUTOMATION_CONTEXT_BYTES} from '../app/automation-context.mjs';
import {startTestServer} from './helpers/tool-server.mjs';

const source='https://jobs.example/results';
function fixture(t){
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());
 const db=new AutomationStore(store),a=db.create('custom',{goal:'Inspect all listings',criteria:Object.fromEntries(db.template('custom').fields.filter(f=>f.required).map(f=>[f.id,'Test criteria'])),sources:[source]});
 db.review(a.id);db.skipTrial(a.id);db.enable(a.id);
 const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const run=db.begin(a.id,{kind:'run',taskId:task.id}),urls=Array.from({length:135},(_,i)=>`https://jobs.example/listing/${i}`);
 const document={url:source,observationMode:'document',text:'cursor Ö / next\n'+urls.map(url=>`Link: Role — ${url}`).join('\n'),links:urls.map(url=>({text:'Role',url})),controls:[],clickTargets:[],scrollTargets:[],pagination:[]};
 const flow=automationWorkflow({db,run,signal:{aborted:false},browser:{call:async()=>({content:[{type:'text',text:`Page URL: ${source}\n`+JSON.stringify(document)}]})},report:()=>{}});
 return {store,db,id:a.id,run,urls,flow,call:(name,args={})=>flow.call(a.id,run.id,name,args)};
}
async function full(f,name,args){
 let value=await f.call(name,args);if(!value.context)return value;
 let text='';
 for(;;){
  assert.ok(Buffer.byteLength(JSON.stringify(value))<=AUTOMATION_CONTEXT_BYTES);text+=value.text;
  if(value.context.nextOffset===null)return JSON.parse(text);
  value=await f.call('read_automation_context_part',{contextId:value.context.id,offset:value.context.nextOffset});
 }
}

test('write receipts preserve protected state and review requirements without echoing the record',()=>{
 for(const status of ['prepared','executing','uncertain','completed','dismissed']){
  const record={id:'record',status,digest:'new',approvedDigest:'old',requiresReview:true,trial:false,proposal:'Exact consent: No. '.repeat(1000),evidence:'No confirmation. '.repeat(1000),legacyApplication:{proof:'Historical proof'},assessment:{status:'scored',score:63,revision:2,gaps:['Certificate missing'],uncertainties:['Salary unknown']}};
  const before=structuredClone(record),receipt=recordReceipt(record);
  for(const key of ['id','status','digest','approvedDigest','requiresReview','trial','assessment'])assert.deepEqual(receipt[key],record[key]);
  assert.equal(receipt.hasProposal,true);assert.equal(receipt.hasEvidence,true);
  assert.equal(receipt.proposal,undefined);assert.equal(receipt.evidence,undefined);assert.equal(receipt.legacyApplication,undefined);
  assert.match(receipt.detail,/full saved record.*before judging or acting/);assert.deepEqual(record,before);
  assert.ok(JSON.stringify(receipt).length<JSON.stringify(record).length*.05);
 }
});

test('actual writes return a receipt; exact large records remain readable and protected rediscovery preserves proof',async t=>{
 const f=fixture(t),input={key:f.urls[0],url:f.urls[0],title:'Role',summary:'Full requirements. '.repeat(300).trim()};
 const receipt=await f.call('record_automation_result',input),saved=f.db.result(f.id,receipt.id);
 assert.equal(receipt.status,'found');assert.equal(receipt.hasProposal,false);assert.equal(receipt.summary,undefined);
 assert.deepEqual(await full(f,'get_automation_result',{itemId:receipt.id}),saved);
 assert.equal(saved.summary,input.summary);
 const protectedRecord=f.db.putResult({...saved,status:'uncertain',proposal:'Exact draft and consent: No. '.repeat(400),evidence:'Ambiguous send; do not resubmit.',approvedDigest:saved.digest});
 const repeated=await f.call('record_automation_result',{...input,summary:'Replacement',proposal:'Replacement'});
 assert.equal(repeated.id,saved.id);assert.equal(repeated.status,'uncertain');assert.equal(repeated.hasEvidence,true);assert.equal(repeated.duplicate,true);assert.equal(repeated.hasProposal,true);
 assert.deepEqual(f.db.result(f.id,saved.id),protectedRecord);
 assert.deepEqual(await full(f,'get_automation_result',{itemId:saved.id}),protectedRecord);
});

test('scan output has one paged URL list, preserves exact cursors and never drops durable work',async t=>{
 const f=fixture(t);await f.call('save_scan_searches',{searches:[{id:'first',label:'First search'},{id:'other',label:'Other search'}]});
 const observed=await f.call('browser_open',{url:source});
 // Browser output omitted only the duplicate link index; queue writes still
 // preserve every URL and the exact reported continuation cursor.
 let output;
 for(let i=0;i<f.urls.length;i+=100)output=await f.call('save_scan_progress',{snapshotId:observed.snapshot.id,pendingUrls:f.urls.slice(i,i+100),reason:'Read every listing',cursor:'cursor Ö / next'});
 assert.equal(output.scanProgress.pendingCount,135);assert.equal(output.scanProgress.pendingUrls,undefined);
 assert.equal(output.scanPlan.checkpoint.cursor,'cursor Ö / next');assert.equal(output.scanPlan.checkpoint.pendingUrls,undefined);
 assert.equal(output.queue.checkpoint.pendingUrls,undefined);assert.equal(output.queue.pendingUrls.length,25);assert.equal(output.queue.nextOffset,25);
 const collected=[];let queue=output.queue;
 for(;;){collected.push(...queue.pendingUrls);if(queue.nextOffset===null)break;queue=await f.call('get_scan_queue',{searchId:'first',offset:queue.nextOffset});}
 assert.deepEqual(collected,f.urls);assert.equal((await f.call('get_scan_queue',{limit:100})).pendingUrls.length,100);
 assert.deepEqual(f.db.run(f.run.id).scan.pendingUrls,f.urls);
 const context=await full(f,'get_automation_context');
 assert.equal(context.scanProgress.pendingCount,135);assert.equal(context.scanProgress.pendingUrls,undefined);
 assert.equal(context.scanWork.queue.pendingUrls.length,25);assert.equal(context.scanPlan.checkpoint.pendingUrls,undefined);
 assert.equal(context.scanWork.searches.find(s=>s.id==='first').pendingCount,135);
 await f.call('select_scan_search',{searchId:'other'});
 assert.equal((await f.call('get_scan_queue')).total,0);assert.equal((await f.call('get_scan_queue',{searchId:'first'})).total,135);
 await f.call('save_scan_progress',{pendingUrls:['https://jobs.example/reported'],processedUrls:[f.urls[0]],reason:'Reported work for this search'});
 assert.deepEqual((await f.call('get_scan_queue')).pendingUrls,['https://jobs.example/reported']);
 assert.equal((await f.call('get_scan_queue',{searchId:'first'})).total,135,'Another search retains its own pending work');
});

test('scan projections preserve cutoff evidence and never mutate the source payload',()=>{
 const urls=['https://jobs.example/one'],checkpoint={url:source,pendingUrls:urls,cursor:'exact cursor',at:123},boundary={evidence:'All listed dates precede the cutoff',at:99};
 const value={scanProgress:{complete:false,pendingUrls:urls},scanPlan:{mode:'incremental',cutoffAt:99,boundary,checkpoint},queue:{searchId:'one',pendingUrls:urls,total:1,offset:0,nextOffset:null,checkpoint}},before=structuredClone(value);
 const output=scanToolOutput(value);assert.deepEqual(output.scanPlan.boundary,boundary);assert.equal(output.scanPlan.cutoffAt,99);assert.equal(output.scanProgress.complete,false);assert.deepEqual(value,before);
});

test('context reuse preserves exact rules and restores changed, missing or foreign versions',()=>{
 const value={automation:{id:'one',criteria:{location:'Berlin'},mode:'observe'},questions:[{answerValues:{consent:false},answer:'No'}],referenceData:{profile:{facts:'Exact multilingual fact 家😀'}},recordAuthorization:{directExecution:false},currentRun:{id:'first'},scanWork:{queue:{total:3}}};
 const first=taskContextOutput(value),knownVersions=first.contextReuse.versions;
 const schema=automationTools.find(t=>t.name==='get_automation_context').inputSchema;
 assert.doesNotThrow(()=>validate(schema,{knownVersions}));
 assert.throws(()=>validate(schema,{knownVersions:{foreign:'a'.repeat(64)}}));
 const resumed=taskContextOutput({...value,currentRun:{id:'second'}},knownVersions);
 assert.equal(resumed.automation,undefined);assert.equal(resumed.questions,undefined);assert.equal(resumed.currentRun.id,'second');assert.deepEqual(resumed.scanWork,value.scanWork);
 const merged={...first,...resumed};for(const key of Object.keys(value))assert.deepEqual(merged[key],key==='currentRun'?{id:'second'}:value[key]);
 const changed=taskContextOutput({...value,recordAuthorization:{directExecution:true}},knownVersions);
 assert.deepEqual(changed.recordAuthorization,{directExecution:true});assert.equal(changed.referenceData,undefined);
 assert.deepEqual(taskContextOutput(value).questions,value.questions,'fresh/compacted sessions get every exact answer');
 assert.deepEqual(taskContextOutput({...value,automation:{...value.automation,id:'other'}},knownVersions).questions,value.questions);
 assert.deepEqual(taskContextOutput({...value,questions:[]},knownVersions).questions,[],'deletions replace old context');
});

test('Jev queue summaries keep all work and explicit pages can recover every URL',async t=>{
 const f=fixture(t);f.db.put({...f.db.get(f.id),browserMode:'jev'});
 const observed=await f.call('browser_open',{url:source});
 for(let i=0;i<f.urls.length;i+=100)await f.call('save_scan_progress',{snapshotId:observed.snapshot.id,pendingUrls:f.urls.slice(i,i+100),reason:'Persist exact leads',cursor:'cursor Ö / next'});
 const summary=await f.call('get_scan_queue',{limit:100});assert.equal(summary.total,135);assert.equal(summary.pendingUrls,undefined);assert.equal(summary.checkpoint.cursor,'cursor Ö / next');
 const before=await full(f,'get_automation_context');assert.equal(before.scanWork.queue.pendingUrls,undefined);assert.equal(before.scanWork.queue.total,135);
 const resumed=await full(f,'get_automation_context',{knownVersions:before.contextReuse.versions});assert.equal(resumed.automation,undefined);assert.equal(resumed.currentRun.id,f.run.id);
 const urls=[];let offset=0;do{const page=await f.call('get_scan_queue',{view:'entries',offset,limit:20});urls.push(...page.pendingUrls);offset=page.nextOffset;}while(offset!==null);
 assert.deepEqual(urls,f.urls);assert.deepEqual(f.db.run(f.run.id).scan.pendingUrls,f.urls);
 const restored=await full(f,'get_automation_context');assert.deepEqual(restored.automation,before.automation);
});

test('context version acknowledgement passes the real MCP validator and returns only changed sections',async t=>{
 const f=fixture(t),initial=await full(f,'get_automation_context');
 const server=await startTestServer(f.store,f.flow);t.after(()=>server.close());const token=server.grant(f.id,f.run.id);
 const response=await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_automation_context',arguments:{knownVersions:initial.contextReuse.versions}}})});
 const result=(await response.json()).result;assert.ok(!result.isError,JSON.stringify(result));
 const value=JSON.parse(result.content[0].text);assert.ok(value.contextReuse.unchanged.includes('automation'));assert.equal(value.automation,undefined);assert.equal(value.currentRun.id,f.run.id);
});

test('browser output removes only an exact duplicate link index and preserves all actionable and visible state',()=>{
 const link={text:'Apply — consent stays No',url:'https://jobs.example/apply?x=1&y=2'};
 const page={observationMode:'document',text:`Exact salary €90,000\nLink: ${link.text} — ${link.url}\nNot submitted`,links:[link],viewportText:'Frame: Consent No',controls:[{controlId:'fresh',value:false}],clickTargets:[{targetId:'fresh-click'}],fillFields:[{fieldId:'fresh-fill',value:'No'}],uploads:[{uploadId:'fresh-upload'}],pagination:[{url:link.url,current:false}],reading:{readiness:{loading:true},unreadFrames:1},verified:false};
 const content=[{type:'text',text:'Page URL: '+source+'\n'+JSON.stringify(page)},{type:'image',data:'untouched'}],before=structuredClone(content);
 const result=documentToolContent(content),projected=JSON.parse(result[0].text.split('\n').slice(1).join('\n'));
 assert.equal(projected.links,undefined);assert.equal(projected.linksInText,true);
 for(const key of Object.keys(page).filter(key=>key!=='links'))assert.deepEqual(projected[key],page[key]);
 assert.deepEqual(result[1],content[1]);assert.deepEqual(content,before);
 for(const patch of [{text:'Missing the link'},{links:[{...link,rel:'next'}]},{links:[{...link,text:'Changed label'}]},{observationMode:'full'}]){
  const original=[{type:'text',text:JSON.stringify({...page,...patch})}];assert.deepEqual(documentToolContent(original),original);
 }
});
