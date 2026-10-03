import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {bundledSources,catalogSources,loadSourceLibrary,importSourceLibrary} from '../app/source-library.mjs';
import {sourceScanScope} from '../app/source-scan.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {automationPrompt} from '../app/automation-worker.mjs';
import {reusableTemplate,automationTemplate} from '../app/automation-templates.mjs';

function fixture(t){const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('job-search',{sources:[],goal:'Find developer roles',criteria:{preferences:'Berlin',ranking:'Role and location, 0–100'}});return {core,db,id:a.id};}
function beginTrial(db,id,url){const task=db.store.workspaces.tasks.enqueue(id,{operation:'trial',sourceUrl:url,sources:[url],lockKey:'source:'+url});return db.begin(id,{kind:'trial',taskId:task.id});}
const freehire=bundledSources.find(s=>s.url==='https://freehire.me/');
test('bundled sources are browser-only and the launch prompt never mentions a CLI',()=>{
 for(const source of bundledSources){assert.equal(source.tool,undefined);assert.equal(source.skill,undefined);assert.doesNotMatch(source.instructions,/CLI|sourceRead|assignedSource\.cli/);}
 for(const kind of ['trial','run']){const prompt=automationPrompt({kind,sourceUrl:freehire.url});assert.doesNotMatch(prompt,/CLI|sourceRead|assignedSource\.cli/);assert.match(prompt,/Jev delegation is available/);}
});
test('catalog import enriches old sources without overwriting personal settings; imports are atomic and repeatable',t=>{
 const {db,id}=fixture(t);db.addSource(id,{url:freehire.url,name:'My board',query:'My search',intervalMinutes:87,enabled:false});
 assert.deepEqual(importSourceLibrary(db,id,[freehire]),{added:0,enriched:1,skipped:0});
 const source=db.sources(id)[0];assert.equal(source.name,'My board');assert.equal(source.query,'My search');assert.equal(source.intervalMinutes,87);assert.equal(source.enabled,false);assert.equal(source.instructions,freehire.instructions);
 db.saveSource(id,freehire.url,{instructions:'My own method'});
 assert.deepEqual(importSourceLibrary(db,id,[freehire]),{added:0,enriched:0,skipped:1});assert.equal(db.sources(id)[0].instructions,'My own method');
 const newSource=bundledSources.find(s=>s.url==='https://jobnet.dk/');
 assert.throws(()=>importSourceLibrary(db,id,[newSource,{name:'Broken',url:'file:///secret'}]),/HTTP/);
 assert.equal(db.sources(id).length,1,'Failed import rolls back earlier additions');
 importSourceLibrary(db,id,[newSource]);assert.equal(db.sources(id)[1].query,'Find developer roles');assert.equal(db.sources(id)[1].enabled,true);
});
test('imported source and skill are independent copies, used by the agent and removable without deleting records',t=>{
 const {db,core,id}=fixture(t),other=db.create('job-search',{sources:[]}),entry={...structuredClone(freehire),skill:'Shared skill'};
 importSourceLibrary(db,id,[entry]);importSourceLibrary(db,other.id,[entry]);
 const original=db.sources(id)[0];assert.equal(original.skill,'Shared skill');
 entry.name='Changed remote name';entry.instructions='Changed remote method';entry.skill='Changed remote skill';
 assert.equal(db.sources(id)[0].skill,original.skill);assert.equal(db.sources(id)[0].instructions,original.instructions);
 db.saveSource(id,entry.url,{name:'My copy',instructions:'My local method',skill:'My edited skill'});
 assert.equal(db.sources(other.id)[0].skill,original.skill);
 assert.deepEqual(importSourceLibrary(db,id,[entry]),{added:0,enriched:0,skipped:1});assert.equal(db.sources(id)[0].skill,'My edited skill');
 const exported=reusableTemplate({...automationTemplate('job-search'),defaultSources:db.sources(id)});assert.equal(exported.defaultSources[0].skill,'My edited skill');
 db.review(id);const run=beginTrial(db,id,entry.url),context=automationTaskContext(db,id,run);
 assert.equal(context.assignedSource.skill,'My edited skill');assert.equal(context.assignedSource.cli,undefined);assert.equal(context.assignedSource.tool,undefined);
 assert.throws(()=>db.removeSource(id,entry.url),/çalışan/);
 const record=db.record(id,run.id,{url:'https://employer.test/job/1',title:'Synthetic job',summary:'Saved finding'});db.finish(id,run.id,'interrupted','Done');
 const pending=core.workspaces.tasks.enqueue(id,{operation:'trial',sourceUrl:entry.url,sources:[entry.url],lockKey:'source:'+entry.url});
 db.removeSource(id,entry.url);assert.equal(db.sources(id).length,0);assert.equal(db.get(id).sourceSettings[entry.url],undefined);assert.equal(db.result(id,record.id).title,'Synthetic job');assert.equal(core.workspaces.tasks.get(id,pending.id).state,'cancelled');assert.equal(db.sources(other.id).length,1);
});
test('remote catalogs validate the whole list without executing anything',async()=>{
 const entries=await loadSourceLibrary('https://catalog.test/sources.json',{fetchImpl:async()=>Response.json([...bundledSources,{name:'Future',url:'https://new.test/'}])});
 assert.equal(entries.length,7);assert.equal(entries.at(-1).name,'Future');
 for(const source of [{url:'file:///secret'},{url:'https://a:b@example.test/'},{url:'https://example.test/',instructions:'x'.repeat(6001)},{url:'https://example.test/',skill:'x'.repeat(60001)}])assert.throws(()=>catalogSources([source]));
 await assert.rejects(loadSourceLibrary('https://catalog.test/list',{fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))}),/1 MB/);
 await assert.rejects(loadSourceLibrary('https://catalog.test/list',{fetchImpl:async()=>new Response('',{status:404})}),/404/);
 assert.throws(()=>catalogSources([freehire,freehire]),/benzersiz|yinelenen/);
 const exported=reusableTemplate({...automationTemplate('job-search'),defaultSources:[freehire]});assert.equal(exported.defaultSources[0].instructions,freehire.instructions);
});
test('method changes invalidate only the source trial and scope',t=>{
 const {db,id}=fixture(t);importSourceLibrary(db,id,[freehire,bundledSources[0]]);
 const a=db.get(id);db.put({...a,sourceState:Object.fromEntries(a.sources.map(url=>[url,{trial:{status:'passed',runId:'old'},scan:{pendingUrls:['https://jobs.test/1']}}]))});
 const before=db.get(id),other=before.sources[1],oldScope=sourceScanScope(before,freehire.url);
 db.saveSource(id,freehire.url,{instructions:'Use a different query strategy',skill:'Read this local skill'});
 assert.notEqual(sourceScanScope(db.get(id),freehire.url),oldScope);assert.equal(db.get(id).sourceState[freehire.url].trial,null);assert.deepEqual(db.get(id).sourceState[other],before.sourceState[other]);
 db.review(id);const run=beginTrial(db,id,freehire.url);
 const context=automationTaskContext(db,id,run);assert.equal(context.assignedSource.instructions,'Use a different query strategy');assert.equal(context.assignedSource.skill,'Read this local skill');
});
