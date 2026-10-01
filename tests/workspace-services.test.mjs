import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {Workspaces} from '../app/workspaces.mjs';
import {WorkspaceDocuments} from '../app/workspace-documents.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {saveAgentSettings} from '../src/agent-settings-save.js';

const raw=(store,table,id)=>JSON.parse(store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id).data);
const assertDomain=value=>{for(const key of ['agentSettings','browserMode','chromeProfile','table'])assert.equal(Object.hasOwn(value,key),false,key);};
function fixture(t){const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),job=db.create('job-search',{title:'Test',goal:'Remote',facts:'Berlin',mode:'auto'}),web=db.create('housing');return {store,db,job,web};}

test('plan mutations keep provider, browser and table settings only in workspaces',t=>{
 const {store,db,job}=fixture(t),canonical=store.workspaces.get(job.id);
 for(const input of [{facts:'Berlin'},{criteria:{preferences:'Remote',ranking:'Skills'}},{title:'Renamed'},{goal:'Updated goal'}]){
  db.save(job.id,input);assertDomain(raw(store,'automations',job.id));const p=db.get(job.id);
  assert.deepEqual(p.agentSettings,canonical.agentSettings);assert.equal(p.browserMode,canonical.browserMode);assert.deepEqual(p.table,canonical.table);
 }
});
test('migration removes stale copies without overwriting canonical settings and is repeatable',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'loop-settings-migration-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'db.sqlite');
 let store=new WorkspaceDatabase(file);const db=new AutomationStore(store),job=db.create('job-search',{title:'Test',browserMode:'jev'}),web=db.create('custom');
 for(const [table,id] of [['automations',job.id],['automations',web.id]])store.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify({...raw(store,table,id),browserMode:'existing',agentSettings:{provider:'stale'},chromeProfile:{directory:'Old'},table:{title:'Stale',columns:[]}}),id);
 const before=store.workspaces.list();store.close();store=new WorkspaceDatabase(file);t.after(()=>store.close());
 assert.deepEqual(store.workspaces.list(),before);assertDomain(raw(store,'automations',job.id));assertDomain(raw(store,'automations',web.id));
 const changes=()=>store.db.prepare('SELECT total_changes() AS n').get().n,prior=changes();store.workspaces.migrate();assert.equal(changes(),prior);
});

function drivers(store,db,pool,runtime){return {
 browser:{rename:(id,name)=>db.rename(id,name),remove:id=>db.remove(id),workers:{add:(...a)=>runtime.add(...a),start:(...a)=>runtime.startWorker(...a),stop:(...a)=>runtime.stopWorker(...a),remove:(...a)=>runtime.remove(...a),restartState:(...a)=>runtime.restartState(...a)}}
};}

for(const template of ['custom','housing','appointment','job-search'])for(const browserChange of [false,true])test(`${template}: ${browserChange?'confirmed browser restart continues setup':'worker agent settings leave setup running'}`,async t=>{
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),a=db.create(template),launches=[],closed=[];
 const history=store.workspaces.history(a.id).forProfile('builtin.agent-profile.loop-web-interview');
 history.saveConversation(a.id,'claude','setup-conversation',{provider:'claude',model:'default',permission:'auto'});
 const runtime=new WebTasks(db,{launch:async run=>{launches.push(run);return {close:async()=>closed.push(run.id)};}});t.after(async()=>{await runtime.close();store.close();});
 const workspaces=new Workspaces(store.workspaces,{templates:drivers(store,db,{},runtime)});
 await runtime.setup(a.id);const first=launches[0];
 const question=db.askQuestion(a.id,{text:'Nerede?'});
 let confirmed=0;
 const result=await saveAgentSettings({owner:a.id,input:{agentSettings:{...db.get(a.id).agentSettings,contextCompactPercent:60},...(browserChange?{browserMode:'jev'}:{})},confirmRestart:async count=>{confirmed++;assert.equal(count,1);return true;},api:{
  workspaceSnapshot:async()=>({workers:[{id:first.workerId,conversation:true,active:{sessionId:first.id},execution:{task:{id:first.id,kind:'interview'}}}]}),
  workspaceSettings:async(id,input)=>{if(browserChange)await runtime.pause(id);db.save(id,input);},
  restartWorker:(...args)=>workspaces.restartWorker(...args)
 }});
 assert.deepEqual(result,{restarted:browserChange?1:0,failed:[]});assert.equal(confirmed,browserChange?1:0);assert.deepEqual(closed,browserChange?[first.id]:[]);
 assert.equal(launches.length,browserChange?2:1);assert.equal(launches.at(-1).kind,'interview');assert.equal(runtime.slots(a.id)[0].run.id,launches.at(-1).id);
 assert.equal(history.conversation(a.id,'claude'),'setup-conversation');assert.equal(db.get(a.id).questions[0].id,question.id);
 assert.equal(db.get(a.id).trial,null);
});


test('web workers share restart ordering, ownership checks and removal cleanup',async t=>{
 const {store,db,job,web}=fixture(t);const launches=[],closed=[];
 db.save(web.id,{goal:'Find homes',criteria:{location:'Berlin',budget:'1500',requirements:'Two rooms'},sources:['https://homes.test/']});db.review(web.id);
 const runtime=new WebTasks(db,{launch:async(run)=>{launches.push(run);return {close:async()=>{closed.push(run.id);store.workspaces.history(web.id,run.workerId).saveConversation(web.id,'claude','late-thread',{});}};}});t.after(()=>runtime.close());
 const removed=[],workspaces=new Workspaces(store.workspaces,{templates:drivers(store,db,{},runtime),workerRemoved:(...args)=>removed.push(args)});
 const worker=await workspaces.addWorker(web.id),foreign=store.workspaces.workers.add(job.id);await assert.rejects(workspaces.startWorker(web.id,foreign.id),/ait değil/);
 await workspaces.startWorker(web.id,worker.id);assert.equal(launches.length,1);await workspaces.restartWorker(web.id,worker.id);assert.equal(launches.length,2);assert.equal(closed.length,1);
  assert.equal(store.workspaces.history(web.id,worker.id).conversation(web.id,'claude'),null);
 await workspaces.stopWorker(web.id,worker.id);assert.equal(runtime.slots(web.id).length,0);await workspaces.removeWorker(web.id,worker.id);assert.deepEqual(removed,[[web.id,worker.id]]);
 await assert.rejects(workspaces.removeWorker(web.id,'main'),/İlk worker/);
});

test('deleting a running automation stops its active worker before removing the workspace',async t=>{
 const {store,db,web}=fixture(t);const closed=[];
 db.save(web.id,{goal:'Find homes',criteria:{location:'Berlin',budget:'1500',requirements:'Two rooms'},sources:['https://homes.test/']});db.review(web.id);
 const runtime=new WebTasks(db,{launch:async run=>({close:async()=>closed.push(run.id)})});t.after(()=>runtime.close());
 const workspaces=new Workspaces(store.workspaces,{templates:{browser:{remove:async id=>{await runtime.pause(id);db.remove(id);}}}});
 await runtime.start(web.id,'trial');assert.equal(runtime.slots(web.id).length,1);
 await workspaces.remove(web.id);
 assert.equal(runtime.slots(web.id).length,0);assert.equal(closed.length,1);assert.equal(store.workspaces.has(web.id),false);
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
 const workspaces=new Workspaces(store.workspaces,{templates,workerRemoved:(...args)=>removed.push(args)}),documents=new WorkspaceDocuments(workspaces,{window:()=>null,dialog:{showOpenDialog:async()=>({canceled:!picked,filePaths:[picked]})},shell:{openPath:async file=>{opened.push(file);return '';}}});
 for(const [id,title] of [[job.id,'Jobs renamed'],[web.id,'Homes renamed']]){
  workspaces.rename(id,title);assert.equal(store.workspaces.get(id).title,title);
  const imported=await documents.pick(id);assert.equal(await readFile(imported,'utf8'),'Document text');const [doc]=await documents.list(id);assert.equal(await documents.read(id,doc.path),'Document text');await documents.open(id,doc.path);assert.equal(opened.at(-1),await realpath(imported));
  await assert.rejects(documents.open(id,'../source.txt'));await assert.rejects(documents.read(id,'/tmp/outside.txt'));
  await symlink(source,path.join(dir,id,'outside.txt'));await assert.rejects(documents.open(id,'outside.txt'));
 }
 await assert.rejects(documents.pick(job.id,{purpose:'cv'}),/desteklenmiyor/);await assert.rejects(documents.pick(web.id,{purpose:'cv'}),/desteklenmiyor/);
 picked=null;assert.equal(await documents.pick(web.id),null);assert.equal(added.length,2);
 for(const id of [web.id,job.id]){await workspaces.remove(id);assert.equal(store.workspaces.has(id),false);assert.throws(()=>documents.list(id),/bulunamadı/);}
 assert.deepEqual(removed,[[web.id,'main'],[job.id,'main']]);
});
