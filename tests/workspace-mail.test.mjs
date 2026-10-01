import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {reusableTemplate} from '../app/automation-templates.mjs';
import {prepareDataUpgrade,inspectBackup,stageRestore,applyPendingRestore} from '../app/data-management.mjs';
import {DATA_SCHEMA_VERSION} from '../app/data-management-schema.mjs';
import {seedLegacyDatabase} from './helpers/legacy-database.mjs';
import {upgradeWorkspaces} from '../app/workspace-upgrade.mjs';

test('legacy mail metadata remains portable in saved templates',t=>{
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core);
 const mail={instructions:'Track appointment replies only.',outcomes:[{id:'rescheduled',label:'Tarih değişti'}]},definition={...db.template('appointment'),mail};
 const exported=reusableTemplate(definition);assert.deepEqual(exported.mail,mail);
 const template=db.saveTemplate(exported);assert.deepEqual(db.template(template.id).mail,mail);
 for(const outcomes of [[null],[{id:'ignored',label:'Ignore'}],[{id:'constructor',label:'Bad'}],[{id:'x',label:'X'},{id:'x',label:'Duplicate'}]])assert.throws(()=>reusableTemplate({...definition,mail:{...mail,outcomes}}),/posta sonucu/);
});

test('fresh and previously imported personal job templates retain application mail outcomes',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'loop-personal-mail-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'db');
 const {profile}=seedLegacyDatabase(file,{personal:true}),templateId=profile.templateId;
 const core=new WorkspaceDatabase(file);t.after(()=>core.close());const db=new AutomationStore(core);
 assert.deepEqual(upgradeWorkspaces(db),[profile.id]);assert.ok(db.template(templateId).mail.outcomes.some(o=>o.id==='interview'));
 const saved=JSON.parse(core.db.prepare('SELECT data FROM automation_templates WHERE id=?').get(templateId).data);delete saved.mail;
 const write=input=>core.db.prepare('UPDATE automation_templates SET data=? WHERE id=?').run(JSON.stringify(input),templateId);
 write(saved);assert.deepEqual(upgradeWorkspaces(db),[]);assert.ok(db.template(templateId).mail.outcomes.some(o=>o.id==='offer'));
 const custom={instructions:'Keep the saved contract.',outcomes:[{id:'reply',label:'Yanıt'}]};write({...saved,mail:custom});upgradeWorkspaces(db);assert.deepEqual(db.template(templateId).mail,custom);
});

test('schema eight backup, upgrade and restore retain personal templates and historical mail',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'loop-mail-upgrade-')),data=path.join(root,'data');await mkdir(data);t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(data,'jobloop.sqlite');
 let core=new WorkspaceDatabase(file),db=new AutomationStore(core);const template=db.saveTemplate({...db.template('housing'),title:'Saved homes'});
 const {mail,...oldTemplate}=template;core.db.prepare('UPDATE automation_templates SET data=? WHERE id=?').run(JSON.stringify(oldTemplate),template.id);
 const a=db.create(template.id),record=db.putResult({id:'old-record',automationId:a.id,key:'old',url:'https://example.test/old',title:'Old home',summary:'Saved',status:'completed',trial:false});
 const signal={id:'old-mail',jobId:record.id,outcome:'confirmation',summary:'Saved confirmation'};
 core.db.exec('CREATE TABLE mail_signals(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,account TEXT NOT NULL,message_id TEXT NOT NULL,data TEXT NOT NULL)');
 core.db.prepare('INSERT INTO mail_signals VALUES(?,?,?,?,?)').run(signal.id,a.id,'synthetic@example.test','old-message',JSON.stringify(signal));
 core.db.exec('PRAGMA user_version=8');core.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:data,appVersion:'test'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,8);
 core=new WorkspaceDatabase(file);db=new AutomationStore(core);assert.equal(core.db.prepare('PRAGMA user_version').get().user_version,DATA_SCHEMA_VERSION);assert.equal(db.result(a.id,record.id).status,'completed');assert.ok(db.template(template.id).mail.outcomes.some(o=>o.id==='reply'));
 await stageRestore({dataDirectory:data,directory:upgrade.backup,db:core.db,appVersion:'test'});core.close();await applyPendingRestore({dataDirectory:data});
 core=new WorkspaceDatabase(file);try{db=new AutomationStore(core);assert.equal(db.get(a.id).templateId,template.id);const saved=core.db.prepare('SELECT data FROM mail_signals WHERE candidate_id=?').all(a.id).map(row=>JSON.parse(row.data));assert.equal(saved[0].id,signal.id);assert.equal(saved[0].summary,signal.summary);assert.equal(db.result(a.id,record.id).status,'completed');assert.ok(db.template(template.id).mail.outcomes.some(o=>o.id==='reply'));}finally{core.close();}
});
