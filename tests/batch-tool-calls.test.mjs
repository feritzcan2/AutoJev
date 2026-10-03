import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';

const url='https://example.test/list',one=url+'/one',two=url+'/two';
const answer=(choice,criteria,confidence=1)=>({choice,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===choice?1:0]))});
function fixture(t){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);t.after(()=>core.close());
 const a=db.create('housing',{goal:'Berlin homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[url]});db.save(a.id,{browserMode:'jev'});db.review(a.id);
 const task=core.workspaces.tasks.enqueue(a.id,{operation:'scan',capability:'browser.observe',sourceUrl:url,sources:[url],lockKey:'source:'+url}),run=db.begin(a.id,{kind:'run',taskId:task.id});
 const browser={call:async(_,name,args)=>{
  const page=args.url===url?{url,title:'Results',text:'Exact original results',links:[{url:one,text:'Home one'},{url:two,text:'Home two'}],pagination:[{text:'1 of 1',url}]}:{url:args.url,title:'Individual home',text:'Link: Startseite — https://example.test/\nFull original detail\nLink: Bewerben — https://example.test/apply'};
  return {jevPage:page,pageContext:{url:page.url,tabId:'owned'},content:[{type:'text',text:'Page URL: '+page.url+'\n'+JSON.stringify(page)}]};
 },evaluateJev:async(_,state,questions)=>({answers:Object.fromEntries(Object.entries(questions).map(([key,q])=>[key,answer(key==='next'?'end':key==='fit'?'possible':'listing',q.criteria)]))})};
 const flow=automationWorkflow({db,run,signal:new AbortController().signal,browser,report:()=>{}});
 return {core,db,a,run,flow,call:(name,args)=>flow.call(a.id,run.id,name,args)};
}

test('a source scan saves several findings in one call and reports failed entries by index',async t=>{
 const f=fixture(t);
 const scan=await f.call('browser_jev_run',{operation:'scan_results',url});assert.equal(scan.status,'completed');
 await f.call('browser_jev_run',{operation:'collect_details',fromTaskId:scan.taskId});
 assert.deepEqual(new Set(f.db.scanQueue(f.a.id,f.run.id).pendingUrls),new Set([one,two]));
 const result=await f.call('record_automation_results',{records:[
  {url:one,title:'Home one',summary:'Observed'},
  {url:two,title:'Home two',summary:'Observed',score:70,assessment:{score:70}}
 ]});
 assert.equal(result.saved,1);assert.equal(result.records[0].url,one);assert.ok(result.records[0].detail,'entries are receipts, not full records');
 assert.equal(result.failed.length,1);assert.equal(result.failed[0].index,1);assert.match(result.failed[0].error,/assessment/);
 assert.deepEqual(f.db.scanQueue(f.a.id,f.run.id).pendingUrls,[two],'a saved finding leaves the pending queue');
 await assert.rejects(f.call('record_automation_results',{records:[{url:two,title:'Home two',summary:'x',score:70,assessment:{score:70}}]}),/arguments\.records\[0\]/);
 assert.equal(f.db.results(f.a.id).length,1);
});

test('read_jev_brief returns several briefs in one call and rejects mixed selectors',async t=>{
 const f=fixture(t);
 const scan=await f.call('browser_jev_run',{operation:'scan_results',url});
 const details=await f.call('browser_jev_run',{operation:'collect_details',fromTaskId:scan.taskId});
 const index=await f.call('read_jev_task',{taskId:details.taskId}),ids=index.items.map(i=>i.evidenceId);
 assert.equal(ids.length,2);
 const batch=await f.call('read_jev_brief',{evidenceIds:ids});
 assert.deepEqual(batch.briefs.map(b=>b.evidenceId),ids);assert.ok(batch.briefs.every(b=>b.status==='ready'&&b.sections.length));
 for(const b of batch.briefs){assert.equal(b.next,undefined,'the batch carries one hint');for(const s of b.sections){assert.doesNotMatch(s.text,/^Link: /m);assert.equal(s.linksOmitted,2);assert.equal(s.text.trim(),'Full original detail');}}
 assert.ok(batch.next.includes('status=running'));
 const single=await f.call('read_jev_brief',{evidenceId:ids[0]});assert.equal(single.status,'ready');assert.equal(single.evidenceId,ids[0]);assert.doesNotMatch(single.sections[0].text,/Link: /);assert.ok(single.next);
 await assert.rejects(f.call('read_jev_brief',{evidenceId:ids[0],evidenceIds:ids}),/not both/);
 await assert.rejects(f.call('read_jev_brief',{}),/evidenceId/);
 const mixed=await f.call('read_jev_brief',{evidenceIds:[ids[0],'missing-evidence']});
 assert.equal(mixed.briefs[0].status,'ready');assert.equal(mixed.briefs[1].status,'error');
 await assert.rejects(f.call('read_jev_brief',{evidenceIds:['missing-a','missing-b']}));
});

test('source scans do not list tools that only record operations can use',t=>{
 const f=fixture(t),names=f.flow.tools.map(x=>x.name);
 for(const name of ['browser_jev_inspect_form','reserve_automation_action','browser_upload_document','record_automation_outcome','get_workspace_history','configure_workspace_table'])assert.ok(!names.includes(name),name);
 assert.ok(names.includes('record_automation_results'));
 const batch=f.flow.tools.find(x=>x.name==='record_automation_results').inputSchema.properties.records.items,single=f.flow.tools.find(x=>x.name==='record_automation_result').inputSchema;
 assert.deepEqual(batch,single,'batch entries follow the single-record schema of this run');
 const recordFlow=automationWorkflow({db:f.db,run:f.db.putRun({...f.run,recordId:'record',recordOperation:'prepare'}),signal:new AbortController().signal,browser:{},report:()=>{}}),recordNames=recordFlow.tools.map(x=>x.name);
 for(const name of ['browser_jev_inspect_form','reserve_automation_action','record_automation_outcome'])assert.ok(recordNames.includes(name),name);
 assert.ok(!recordNames.includes('record_automation_results'));
});

import {jevTaskSummary} from '../app/jev-tasks.mjs';
import {JEV_CLASSIFICATION_VERSION} from '../app/jev-triage.mjs';
test('a review pause lists its whole batch in one read',()=>{
 const urls=Array.from({length:20},(_,n)=>'https://example.test/'+n);
 const task={id:'task',input:{operation:'collect_details'},status:'needs_agent',classificationVersion:JEV_CLASSIFICATION_VERSION,items:urls.map(url=>({url,title:'Role',evidenceId:'e'+url.at(-1),collected:true,assessment:{decision:'possible',confidence:.6}})),answers:{},batch:{id:'batch',urls}};
 const page=jevTaskSummary(task,{});
 assert.equal(page.items.length,20);assert.equal(page.nextOffset,null);assert.deepEqual(page.items.map(i=>i.item).slice(0,3),[1,2,3]);
 assert.equal(jevTaskSummary(task,{limit:100}).items.length,20,'the cap stays at 20');
});
