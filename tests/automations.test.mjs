import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow,researchUrl} from '../app/automation-worker.mjs';
import {automationTemplate,reusableTemplate,webUrl,automationTable,automationCells} from '../app/automation-templates.mjs';
import {startMcp,validate} from '../app/mcp.mjs';
import {createBackup,stageRestore,applyPendingRestore,pruneLogs} from '../app/data-management.mjs';
import {prepareAutomationChat} from '../src/automation-chat.js';

const setup={title:'Berlin’de ev',goal:'Uygun evleri bul',criteria:{location:'Berlin',budget:'1500 EUR warm',requirements:'2 oda'},sources:['https://example.com/homes']};
function fixture(t){const store=new Store(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),a=db.create('housing',setup);return {store,db,id:a.id};}
function trial(db,id){db.review(id);const run=db.begin(id,'trial');db.observe(id,run.id,'https://example.com/homes','Actual rental listings');db.finish(id,run.id,'completed','İlanlar gözlendi');return run;}
function record(db,id,run,key='1',proposal='Merhaba, bu evle ilgileniyorum.'){return db.record(id,run.id,{key,url:'https://example.com/homes/'+key,title:'İki odalı ev',summary:'Berlin, 1400 EUR warm',proposal});}
const settle=()=>new Promise(r=>setImmediate(r));

test('agent table edits persist without changing plan review, action authority or result evidence',async t=>{
 const {db,id}=fixture(t);trial(db,id);const run=db.begin(id,'run'),item=record(db,id,run);db.finish(id,run.id,'completed','Prepared');db.approve(id,item.id);db.star(id,item.id,true);
 const before=db.get(id),saved=db.result(id,item.id),interview=db.begin(id,'interview');
 const flow=automationWorkflow({db,run:interview,signal:new AbortController().signal,browser:{call(){throw Error('No browser work needed');}},report:()=>{}});
 const table={title:'Kiralık evler',columns:[{key:'source',label:'Site',type:'text'},{key:'title',label:'Ev',type:'text'},{key:'rent',label:'Warmmiete (€)',type:'money'},{key:'rooms',label:'Oda',type:'number'},{key:'available',label:'Taşınma',type:'date'}]};
 await flow.call(id,interview.id,'configure_automation_table',table);
 const updated=await flow.call(id,interview.id,'update_automation_cells',{itemId:item.id,cells:[{key:'rent',value:'1400.50'},{key:'rooms',value:'2'},{key:'available',value:'2026-11-01'}]});
 assert.deepEqual(updated.cells,{rent:'1400.5',rooms:'2',available:'2026-11-01'});
 for(const field of ['status','digest','approvedDigest','proposal','revision','url','updatedAt','starred'])assert.equal(updated[field],saved[field]);
 for(const field of ['mode','revision','reviewedRevision','intervalMinutes'])assert.equal(db.get(id)[field],before[field]);assert.deepEqual(db.get(id).trial,before.trial);assert.equal(db.results(id).length,1);
 const other=db.create('housing',setup),otherRun=db.begin(other.id,'interview');await assert.rejects(flow.call(other.id,otherRun.id,'configure_automation_table',table),/geçersiz/);assert.throws(()=>db.updateCells(other.id,item.id,[]),/bu çalışma alanına/);
 const template=db.saveTemplate({...automationTemplate('housing'),table});assert.deepEqual(reusableTemplate(template).table,table);
 db.finish(id,interview.id,'completed','Table updated');const next=db.begin(id,'run');const rerecorded=record(db,id,next);assert.deepEqual(rerecorded.cells,updated.cells);assert.equal(rerecorded.starred,true);
});

test('table schema and cells reject authority fields, unsafe URLs and ambiguous typed values',()=>{
 const table={title:'Evler',columns:[{key:'source',label:'Site',type:'text'},{key:'title',label:'Ev',type:'text'},{key:'price',label:'Kira',type:'money'},{key:'date',label:'Tarih',type:'date'},{key:'link',label:'Bağlantı',type:'url'}]};
 assert.deepEqual(automationTable(table),table);
 for(const key of ['status','updatedAt','__proto__','constructor','source'])assert.throws(()=>automationTable({...table,columns:[...table.columns,{key,label:'X',type:'text'}]}));
 assert.throws(()=>automationTable({...table,columns:table.columns.slice(1)}),/korunmalı/);
 for(const [key,value] of [['price','1.400,50'],['price','NaN'],['date','2026-02-30'],['link','javascript:alert(1)'],['link','https://user:pass@example.com'],['status','completed']])assert.throws(()=>automationCells([{key,value}],table));
 assert.deepEqual(automationCells([{key:'price',value:''}],table),{price:''});
 assert.throws(()=>automationCells([{key:'price',value:'1'},{key:'price',value:'2'}],table),/benzersiz/);
});

test('incomplete interview drafts preserve source requests without granting them browser access',()=>{
 const pending=prepareAutomationChat('Randevu bul',{goal:'',criteria:{},sources:['sen bul','https://example.com/results#top']});
 assert.deepEqual(pending.draft.sources,['https://example.com/results']);assert.equal(pending.draft.goal,'');assert.match(pending.message,/sen bul/);
 assert.throws(()=>prepareAutomationChat('Randevu bul',{sources:['https://user:secret@example.com']}),/Kullanıcı/);
 assert.throws(()=>prepareAutomationChat('Randevu bul',{sources:['file:///etc/passwd']}),/HTTP/);
 assert.throws(()=>prepareAutomationChat('x'.repeat(12000),{sources:['sen bul']}),/12000/);
});

test('Agent settings can be saved during a run without changing its plan or action authority',t=>{
 const {db,id}=fixture(t);trial(db,id);db.enable(id);const run=db.begin(id,'run'),before=db.get(id),settings={...before.agentSettings,network:false};
 db.save(id,{agentSettings:settings});const after=db.get(id);
 assert.deepEqual(after.agentSettings,settings);
 for(const key of ['revision','reviewedRevision','mode','status','goal','nextRunAt'])assert.deepEqual(after[key],before[key]);
 assert.deepEqual(after.trial,before.trial);assert.equal(db.run(run.id).status,'running');
 assert.throws(()=>db.save(id,{agentSettings:settings,goal:'Changed'}),/durdur/);
 assert.throws(()=>db.save(id,{agentSettings:{...settings,provider:'unknown'}}),/sağlayıcı/);
});

test('browser selection persists and requires a new trial while keeping the plan and records',t=>{
 const {db,id}=fixture(t);trial(db,id);const before=db.get(id);
 const selected=db.save(id,{browserMode:'jev',chromeProfile:{directory:'Profile 1',name:'Work'}});
 assert.equal(selected.browserMode,'jev');assert.equal(db.get(id).chromeProfile.directory,'Profile 1');
 assert.equal(selected.revision,before.revision);assert.equal(selected.reviewedRevision,before.reviewedRevision);assert.equal(selected.trial,null);assert.equal(selected.status,'paused');
 assert.throws(()=>db.begin(id,'run'),/deneme/);assert.throws(()=>db.save(id,{browserMode:'unknown'}),/tarayıcı/);
 assert.throws(()=>db.save(id,{chromeProfile:{directory:'../other',name:'Other'}}),/profil/);
 const run=db.begin(id,'trial');assert.throws(()=>db.save(id,{browserMode:'separate'}),/durdur/);db.finish(id,run.id,'interrupted','Stopped');
 assert.equal(db.get(id).browserMode,'jev');
});

test('templates are isolated; jobs remain in the existing workspace and generic tasks do not create candidates',t=>{
 const {store,db,id}=fixture(t),job=store.saveProfile({name:'Existing',preferences:'Remote'}),other=db.create('appointment');
 assert.equal(store.candidates().length,1);assert.equal(db.list().length,2);assert.equal(automationTemplate('housing').fields.length,4);
 const interview=db.begin(id,'interview');db.save(id,{criteria:{...setup.criteria,budget:'1800 EUR'}},{agent:true});db.finish(id,interview.id,'completed','Updated');
 assert.equal(db.get(other.id).criteria.budget,undefined);assert.equal(store.profile(job.id).preferences,'Remote');
 assert.throws(()=>db.create('job-search'),/aday/);assert.throws(()=>webUrl('https://user:secret@example.com'),/Kullanıcı/);assert.throws(()=>webUrl('file:///tmp/test'));
});
test('reusable templates carry questions and workflow, never instance data or activation authority',t=>{
 const {db,id}=fixture(t),base=automationTemplate('housing');const template=db.saveTemplate({...base,title:'Berlin evleri',description:'Ev arama başlangıcı',guidance:'Read listings and prepare a message',facts:'Private person',sources:['https://private.example'],mode:'auto',trial:{status:'passed'}});
 const portable=reusableTemplate(template);assert.equal(portable.facts,undefined);assert.equal(portable.sources,undefined);assert.equal(portable.trial,undefined);assert.equal(portable.defaultMode,'observe');
 const a=db.create(template.id);assert.deepEqual(a.criteria,{});assert.equal(a.goal,'');assert.equal(a.mode,'observe');assert.equal(a.trial,null);assert.equal(db.template(a.templateId).guidance,template.guidance);assert.equal(db.catalog().length,5);assert.equal(db.get(id).title,setup.title);
 assert.throws(()=>db.saveTemplate({...base,fields:[...base.fields,base.fields[0]]}),/benzersiz/);
});
test('completed goals stop scheduling; timeouts block retries and respect concurrency',async t=>{
 const {db,id}=fixture(t);trial(db,id);db.enable(id);const runtime=new WebTasks(db,{concurrency:1,launch:async()=>({close:async()=>{}})});t.after(()=>runtime.close());
 await runtime.start(id);const other=db.create('housing',setup);trial(db,other.id);await assert.rejects(runtime.start(other.id),/en fazla/);
 runtime.report(id,runtime.active.get(id).run.id,'completed','User-defined goal achieved',true);await runtime.finish(id);assert.equal(db.get(id).status,'complete');await runtime.tick();assert.equal(runtime.active.size,0);
 db.enable(id);await runtime.start(id);await runtime.finish(id,'timeout','Timed out');assert.equal(db.get(id).status,'blocked');await runtime.tick();assert.equal(runtime.active.size,0);
});
test('review and a real trial are required; updates invalidate previous evidence',t=>{
 const {db,id}=fixture(t);assert.throws(()=>db.enable(id),/deneme/);assert.throws(()=>db.begin(id,'trial'),/kurulum/);
 db.review(id);let run=db.begin(id,'trial');const result=db.finish(id,run.id,'completed','No actual browser');assert.equal(result.status,'failed');assert.throws(()=>db.enable(id));
 trial(db,id);db.enable(id);assert.equal(db.get(id).status,'enabled');db.pause(id);db.save(id,{criteria:{...setup.criteria,budget:'1600 EUR'}});assert.equal(db.get(id).trial,null);assert.equal(db.get(id).status,'draft');assert.throws(()=>db.begin(id,'run'));
});
test('every source origin needs evidence; blocked trials never pass',t=>{
 const {db,id}=fixture(t);db.save(id,{sources:[...setup.sources,'https://second.example/']});db.review(id);const run=db.begin(id,'trial');db.observe(id,run.id,setup.sources[0],'Observed');assert.equal(db.finish(id,run.id,'completed','Done').status,'failed');
 const blocked=db.begin(id,'trial');for(const url of db.get(id).sources)db.observe(id,blocked.id,url,'Login required');db.finish(id,blocked.id,'blocked','Login needed');assert.equal(db.get(id).trial.status,'failed');
});
test('optional action tracking respects the saved mode and exact proposal approval',t=>{
 const {db,id}=fixture(t);trial(db,id);db.save(id,{mode:'observe'});let run=db.begin(id,'run'),item=record(db,id,run);assert.throws(()=>db.reserve(id,run.id,item.id),/gözlem/);db.finish(id,run.id,'completed','Found');
 db.save(id,{mode:'prepare'});db.approve(id,item.id);run=db.begin(id,'run');item=record(db,id,run,'1','Changed message');assert.equal(item.approvedDigest,null);assert.throws(()=>db.reserve(id,run.id,item.id),/onay/);db.finish(id,run.id,'completed','Review');
 db.approve(id,item.id);run=db.begin(id,'run');db.reserve(id,run.id,item.id);assert.equal(db.run(run.id).actionId,item.id);db.observe(id,run.id,item.url,'Message sent');db.resolve(id,run.id,item.id,{status:'completed',evidence:'Message sent',url:item.url});assert.equal(db.run(run.id).actionId,null);db.finish(id,run.id,'completed','Sent');
 run=db.begin(id,'trial');item=record(db,id,run,'2');assert.throws(()=>db.reserve(id,run.id,item.id),/gözlem/);db.finish(id,run.id,'blocked','Test');assert.throws(()=>db.approve(id,item.id),/Güncel/);
});
test('daily limits count interrupted attempts and cannot be bypassed with a new listing key',t=>{
 const {db,id}=fixture(t);trial(db,id);db.save(id,{mode:'auto',maxActionsPerDay:1});let run=db.begin(id,'run'),item=record(db,id,run);db.reserve(id,run.id,item.id);db.finish(id,run.id,'interrupted','Stopped');assert.equal(db.result(id,item.id).status,'uncertain');
 run=db.begin(id,'run');const duplicate=db.record(id,run.id,{key:'different-key',url:item.url,title:'Again',summary:'Again',proposal:'New words'});assert.equal(duplicate.id,item.id);assert.equal(duplicate.duplicate,true);assert.throws(()=>db.reserve(id,run.id,item.id));
 const second=record(db,id,run,'2');assert.throws(()=>db.reserve(id,run.id,second.id),/Günlük/);db.observe(id,run.id,item.url,'Previously sent');db.resolve(id,run.id,item.id,{status:'completed',evidence:'History confirms message',url:item.url});db.finish(id,run.id,'completed','Verified');assert.equal(db.result(id,item.id).status,'completed');
});
test('counts, export data and approval invalidation cover results older than the UI window',t=>{
 const {db,id}=fixture(t);trial(db,id);const run=db.begin(id,'run');let first;
 for(let n=0;n<503;n++){const item=record(db,id,run,String(n));if(!first)first=item;}
 db.finish(id,run.id,'completed','Prepared');db.approve(id,first.id);
 assert.equal(db.results(id).length,500);assert.equal(db.results(id,{all:true}).length,503);
 assert.equal(db.resultCounts(id).resultCount,503);assert.equal(db.resultCounts(id).pendingCount,502);
 db.save(id,{goal:'Find a different home'});assert.equal(db.result(id,first.id).approvedDigest,undefined);assert.equal(db.resultCounts(id).pendingCount,503);
});
test('scheduler reserves once and holds a blocked source until an explicit retry',async t=>{
 const {db,id}=fixture(t);trial(db,id);db.enable(id);let launches=0,closes=0;const runtime=new WebTasks(db,{launch:async()=>{launches++;return {close:async()=>{closes++;}};}});t.after(()=>runtime.close());
 await runtime.tick();await runtime.tick();await settle();assert.equal(launches,1);await assert.rejects(runtime.start(id),/zaten/);const run=runtime.active.get(id).run;runtime.report(id,run.id,'blocked','Login expired');await runtime.finish(id);assert.equal(closes,1);assert.equal(db.get(id).status,'enabled');await runtime.tick();assert.equal(launches,1);assert.equal(db.sources(id)[0].blocked,true);
 await runtime.runSource(id,setup.sources[0]);await settle();assert.equal(launches,2);await runtime.pause(id);assert.equal(db.get(id).status,'paused');
});
test('stop during launch waits for termination and stale sessions cannot mutate',async t=>{
 const {db,id}=fixture(t);trial(db,id);let release,closed=0;const runtime=new WebTasks(db,{launch:()=>new Promise(resolve=>{release=()=>resolve({close:async()=>{closed++;}});})});t.after(()=>runtime.close());
 const start=runtime.start(id);await settle();const stop=runtime.pause(id);release();await Promise.all([start,stop]);assert.equal(closed,1);assert.equal(db.runs(id)[0].status,'interrupted');assert.throws(()=>db.record(id,db.runs(id)[0].id,{...setup}));
});
test('restart marks a reserved action uncertain and suspends its automation',t=>{
 const {db,id}=fixture(t);trial(db,id);db.save(id,{mode:'auto'});db.enable(id);const run=db.begin(id,'run'),item=record(db,id,run);db.reserve(id,run.id,item.id);db.recover();assert.equal(db.result(id,item.id).status,'uncertain');assert.equal(db.get(id).status,'blocked');assert.equal(db.run(run.id).status,'interrupted');
});
test('a new trial pauses an existing schedule; graceful shutdown also blocks uncertain sends',async t=>{
 const {db,id}=fixture(t);trial(db,id);db.enable(id);const attempt=db.begin(id,'trial');assert.equal(db.get(id).status,'paused');db.finish(id,attempt.id,'blocked','Session expired');assert.throws(()=>db.enable(id));
 trial(db,id);db.save(id,{mode:'auto'});db.enable(id);const runtime=new WebTasks(db,{launch:async()=>({close:async()=>{}})});t.after(()=>runtime.close());const run=await runtime.start(id),item=record(db,id,run);db.reserve(id,run.id,item.id);await runtime.close();assert.equal(db.get(id).status,'blocked');assert.equal(db.result(id,item.id).status,'uncertain');
});
test('log cleanup removes completed automation output and preserves active run output',async t=>{
 const {store}=fixture(t),data=await mkdtemp(path.join(tmpdir(),'loop-retention-'));t.after(()=>rm(data,{recursive:true,force:true}));for(const id of ['active','complete']){await mkdir(path.join(data,'automations','runs',id),{recursive:true});await writeFile(path.join(data,'automations','runs',id,'terminal.log'),'Output');}
 const result=await pruneLogs({dataDirectory:data,db:store.db,clear:true,activeBackgroundRunIds:['active']});assert.equal(result.terminalFiles,1);assert.equal(await readFile(path.join(data,'automations','runs','active','terminal.log'),'utf8'),'Output');await assert.rejects(readFile(path.join(data,'automations','runs','complete','terminal.log')));
});
test('a failed process close retains the slot until a later stop confirms termination',async t=>{
 const {db,id}=fixture(t);trial(db,id);let stops=0;const runtime=new WebTasks(db,{launch:async()=>({close:async()=>{if(++stops===1)throw Error('Still running');}})});t.after(()=>runtime.close());await runtime.start(id);
 await assert.rejects(runtime.pause(id),/Still running/);assert.equal(runtime.active.size,1);assert.equal(db.get(id).status,'blocked');await assert.rejects(runtime.start(id),/zaten/);await runtime.pause(id);assert.equal(runtime.active.size,0);assert.equal(stops,2);
});
test('browser tools enforce session ownership and step limits without browser authority gates',async t=>{
 const {store,db,id}=fixture(t);trial(db,id);db.save(id,{maxBrowserSteps:5});const run=db.begin(id,'run'),controller=new AbortController();let writes=0;
 const browser={async call(owner,name,args){if(name==='browser_click')writes++;return {content:[{type:'text',text:'### Page\n- Page URL: https://example.com/homes\n- Heading: Actual listings'}]};}};
 const flow=automationWorkflow({db,run,signal:controller.signal,browser,report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
 await assert.rejects(flow.call('foreign',run.id,'get_automation_context',{}),/geçersiz/);
 await assert.rejects(flow.call(id,run.id,'save_automation_plan',{}),/kurulum/);
 await flow.call(id,run.id,'browser_open',{url:'https://other.example/'});
 await flow.call(id,run.id,'browser_interact',{operation:'click',ref:'e1'});assert.equal(writes,1);
 const mcp=await startMcp(store,()=>{},async()=>({}),null,null,flow);t.after(()=>mcp.close());const token=mcp.grant(id,run.id);
 const call=async(method,params)=>{const r=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return r.json();};
 const list=(await call('tools/list')).result.tools.map(t=>t.name);assert.ok(list.includes('browser_open'));assert.ok(!list.includes('browser_run_code'));assert.ok(!list.includes('record_submission'));
 const denied=await call('tools/call',{name:'browser_click',arguments:{ref:'e1'}});assert.equal(denied.result.isError,true);
 await flow.call(id,run.id,'browser_read',{});assert.equal(db.run(run.id).observations.length,4);while(db.run(run.id).browserSteps<5)await flow.call(id,run.id,'browser_read',{});await assert.rejects(flow.call(id,run.id,'browser_read',{}),/sınır/);
 controller.abort();await assert.rejects(flow.call(id,run.id,'get_automation_context',{}),/geçersiz/);
});
test('interviews can research and interact without activating sources or scheduling work',async t=>{
 const {db,id}=fixture(t),run=db.begin(id,'interview'),controller=new AbortController();let current='',calls=0;
 const browser={async call(owner,name,args){calls++;if(name==='browser_navigate')current=args.url;return {content:[{type:'text',text:'### Page\n- Page URL: '+current+'\n- Official appointment instructions'}]};}};
 const flow=automationWorkflow({db,run,signal:controller.signal,browser,report:()=>{}});
 const schema=flow.tools.find(t=>t.name==='save_automation_plan').inputSchema;
 assert.deepEqual(schema.properties.criteria.items.properties.key.enum,['location','budget','requirements','introduction']);
 assert.doesNotThrow(()=>validate(flow.tools.find(t=>t.name==='research_automation_source').inputSchema,{url:'https://official.example/appointments'}));assert.doesNotThrow(()=>validate(flow.tools.find(t=>t.name==='reply_to_user').inputSchema,{message:'Kaynakları inceliyorum'}));
 await flow.call(id,run.id,'research_automation_source',{url:'https://official.example/appointments'});assert.equal(db.run(run.id).observations.length,1);assert.deepEqual(db.get(id).sources,setup.sources);assert.equal(db.get(id).reviewedRevision,null);
 const previous=calls;await flow.call(id,run.id,'browser_interact',{operation:'click',ref:'e1'});assert.equal(calls,previous+3);
 await assert.rejects(flow.call(id,run.id,'research_automation_source',{url:'http://127.0.0.1/private'}),/herkese açık/);
 while(db.run(run.id).browserSteps<12)await flow.call(id,run.id,'browser_read',{});await assert.rejects(flow.call(id,run.id,'browser_read',{}),/sınır/);
 for(const url of ['http://localhost/a','http://service.internal/','http://[::1]/','file:///etc/passwd'])assert.throws(()=>researchUrl(url));
 db.finish(id,run.id,'completed','Sources researched');trial(db,id);const trialRun=db.begin(id,'trial'),trialFlow=automationWorkflow({db,run:trialRun,signal:controller.signal,browser,report:()=>{}});await assert.rejects(trialFlow.call(id,trialRun.id,'research_automation_source',{url:'https://unapproved.example/'}),/kurulum/);
});
test('complete navigation history survives excerpt rotation without bloating agent context',async t=>{
 const {db,id}=fixture(t);trial(db,id);const run=db.begin(id,'run');
 for(let n=1;n<=35;n++)db.observe(id,run.id,`https://example.com/homes?page=${n}`,'Listings observed '.repeat(120));
 const saved=db.run(run.id);assert.equal(saved.observations.length,20);assert.equal(saved.navigation.length,35);
 assert.equal(saved.navigation[0].url,'https://example.com/homes?page=1');assert.equal(saved.navigation.at(-1).url,'https://example.com/homes?page=35');
 const flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:{},report:()=>{}});
 const context=await flow.call(id,run.id,'get_automation_context',{});
 assert.equal(context.currentRun.navigation,undefined);assert.equal(context.currentRun.navigationCount,35);
 assert.ok(context.previousRuns.every(r=>r.navigation===undefined));
 assert.deepEqual(context.currentRun.observations,saved.observations.slice(-3).map(({url,at})=>({url,at})));
 assert.ok(context.previousRuns.every(r=>r.observations.length<=3&&r.observations.every(o=>o.evidence===undefined)));
 assert.ok(!JSON.stringify(context).includes('Listings observed'));
 assert.equal(db.run(run.id).observations[0].evidence.length,2000);
 db.finish(id,run.id,'completed','35 pages observed');assert.equal(db.run(run.id).navigation.length,35);
});
test('interview samples require an observed source detail and cannot authorize or schedule actions',async t=>{
 const {db,id}=fixture(t),run=db.begin(id,'interview');let current='';
 const browser={async call(owner,name,args){if(name==='browser_navigate')current=args.url;return {content:[{type:'text',text:'Page URL: '+current+'\nObserved listing details'}]};}};
 const flow=automationWorkflow({db,run,signal:new AbortController().signal,browser,report:()=>{}});
 const sample={url:'https://example.com/homes/1',key:'1',title:'Sample listing',summary:'Observed rent; personal suitability unknown.',proposal:''};
 await assert.rejects(flow.call(id,run.id,'record_automation_result',sample),/önce bu turda gözlemle/);
 await flow.call(id,run.id,'research_automation_source',{url:sample.url});
 await assert.rejects(flow.call(id,run.id,'record_automation_result',{...sample,proposal:'Send a message'}),/işlem taslağı/);
 await flow.call(id,run.id,'research_automation_source',{url:'https://outside.example/home'});
 const linked=await flow.call(id,run.id,'record_automation_result',{...sample,url:'https://outside.example/home'});assert.equal(linked.url,'https://outside.example/home');assert.equal(linked.trial,true);
 const saved=await flow.call(id,run.id,'record_automation_result',sample);
 assert.equal(saved.trial,true);assert.equal(saved.sampleKind,'interview');assert.equal(saved.status,'found');assert.equal(saved.proposal,'');
 assert.equal(db.resultCounts(id).storedCount,2);assert.equal(db.resultCounts(id).resultCount,0);
 assert.throws(()=>db.reserve(id,run.id,saved.id),/gözlem/);
 db.finish(id,run.id,'completed','Sources and examples observed');
 assert.equal(db.get(id).reviewedRevision,null);assert.equal(db.get(id).trial,null);assert.equal(db.get(id).nextRunAt,null);
 assert.throws(()=>db.approve(id,saved.id),/Güncel/);assert.throws(()=>db.enable(id),/deneme/);
 trial(db,id);const liveRun=db.begin(id,'run'),live=record(db,id,liveRun);
 assert.equal(live.id,saved.id);assert.equal(live.trial,false);assert.equal(live.sampleKind,null);assert.equal(db.resultCounts(id).resultCount,1);
});
for(const kind of ['interview','trial'])test(`${kind} samples never replace live records or their exact approvals`,t=>{
 const {db,id}=fixture(t);trial(db,id);const run=db.begin(id,'run'),saved=record(db,id,run);
 db.finish(id,run.id,'completed','Prepared');db.approve(id,saved.id);const before=db.result(id,saved.id);
 const sampleRun=db.begin(id,kind);db.observe(id,sampleRun.id,before.url,'Observed listing details');
 const duplicate=record(db,id,sampleRun,'1','');assert.equal(duplicate.duplicate,true);assert.deepEqual(db.result(id,saved.id),before);
 assert.equal(db.resultCounts(id).resultCount,1);assert.equal(db.resultCounts(id).storedCount,1);
});
test('backup includes automation documents, pauses schedules and clears approvals and trial on restore',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'loop-automation-backup-'));t.after(()=>rm(root,{recursive:true,force:true}));const data=path.join(root,'data');await mkdir(data);const store=new Store(path.join(data,'jobloop.sqlite')),db=new AutomationStore(store),a=db.create('housing',setup);trial(db,a.id);db.enable(a.id);
 const documents=path.join(data,'automations','workspaces',a.id,'documents');await mkdir(documents,{recursive:true});await writeFile(path.join(documents,'intro.txt'),'A tenant introduction');
 const backup=path.join(root,'backup');await createBackup({dataDirectory:data,db:store.db,destination:backup,appVersion:'test'});assert.equal(await readFile(path.join(backup,'automations','workspaces',a.id,'documents','intro.txt'),'utf8'),'A tenant introduction');
 await stageRestore({dataDirectory:data,directory:backup,db:store.db,appVersion:'test'});store.close();await applyPendingRestore({dataDirectory:data});const restored=new Store(path.join(data,'jobloop.sqlite'));t.after(()=>restored.close());const db2=new AutomationStore(restored);assert.equal(db2.get(a.id).status,'paused');assert.equal(db2.get(a.id).trial,null);assert.equal(db2.get(a.id).reviewedRevision,null);
});
