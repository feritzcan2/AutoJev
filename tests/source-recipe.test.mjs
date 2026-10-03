import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {normalizeSourceRecipe,replayUrl,recipeReplay,replayMatches,recipeRunOutcome,advanceRecipeState,recipeStatus,recipeSummary,jevListingItem} from '../app/source-recipe.mjs';
import {importSourceLibrary} from '../app/source-library.mjs';
import {sourceScanScope} from '../app/source-scan.mjs';

const source='https://board.test/jobs';
const template='https://board.test/jobs/search?q={query}&l={location}&sort=date';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const answer=(choice,criteria,confidence=1)=>({choice,confidence,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===choice?1:0]))});

test('recipes are validated as data: placeholders, form fields and pagination kinds',()=>{
 const recipe=normalizeSourceRecipe({entry:{kind:'url_template',template},pagination:'url_param',notes:'Sorted by date'});
 assert.deepEqual(recipe,{entry:{kind:'url_template',template},pagination:'url_param',notes:'Sorted by date'});
 assert.deepEqual(normalizeSourceRecipe({entry:{kind:'url_template',template:'https://board.test/jobs'}}).entry,{kind:'url_template',template:'https://board.test/jobs'},'a fixed results address needs no placeholder');
 assert.throws(()=>normalizeSourceRecipe({entry:{kind:'url_template',template:'https://board.test/jobs'},terms:['ops']}),/\{query\}/);
 assert.throws(()=>normalizeSourceRecipe({entry:{kind:'url_template',template},terms:[]}),/1–5/);
 const termed=normalizeSourceRecipe({entry:{kind:'url_template',template},terms:['Compliance',' AI Governance ','Compliance']});
 assert.deepEqual(termed.terms,['Compliance','AI Governance']);
 assert.throws(()=>normalizeSourceRecipe({entry:{kind:'url_template',template:'ftp://x/{query}'}}),/HTTP/);
 assert.throws(()=>normalizeSourceRecipe({entry:{kind:'search_form',url:source,fields:[{key:'location',label:'Ort'}]}}),/query/);
 assert.throws(()=>normalizeSourceRecipe({entry:{kind:'url_template',template},pagination:'magic'}),/sayfalama/);
 assert.equal(normalizeSourceRecipe(null),null);
 const form=normalizeSourceRecipe({entry:{kind:'search_form',url:source+'#top',fields:[{key:'query',label:'Stichwort'},{key:'location',label:'Ort'}]}});
 assert.equal(form.entry.url,source);assert.equal(form.pagination,'auto');
 assert.equal(replayUrl(template,{query:'backend developer',location:'Berlin'}),'https://board.test/jobs/search?q=backend+developer&l=Berlin&sort=date');
 assert.equal(replayUrl(template,{query:'ops'}),'https://board.test/jobs/search?q=ops&sort=date','empty placeholders drop their parameter');
 assert.equal(recipeReplay(normalizeSourceRecipe({entry:{kind:'discovery'}}),{query:'x'}),null);
 assert.deepEqual(recipeReplay(form,{query:'ops',location:''}).searches,[{term:null,url:source,answers:[{key:'query',label:'Stichwort',value:'ops'}]}]);
 assert.deepEqual(recipeReplay(termed,{query:'Aday profiline uygun ilanlar',location:'Berlin'}).searches.map(s=>s.url),['https://board.test/jobs/search?q=Compliance&l=Berlin&sort=date','https://board.test/jobs/search?q=AI+Governance&l=Berlin&sort=date'],'terms replace a descriptive source query');
 assert.deepEqual(recipeReplay(normalizeSourceRecipe({entry:{kind:'url_template',template:'https://board.test/jobs'}}),{query:'x'}).searches,[{term:null,url:'https://board.test/jobs'}]);
});

test('scan outcomes verify, tolerate barriers and mark a recipe stale after two failures',()=>{
 const url='https://board.test/jobs/search?q=ops',replay={kind:'url_template',pagination:'auto',searches:[{term:null,url},{term:'risk',url:'https://board.test/jobs/search?q=risk'}]};
 const listing=[{input:{operation:'scan_results',url:replay.searches[1].url},status:'completed',items:[{url:'a',discovery:{decision:'listing'}}]}];
 assert.equal(recipeRunOutcome(replay,listing),'success');
 assert.equal(recipeRunOutcome(replay,[{input:{operation:'scan_results',url},status:'needs_agent',issue:{reason:'access_barrier'},items:[]}]),'neutral');
 assert.equal(recipeRunOutcome(replay,[{input:{operation:'scan_results',url:'https://elsewhere.test'},status:'completed',items:[]}]),'neutral','unrelated scans say nothing about the recipe');
 assert.equal(recipeRunOutcome(replay,[{input:{operation:'scan_results',url:url+'&start=20&vjk=abc'},status:'completed',items:[{url:'b',discovery:{decision:'listing'}}]}]),'success','a later page or a site-added token is the same search');
 assert.ok(replayMatches(replay,'https://board.test/jobs/search?q=ops&page=5'));assert.ok(!replayMatches(replay,'https://board.test/jobs/search?q=other'));assert.ok(!replayMatches(replay,'https://board.test/jobs/view?q=ops'));assert.ok(!replayMatches(replay,'https://board.test/jobs/search'),'a search missing the replayed parameter is not the replay');
 const failed=[{input:{operation:'scan_results',url},status:'needs_agent',issue:{reason:'no_listing_links'},items:[]}];
 assert.equal(recipeRunOutcome(replay,failed),'failure');
 let state=advanceRecipeState({status:'verified',successCount:3,failCount:0},'failure',{runId:'r1',now:1,reason:'no_listing_links',url});
 assert.equal(state.status,'verified');assert.equal(state.failCount,1);
 state=advanceRecipeState(state,'failure',{runId:'r2',now:2,reason:'no_listing_links',url});
 assert.equal(state.status,'stale');assert.equal(state.lastFailure.reason,'no_listing_links');
 state=advanceRecipeState(state,'success',{runId:'r3',now:3});
 assert.equal(state.status,'verified');assert.equal(state.failCount,0);assert.equal(state.successCount,4);
 assert.equal(recipeStatus(null,null),'none');assert.equal(recipeStatus({entry:{kind:'discovery'}},null),'discovery');
 assert.equal(recipeSummary({entry:{kind:'url_template',template}},{status:'verified',successCount:2,failCount:0}).label,'Reçete doğrulandı');
});

function fixture(t){
 const store=new WorkspaceDatabase(':memory:');let now=1_800_000_000_000;const db=new AutomationStore(store,{now:()=>now});
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[source]});db.review(a.id);
 const launches=[],runtime=new WebTasks(db,{now:()=>now,launch:async run=>{launches.push(run);return {close:async()=>{}};}});
 t.after(async()=>{await runtime.close();store.close();});
 return {store,db,id:a.id,runtime,launches,advance:minutes=>{now+=minutes*60000;}};
}
// A Jev fake: the replayed search lists two jobs on one page; any other board is empty.
// A results board with `pages` numbered pages behind `expected`; each page
// links two listings and the last one shows no further pagination.
// `leads` makes discovery mark every result link uncertain, like boards whose
// result links are redirects; details then read as individual listings.
function jevBrowser(expected,{listings=2,pages=1,leads=false}={}){
 const opened=[],pageUrl=n=>n===1?expected:expected+'&start='+(n-1)*10,pageNumber=url=>[...Array(pages).keys()].map(n=>n+1).find(n=>pageUrl(n)===url);
 return {opened,browser:{
  evaluateJev:async(_id,state,questions)=>({answers:Object.fromEntries(Object.entries(questions).map(([key,q])=>[key,answer(key==='next'?Object.keys(state.pagination??{}).length?'0':'end':key==='fit'?'possible':leads?'uncertain':'listing',q.criteria)]))}),
  async call(_id,name,args){
   const url=args.url??opened.at(-1);if(name==='browser_navigate')opened.push(url);
   const n=pageNumber(url),view=k=>expected.replace('search','view/'+k);
   const page=n?{url,title:'Results',text:`Jobs for you, page ${n}\nLink: Job A — ${view(n+'a')}\nLink: Job B — ${view(n+'b')}`,links:Array.from({length:listings},(_,i)=>({url:view(n+'ab'[i]),text:'Job '+n+'ab'[i]})),pagination:n<pages?[{text:'Next',url:pageUrl(n+1),kind:'link'}]:[]}
    :url.includes('/view/')?{url,title:'Job detail',text:'Individual opportunity. '+'Responsibilities and requirements. '.repeat(20),links:[],pagination:[]}:{url,title:'Board',text:'Nothing here',links:[],pagination:[]};
   return {jevPage:page,pageContext:{url,tabId:'owned'},content:[{type:'text',text:'Page URL: '+url+'\n'+JSON.stringify(page)}]};
  }
 }};
}
const settleTask=async(flow,id,runId,first)=>{let result=first,polls=0;while(result.status==='running'){if(++polls>40)throw Error('task did not settle');result=await flow.call(id,runId,'read_jev_task',{taskId:result.taskId??result.index?.taskId});}return result;};

test('a recipe check proves redirect-style result links by reading a few details',async t=>{
 const f=fixture(t);f.db.enable(f.id);await f.runtime.tick();await settle();
 const trial=f.launches[0],expected='https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',{browser,opened}=jevBrowser(expected,{pages:3,leads:true});
 const flow=automationWorkflow({db:f.db,run:trial,signal:new AbortController().signal,browser,report:(...args)=>f.runtime.report(...args)});
 const saved=await flow.call(f.id,trial.id,'save_source_recipe',{entry:{kind:'url_template',template},pagination:'url_param'});
 assert.equal(saved.status,'verified');assert.ok(saved.listings>=1);assert.ok(saved.detailsTaskId);assert.match(saved.note,/reading details/);
 assert.equal(opened.filter(u=>u.includes('/view/')).length,3,'only three leads are read');assert.equal(opened.filter(u=>u.startsWith(expected)).length,2,'two result pages');
 assert.equal(f.db.sources(f.id)[0].recipeState.status,'verified');
 const tasks=f.db.jevTasks.list(f.id,trial.taskId??trial.id),scanTask=tasks.find(t=>t.input.operation==='scan_results'),detailTask=tasks.find(t=>t.input.operation==='collect_details');
 assert.ok(scanTask.items.every(i=>i.discovery.decision==='uncertain'));assert.ok(detailTask.items.some(jevListingItem));
 assert.equal(recipeRunOutcome(recipeReplay(f.db.sources(f.id)[0].recipe,{query:'Find homes',location:'Berlin'}),tasks.map(t=>t.input.operation==='collect_details'?{...t,input:{...t.input,fromTaskId:scanTask.id}}:t)),'success','details linked to the replayed scan count as success');
 assert.equal(recipeRunOutcome(recipeReplay(f.db.sources(f.id)[0].recipe,{query:'Find homes',location:'Berlin'}),[scanTask]),'neutral','uncertain leads without details prove nothing either way');
});

test('a trial scan reads at most two result pages while a scan run keeps paging',async t=>{
 const f=fixture(t);f.db.enable(f.id);await f.runtime.tick();await settle();
 const trial=f.launches[0],expected='https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',{browser,opened}=jevBrowser(expected,{pages:4});
 const flow=automationWorkflow({db:f.db,run:trial,signal:new AbortController().signal,browser,report:(...args)=>f.runtime.report(...args)});
 const scanned=await settleTask(flow,f.id,trial.id,await flow.call(f.id,trial.id,'browser_jev_run',{operation:'scan_results',url:expected}));
 assert.equal(scanned.status,'completed');assert.equal(scanned.pageCount,2);assert.equal(scanned.pageLimitReached,true);assert.match(scanned.next,/Page limit for this turn/);
 assert.equal(opened.filter(u=>u.startsWith(expected)).length,2,'the trial never opened a third page');
 f.db.observe(f.id,trial.id,source,'Listings');
 await flow.call(f.id,trial.id,'finish_automation_run',{status:'completed',summary:'Access ok'});await f.runtime.finish(f.id,'completed','Access ok',trial.workerId);await f.runtime.tick();
 f.advance(31);await f.runtime.tick();await settle();
 const scan=f.launches[1];assert.equal(scan.kind,'run');
 const scanFlow=automationWorkflow({db:f.db,run:scan,signal:new AbortController().signal,browser,report:(...args)=>f.runtime.report(...args)});
 const full=await settleTask(scanFlow,f.id,scan.id,await scanFlow.call(f.id,scan.id,'browser_jev_run',{operation:'scan_results',url:expected}));
 assert.equal(full.status,'completed');assert.equal(full.pageCount,4);assert.equal(full.pageLimitReached,undefined);
});

test('a trial agent saves a recipe that the app verifies with Jev before accepting it',async t=>{
 const f=fixture(t);f.db.enable(f.id);await f.runtime.tick();await settle();
 const trial=f.launches[0];assert.equal(trial.kind,'trial');
 const expected='https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',{browser,opened}=jevBrowser(expected);
 const flow=automationWorkflow({db:f.db,run:trial,signal:new AbortController().signal,browser,report:(...args)=>f.runtime.report(...args)});
 const context=await flow.call(f.id,trial.id,'get_automation_context',{});
 assert.equal(context.assignedSource.recipeStatus,'none');assert.equal(context.assignedSource.recipeReplay,null);
 await assert.rejects(flow.call(f.id,trial.id,'save_source_recipe',{entry:{kind:'url_template',template:'https://board.test/other?q={query}'}}),/doğrulanamadı: no_listing_links/);
 assert.equal(f.db.sources(f.id)[0].recipe,undefined,'a failed check saves nothing');
 const saved=await flow.call(f.id,trial.id,'save_source_recipe',{entry:{kind:'url_template',template},pagination:'url_param'});
 assert.equal(saved.status,'verified');assert.equal(saved.listings,2);assert.equal(saved.url,expected);assert.ok(opened.includes(expected));
 const after=f.db.sources(f.id)[0];assert.equal(after.recipe.entry.template,template);assert.equal(after.recipeState.status,'verified');assert.equal(after.recipeState.successCount,1);
 assert.equal(sourceScanScope(f.db.get(f.id),source),sourceScanScope({...f.db.get(f.id),sourceSettings:{[source]:{}}},source),'recipes never change the scan scope');
 f.db.observe(f.id,trial.id,source,'Listings');
 await flow.call(f.id,trial.id,'finish_automation_run',{status:'completed',summary:'Recipe saved'});await f.runtime.finish(f.id,'completed','Recipe saved',trial.workerId);await f.runtime.tick();
 assert.equal(f.db.sources(f.id)[0].trial.status,'passed');assert.equal(f.db.sources(f.id)[0].recipeState.status,'verified');
 f.advance(31);await f.runtime.tick();await settle();
 const scan=f.launches[1];assert.equal(scan.kind,'run');
 const scanFlow=automationWorkflow({db:f.db,run:scan,signal:new AbortController().signal,browser,report:(...args)=>f.runtime.report(...args)});
 const scanContext=await scanFlow.call(f.id,scan.id,'get_automation_context',{});
 assert.equal(scanContext.assignedSource.recipeReplay.searches[0].url,expected);assert.match(scanContext.assignedSource.recipeGuidance,/Start with recipeReplay/);
});

test('a passed trial without a saved recipe leaves the source in discovery mode',async t=>{
 const f=fixture(t);f.db.enable(f.id);await f.runtime.tick();await settle();
 const trial=f.launches[0];f.db.spendStep(f.id,trial.id);f.db.observe(f.id,trial.id,source,'Listings');
 const flow=automationWorkflow({db:f.db,run:trial,signal:{aborted:false},browser:{},report:(...args)=>f.runtime.report(...args)});
 await flow.call(f.id,trial.id,'finish_automation_run',{status:'completed',summary:'Checked'});await f.runtime.finish(f.id,'completed','Checked',trial.workerId);
 const after=f.db.sources(f.id)[0];assert.equal(after.trial.status,'passed');assert.equal(after.recipe.entry.kind,'discovery');assert.equal(after.recipeState.status,'discovery');
 assert.equal(recipeSummary(after.recipe,after.recipeState).label,'Keşif modu');
});

test('replayed scans verify or invalidate the recipe; a stale recipe sends the source back to a trial',async t=>{
 const f=fixture(t);
 f.db.saveSource(f.id,source,{recipe:{entry:{kind:'url_template',template}}});
 assert.equal(f.db.sources(f.id)[0].recipeState.status,'candidate');
 const trial=f.db.begin(f.id,'trial');f.db.observe(f.id,trial.id,source,'Listings');f.db.finish(f.id,trial.id,'completed','Read');f.db.enable(f.id);
 const expected='https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date';
 const scanOnce=async listings=>{
  await f.runtime.tick();await settle();const run=f.launches.at(-1);assert.equal(run.kind,'run');
  const {browser}=jevBrowser(expected,{listings});
  const flow=automationWorkflow({db:f.db,run,signal:new AbortController().signal,browser,report:(...args)=>f.runtime.report(...args)});
  const scan=await flow.call(f.id,run.id,'browser_jev_run',{operation:'scan_results',url:expected});
  if(listings)await flow.call(f.id,run.id,'browser_jev_run',{operation:'collect_details',fromTaskId:scan.taskId}).catch(()=>{});
  f.runtime.report(f.id,run.id,'completed','Scan ended');await f.runtime.finish(f.id,'completed','Scan ended',run.workerId);
  await f.runtime.tick();f.advance(31);return f.db.sources(f.id)[0].recipeState;
 };
 let state=await scanOnce(2);assert.equal(state.status,'verified');assert.equal(state.successCount,1);
 state=await scanOnce(0);assert.equal(state.status,'verified');assert.equal(state.failCount,1);assert.equal(state.lastFailure.reason,'no_listing_links');
 state=await scanOnce(0);assert.equal(state.status,'stale');assert.equal(f.db.sources(f.id)[0].trial,null,'a stale recipe forgets the trial');
 const context=f.db.sourceRecipe(f.id,source);assert.equal(context.replay,null,'a stale recipe is not replayed');
 await f.runtime.tick();await settle();assert.equal(f.launches.at(-1).kind,'trial','the next turn relearns the source');
});

test('relearning, library recipes and settings carry recipes without touching scan state',async t=>{
 const f=fixture(t);
 assert.deepEqual(importSourceLibrary(f.db,f.id,[{url:source,name:'Board',recipe:{entry:{kind:'url_template',template}}}]),{added:0,enriched:1,skipped:0});
 assert.equal(f.db.sources(f.id)[0].recipe.entry.template,template);assert.equal(f.db.sources(f.id)[0].recipeState.status,'candidate');
 assert.deepEqual(importSourceLibrary(f.db,f.id,[{url:source,name:'Board',recipe:{entry:{kind:'discovery'}}}]),{added:0,enriched:0,skipped:1},'a saved recipe is never overwritten by an import');
 const trial=f.db.begin(f.id,'trial');f.db.observe(f.id,trial.id,source,'Listings');f.db.finish(f.id,trial.id,'completed','Read');
 assert.equal(f.db.sources(f.id)[0].trial.status,'passed');
 await f.runtime.relearnSource(f.id,source);
 const after=f.db.sources(f.id)[0];assert.equal(after.trial,null);assert.equal(after.recipeState.status,'candidate');assert.equal(after.recipe.entry.template,template,'relearning keeps the saved recipe for comparison');
 f.db.put({...f.db.get(f.id),sourceState:{...f.db.get(f.id).sourceState,[source]:{...f.db.get(f.id).sourceState[source],recipeState:{status:'verified',successCount:3,failCount:0}}}});
 f.db.saveSource(f.id,source,{recipe:{...after.recipe,notes:'Sorted by date',pagination:'next_link',loginRequired:false},mode:'observe'});
 assert.equal(f.db.sources(f.id)[0].recipeState.successCount,3,'advisory recipe fields do not reset verification');
 f.db.saveSource(f.id,source,{recipe:{...after.recipe,terms:['ops']}});assert.equal(f.db.sources(f.id)[0].recipeState.status,'candidate','a different search method needs a new check');
 f.db.saveSource(f.id,source,{recipe:null});assert.equal(f.db.sources(f.id)[0].recipe,undefined);assert.equal(f.db.sources(f.id)[0].recipeState,null);
 const settings=f.db.save(f.id,{agentSettings:{provider:'codex',model:'default',trialModel:'gpt-5-pro',permission:'bypassPermissions',reasoning:'default',network:null}}).agentSettings;
 assert.equal(settings.trialModel,'gpt-5-pro');
 assert.equal(f.db.save(f.id,{agentSettings:{...settings,trialModel:null}}).agentSettings.trialModel,undefined);
});
