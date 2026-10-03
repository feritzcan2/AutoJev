import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';

const source='https://listings.test/results',next=source+'?page=3';
const details=Array.from({length:17},(_,i)=>'https://listings.test/detail/'+i);
function fixture(t,{recover=false}={}){
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store);
 const a=db.create('custom',{goal:'Find listings',criteria:{outcome:'List matches',rules:'Read only',completion:'All pages'},sources:[source]});
 db.review(a.id);db.skipTrial(a.id);db.enable(a.id);
 const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const run=db.begin(a.id,{kind:'run',taskId:task.id});let current=source,reopened=false,error=null;
 const calls=[],browser={async call(id,name,args){
  calls.push({name,args});if(error==='EMPTY_OBSERVATION')return {content:[{type:'text',text:'Chrome error page'}]};if(error)throw Error(error);
  if(args.url)current=args.url;if(name==='browser_reopen_readonly')reopened=true;
  const loading=current===next&&!(recover&&reopened),text=loading?'Search header':current===source?'Page 2 of 13 '+details.join(' ')+' '+next:'Actual listing';
  return {pageContext:{url:current,tabId:reopened?'recovery':'original'},readiness:{loading,reason:loading?'stream_pending':null},content:[{type:'text',text:'Page URL: '+current+'\n'+text}]};
 }};
 const flow=automationWorkflow({db,run,signal:{aborted:false},browser,report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
 const queue=(input,url=source)=>db.saveScanProgress(a.id,run.id,input,{url,text:''});
 return {db,id:a.id,run,calls,queue,call:(name,args={})=>flow.call(a.id,run.id,name,args),error:value=>{error=value;}};
}

test('unfinished source navigation rechecks the document and recovers in one fresh read tab',async t=>{
 const f=fixture(t,{recover:true}),page=await f.call('browser_open',{url:next});
 assert.equal(page.readiness.loading,false);assert.match(page.content[0].text,/Actual listing/);
 assert.equal(f.calls.filter(c=>c.name==='browser_reopen_readonly').length,1);
 assert.deepEqual(f.db.run(f.run.id).scanIssues,{});
 assert.equal(f.db.run(f.run.id).resumeContext.tabId,'recovery');
 assert.ok(!f.calls.some(c=>/click|type|submit|close/.test(c.name)),'Original tab and forms remain untouched');
});

test('a failed results page cannot abandon 17 reachable details, then retries only the saved remainder',async t=>{
 const f=fixture(t);await f.call('browser_open',{url:source});
 f.queue({pendingUrls:[...details,next],reason:'Process details then next page'});
 const failed=await f.call('browser_open',{url:next}),issue=failed.technicalIssue;
 assert.equal(issue.verified,true);assert.equal(issue.url,next);assert.match(failed.nextStep,/retry it later/);
 // The agent only reports the failure; the app decides it is technical.
 await assert.rejects(f.call('finish_automation_run',{status:'blocked',summary:'Page empty'}),/17 bekleyen/);
 await assert.rejects(f.call('finish_automation_run',{status:'completed',summary:'Done',scan:{complete:true,pendingUrls:[],reason:'Done',evidenceUrl:next}}),/Çözümlenmemiş/);
 for(const url of details){await f.call('browser_open',{url});await f.call('record_automation_result',{key:url,url,title:'Listing',summary:'Observed details'});}
 assert.deepEqual(f.db.scanQueue(f.id,f.run.id).pendingUrls,[next],'saved findings leave the queue');
 const result=await f.call('finish_automation_run',{status:'blocked',summary:'Only results page remains'});
 assert.equal(f.db.run(f.run.id).stop.kind,'technical');
 assert.equal(result.status,'interrupted');assert.equal(result.recovery.reason,'technical_page');
 assert.deepEqual(result.scan.pendingUrls,[next]);assert.equal(f.db.results(f.id,{all:true}).length,17);
 assert.notEqual(f.db.sources(f.id)[0].blocked,true);
 assert.equal(f.calls.filter(c=>c.name==='browser_reopen_readonly').length,1);
});

test('technical proof requires actual repeated transport errors and is invalidated after recovery',async t=>{
 const f=fixture(t);f.error('Connection closed');
 await assert.rejects(f.call('browser_open',{url:next}),/Page load failed/);
 let issue=f.db.run(f.run.id).scanIssues[next];assert.equal(issue.verified,false);
 await assert.rejects(f.call('finish_automation_run',{status:'failed',summary:'Disconnected'}),/Doğrulanmış/);
 await assert.rejects(f.call('browser_open',{url:next}),/Page load failed/);
 issue=f.db.run(f.run.id).scanIssues[next];assert.equal(issue.verified,true);assert.equal(issue.global,true);
 f.error(null);await f.call('browser_open',{url:source});
 await assert.rejects(f.call('finish_automation_run',{status:'failed',summary:'Old error'}),/Doğrulanmış/);
 f.error('Observed ref is stale');await assert.rejects(f.call('browser_open',{url:next}),/stale/);assert.deepEqual(f.db.run(f.run.id).scanIssues,{});
});

test('an explicitly empty but loaded page gets a fresh read; it does not produce invented failure evidence',async t=>{
 const f=fixture(t);await f.call('browser_open',{url:source});
 const result=await f.call('browser_read');
 assert.equal(result.technicalIssue,undefined);assert.equal(result.readiness.loading,false);
 assert.equal(f.calls.filter(c=>c.name==='browser_reopen_readonly').length,0);assert.deepEqual(f.db.run(f.run.id).scanIssues??{},{});
});

test('navigation context errors and missing observations retain the attempted page and stop a retry loop',async t=>{
 for(const missing of [false,true]){
  const f=fixture(t);await f.call('browser_open',{url:source});
  f.queue({pendingUrls:[next],reason:'Only the last results page remains'});
  f.error(missing?'EMPTY_OBSERVATION':'jsHandle.evaluate: Execution context was destroyed, most likely because of a navigation');
  await assert.rejects(f.call('browser_open',{url:next}),/Page load failed/);assert.equal(f.db.run(f.run.id).scanIssues[next].verified,false);
  await assert.rejects(f.call('browser_read'),/Page load failed/);assert.equal(f.db.run(f.run.id).scanIssues[next].verified,true);
  assert.equal(f.db.sources(f.id)[0].scanIssue.url,next,'Failure belongs to the attempted page, not the previous good page');
  await assert.rejects(f.call('browser_read'),/Tarama beklemeye alındı/);
  const run=f.db.run(f.run.id);
  assert.equal(run.status,'interrupted');assert.equal(run.recovery.reason,'technical_page');
  assert.deepEqual(run.scan.pendingUrls,[next]);assert.equal(run.scan.complete,false);
  const count=f.calls.length;await assert.rejects(f.call('browser_read'));assert.equal(f.calls.length,count);
 }
});

test('repeated page errors block further attempts to that URL but preserve reachable details',async t=>{
 const f=fixture(t);await f.call('browser_open',{url:source});
 f.queue({pendingUrls:[details[0],next],reason:'Read the detail and last results page'});
 f.error('net::ERR_HTTP2_PROTOCOL_ERROR');
 for(let i=0;i<3;i++)await assert.rejects(f.call('browser_open',{url:next}),/ERR_HTTP2/);
 assert.equal(f.db.run(f.run.id).status,'running');
 const count=f.calls.length;await assert.rejects(f.call('browser_open',{url:next}),/diğer bekleyen/i);assert.equal(f.calls.length,count);
 f.error(null);await f.call('browser_open',{url:details[0]});
 await f.call('record_automation_result',{key:details[0],url:details[0],title:'Listing',summary:'Observed details'});
 const result=await f.call('finish_automation_run',{status:'blocked',summary:'Last page unavailable'});
 assert.equal(result.status,'interrupted');assert.deepEqual(result.scan.pendingUrls,[next]);
});

test('a global disconnection pauses without dropping any pending details',async t=>{
 const f=fixture(t);await f.call('browser_open',{url:source});
 f.queue({pendingUrls:[...details,next],reason:'Read details and next page'});
 f.error('Connection closed');for(let i=0;i<3;i++)await assert.rejects(f.call('browser_open',{url:next}));
 assert.equal(f.db.run(f.run.id).status,'interrupted');assert.deepEqual(f.db.run(f.run.id).scan.pendingUrls,[...details,next]);
});
