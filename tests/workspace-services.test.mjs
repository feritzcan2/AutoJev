import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {Workspaces} from '../app/workspaces.mjs';
import {WorkspaceDocuments} from '../app/workspace-documents.mjs';
import {WorkerCampaigns} from '../app/worker-campaigns.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {addRankedJob} from './rank-fixture.mjs';

const raw=(store,table,id)=>JSON.parse(store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id).data);
const assertDomain=value=>{for(const key of ['agentSettings','browserMode','chromeProfile','table'])assert.equal(Object.hasOwn(value,key),false,key);};
function fixture(t){const store=new Store(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),job=store.saveProfile({name:'Test',preferences:'Remote',facts:'Berlin',authorization:'submit'}),web=db.create('housing');return {store,db,job,web};}

test('all profile mutations keep provider, browser and table settings only in workspaces',t=>{
 const {store,job}=fixture(t),canonical=store.workspaces.get(job.id);
 const mutations=[()=>store.setCv(job.id,'/tmp/CV.pdf'),()=>store.rememberFact(job.id,{key:'location',value:'Berlin',source:'profile',sourceId:job.id,evidence:'Berlin'}),()=>store.saveApplicationPolicy(job.id,{acceptPrivacy:true}),()=>store.saveRankThreshold(job.id,65),()=>store.renameWorkspace(job.id,'Renamed'),()=>store.saveProfile({...store.profile(job.id),name:'Updated'})];
 for(const mutate of mutations){mutate();assertDomain(raw(store,'candidates',job.id));const p=store.profile(job.id);assert.deepEqual(p.agentSettings,canonical.agentSettings);assert.equal(p.browserMode,canonical.browserMode);assert.deepEqual(p.table,canonical.table);}
 assert.equal(store.profile(job.id).learnedFacts.location.value,'Berlin');assert.equal(store.profile(job.id).rankThreshold,65);assert.equal(store.profile(job.id).cvPath,'/tmp/CV.pdf');
});

test('migration removes stale copies without overwriting canonical settings and is repeatable',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'loop-settings-migration-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'db.sqlite');
 let store=new Store(file);const db=new AutomationStore(store),job=store.saveProfile({name:'Test',preferences:'Remote',browserMode:'jev'}),web=db.create('custom');
 for(const [table,id] of [['candidates',job.id],['automations',web.id]])store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify({...raw(store,table,id),browserMode:'existing',agentSettings:{provider:'stale'},chromeProfile:{directory:'Old'},table:{title:'Stale',columns:[]}}),id);
 const before=store.workspaces.list();store.close();store=new Store(file);t.after(()=>store.close());
 assert.deepEqual(store.workspaces.list(),before);assertDomain(raw(store,'candidates',job.id));assertDomain(raw(store,'automations',web.id));
 const changes=()=>store.db.prepare('SELECT total_changes() AS n').get().n,prior=changes();store.workspaces.migrate();assert.equal(changes(),prior);
});

function drivers(store,db,pool,runtime){return {
 applications:{rename:(id,name)=>store.renameWorkspace(id,name),remove:id=>store.deleteWorkspace(id),workers:{add:(...a)=>pool.add(...a),start:(...a)=>pool.startWorker(...a),stop:(...a)=>pool.stopWorker(...a),remove:(...a)=>pool.remove(...a),restartState:(...a)=>pool.restartState(...a)}},
 browser:{rename:(id,name)=>db.rename(id,name),remove:id=>db.remove(id),workers:{add:(...a)=>runtime.add(...a),start:(...a)=>runtime.startWorker(...a),stop:(...a)=>runtime.stopWorker(...a),remove:(...a)=>runtime.remove(...a)}}
};}

test('shared worker restart preserves interrupted submissions and isolates other workers',async t=>{
 const {store,db,job,web}=fixture(t);store.setCv(job.id,'/tmp/CV.pdf');
 const record=addRankedJob(store,job.id,{company:'Example',role:'Engineer',location:'Berlin',fit:'Match',url:'https://example.test/job'}).job;
 for(const status of ['working','prepared','submitting'])store.updateJob(job.id,record.id,status,'Form','old-session');
 store.saveCampaign(job.id,{status:'running',target:75,intervalMinutes:45,task:{id:'pending',kind:'application',jobId:record.id,seenWorking:true},attempts:{}});
 const other=store.workerState.add(job.id);store.forWorker(other.id).saveConversation(job.id,'claude','other-worker',{});db.saveConversation(web.id,'codex','other-workspace',{});
 let active={sessionId:'old-session'};const events=[];
 const pool=new WorkerCampaigns(store,{changed:()=>{},active:()=>active,stop:async(id,worker)=>{events.push('stop');store.recoverSession(id,'old-session');store.forWorker(worker).saveConversation(id,'codex','late-thread',{});active=null;},send:async()=>{},launch:async(id)=>{events.push('launch');assert.equal(store.conversation(id,'codex'),null);active={sessionId:'new-session'};}});
 const workspaces=new Workspaces(store.workspaces,{templates:drivers(store,db,pool,{})});
 const result=await workspaces.restartWorker(job.id,'main');assert.equal(result.fresh,true);
 assert.equal(store.campaign(job.id).task.kind,'verify');assert.equal(store.campaign(job.id).target,75);assert.equal(store.campaign(job.id).intervalMinutes,45);assert.equal(store.job(job.id,record.id).status,'uncertain');
 assert.equal(events.at(-1),'launch');assert.equal(store.forWorker(other.id).conversation(job.id,'claude'),'other-worker');assert.equal(db.conversation(web.id,'codex'),'other-workspace');
});

test('web workers share restart ordering, ownership checks and removal cleanup',async t=>{
 const {store,db,job,web}=fixture(t);const launches=[],closed=[];
 db.save(web.id,{goal:'Find homes',criteria:{location:'Berlin',budget:'1500',requirements:'Two rooms'},sources:['https://homes.test/']});db.review(web.id);
 const runtime=new WebTasks(db,{launch:async(run)=>{launches.push(run);return {close:async()=>{closed.push(run.id);store.workspaces.history(web.id,run.workerId).saveConversation(web.id,'claude','late-thread',{});}};}});t.after(()=>runtime.close());
 const removed=[],workspaces=new Workspaces(store.workspaces,{templates:drivers(store,db,{},runtime),workerRemoved:(...args)=>removed.push(args)});
 const worker=await workspaces.addWorker(web.id),foreign=store.workerState.add(job.id);await assert.rejects(workspaces.startWorker(web.id,foreign.id),/ait değil/);
 await workspaces.startWorker(web.id,worker.id);assert.equal(launches.length,1);await workspaces.restartWorker(web.id,worker.id);assert.equal(launches.length,2);assert.equal(closed.length,1);
  assert.equal(store.workspaces.history(web.id,worker.id).conversation(web.id,'claude'),null);
 await workspaces.stopWorker(web.id,worker.id);assert.equal(runtime.slots(web.id).length,0);await workspaces.removeWorker(web.id,worker.id);assert.deepEqual(removed,[[web.id,worker.id]]);
 await assert.rejects(workspaces.removeWorker(web.id,'main'),/İlk worker/);
});

test('a failed stop keeps conversation history and never starts a replacement worker',async t=>{
 const {store,web}=fixture(t);store.workspaces.history(web.id).saveConversation(web.id,'codex','keep',{});
 let starts=0;const workspaces=new Workspaces(store.workspaces,{templates:{browser:{workers:{stop:async()=>{throw Error('Still alive');},start:()=>starts++}}}});
 await assert.rejects(workspaces.restartWorker(web.id,'main'),/Still alive/);assert.equal(starts,0);assert.equal(workspaces.changing.size,0);assert.equal(store.workspaces.history(web.id).conversation(web.id,'codex'),'keep');
});

test('the same workspace APIs rename, delete, import, preview and open documents for both templates',async t=>{
 const {store,db,job,web}=fixture(t),dir=await mkdtemp(path.join(tmpdir(),'loop-documents-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.txt');await writeFile(source,'Document text');let picked=source;const opened=[],added=[],removed=[];
 const templates=drivers(store,db,{},{});
 for(const driver of Object.values(templates))Object.assign(driver,{directory:id=>path.join(dir,id),documentPurposes:['attachment'],documentAdded:(id,doc)=>added.push({id,...doc})});
 templates.applications.documentPurposes.push('cv');templates.applications.documentAdded=(id,doc)=>{added.push({id,...doc});if(doc.purpose==='cv')store.setCv(id,doc.path);};
 const workspaces=new Workspaces(store.workspaces,{templates,workerRemoved:(...args)=>removed.push(args)}),documents=new WorkspaceDocuments(workspaces,{window:()=>null,dialog:{showOpenDialog:async()=>({canceled:!picked,filePaths:[picked]})},shell:{openPath:async file=>{opened.push(file);return '';}}});
 for(const [id,title] of [[job.id,'Jobs renamed'],[web.id,'Homes renamed']]){
  workspaces.rename(id,title);assert.equal(store.workspaces.get(id).title,title);
  const imported=await documents.pick(id);assert.equal(await readFile(imported,'utf8'),'Document text');const [doc]=await documents.list(id);assert.equal(await documents.read(id,doc.path),'Document text');await documents.open(id,doc.path);assert.equal(opened.at(-1),await realpath(imported));
  await assert.rejects(documents.open(id,'../source.txt'));await assert.rejects(documents.read(id,'/tmp/outside.txt'));
  await symlink(source,path.join(dir,id,'outside.txt'));await assert.rejects(documents.open(id,'outside.txt'));
 }
 const cv=await documents.pick(job.id,{purpose:'cv'});assert.equal(store.profile(job.id).cvPath,cv);assertDomain(raw(store,'candidates',job.id));await assert.rejects(documents.pick(web.id,{purpose:'cv'}),/desteklenmiyor/);
 picked=null;assert.equal(await documents.pick(web.id),null);assert.equal(added.length,3);
 for(const id of [web.id,job.id]){await workspaces.remove(id);assert.equal(store.workspaces.has(id),false);assert.throws(()=>documents.list(id),/bulunamadı/);}
 assert.deepEqual(removed,[[web.id,'main'],[job.id,'main']]);
});
