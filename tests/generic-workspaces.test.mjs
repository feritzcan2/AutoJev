import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {templateContract} from '../app/template-contract.mjs';
import {workspaceTableCall} from '../app/workspace-table-tools.mjs';
const car=JSON.parse(await readFile(new URL('./fixtures/car-search.loop-template.json',import.meta.url))).template;
const settle=()=>new Promise(r=>setTimeout(r,0));
function fixture(t){const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),template=db.saveTemplate(car),a=db.create(template.id,{goal:'Berlin’de uygun araba bul',criteria:{location:'Berlin',budget:'15000',transmission:'Otomatik'},sources:['https://cars.test/a','https://cars.test/b']});db.review(a.id);const trial=db.begin(a.id,'trial');for(const url of a.sources)db.observe(a.id,trial.id,url,'Gerçek ilan örnekleri');db.finish(a.id,trial.id,'completed','Kaynaklar okundu');return {store,db,id:a.id};}

test('a new car template defines fields, states and executable operations without application code changes',()=>{
 const definition=templateContract(car);assert.equal(definition.execution.maxWorkers,8);assert.equal(definition.fields[2].type,'choice');assert.equal(definition.workflow.length,4);
 assert.throws(()=>templateContract({...car,workflow:[{...car.workflow[0],after:['contact']},...car.workflow.slice(1)]}),/bağımlılığı/);
 assert.throws(()=>templateContract({...car,workflow:[{...car.workflow[0],capability:'shell.execute'}]}),/adımı/);
});

test('job and web records have one physical store and shared table/state tools preserve evidence',t=>{
 const {store,db,id}=fixture(t),p=db.create('job-search',{title:'Test'}),job=db.putResult({id:'job',automationId:p.id,key:'job',url:'https://jobs.test/1',title:'Engineer',status:'found'});
 const run=db.begin(id,'run'),record=db.record(id,run.id,{url:'https://cars.test/car/1',title:'Car',summary:'Observed',cells:[{key:'price',value:'12000'}]});
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM workspace_records').get().n,2);assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('jobs','automation_results','agent_workers','agent_conversations','conversation_launch_settings')").get().n,0);
 const changed=workspaceTableCall(store,id,'transition_workspace_record',{itemId:record.id,actionId:'shortlist'});assert.equal(changed.workflowState,'shortlisted');assert.equal(changed.status,'found');assert.equal(changed.digest,record.digest);
 assert.throws(()=>workspaceTableCall(store,id,'update_workspace_cells',{itemId:job.id,cells:[]}),/ait/);assert.equal(db.result(p.id,job.id).status,'found');
});

test('two workers execute one declarative graph, wait for closure, and never execute an unapproved send',async t=>{
 const {store,db,id}=fixture(t),worker=store.workspaces.workers.add(id);db.save(id,{mode:'prepare'});const launched=[];
 const runtime=new WebTasks(db,{launch:async(run)=>{launched.push(run);return {close:async()=>{}};}});t.after(()=>runtime.close());
 await runtime.runOnce(id);await settle();assert.equal(launched.length,2);assert.deepEqual(new Set(launched.map(r=>r.workerId)),new Set(['main',worker.id]));
 const finish=async run=>{runtime.report(id,run.id,'completed','Adım tamamlandı');await runtime.finish(id,'completed','Adım tamamlandı',run.workerId);};
 for(const [index,run]of launched.slice().entries()){db.record(id,run.id,{url:'https://cars.test/car/'+index,title:'Car '+index,summary:'Observed details',cells:[{key:'price',value:'12000'}]});runtime.report(id,run.id,'completed','Bulundu');}
 await runtime.tick();assert.equal(launched.length,2,'downstream steps must wait for provider closure');
 for(const run of launched.slice())await runtime.finish(id,'completed','Bulundu',run.workerId);
 await runtime.tick();await settle();assert.equal(launched.length,4);assert.deepEqual(launched.slice(2).map(r=>r.operation),['evaluate','evaluate']);assert.notEqual(launched[2].recordId,launched[3].recordId);
 for(const run of launched.slice(2)){store.workspaces.transition(id,run.recordId,'shortlist');assert.throws(()=>db.reserve(id,run.id,run.recordId),/adımı/);await finish(run);}
 await runtime.tick();await settle();assert.equal(launched.length,6);assert.deepEqual(launched.slice(4).map(r=>r.operation),['prepare','prepare']);
 for(const run of launched.slice(4)){const r=db.result(id,run.recordId);db.record(id,run.id,{key:r.key,url:r.url,title:r.title,summary:r.summary,proposal:'Merhaba, araç hâlâ satılık mı?'});await finish(run);}
 await runtime.tick();assert.equal(db.get(id).status,'paused');assert.equal(launched.length,6);assert.equal(db.results(id).filter(r=>r.status==='prepared').length,2);assert.equal(store.workspaces.tasks.list(id,{states:['running','reported','paused']}).length,0);
});

test('worker record claims and dependencies are durable and cannot cross workspaces',t=>{
 const {store,id}=fixture(t),queue=store.workspaces.tasks,first=queue.enqueue(id,{operation:'one',lockKey:'record:1'}),second=queue.enqueue(id,{operation:'two',dependsOn:[first.id],lockKey:'record:1'});
 queue.claim(id,first.id,'main');assert.throws(()=>queue.claim(id,second.id,'second'),/tamamlanmadı/);queue.finish(id,first.id);queue.claim(id,second.id,'second');
 const third=queue.enqueue(id,{operation:'three',lockKey:'record:1'});assert.throws(()=>queue.claim(id,third.id,'main'),/başka bir worker/);
 const outsider=new AutomationStore(store).create('custom',{title:'Other'});assert.throws(()=>queue.enqueue(outsider.id,{id:second.id}),/başka çalışma/);
});

test('schema four migration preserves records, question relations, approvals and worker names',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'loop-generic-v4-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'db.sqlite'),db=new DatabaseSync(file);
 db.exec(`PRAGMA user_version=4; CREATE TABLE candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE jobs(id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES candidates(id),url TEXT,identity TEXT,data TEXT); CREATE TABLE questions(id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES candidates(id),job_id TEXT REFERENCES jobs(id),question TEXT,answer TEXT,created_at TEXT); CREATE TABLE automations(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE automation_results(id TEXT PRIMARY KEY,automation_id TEXT REFERENCES automations(id),item_key TEXT,data TEXT); CREATE TABLE agent_workers(candidate_id TEXT REFERENCES candidates(id),id TEXT,data TEXT,PRIMARY KEY(candidate_id,id));`);
 const p={id:'person',name:'Test',preferences:'Remote'},job={id:'job',candidateId:p.id,company:'ACME',role:'Dev',location:'Berlin',url:'https://jobs.test/1',status:'submitted',proof:{text:'Confirmation',url:'https://jobs.test/receipt'}},a={id:'housing',templateId:'housing',title:'Berlin',sources:[],criteria:{},mode:'prepare',revision:3,status:'paused'},record={id:'home',automationId:a.id,key:'home',title:'Home',url:'https://home.test/1',status:'prepared',digest:'same',approvedDigest:'same'};
 db.prepare('INSERT INTO candidates VALUES(?,?)').run(p.id,JSON.stringify(p));db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id,p.id,job.url,'identity',JSON.stringify(job));db.prepare('INSERT INTO questions VALUES(?,?,?,?,?,?)').run('question',p.id,job.id,'Question','Answer','2026-09-29');db.prepare('INSERT INTO automations VALUES(?,?)').run(a.id,JSON.stringify(a));db.prepare('INSERT INTO automation_results VALUES(?,?,?,?)').run(record.id,a.id,record.key,JSON.stringify(record));db.prepare('INSERT INTO agent_workers VALUES(?,?,?)').run(p.id,'worker',JSON.stringify({id:'worker',name:'My worker'}));db.close();
 let store=new WorkspaceDatabase(file);assert.deepEqual(store.workspaces.records.get(p.id,job.id),job);assert.deepEqual(store.workspaces.records.get(a.id,record.id),record);assert.equal(store.db.prepare('SELECT answer FROM questions WHERE candidate_id=?').get(p.id).answer,'Answer');assert.equal(store.workspaces.workers.list(p.id)[1].name,'My worker');assert.equal(store.workspaces.exists('agent_workers'),false);assert.equal(store.db.prepare('PRAGMA foreign_key_check').get(),undefined);store.close();store=new WorkspaceDatabase(file);assert.equal(store.workspaces.records.count(a.id),1);store.close();
});

test('an imported job template uses the browser contract and canonical record tasks',t=>{
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core);
 const template=db.saveTemplate({...db.template('job-search'),title:'Remote engineering',fields:[{id:'salary',label:'Maaş',question:'Alt sınır?',required:false,type:'money'}]});
 const a=db.create(template.id,{criteria:{salary:'65000'}});assert.equal(core.workspaces.definition(a.id).execution.driver,'browser');assert.equal(db.get(a.id).criteria.salary,'65000');
 const item=db.putResult({id:'job',automationId:a.id,key:'job',title:'Developer',url:'https://jobs.test/1',status:'found'});
 const task=core.workspaces.tasks.enqueue(a.id,{operation:'score',recordId:item.id});assert.equal(core.workspaces.tasks.get(a.id,task.id).recordId,item.id);
 assert.throws(()=>db.save(a.id,{criteria:{salary:'unknown'}}),/sayı gerekli/);
});
test('a failed close retains the shared lease until termination is confirmed',async t=>{
 const {store,db,id}=fixture(t);let fail=true;const runtime=new WebTasks(db,{launch:async()=>({close:async()=>{if(fail)throw Error('still alive');}})});t.after(()=>runtime.close());
 const run=await runtime.start(id,'run');runtime.report(id,run.id,'completed','Observed');await assert.rejects(runtime.finish(id),/still alive/);assert.equal(store.workspaces.tasks.get(id,run.taskId).state,'paused');
 await assert.rejects(runtime.start(id,'run'),/zaten/);fail=false;await runtime.finish(id);assert.equal(runtime.active.size,0);assert.equal(store.workspaces.tasks.list(id,{states:['running','reported','paused']}).length,0);assert.equal(db.get(id).status,'blocked');
});


test('personal job templates, worker queues and histories survive reopening without legacy tables',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'loop-personal-reopen-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'db.sqlite');
 let core=new WorkspaceDatabase(file);t.after(()=>core.close());const db=new AutomationStore(core),template=db.saveTemplate({...db.template('job-search'),title:'Personal applications'}),a=db.create(template.id);
 const worker=core.workspaces.workers.add(a.id,{name:'Helper'}),item=db.putResult({id:'job',automationId:a.id,key:'job',url:'https://jobs.test/custom',title:'Developer',status:'found'});
 const task=core.workspaces.tasks.enqueue(a.id,{operation:'score',recordId:item.id});core.workspaces.tasks.claim(a.id,task.id,worker.id);
 core.workspaces.history(a.id).saveConversation(a.id,'codex','main-history',{});core.workspaces.history(a.id,worker.id).saveConversation(a.id,'claude','helper-history',{});
 const saved=core.workspaces.tasks.get(a.id,task.id);core.close();core=new WorkspaceDatabase(file);
 assert.equal(core.workspaces.get(a.id).templateId,template.id);assert.equal(core.workspaces.definition(a.id).title,template.title);assert.deepEqual(core.workspaces.tasks.get(a.id,task.id),saved);
 assert.equal(core.workspaces.history(a.id).conversation(a.id,'codex'),'main-history');assert.equal(core.workspaces.history(a.id,worker.id).conversation(a.id,'claude'),'helper-history');
 for(const table of ['candidates','jobs','automation_results','agent_workers','worker_state','campaigns'])assert.equal(core.workspaces.exists(table),false,table);
 assert.equal(core.db.prepare('PRAGMA foreign_key_check').get(),undefined);
});