import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {seedLegacyDatabase} from './helpers/legacy-database.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {upgradeWorkspaces} from '../app/workspace-upgrade.mjs';

test('application workspace upgrades once to the browser template with records and schedules intact',t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'workspace-upgrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'db');
 const {profile:p,completed,unsure,worker}=seedLegacyDatabase(file);
 let core=new WorkspaceDatabase(file),db=new AutomationStore(core);assert.deepEqual(upgradeWorkspaces(db),[p.id]);
 assert.equal(core.workspaces.definition(p.id).execution.driver,'browser');assert.equal(db.get(p.id).mode,'observe');assert.equal(db.get(p.id).status,'paused');
 assert.equal(db.sources(p.id)[0].intervalMinutes,555);assert.equal(db.sources(p.id)[0].nextRunAt,33301000);
 assert.equal(db.result(p.id,completed.id).status,'completed');assert.match(db.result(p.id,completed.id).evidence,/Receipt 123/);
 assert.equal(db.result(p.id,unsure.id).status,'uncertain');assert.equal(db.get(p.id).questions[0].text,'Start date?');assert.equal(db.get(p.id).questions[0].fields[0].type,'date');
 assert.ok(core.workspaces.workers.list(p.id).some(w=>w.id===worker.id));
 assert.equal(core.workspaces.history(p.id).conversation(p.id,'codex'),'main-history');
 assert.equal(core.workspaces.history(p.id,worker.id).conversation(p.id,'claude'),'helper-history');
 assert.deepEqual(db.result(p.id,completed.id).documents,completed.documents);
 assert.equal(core.db.prepare('PRAGMA foreign_key_check').get(),undefined);
 db.saveSourcesInterval(p.id,777);assert.deepEqual(upgradeWorkspaces(db),[]);core.close();
 core=new WorkspaceDatabase(file);db=new AutomationStore(core);assert.deepEqual(upgradeWorkspaces(db),[]);assert.equal(db.sources(p.id)[0].intervalMinutes,777);
 db.remove(p.id);core.close();core=new WorkspaceDatabase(file);db=new AutomationStore(core);assert.deepEqual(upgradeWorkspaces(db),[]);assert.equal(core.workspaces.has(p.id),false);core.close();
});

test('new job search is an ordinary automation with template-defined fields',()=>{
 const core=new WorkspaceDatabase(':memory:');try{const db=new AutomationStore(core),a=db.create('job-search');assert.equal(db.template(a.templateId).execution.driver,'browser');assert.ok(db.template(a.templateId).fields.some(f=>f.id==='preferences'));assert.equal(core.workspaces.exists('candidates'),false);}finally{core.close();}
});
