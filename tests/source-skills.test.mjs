import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow,automationPrompt} from '../app/automation-worker.mjs';
import {automationTaskContext} from '../app/automation-task-context.mjs';
import {AUTOMATION_INSTRUCTIONS} from '../app/automation-agent-profiles.mjs';
import {guideSections} from '../app/source-guide.mjs';
import {sourceScanScope} from '../app/source-scan.mjs';
import {createBackup,stageRestore,applyPendingRestore,prepareDataUpgrade,inspectBackup} from '../app/data-management.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),url='https://homes.test/search';
const section=(key,status,instructions,evidenceIds=[])=>({key,status,instructions,evidenceIds});

test('user guide edits survive agent learning while untouched sections keep updating',async t=>{
 const f=fixture(t),trial=f.start();await learn(f,trial);await trial.call('finish_automation_run',{status:'completed',summary:'Ready'});
 const before=sourceScanScope(f.db.get(f.id),url);
 f.db.saveSource(f.id,url,{guideOverrides:{search:'Always clear promotion filters before searching.'},guideBaseVersion:1});
 assert.notEqual(sourceScanScope(f.db.get(f.id),url),before);
 const scan=f.start('run'),config=await scan.call('get_workspace_source_instructions');
 assert.equal(config.guideOverrides.search,'Always clear promotion filters before searching.');
 const page=await scan.observe('New list with a working filter and public details.'),proof=await scan.proof(page,'working filter and public details');
 await scan.call('save_workspace_source_skill',{baseVersion:1,summary:'Updated site controls',sections:[section('search','verified','Use the new site filter.',[proof]),section('details','verified','Read the new details panel.',[proof])]});
 const updated=await scan.call('get_workspace_source_instructions'),effective=guideSections(updated.learnedSkill,updated.guideOverrides);
 assert.equal(updated.learnedSkill.version,2);
 assert.equal(effective.find(s=>s.key==='search').instructions,config.guideOverrides.search);
 assert.equal(effective.find(s=>s.key==='search').status,'unverified');
 assert.deepEqual(effective.find(s=>s.key==='search').evidence,[]);
 assert.equal(effective.find(s=>s.key==='details').instructions,'Read the new details panel.');
 f.db.finish(f.id,scan.run.id,'interrupted','Stop for editing');
 assert.throws(()=>f.db.saveSource(f.id,url,{guideOverrides:{search:'Stale edit'},guideBaseVersion:1}),/güncellendi/);
 assert.equal(f.db.get(f.id).sourceSettings[url].guideOverrides.search,config.guideOverrides.search);
 f.db.saveSource(f.id,url,{guideOverrides:{},guideBaseVersion:2});
 assert.equal(guideSections(f.db.sourceSkills.get(f.id,url),f.db.get(f.id).sourceSettings[url].guideOverrides)[0].instructions,'Use the new site filter.');
 assert.equal(f.db.sourceSkills.history(f.id,url).length,2);
});
function fixture(t,{file=':memory:'}={}){
 const store=new Store(file),db=new AutomationStore(store),a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'1500',requirements:'Two rooms'},sources:[url,'https://homes.test/other']});
 db.review(a.id);db.saveSource(a.id,url,{skillText:'Keep my manual instructions. Use the current criteria.'});
 t.after(()=>{try{store.close();}catch{}});
 const start=(kind='trial',sourceUrl=url,workerId='main')=>{
  const task=store.workspaces.tasks.enqueue(a.id,{operation:kind==='trial'?'trial':'scan',sourceUrl,sources:[sourceUrl],lockKey:'source:'+sourceUrl});
  const run=db.begin(a.id,{kind,taskId:task.id},workerId);let current=sourceUrl,text='Page one: Berlin homes. Next page. Two rooms.',handle=1;
  const browser={async call(id,name,args){if(name==='browser_navigate')current=args.url;return {content:[{type:'text',text:`Page URL: ${current}\n${text}\n- button "Next page" [ref=e${handle++}]`}]};}};
  const flow=automationWorkflow({root,db,run,signal:{aborted:false},browser,report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
  const call=(name,args={})=>flow.call(a.id,run.id,name,args);
  const observe=async(value,next=current)=>{text=value;return call('browser_open',{url:next});};
  const proof=async(page,quote)=>{const result=await call('record_source_skill_evidence',{snapshotId:page.snapshot.id,evidence:quote});return result.evidenceId;};
  return {run,flow,call,observe,proof};
 };
 return {store,db,id:a.id,start};
}

async function learn(f,run){
 const before=await run.observe('Page one: Berlin homes. Next page. Two rooms.'),first=await run.proof(before,'Page one: Berlin homes.');
 const after=await run.observe('Page two: More Berlin homes. Previous page. Two rooms.',url+'?page=2'),second=await run.proof(after,'Page two: More Berlin homes.');
 return run.call('save_workspace_source_skill',{baseVersion:f.db.sourceSkills.get(f.id,url)?.version??0,summary:'Tested search and next-page navigation',sections:[
  section('search','verified','Read the current criteria, enter the location, then use Search.',[first]),
  section('pagination','verified','Use Next page and verify that results change while location and room filters persist. Last-page detection has not been tested.',[first,second]),
  section('details','unverified','Open a result and inspect price and restrictions; no detail was tested in this turn.'),
  section('access','verified','Public results are accessible; dismiss a cookie dialog if observed.',[first])
 ]});
}

test('a source trial saves evidence-backed methods and honest unknowns before completion',async t=>{
 const f=fixture(t),run=f.start();await run.observe('Page one: Berlin homes. Next page. Two rooms.');
 await assert.rejects(run.call('finish_automation_run',{status:'completed',summary:'Ready'}),/save_workspace_source_skill/);
 const receipt=await learn(f,run);assert.equal(receipt.version,1);assert.equal(receipt.verifiedCount,3);
 const skill=f.db.sourceSkills.get(f.id,url);assert.equal(skill.sections[2].status,'unverified');assert.equal(skill.sections[1].evidence.length,2);assert.match(skill.skillText,/Henüz doğrulanmadı/);
 assert.equal(f.db.get(f.id).sourceSettings[url].skillText,'Keep my manual instructions. Use the current criteria.');
 await run.call('finish_automation_run',{status:'completed',summary:'Learned this source'});
 assert.equal(f.db.sources(f.id)[0].trial.status,'passed');assert.equal(f.db.sources(f.id)[0].learnedSkill.version,1);
 assert.equal(f.db.sourceSkills.get(f.id,'https://homes.test/other'),null);
 assert.match(automationPrompt(run.run),/save_workspace_source_skill/);assert.match(AUTOMATION_INSTRUCTIONS,/current criteria on every turn/);
});

test('evidence must come from the current snapshot and cannot be fabricated or borrowed from another source',async t=>{
 const f=fixture(t),run=f.start(),page=await run.observe('Page one: Berlin homes. Next page.'),id=await run.proof(page,'Berlin homes.');
 await assert.rejects(run.proof(page,'Invented secret page'),/bulunamadı/);
 await run.observe('Page two: New homes.');await assert.rejects(run.proof(page,'Berlin homes.'),/eski/);
 const worker=f.store.workspaces.workers.add(f.id),other=f.start('trial','https://homes.test/other',worker.id);
 await assert.rejects(other.call('save_workspace_source_skill',{baseVersion:0,summary:'Borrowed proof',sections:[section('search','verified','Search here',[id])]}),/bu kaynak turunda/);
 await assert.rejects(run.call('save_workspace_source_skill',{baseVersion:0,summary:'Fake proof',sections:[section('search','verified','Search here',['fake'])]}),/bu kaynak turunda/);
 assert.equal(f.db.sourceSkills.get(f.id,url),null);
});

test('pagination cannot be verified from a Next label, rereading the same content or reversed evidence',async t=>{
 const f=fixture(t),run=f.start(),page=await run.observe('Page one: Berlin homes. Next page.'),first=await run.proof(page,'Page one: Berlin homes.');
 const save=ids=>run.call('save_workspace_source_skill',{baseVersion:0,summary:'Pagination',sections:[section('pagination','verified','Use Next page',ids)]});
 await assert.rejects(save([first]),/öncesi ve sonrası/);
 const same=await run.observe('Page one: Berlin homes. Next page.'),second=await run.proof(same,'Next page.');
 await assert.rejects(save([first,second]),/öncesi ve sonrası/); // Only the temporary ref changed.
 const next=await run.observe('Page two: Hamburg homes.'),third=await run.proof(next,'Page two: Hamburg homes.');
 await assert.rejects(save([third,first]),/öncesi ve sonrası/);
 const saved=await run.call('save_workspace_source_skill',{baseVersion:0,summary:'Single page only',sections:[section('pagination','unverified','Next is visible, but its behavior and the end condition have not been tested.')]});
 assert.equal(saved.verifiedCount,0);
});

test('skills reject transient handles, unproven verified sections and invalid updates atomically',async t=>{
 const f=fixture(t),run=f.start();
 for(const instructions of ['Click e12','Use [ref=f3e20]','Use controlId: scroll_2'])await assert.rejects(run.call('save_workspace_source_skill',{baseVersion:0,summary:'Bad method',sections:[section('search','unverified',instructions)]}),/Geçici/);
 await assert.rejects(run.call('save_workspace_source_skill',{baseVersion:0,summary:'Missing evidence',sections:[section('details','verified','Read the exact rent')]}),/kanıt gerekli/);
 await assert.rejects(run.call('save_workspace_source_skill',{baseVersion:0,summary:'Bad duplicate',sections:[section('search','unverified','Search'),section('search','unverified','Again')]}),/tekrar eden/);
 assert.deepEqual(f.db.sourceSkills.history(f.id,url),[]);
});

test('normal scans read learned methods with current criteria and update only the broken section',async t=>{
 const f=fixture(t),trial=f.start();await learn(f,trial);await trial.call('finish_automation_run',{status:'completed',summary:'Ready'});
 f.db.save(f.id,{criteria:{location:'Hamburg',budget:'1800',requirements:'Three rooms'}});f.db.review(f.id);
 const scan=f.start('run'),context=automationTaskContext(f.db,f.id,scan.run),instructions=await scan.call('get_workspace_source_instructions');
 assert.equal(context.automation.criteria.location,'Hamburg');assert.equal(context.assignedSource.learnedSkill.version,1);assert.equal(context.assignedSource.learnedSkill.skillText,undefined);
 assert.equal(instructions.learnedSkill.version,1);assert.match(instructions.skillText,/manual instructions/);
 const page=await scan.observe('Load more is unavailable. Please try again.'),evidence=await scan.proof(page,'Load more is unavailable.');
 const result=await scan.call('save_workspace_source_skill',{baseVersion:1,summary:'Pagination changed',sections:[section('pagination','blocked','The previous Next method failed. Inspect the current navigation before continuing.',[evidence])]});
 assert.equal(result.version,2);assert.equal(f.db.sourceSkills.get(f.id,url).sections[0].status,'verified');
 assert.equal(f.db.sourceSkills.get(f.id,url,1).sections[1].status,'verified');assert.equal(f.db.sourceSkills.get(f.id,url,2).sections[1].status,'blocked');
 assert.deepEqual(f.db.sourceSkills.history(f.id,url).map(s=>s.version),[2,1]);
 await assert.rejects(scan.call('save_workspace_source_skill',{baseVersion:1,summary:'Stale update',sections:[section('details','unverified','Not checked')]}),/sürümü değişti/);
 assert.match(automationPrompt(scan.run),/reuse the learned skill with current criteria/);
});

test('repeated unchanged saves do not duplicate versions; a method change makes old checks unverified',async t=>{
 const f=fixture(t),run=f.start();await learn(f,run);const same=await learn(f,run);assert.equal(same.unchanged,true);assert.equal(same.version,1);
 await run.call('finish_automation_run',{status:'completed',summary:'Ready'});
 f.db.save(f.id,{chromeProfile:{directory:'Profile 2',name:'Other browser'}});
 assert.equal(f.db.sourceSkills.get(f.id,url).needsReview,true);
 const next=f.start(),page=await next.observe('Public search works in the new profile.'),evidence=await next.proof(page,'Public search works');
 await next.call('save_workspace_source_skill',{baseVersion:1,summary:'Checked the changed browser',sections:[section('access','verified','Read public results in the selected browser.',[evidence])]});
 const skill=f.db.sourceSkills.get(f.id,url);assert.equal(skill.needsReview,false);assert.equal(skill.sections.find(s=>s.key==='access').status,'verified');assert.equal(skill.sections.find(s=>s.key==='pagination').status,'unverified');
});

test('interviews and record operations cannot rewrite source skills, even through a direct tool call',async t=>{
 const f=fixture(t),interview=f.db.begin(f.id,'interview');
 const flow=automationWorkflow({db:f.db,run:interview,signal:{aborted:false},browser:{},report:()=>{}});
 assert.ok(!flow.tools.some(t=>t.name==='save_workspace_source_skill'));
 await assert.rejects(flow.call(f.id,interview.id,'save_workspace_source_skill',{baseVersion:0,summary:'Wrong task',sections:[section('search','unverified','Unknown')]}),/atanmış kaynağın/);
 f.db.finish(f.id,interview.id,'completed','Setup');
 const run=f.start();f.db.putRun({...f.db.run(run.run.id),recordId:'record',recordOperation:'prepare'});
 await assert.rejects(run.call('save_workspace_source_skill',{baseVersion:0,summary:'Wrong scope',sections:[section('search','unverified','Unknown')]}),/atanmış kaynağın/);
});

test('successful store-level source trials also require saving a skill',t=>{
 const f=fixture(t),run=f.start();f.db.observe(f.id,run.run.id,url,'Visible results');
 const result=f.db.finish(f.id,run.run.id,'completed','Read only');assert.equal(result.status,'failed');assert.match(result.summary,/skill/);
});

test('skill history persists across reopen and workspace deletion removes it',async t=>{
 const f=fixture(t),run=f.start();await learn(f,run);await run.call('finish_automation_run',{status:'completed',summary:'Ready'});
 const reopened=new AutomationStore(f.store);assert.equal(reopened.sourceSkills.get(f.id,url).version,1);
 assert.throws(()=>reopened.sourceSkills.get(f.id,'https://foreign.test/',1),/ait değil/);
 assert.throws(()=>reopened.sourceSkills.get(f.id,url,12),/sürümü/);
 reopened.remove(f.id);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM workspace_source_skills').get().n,0);
});

test('schema upgrade is backed up and restore keeps skill history while requiring fresh checks',async t=>{
 const base=await mkdtemp(path.join(tmpdir(),'jobloop-source-skills-')),data=path.join(base,'data');await mkdir(data);t.after(()=>rm(base,{recursive:true,force:true}));
 const f=fixture(t,{file:path.join(data,'jobloop.sqlite')});f.db.saveSource(f.id,url,{searchMethod:'tool',customTool:{command:process.execPath,args:['-e',"process.stdout.write('Current source listings')"]},fallback:'none'});
 const run=f.start();await run.call('run_workspace_source_tool',{args:['search']});await learn(f,run);await run.call('finish_automation_run',{status:'completed',summary:'Ready'});
 f.store.db.exec('PRAGMA user_version=11');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:data,appVersion:'source-skills-test'});assert.ok(upgrade.backup);assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,11);
 const core=new Store(path.join(data,'jobloop.sqlite'));t.after(()=>{try{core.close();}catch{}});
 const current=new AutomationStore(core);assert.equal(current.sourceSkills.get(f.id,url).version,1);
 const backup=path.join(base,'export');await createBackup({dataDirectory:data,db:core.db,destination:backup,appVersion:'source-skills-test'});
 await stageRestore({dataDirectory:data,directory:backup,db:core.db,appVersion:'source-skills-test'});core.close();await applyPendingRestore({dataDirectory:data});
 const restored=new Store(path.join(data,'jobloop.sqlite'));try{
  const db=new AutomationStore(restored),skill=db.sourceSkills.get(f.id,url);assert.equal(skill.version,1);assert.equal(skill.needsReview,true);assert.equal(db.sourceSkills.history(f.id,url).length,1);
  assert.equal(db.run(run.run.id).sourceToolCheck.status,'succeeded');assert.deepEqual(db.run(run.run.id).sourceToolCheck.args,['search']);
  assert.equal(db.get(f.id).status,'paused');assert.equal(db.get(f.id).sourceSettings[url].skillText,'Keep my manual instructions. Use the current criteria.');
 }finally{restored.close();}
});

test('configured source tools can learn pagination and finish their first trial without browser steps',async t=>{
 const f=fixture(t);
 f.db.saveSource(f.id,url,{searchMethod:'tool',customTool:{command:process.execPath,args:['-e',"process.stdout.write('Result page '+process.argv[1]+': '+(process.argv[1]==='1'?'City home':'Garden home'))"]},fallback:'none'});
 const run=f.start(),first=await run.call('run_workspace_source_tool',{args:['1']}),before=await run.proof(first,'Result page 1: City home');
 const second=await run.call('run_workspace_source_tool',{args:['2']}),after=await run.proof(second,'Result page 2: Garden home');
 await run.call('save_workspace_source_skill',{baseVersion:0,summary:'Tested CLI page argument',sections:[section('pagination','verified','Increment the page argument; verify result content changes. The end condition is not tested.',[before,after])]});
 await run.call('finish_automation_run',{status:'completed',summary:'CLI source checked'});
 assert.equal(f.db.run(run.run.id).browserSteps,0);assert.equal(f.db.sources(f.id)[0].trial.status,'passed');assert.equal(f.db.sourceSkills.get(f.id,url).sections[1].status,'verified');
});

test('a failed configured tool invalidates its old snapshot and can report a blocked trial',async t=>{
 const f=fixture(t);
 f.db.saveSource(f.id,url,{searchMethod:'tool',customTool:{command:process.execPath,args:['-e',"if(process.argv[1]==='fail'){process.stderr.write('Source unavailable');process.exit(2);}process.stdout.write('City home is listed')"]},fallback:'none'});
 const run=f.start(),page=await run.call('run_workspace_source_tool',{args:['ok']}),failed=await run.call('run_workspace_source_tool',{args:['fail']});
 assert.equal(failed.ok,false);await assert.rejects(run.proof(page,'City home is listed'),/eski/);
 await run.call('finish_automation_run',{status:'blocked',summary:'Source unavailable'});assert.equal(f.db.run(run.run.id).status,'blocked');assert.equal(f.db.sourceSkills.get(f.id,url),null);
});

test('tool sources cannot bypass the configured search with browser discovery or cached browser notes',async t=>{
 const f=fixture(t),old=f.start();await learn(f,old);await old.call('finish_automation_run',{status:'completed',summary:'Browser method learned'});
 f.db.saveSource(f.id,url,{searchMethod:'tool',integrationId:'freehire',customTool:{command:process.execPath,args:['-e',"process.stdout.write('Current CLI listings')"]},fallback:'browser'});
 const run=f.start('run');
 let config=await run.call('get_workspace_source_instructions');if(config.context){let text=config.text,part=config;while(part.context.nextOffset!==null){part=await run.call('read_automation_context_part',{contextId:part.context.id,offset:part.context.nextOffset});text+=part.text;}config=JSON.parse(text);}assert.equal(config.searchMethod,'tool');assert.match(config.workflow,/Start with run_workspace_source_tool/);assert.ok(config.learnedSkill);assert.match(config.toolReference,/freehire Search Skill/);
 for(const name of ['browser_open','browser_read','browser_jev_use_tab','browser_interact','recheck_scan_page'])await assert.rejects(run.call(name,{url,ref:'some-control',operation:'click',tabId:'old',snapshotId:'old'}),/run_workspace_source_tool/);
 assert.equal(f.db.run(run.run.id).browserSteps,0);
 await run.call('run_workspace_source_tool',{args:['search','--country','DE','--page','1']});
 assert.equal(f.db.run(run.run.id).sourceToolCheck.status,'succeeded');
 const detail=await run.observe('Observed detail is accessible',url+'/detail');assert.equal(detail.url,url+'/detail');
});

test('a help-only tool invocation cannot complete a trial or unlock browser discovery',async t=>{
 const f=fixture(t);f.db.saveSource(f.id,url,{searchMethod:'tool',customTool:{command:process.execPath,args:['-e',"process.stdout.write('Usage: search --page NUMBER')",'--']},fallback:'web'});
 const run=f.start();await run.call('run_workspace_source_tool',{args:['--help']});
 assert.equal(f.db.run(run.run.id).sourceToolCheck.status,'help');await assert.rejects(run.observe('No browser before search'),/Yardım çıktısı/);
 await run.call('save_workspace_source_skill',{baseVersion:0,summary:'Only help was read',sections:[section('search','unverified','Search has not been tried.')]});
 await assert.rejects(run.call('finish_automation_run',{status:'completed',summary:'Ready'}),/Yardım çıktısı/);
 const ended=f.db.finish(f.id,run.run.id,'completed','Bypassed the worker');assert.equal(ended.status,'failed');assert.match(ended.summary,/Yardım çıktısı/);
});

test('actual source tool failures obey browser, web and disabled fallback settings',async t=>{
 for(const fallback of ['browser','web','none'])await t.test(fallback,async t=>{
  const f=fixture(t);f.db.saveSource(f.id,url,{searchMethod:'tool',customTool:{command:process.execPath,args:['-e',"process.stderr.write('Source connection failed');process.exit(2)"]},fallback});
  const run=f.start();await assert.rejects(run.observe('Do not skip the configured tool'),/run_workspace_source_tool/);
  const failed=await run.call('run_workspace_source_tool',{args:['search']});assert.equal(failed.ok,false);assert.equal(failed.fallback,fallback);assert.equal(f.db.run(run.run.id).sourceToolCheck.status,'failed');
  if(fallback==='none'){await assert.rejects(run.observe('Fallback is disabled'),/alternatif yöntem kapalı/);await run.call('finish_automation_run',{status:'blocked',summary:failed.diagnostic});}
  else {const page=await run.observe('Public fallback results are visible'),proof=await run.proof(page,'Public fallback results are visible');await run.call('save_workspace_source_skill',{baseVersion:0,summary:'CLI failed; the configured fallback worked',sections:[section('access','verified','CLI failed to connect. The configured '+fallback+' fallback shows public results.',[proof])]});await run.call('finish_automation_run',{status:'completed',summary:'Fallback checked'});assert.equal(f.db.run(run.run.id).status,'completed');}
 });
});
