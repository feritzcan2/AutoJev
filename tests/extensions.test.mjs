import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {TemplateRegistry} from '../app/template-registry.mjs';
import {Workspaces} from '../app/workspaces.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {Store} from '../app/store.mjs';
import {loadExtensions} from '../app/extensions.mjs';

test('the default web database and catalog do not create application state',async t=>{
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const web=new AutomationStore(core),a=web.create('housing');
 const tables=core.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name);
 for(const name of ['candidates','campaigns','sources','questions','job_members','worker_state'])assert.ok(!tables.includes(name),name);
 assert.ok(web.catalog().every(template=>template.kind==='web'));assert.equal(core.workspaces.get(a.id).templateId,'housing');
 assert.deepEqual(await loadExtensions(''),[]);
 assert.throws(()=>core.workspaces.template('job-search'),/bulunamadı/);
});

test('a third executor registers its own capabilities and runs through the same workspace queue',async t=>{
 const registry=new TemplateRegistry([{id:'fixture',kind:'web',browserModes:['separate'],defaultBrowserMode:'separate',capabilities:{'fixture.check':{effect:'read'}},workflow:[{id:'check',capability:'fixture.check',scope:'source',instructions:'Read fixture data'}],records:{states:[{id:'observed',label:'Observed'}],bindings:{title:'label'}},templates:[{id:'fixture-template',title:'Fixture'}]}]);
 const core=new WorkspaceDatabase(':memory:',{registry});t.after(()=>core.close());
 const api=new Workspaces(core.workspaces,{templates:{fixture:{create(templateId,input){const id=randomUUID();return core.workspaces.save(id,templateId,{title:input.title});},async start(id){const task=core.workspaces.tasks.enqueue(id,{operation:'check'});core.workspaces.tasks.claim(id,task.id,'main');core.workspaces.records.put(id,'fixture',{label:'Fixture result',status:'observed'});core.workspaces.tasks.finish(id,task.id);},snapshot:id=>({records:core.workspaces.records.list(id),execution:{status:'complete'}})}}});
 const w=await api.create('fixture-template',{title:'New executor'});await api.start(w.id);const result=await api.snapshot(w.id);
 assert.equal(result.records[0].label,'Fixture result');assert.equal(result.workspace.title,'New executor');assert.equal(core.workspaces.definition(w.id).workflow[0].effect,'read');assert.equal(api.list()[0].driver,'fixture');
 assert.throws(()=>registry.normalize({execution:{driver:'fixture'},workflow:[{id:'bad',capability:'browser.act',scope:'source',instructions:'Wrong capability'}]}),/adımı/);
 assert.throws(()=>registry.normalize({execution:{driver:'unregistered'}}),/uzantısı/);
});

test('disabling the application extension preserves its data and only lists supported workspaces',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'loop-optional-extension-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'db.sqlite');
 let store=new Store(file);const automation=new AutomationStore(store),candidate=store.saveProfile({name:'Keep',preferences:'Remote'}),web=automation.create('housing'),personal=automation.saveTemplate({...automation.template('job-search'),title:'Personal applications'});const intake=store.createSetup(store.profile(candidate.id).agentSettings,personal.id);assert.equal(store.profile(intake.id).templateId,personal.id);const saved=store.db.prepare('SELECT data FROM candidates WHERE id=?').get(candidate.id).data;store.close();
 const core=new WorkspaceDatabase(file);try{const api=new Workspaces(core.workspaces,{templates:{browser:{}}});assert.deepEqual(api.list().map(w=>w.id),[web.id]);assert.ok(new AutomationStore(core).catalog().every(t=>t.execution.driver==='browser'));assert.equal(core.db.prepare('SELECT data FROM candidates WHERE id=?').get(candidate.id).data,saved);}finally{core.close();}
 store=new Store(file);t.after(()=>store.close());assert.equal(store.candidates().length,2);assert.equal(store.profile(candidate.id).name,'Keep');assert.equal(store.workspaces.template(personal.id).execution.driver,'applications');
});

test('generic boot has no static dependency on application stores, campaigns or MCP handlers',async()=>{
 const visited=new Set();
 async function visit(file){if(visited.has(file))return;visited.add(file);const source=await readFile(file,'utf8');for(const match of source.matchAll(/(?:import|export)\s[^;]*?from\s*['"](\.[^'"]+)['"]/g)){const dependency=path.resolve(path.dirname(file),match[1]);if(/\.(?:mjs|js)$/.test(dependency))await visit(dependency);}}
 const root=process.cwd();await visit(path.join(root,'app/main.mjs'));
 for(const file of ['app/store.mjs','app/mcp.mjs','app/campaign.mjs','app/worker-campaigns.mjs','app/extensions/job-search/store.mjs','app/extensions/job-search/index.mjs'])assert.equal(visited.has(path.join(root,file)),false,file);
});
