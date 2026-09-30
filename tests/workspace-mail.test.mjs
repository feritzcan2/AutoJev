import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WorkspaceSupport} from '../app/workspace-support.mjs';
import {BackgroundStore} from '../app/background-store.mjs';
import {skillWorkflow} from '../app/background-worker.mjs';
import {reusableTemplate} from '../app/automation-templates.mjs';
import {prepareDataUpgrade,inspectBackup,stageRestore,applyPendingRestore} from '../app/data-management.mjs';
import {DATA_SCHEMA_VERSION} from '../app/data-management-schema.mjs';
import {Store} from '../app/store.mjs';
import {upgradeWorkspaces} from '../app/workspace-upgrade.mjs';

function fixture(t,template='housing'){
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create(template,{facts:'Email: synthetic@example.test'}),store=new WorkspaceSupport(db,{slots:()=>[]}),background=new BackgroundStore(store);
 const item=db.putResult({id:'record',automationId:a.id,key:'home',url:'https://example.test/home',title:'Home',summary:'Observed',status:'completed',trial:false,evidence:'Message sent',proofUrl:'https://example.test/confirmation',verifiedAt:1000});
 const run=background.begin(a.id),completed=[],flow=skillWorkflow(background,run,(...args)=>{completed.push(args);return {saved:true};},{aborted:false});
 const call=(name,args={})=>flow.call(a.id,run.id,name,args);
 return {core,db,id:a.id,store,background,item,flow,call,completed};
}
const message={messageId:'message',threadId:'thread',subject:'Reply',date:'2026-09-30T12:00:00Z',url:'https://mail.google.com/mail/u/0/#all/thread',evidence:'A viewing is available',summary:'A viewing is available'};
const verify=f=>f.call('report_mail_connection',{status:'ready',account:'synthetic@example.test',connector:'test-gmail',message:'Account verified'});

for(const template of ['housing','appointment','custom','job-search'])test(`${template}: mail tools and stored outcomes use the template contract`,async t=>{
 const f=fixture(t,template),context=await f.call('get_mail_task'),recordTool=f.flow.tools.find(t=>t.name==='record_mail_outcome');
 assert.equal(context.workspace.id,f.id);assert.equal(context.records[0].id,f.item.id);assert.equal(context.records[0].evidence,'Message sent');assert.equal(context.applications,undefined);
 assert.deepEqual(context.outcomes,f.db.template(template).mail.outcomes);assert.equal(context.instructions,f.db.template(template).mail.instructions);
 assert.ok(recordTool.inputSchema.properties.recordId);assert.equal(recordTool.inputSchema.properties.jobId,undefined);
 const outcome=template==='job-search'?'interview':'reply';assert.ok(recordTool.inputSchema.properties.outcome.enum.includes(outcome));
 await assert.rejects(f.call('record_mail_outcome',{...message,recordId:f.item.id,outcome}),/doğrula/);
 await verify(f);const saved=await f.call('record_mail_outcome',{...message,recordId:f.item.id,outcome});assert.equal(saved.jobId,f.item.id);assert.equal(saved.review,'accepted');
 assert.equal((await f.call('record_mail_outcome',{...message,recordId:f.item.id,outcome})).duplicate,true);
 await assert.rejects(f.call('record_mail_outcome',{...message,messageId:'invalid',recordId:f.item.id,outcome:'unsupported'}),/Geçersiz mail/);
 if(template!=='job-search')await assert.rejects(f.call('record_mail_outcome',{...message,messageId:'job-only',outcome:'interview'}),/Geçersiz mail/);
});

test('custom skills expose only context and completion, with no mailbox access',async t=>{
 const f=fixture(t);f.background.save(f.id,{enabled:false,intervalMinutes:30,skillPath:'/tmp/synthetic/SKILL.md'});const run=f.background.begin(f.id);
 const controller=new AbortController(),flow=skillWorkflow(f.background,run,()=>({saved:true}),controller.signal);
 assert.deepEqual(flow.tools.map(t=>t.name).sort(),['finish_background_job','get_background_context']);
 await assert.rejects(flow.call(f.id,run.id,'get_mail_task',{}),/araç kullanılamıyor/);
 assert.deepEqual(await flow.call(f.id,run.id,'finish_background_job',{summary:'Skill finished'}),{saved:true});
 controller.abort();await assert.rejects(flow.call(f.id,run.id,'get_background_context',{}),/geçersiz/);
});

test('custom mail outcomes survive template export/import and manual matching checks the same contract',async t=>{
 const f=fixture(t),mail={instructions:'Track appointment replies only.',outcomes:[{id:'rescheduled',label:'Tarih değişti'}]},definition={...f.db.template('appointment'),mail};
 const exported=reusableTemplate(definition);assert.deepEqual(exported.mail,mail);
 const template=f.db.saveTemplate(exported),a=f.db.create(template.id),record=f.db.putResult({...f.item,id:'appointment',automationId:a.id});
 const signal=f.background.record(a.id,'synthetic@example.test',{id:'match',threadId:'thread'},{outcome:'unmatched',summary:'Reschedule'});
 assert.throws(()=>f.background.resolve(a.id,signal.id,record.id,'interview'),/Geçersiz sonuç/);
 assert.equal(f.background.resolve(a.id,signal.id,record.id,'rescheduled').outcome,'rescheduled');
 const other=f.db.create('custom');assert.throws(()=>f.background.resolve(other.id,signal.id,record.id,'confirmation'),/ait değil/);
 for(const outcomes of [[null],[{id:'ignored',label:'Ignore'}],[{id:'constructor',label:'Bad'}],[{id:'x',label:'X'},{id:'x',label:'Duplicate'}]])assert.throws(()=>reusableTemplate({...definition,mail:{...mail,outcomes}}),/posta sonucu/);
});

test('fresh and previously imported personal job templates retain application mail outcomes',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'loop-personal-mail-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'db');
 const legacy=new Store(file);new AutomationStore(legacy);const {mail,...old}=legacy.workspaces.template('job-search'),templateId='template-old-job';
 legacy.db.prepare('INSERT INTO automation_templates VALUES(?,?)').run(templateId,JSON.stringify({...old,id:templateId,personal:true}));
 const profile=legacy.saveProfile({templateId,name:'Synthetic candidate',preferences:'Remote',authorization:'research'});legacy.close();
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
 const a=db.create(template.id),store=new WorkspaceSupport(db,{slots:()=>[]}),background=new BackgroundStore(store),record=db.putResult({id:'old-record',automationId:a.id,key:'old',url:'https://example.test/old',title:'Old home',summary:'Saved',status:'completed',trial:false});
 const signal=background.record(a.id,'synthetic@example.test',{id:'old-mail',threadId:'old-thread'},{jobId:record.id,outcome:'confirmation',summary:'Saved confirmation'});
 core.db.exec('PRAGMA user_version=8');core.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:data,appVersion:'test'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,8);
 core=new WorkspaceDatabase(file);db=new AutomationStore(core);assert.equal(core.db.prepare('PRAGMA user_version').get().user_version,DATA_SCHEMA_VERSION);assert.equal(db.result(a.id,record.id).status,'completed');assert.ok(db.template(template.id).mail.outcomes.some(o=>o.id==='reply'));
 await stageRestore({dataDirectory:data,directory:upgrade.backup,db:core.db,appVersion:'test'});core.close();await applyPendingRestore({dataDirectory:data});
 core=new WorkspaceDatabase(file);try{db=new AutomationStore(core);assert.equal(db.get(a.id).templateId,template.id);const saved=new BackgroundStore(new WorkspaceSupport(db,{slots:()=>[]})).signals(a.id);assert.equal(saved[0].id,signal.id);assert.equal(saved[0].summary,signal.summary);assert.equal(db.result(a.id,record.id).status,'completed');assert.ok(db.template(template.id).mail.outcomes.some(o=>o.id==='reply'));}finally{core.close();}
});
