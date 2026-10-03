import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow,automationPrompt} from '../app/automation-worker.mjs';
import {continueSourceRun} from '../app/automation-recovery.mjs';
import {SOURCE_PAGE_INSTRUCTIONS,SOURCE_SCAN_INSTRUCTIONS} from '../app/source-scan.mjs';
import {webAgentProfile} from '../app/automation-agent-profiles.mjs';

const source='https://listings.example/search';
test('production launches and continuations require processing each page; trials and record tasks keep their scope',()=>{
 const run={kind:'run',sourceUrl:source};
 assert.ok(automationPrompt(run).includes(SOURCE_PAGE_INSTRUCTIONS));
 assert.ok(!automationPrompt({...run,kind:'trial'}).includes(SOURCE_PAGE_INSTRUCTIONS));
 assert.ok(!automationPrompt({...run,recordId:'one',recordOperation:'score'}).includes(SOURCE_PAGE_INSTRUCTIONS));
 assert.ok(SOURCE_SCAN_INSTRUCTIONS.startsWith(SOURCE_PAGE_INSTRUCTIONS));
 for(const name of ['save_scan_progress','report_scan_page','save_scan_searches','select_scan_search','lookup_scan_results','recheck_scan_page'])assert.ok(!SOURCE_SCAN_INSTRUCTIONS.includes(name),name);
 assert.doesNotMatch(webAgentProfile('run',{}).instructions,/Use the managed browser to search the assigned source/);
});

test('page findings and remaining details survive restart; saved findings leave the Jev-maintained queue',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'source-page-processing-')),file=path.join(directory,'state.sqlite');
 let store=new WorkspaceDatabase(file),db=new AutomationStore(store);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const a=db.create('job-search',{sources:[],goal:'Find relevant roles',criteria:{preferences:'Berlin',ranking:'Role and location'}}),id=a.id;
 db.addSource(id,{url:source,instructions:'Search with the saved criteria',skill:''});
 db.review(id);db.skipTrial(id);db.enable(id);
 const task=store.workspaces.tasks.enqueue(id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 let run=db.begin(id,{kind:'run',taskId:task.id});
 const workflow=()=>automationWorkflow({db,run,signal:{aborted:false},browser:{call:()=>{throw Error('Queue work must not need a browser');}},report:()=>{}});
 let flow=workflow();const call=(name,args={})=>flow.call(id,run.id,name,args);
 const fullContext=async()=>{
  let part=await call('get_automation_context'),text='';if(!part.context)return part;
  for(;;){text+=part.text;if(part.context.nextOffset===null)return JSON.parse(text);part=await call('read_automation_context_part',{contextId:part.context.id,offset:part.context.nextOffset});}
 };
 const context=await fullContext();assert.equal(context.assignedSource.cli,undefined);assert.equal(context.scanInstructions,SOURCE_SCAN_INSTRUCTIONS);
 assert.ok(continueSourceRun(db,id,run.id).includes(SOURCE_PAGE_INSTRUCTIONS));
 const savedUrl='https://employer.example/listing/1',remainingUrl='https://employer.example/listing/3',cursor='offset=3';
 // Jev's scan_results checkpoint fills the queue; the agent has no progress tool.
 db.saveScanProgress(id,run.id,{pendingUrls:[savedUrl,remainingUrl],cursor,reason:'Jev found two listings'},{url:source,text:''});
 const queueBefore=await call('get_scan_queue',{view:'entries'});assert.deepEqual(queueBefore.pendingUrls,[savedUrl,remainingUrl]);
 const summary=await call('get_scan_queue');assert.equal(summary.pendingUrls,undefined);assert.equal(summary.total,2);assert.match(summary.delegation,/collect_details/);
 const finding={key:savedUrl,url:savedUrl,title:'Developer',summary:'Observed full description in Berlin',score:67};
 const receipt=await call('record_automation_result',finding);
 assert.deepEqual((await call('get_scan_queue',{view:'entries'})).pendingUrls,[remainingUrl],'a saved finding retires its URL');
 assert.equal(db.results(id).length,1);
 const planId=db.run(run.id).scanPlan.id;
 db.finish(id,run.id,'interrupted','Synthetic interruption after a partial page');
 store.close();store=new WorkspaceDatabase(file);db=new AutomationStore(store);
 store.workspaces.tasks.put({...store.workspaces.tasks.get(id,task.id),state:'pending',workerId:null});
 run=db.begin(id,{kind:'run',taskId:task.id});flow=workflow();
 const queue=await call('get_scan_queue',{view:'entries'});
 assert.deepEqual(queue.pendingUrls,[remainingUrl]);assert.equal(queue.checkpoint.cursor,cursor);assert.equal(queue.processedCount,1);
 assert.equal(db.run(run.id).scanPlan.id,planId);assert.equal(db.result(id,receipt.id).assessment.score,67);
 const duplicate=await call('record_automation_result',finding);assert.equal(duplicate.id,receipt.id);assert.equal(db.results(id).length,1);
 await assert.rejects(call('complete_scan_search',{completion:'end'}),/bekleyen|gözle/);
 await call('record_automation_result',{...finding,key:remainingUrl,url:remainingUrl,title:'Another relevant role'});
 assert.equal((await call('get_scan_queue')).total,0);assert.equal(db.results(id).length,2);
 assert.equal(db.run(run.id).browserSteps,0);
});
