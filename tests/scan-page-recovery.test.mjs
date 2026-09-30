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
 db.save(a.id,{browserMode:'jev'});db.review(a.id);db.skipTrial(a.id);db.enable(a.id);
 const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const run=db.begin(a.id,{kind:'run',taskId:task.id});let current=source,reopened=false,error=null;
 const calls=[],browser={async call(id,name,args){
  calls.push({name,args});if(error)throw Error(error);
  if(args.url)current=args.url;if(name==='browser_reopen_readonly')reopened=true;
  const loading=current===next&&!(recover&&reopened),text=loading?'Search header':current===source?'Page 2 of 13 '+details.join(' ')+' '+next:'Actual listing';
  return {pageContext:{url:current,tabId:reopened?'recovery':'original'},readiness:{loading,reason:loading?'stream_pending':null},content:[{type:'text',text:'Page URL: '+current+'\n'+text}]};
 }};
 const flow=automationWorkflow({db,run,signal:{aborted:false},browser,report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
 return {db,id:a.id,run,calls,call:(name,args={})=>flow.call(a.id,run.id,name,args),error:value=>{error=value;}};
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
 const f=fixture(t),page=await f.call('browser_open',{url:source});
 await f.call('save_scan_progress',{snapshotId:page.snapshot.id,pendingUrls:[...details,next],reason:'Process details then next page'});
 const failed=await f.call('browser_open',{url:next}),issue=failed.technicalIssue;
 assert.equal(issue.verified,true);assert.equal(issue.url,next);
 const stop={kind:'technical',evidence:'Rendering stayed pending in fresh tab',issueIds:[issue.id]};
 await assert.rejects(f.call('finish_automation_run',{status:'blocked',stop,summary:'Page empty'}),/17 bekleyen/);
 await assert.rejects(f.call('finish_automation_run',{status:'completed',summary:'Done',scan:{complete:true,pendingUrls:[],reason:'Done',evidenceUrl:next}}),/Çözümlenmemiş/);
 let observed;
 for(const url of details){observed=await f.call('browser_open',{url});await f.call('record_automation_result',{key:url,url,title:'Listing',summary:'Observed details'});}
 await f.call('save_scan_progress',{snapshotId:observed.snapshot.id,pendingUrls:[next],reason:'All 17 details processed; retry results page'});
 const result=await f.call('finish_automation_run',{status:'blocked',stop,summary:'Only results page remains'});
 assert.equal(result.status,'interrupted');assert.equal(result.recovery.reason,'technical_page');
 assert.deepEqual(result.scan.pendingUrls,[next]);assert.equal(f.db.results(f.id,{all:true}).length,17);
 assert.notEqual(f.db.sources(f.id)[0].blocked,true);
 assert.equal(f.calls.filter(c=>c.name==='browser_reopen_readonly').length,1);
});

test('technical proof requires actual repeated transport errors and is invalidated after recovery',async t=>{
 const f=fixture(t);f.error('Connection closed');
 await assert.rejects(f.call('browser_open',{url:next}),/verified: false/);
 let issue=f.db.run(f.run.id).scanIssues[next];
 await assert.rejects(f.call('finish_automation_run',{status:'failed',summary:'Disconnected',stop:{kind:'technical',evidence:'Disconnected',issueIds:[issue.id]}}),/doğrulanmış/);
 await assert.rejects(f.call('browser_open',{url:next}),/verified: true/);
 issue=f.db.run(f.run.id).scanIssues[next];assert.equal(issue.global,true);
 f.error(null);await f.call('browser_open',{url:source});
 await assert.rejects(f.call('finish_automation_run',{status:'failed',summary:'Old error',stop:{kind:'technical',evidence:'Old error',issueIds:[issue.id]}}),/doğrulanmış/);
 f.error('Observed ref is stale');await assert.rejects(f.call('browser_open',{url:next}),/stale/);assert.deepEqual(f.db.run(f.run.id).scanIssues,{});
});

test('an explicitly empty but loaded page gets a fresh read; it does not produce invented failure evidence',async t=>{
 const f=fixture(t),page=await f.call('browser_open',{url:source});
 const result=await f.call('recheck_scan_page',{snapshotId:page.snapshot.id});
 assert.equal(result.technicalIssue,undefined);assert.equal(result.readiness.loading,false);
 assert.equal(f.calls.filter(c=>c.name==='browser_reopen_readonly').length,1);
});
