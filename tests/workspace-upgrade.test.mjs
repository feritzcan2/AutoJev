import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {upgradeWorkspaces} from '../app/workspace-upgrade.mjs';

test('application workspace upgrades once to the browser template with records and schedules intact',t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'workspace-upgrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'db');
 let legacy=new Store(file);const p=legacy.saveProfile({name:'Profile',preferences:'Remote engineering',authorization:'research'}),sources=legacy.sources(p.id);
 legacy.saveSource(p.id,{...sources[0],intervalMinutes:555});legacy.markSourceRun(p.id,sources[0].id,{at:1000,nextRunAt:33301000,result:'Saved search',found:2});
 const completed=legacy.addJob(p.id,{url:'https://example.com/sent',company:'ACME',role:'Engineer',location:'Berlin',fit:'Match'}).job;
 const unsure=legacy.addJob(p.id,{url:'https://example.com/uncertain',company:'ACME',role:'Lead',location:'Berlin',fit:'Match'}).job;
 legacy.workspaces.records.update(p.id,completed.id,j=>({...j,status:'submitted',proof:{text:'Receipt 123',url:j.url}}));
 legacy.workspaces.records.update(p.id,unsure.id,j=>({...j,status:'submitting'}));
 legacy.ask(p.id,{jobId:unsure.id,question:'Start date?',fields:[{id:'start',label:'Başlangıç',type:'date'}]});const worker=legacy.workerState.add(p.id);legacy.close();
 let core=new WorkspaceDatabase(file),db=new AutomationStore(core);assert.deepEqual(upgradeWorkspaces(db),[p.id]);
 assert.equal(core.workspaces.definition(p.id).execution.driver,'browser');assert.equal(db.get(p.id).mode,'observe');assert.equal(db.get(p.id).status,'paused');
 assert.equal(db.sources(p.id)[0].intervalMinutes,555);assert.equal(db.sources(p.id)[0].nextRunAt,33301000);
 assert.equal(db.result(p.id,completed.id).status,'completed');assert.match(db.result(p.id,completed.id).evidence,/Receipt 123/);
 assert.equal(db.result(p.id,unsure.id).status,'uncertain');assert.equal(db.get(p.id).questions[0].text,'Start date?');assert.equal(db.get(p.id).questions[0].fields[0].type,'date');
 assert.ok(core.workspaces.workers.list(p.id).some(w=>w.id===worker.id));
 db.saveSourcesInterval(p.id,777);assert.deepEqual(upgradeWorkspaces(db),[]);core.close();
 core=new WorkspaceDatabase(file);db=new AutomationStore(core);assert.deepEqual(upgradeWorkspaces(db),[]);assert.equal(db.sources(p.id)[0].intervalMinutes,777);
 db.remove(p.id);core.close();core=new WorkspaceDatabase(file);db=new AutomationStore(core);assert.deepEqual(upgradeWorkspaces(db),[]);assert.equal(core.workspaces.has(p.id),false);core.close();
});

test('new job search is an ordinary automation with template-defined fields',()=>{
 const core=new WorkspaceDatabase(':memory:');try{const db=new AutomationStore(core),a=db.create('job-search');assert.equal(db.template(a.templateId).execution.driver,'browser');assert.ok(db.template(a.templateId).fields.some(f=>f.id==='preferences'));assert.equal(core.workspaces.exists('candidates'),false);}finally{core.close();}
});
