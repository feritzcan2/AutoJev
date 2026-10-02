import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {bundledSources,catalogSources,loadSourceLibrary,importSourceLibrary} from '../app/source-library.mjs';
import {sourceScanScope} from '../app/source-scan.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {automationWorkflow,automationPrompt} from '../app/automation-worker.mjs';
import {reusableTemplate,automationTemplate} from '../app/automation-templates.mjs';
import {sourceToolContext} from '../app/source-tools.mjs';
import {recordSourceRead} from '../app/source-read.mjs';

function fixture(t){const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('job-search',{sources:[],goal:'Find developer roles',criteria:{preferences:'Berlin',ranking:'Role and location, 0–100'}});return {core,db,id:a.id};}
function beginTrial(db,id,url){const task=db.store.workspaces.tasks.enqueue(id,{operation:'trial',sourceUrl:url,sources:[url],lockKey:'source:'+url});return db.begin(id,{kind:'trial',taskId:task.id});}
const freehire=bundledSources.find(s=>s.tool==='freehire-search');
test('launch mentions CLI only when available and directs that source to use it',()=>{
 for(const kind of ['trial','run']){
  const run={kind,sourceUrl:freehire.url,browserMode:'jev'};
  const browser=automationPrompt(run);assert.doesNotMatch(browser,/CLI|sourceRead|assignedSource\.cli/);assert.match(browser,/Jev delegation is available/);
  const cli=automationPrompt({...run,sourceCliAvailable:true});assert.match(cli,/Use that CLI through your native terminal tool/);assert.doesNotMatch(cli,/Jev delegation is available|CLI or|may use.*CLI/);
 }
});
test('catalog import enriches old sources without overwriting personal settings; imports are atomic and repeatable',t=>{
 const {db,id}=fixture(t);db.addSource(id,{url:freehire.url,name:'My board',query:'My search',intervalMinutes:87,enabled:false});
 assert.deepEqual(importSourceLibrary(db,id,[freehire]),{added:0,enriched:1,skipped:0});
 const source=db.sources(id)[0];assert.equal(source.name,'My board');assert.equal(source.query,'My search');assert.equal(source.intervalMinutes,87);assert.equal(source.enabled,false);assert.equal(source.tool,'freehire-search');
 db.saveSource(id,freehire.url,{instructions:'My own method'});
 assert.deepEqual(importSourceLibrary(db,id,[freehire]),{added:0,enriched:0,skipped:1});assert.equal(db.sources(id)[0].instructions,'My own method');
 const newSource=bundledSources.find(s=>s.tool==='jobnet-search');
 assert.throws(()=>importSourceLibrary(db,id,[newSource,{name:'Unknown',url:'https://unknown.test/',tool:'future-tool'}]),/bulunamadı/);
 assert.equal(db.sources(id).length,1,'Failed import rolls back earlier additions');
 importSourceLibrary(db,id,[newSource]);assert.equal(db.sources(id)[1].query,'Find developer roles');assert.equal(db.sources(id)[1].enabled,true);
});
test('imported source and skill are independent copies, used by the agent and removable without deleting records',t=>{
 const {db,core,id}=fixture(t),other=db.create('job-search',{sources:[]}),entry=structuredClone(freehire);
 importSourceLibrary(db,id,[entry]);importSourceLibrary(db,other.id,[entry]);
 const original=db.sources(id)[0];assert.equal(original.skill,freehire.skill.trim());
 entry.name='Changed remote name';entry.instructions='Changed remote method';entry.skill='Changed remote skill';
 assert.equal(db.sources(id)[0].skill,original.skill);assert.equal(db.sources(id)[0].instructions,original.instructions);
 db.saveSource(id,entry.url,{name:'My copy',instructions:'My local method',skill:'My edited skill'});
 assert.equal(db.sources(other.id)[0].skill,original.skill);assert.equal(bundledSources.find(s=>s.url===entry.url).skill,freehire.skill);
 assert.deepEqual(importSourceLibrary(db,id,[entry]),{added:0,enriched:0,skipped:1});assert.equal(db.sources(id)[0].skill,'My edited skill');
 const exported=reusableTemplate({...automationTemplate('job-search'),defaultSources:db.sources(id)});assert.equal(exported.defaultSources[0].skill,'My edited skill');
 db.review(id);const run=beginTrial(db,id,entry.url),context=automationTaskContext(db,id,run);
 assert.equal(context.assignedSource.skill,'My edited skill');assert.equal(context.assignedSource.cli.guide,undefined,'No shared guide path remains');
 assert.throws(()=>db.removeSource(id,entry.url),/çalışan/);
 const record=db.record(id,run.id,{url:'https://employer.test/job/1',title:'Synthetic job',summary:'Saved finding'});db.finish(id,run.id,'interrupted','Done');
 const pending=core.workspaces.tasks.enqueue(id,{operation:'trial',sourceUrl:entry.url,sources:[entry.url],lockKey:'source:'+entry.url});
 db.removeSource(id,entry.url);assert.equal(db.sources(id).length,0);assert.equal(db.get(id).sourceSettings[entry.url],undefined);assert.equal(db.result(id,record.id).title,'Synthetic job');assert.equal(core.workspaces.tasks.get(id,pending.id).state,'cancelled');assert.equal(db.sources(other.id).length,1);
});
test('remote catalogs validate the whole list and expose unavailable tools without executing them',async()=>{
 const entries=await loadSourceLibrary('https://catalog.test/sources.json',{fetchImpl:async()=>Response.json([...bundledSources,{name:'Future',url:'https://new.test/',tool:'future-tool'}])});
 assert.equal(entries.length,7);assert.equal(entries.at(-1).toolAvailable,false);
 for(const source of [{url:'file:///secret'},{url:'https://a:b@example.test/'},{url:'https://example.test/',tool:'../../bad'},{url:'https://example.test/',instructions:'x'.repeat(6001)},{url:'https://example.test/',skill:'x'.repeat(60001)}])assert.throws(()=>catalogSources([source]));
 await assert.rejects(loadSourceLibrary('https://catalog.test/list',{fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))}),/1 MB/);
 await assert.rejects(loadSourceLibrary('https://catalog.test/list',{fetchImpl:async()=>new Response('',{status:404})}),/404/);
 assert.throws(()=>catalogSources([freehire,freehire]),/yinelenen/);
 const exported=reusableTemplate({...automationTemplate('job-search'),defaultSources:[freehire]});assert.equal(exported.defaultSources[0].instructions,freehire.instructions);assert.equal(exported.defaultSources[0].tool,freehire.tool);
});
test('method changes invalidate only the source trial and scope, and context exposes the CLI',t=>{
 const {db,id}=fixture(t);importSourceLibrary(db,id,[freehire,bundledSources[0]]);
 const a=db.get(id);db.put({...a,sourceState:Object.fromEntries(a.sources.map(url=>[url,{trial:{status:'passed',runId:'old'},scan:{pendingUrls:['https://jobs.test/1']}}]))});
 const before=db.get(id),other=before.sources[1],oldScope=sourceScanScope(before,freehire.url);
 db.saveSource(id,freehire.url,{instructions:'Use a different query strategy',skill:'Read this local skill'});
 assert.notEqual(sourceScanScope(db.get(id),freehire.url),oldScope);assert.equal(db.get(id).sourceState[freehire.url].trial,null);assert.deepEqual(db.get(id).sourceState[other],before.sourceState[other]);
 db.review(id);const run=beginTrial(db,id,freehire.url);
 const context=automationTaskContext(db,id,run);assert.equal(context.assignedSource.cli.available,true);assert.match(context.assignedSource.cli.command,/freehire-search\.mjs/);assert.equal(context.assignedSource.instructions,'Use a different query strategy');assert.equal(context.assignedSource.skill,'Read this local skill');
 assert.equal(sourceToolContext('missing').available,false);
 const win=sourceToolContext('jobnet-search',{platform:'win32',electron:true,executable:"C:\\Auto Jev's\\AutoJev.exe",directory:'C:\\tools',exists:()=>true});assert.match(win.command,/ELECTRON_RUN_AS_NODE/);assert.match(win.command,/Jev''s/);
});
test('CLI trial and multi-query scan finish without browser snapshots; remaining work and errors still block completion',async t=>{
 const {db,core,id}=fixture(t);importSourceLibrary(db,id,[freehire]);db.review(id);
 const workflow=run=>automationWorkflow({db,run,signal:{aborted:false},browser:{call:()=>{throw Error('Unexpected browser call');}},report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
 const sourceRead={url:freehire.url,command:'freehire-search search -q developer',summary:'Observed current JSON response: one job and its full description.'};
 let run=beginTrial(db,id,freehire.url),flow=workflow(run);
 await flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'Source CLI checked',sourceRead});
 assert.equal(db.sources(id)[0].trial.status,'passed');assert.equal(db.run(run.id).browserSteps,0);assert.equal(db.run(run.id).observations.length,0);
 db.enable(id);const task=core.workspaces.tasks.enqueue(id,{operation:'scan',sourceUrl:freehire.url,sources:[freehire.url],lockKey:'source:'+freehire.url});run=db.begin(id,{kind:'run',taskId:task.id});flow=workflow(run);
 const call=(name,args)=>flow.call(id,run.id,name,args),detail='https://employer.test/jobs/123';
 await call('save_scan_searches',{searches:[{id:'backend',label:'Backend Berlin'},{id:'frontend',label:'Frontend Berlin'}]});
 await call('save_scan_progress',{sourceRead,pendingUrls:[detail],reason:'Read this detail',cursor:'page=2'});
 await assert.rejects(call('complete_scan_search',{sourceRead,completion:'end'}),/bekleyen/);
 await call('record_automation_result',{key:detail,url:detail,title:'Developer',summary:'Full description from the CLI',score:83});
 await call('save_scan_progress',{sourceRead,pendingUrls:[],processedUrls:[detail],reason:'All results processed'});
 await call('complete_scan_search',{sourceRead,completion:'end'});
 const finish={status:'completed',summary:'All queries checked',sourceRead,scan:{complete:true,pendingUrls:[],reason:'Observed final API pages',evidenceUrl:freehire.url,completion:'end'}};
 await assert.rejects(call('finish_automation_run',finish),/aramalar/);
 await call('select_scan_search',{searchId:'frontend'});
 await assert.rejects(call('complete_scan_search',{sourceRead:{...sourceRead,error:true},completion:'end'}),/CLI hata/);
 await call('complete_scan_search',{sourceRead:{...sourceRead,summary:'Second query returned zero jobs, total=0.'},completion:'end'});
 await call('finish_automation_run',finish);assert.equal(db.run(run.id).status,'completed');assert.equal(db.run(run.id).browserSteps,0);assert.equal(db.results(id)[0].assessment.score,83);
});
test('CLI reports cannot certify a browser-only source',async t=>{
 const {db,id}=fixture(t);db.addSource(id,{url:'https://plain.test/'});db.review(id);
 const run=beginTrial(db,id,'https://plain.test/'),flow=automationWorkflow({db,run,signal:{aborted:false},browser:{},report:()=>{}});
 await assert.rejects(flow.call(id,run.id,'finish_automation_run',{status:'completed',summary:'Claimed',sourceRead:{url:'https://plain.test/',command:'anything',summary:'Claimed output'}}),/araç bağlı/);
});
test('a later CLI error prevents a successful trial and record tasks reject CLI source reports',t=>{
 const {db,id}=fixture(t);importSourceLibrary(db,id,[freehire]);db.review(id);
 const run=beginTrial(db,id,freehire.url),read={url:freehire.url,command:'source search',summary:'Current result'};
 recordSourceRead(db,id,run.id,read);recordSourceRead(db,id,run.id,{...read,error:true,summary:'HTTP 503'});
 db.finish(id,run.id,'completed','Claimed success');assert.equal(db.sources(id)[0].trial.status,'failed');
 const next=beginTrial(db,id,freehire.url);db.putRun({...next,recordId:'assigned-record'});
 assert.throws(()=>recordSourceRead(db,id,next.id,read),/araç bağlı/);
});
