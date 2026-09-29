import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {templateContract} from '../app/template-contract.mjs';
import {workspaceTableCall} from '../app/workspace-table-tools.mjs';
const car=JSON.parse(await readFile(new URL('../docs/examples/car-search.loop-template.json',import.meta.url))).template;
const settle=()=>new Promise(r=>setTimeout(r,0));
function fixture(t){const store=new Store(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),template=db.saveTemplate(car),a=db.create(template.id,{goal:'Berlin’de uygun araba bul',criteria:{location:'Berlin',budget:'15000',transmission:'Otomatik'},sources:['https://cars.test/a','https://cars.test/b']});db.review(a.id);const trial=db.begin(a.id,'trial');for(const url of a.sources)db.observe(a.id,trial.id,url,'Gerçek ilan örnekleri');db.finish(a.id,trial.id,'completed','Kaynaklar okundu');return {store,db,id:a.id};}

test('a new car template defines fields, states and executable operations without application code changes',()=>{
 const definition=templateContract(car);assert.equal(definition.execution.maxWorkers,8);assert.equal(definition.fields[2].type,'choice');assert.equal(definition.workflow.length,4);
 assert.throws(()=>templateContract({...car,workflow:[{...car.workflow[0],after:['contact']},...car.workflow.slice(1)]}),/bağımlılığı/);
 assert.throws(()=>templateContract({...car,workflow:[{...car.workflow[0],capability:'shell.execute'}]}),/adımı/);
});

test('job and web records have one physical store and shared table/state tools preserve evidence',t=>{
 const {store,db,id}=fixture(t),p=store.saveProfile({name:'Test',preferences:'Remote'}),job=store.addJob(p.id,{company:'Example',role:'Engineer',location:'Remote',url:'https://jobs.test/1',fit:'Observed'}).job;
 const run=db.begin(id,'run'),record=db.record(id,run.id,{url:'https://cars.test/car/1',title:'Car',summary:'Observed',cells:[{key:'price',value:'12000'}]});
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM workspace_records').get().n,2);assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('jobs','automation_results','agent_workers','agent_conversations','conversation_launch_settings')").get().n,0);
 const changed=workspaceTableCall(store,id,'transition_workspace_record',{itemId:record.id,actionId:'shortlist'});assert.equal(changed.workflowState,'shortlisted');assert.equal(changed.status,'found');assert.equal(changed.digest,record.digest);
 assert.throws(()=>workspaceTableCall(store,id,'update_workspace_cells',{itemId:job.id,cells:[]}),/ait/);assert.equal(store.job(p.id,job.id).status,'found');
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
 const outsider=store.saveProfile({name:'Other',preferences:'Remote'});assert.throws(()=>queue.enqueue(outsider.id,{id:second.id}),/başka çalışma/);
});

test('schema four migration preserves records, question relations, approvals and worker names',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'loop-generic-v4-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'db.sqlite'),db=new DatabaseSync(file);
 db.exec(`PRAGMA user_version=4; CREATE TABLE candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE jobs(id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES candidates(id),url TEXT,identity TEXT,data TEXT); CREATE TABLE questions(id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES candidates(id),job_id TEXT REFERENCES jobs(id),question TEXT,answer TEXT,created_at TEXT); CREATE TABLE automations(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE automation_results(id TEXT PRIMARY KEY,automation_id TEXT REFERENCES automations(id),item_key TEXT,data TEXT); CREATE TABLE agent_workers(candidate_id TEXT REFERENCES candidates(id),id TEXT,data TEXT,PRIMARY KEY(candidate_id,id));`);
 const p={id:'person',name:'Test',preferences:'Remote'},job={id:'job',candidateId:p.id,company:'ACME',role:'Dev',location:'Berlin',url:'https://jobs.test/1',status:'submitted',proof:{text:'Confirmation',url:'https://jobs.test/receipt'}},a={id:'housing',templateId:'housing',title:'Berlin',sources:[],criteria:{},mode:'prepare',revision:3,status:'paused'},record={id:'home',automationId:a.id,key:'home',title:'Home',url:'https://home.test/1',status:'prepared',digest:'same',approvedDigest:'same'};
 db.prepare('INSERT INTO candidates VALUES(?,?)').run(p.id,JSON.stringify(p));db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id,p.id,job.url,'identity',JSON.stringify(job));db.prepare('INSERT INTO questions VALUES(?,?,?,?,?,?)').run('question',p.id,job.id,'Question','Answer','2026-09-29');db.prepare('INSERT INTO automations VALUES(?,?)').run(a.id,JSON.stringify(a));db.prepare('INSERT INTO automation_results VALUES(?,?,?,?)').run(record.id,a.id,record.key,JSON.stringify(record));db.prepare('INSERT INTO agent_workers VALUES(?,?,?)').run(p.id,'worker',JSON.stringify({id:'worker',name:'My worker'}));db.close();
 let store=new Store(file);assert.deepEqual(store.workspaces.records.get(p.id,job.id),job);assert.deepEqual(store.workspaces.records.get(a.id,record.id),record);assert.equal(store.questions(p.id)[0].answer,'Answer');assert.equal(store.workers(p.id)[1].name,'My worker');assert.equal(store.workspaces.exists('agent_workers'),false);assert.equal(store.db.prepare('PRAGMA foreign_key_check').get(),undefined);store.close();store=new Store(file);assert.equal(store.workspaces.records.count(a.id),1);store.close();
});

test('an imported application template uses the same contract and canonical task payload',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),base=db.template('job-search'),template=db.saveTemplate({...base,title:'Remote engineering',fields:[{id:'salary',label:'Maaş',question:'Alt sınır?',required:false,type:'money'}]});
 const p=store.saveProfile({templateId:template.id,name:'Engineer',preferences:'Remote',criteria:{salary:'65000'}});assert.equal(store.workspaces.definition(p.id).execution.driver,'applications');assert.equal(store.profile(p.id).criteria.salary,'65000');assert.equal(store.workspaces.table(p.id).columns[0].label,'Şirket');
 const job=store.addJob(p.id,{company:'Example',role:'Developer',location:'Remote',url:'https://jobs.test/1',fit:'Match'}).job;store.saveCampaign(p.id,{status:'running',task:{id:'rank-task',kind:'rank',jobId:job.id}});
 const persisted=JSON.parse(store.db.prepare('SELECT data FROM campaigns WHERE candidate_id=?').get(p.id).data);assert.equal(persisted.task,undefined);assert.equal(persisted.taskId,'rank-task');assert.equal(store.workspaces.tasks.get(p.id,'rank-task').payload.jobId,job.id);assert.equal(store.campaign(p.id).task.kind,'rank');
 assert.throws(()=>store.saveProfile({...store.profile(p.id),criteria:{salary:'unknown'}}),/sayı gerekli/);
});

test('a failed close retains the shared lease until termination is confirmed',async t=>{
 const {store,db,id}=fixture(t);let fail=true;const runtime=new WebTasks(db,{launch:async()=>({close:async()=>{if(fail)throw Error('still alive');}})});t.after(()=>runtime.close());
 const run=await runtime.start(id,'run');runtime.report(id,run.id,'completed','Observed');await assert.rejects(runtime.finish(id),/still alive/);assert.equal(store.workspaces.tasks.get(id,run.taskId).state,'paused');
 await assert.rejects(runtime.start(id,'run'),/zaten/);fail=false;await runtime.finish(id);assert.equal(runtime.active.size,0);assert.equal(store.workspaces.tasks.list(id,{states:['running','reported','paused']}).length,0);assert.equal(db.get(id).status,'blocked');
});


test('personal application templates, worker queues and conversations survive reopening without legacy tables',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'loop-personal-reopen-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'db.sqlite');
 let store=new Store(file);t.after(()=>store.close());const db=new AutomationStore(store);
 const template=db.saveTemplate({...db.template('job-search'),title:'Personal application flow'});
 const profile=store.saveProfile({templateId:template.id,name:'Test',preferences:'Remote'}),worker=store.workerState.add(profile.id,{name:'Helper'});
 const scope=store.forWorker(worker.id),job=store.addJob(profile.id,{company:'ACME',role:'Developer',location:'Remote',url:'https://jobs.test/custom',fit:'Observed'}).job;
 store.saveConversation(profile.id,'codex','main-history',{});scope.saveConversation(profile.id,'claude','helper-history',{});
 store.saveCampaign(profile.id,{status:'paused',attempts:{[job.id]:2},pendingRetries:{[job.id]:{requestId:'retry'}}});
 scope.saveCampaign(profile.id,{status:'running',task:{id:'custom-rank',kind:'rank',jobId:job.id}});
 const persisted=store.db.prepare("SELECT data FROM worker_state WHERE candidate_id=? AND worker_id=? AND kind='campaign'").get(profile.id,worker.id);
 assert.equal(JSON.parse(persisted.data).attempts,undefined,'shared retry maps are stored only once');
 const taskBefore=store.workspaces.tasks.get(profile.id,'custom-rank');store.close();store=new Store(file);
 assert.equal(store.profile(profile.id).templateId,template.id);assert.equal(store.workspaces.definition(profile.id).title,template.title);
 assert.deepEqual(store.workspaces.tasks.get(profile.id,'custom-rank'),taskBefore);
 assert.equal(store.forWorker(worker.id).campaign(profile.id).pendingRetries[job.id].requestId,'retry');
 assert.equal(store.forWorker(worker.id).campaign(profile.id).attempts[job.id],2);
 assert.equal(store.conversation(profile.id,'codex'),'main-history');assert.equal(store.forWorker(worker.id).conversation(profile.id,'claude'),'helper-history');
 for(const table of ['jobs','automation_results','agent_workers','agent_conversations','conversation_launch_settings'])assert.equal(store.workspaces.exists(table),false,table);
 assert.equal(store.db.prepare('PRAGMA foreign_key_check').get(),undefined);
});
