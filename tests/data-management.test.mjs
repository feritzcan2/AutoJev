import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink,rename,utimes,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {TelegramStore} from '../app/telegram-store.mjs';
import {createBackup,inspectBackup,stageRestore,applyPendingRestore,prepareDataUpgrade,completeDataUpgrade,pruneLogs,dataManagementStatus,DATA_SCHEMA_VERSION} from '../app/data-management.mjs';
import {prunePromptLogs} from '../app/data-management-schema.mjs';
import {calculateScorecard,scoringPolicy} from '../app/scoring-policy.mjs';
import {unknownScorecard} from './helpers/scorecard.mjs';
import {rememberSourceAccess} from '../app/source-access-recovery.mjs';
import {sourceScanScope} from '../app/source-scan.mjs';
import {recordSourceRead} from '../app/source-read.mjs';

// Backup compatibility uses frozen legacy rows, not a second execution engine.
const row=(core,table,id,column='candidate_id')=>JSON.parse(core.db.prepare(`SELECT data FROM ${table} WHERE ${column}=?`).get(id).data);
const profileRow=(core,id)=>row(core,'candidates',id,'id');
function changeProfile(core,id,changes){const value={...profileRow(core,id),...changes};core.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(value),id);return value;}
function seedCandidate(core,name='Ada Lovelace'){
 core.db.exec(`CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS campaigns(candidate_id TEXT PRIMARY KEY,data TEXT);
 CREATE TABLE IF NOT EXISTS worker_state(candidate_id TEXT,worker_id TEXT,kind TEXT,data TEXT);
 CREATE TABLE IF NOT EXISTS task_context_reviews(candidate_id TEXT PRIMARY KEY,task_id TEXT,data TEXT);
 CREATE TABLE IF NOT EXISTS prompts(seq INTEGER PRIMARY KEY,candidate_id TEXT,kind TEXT,text TEXT,at TEXT);
 CREATE TABLE IF NOT EXISTS account_credentials(candidate_id TEXT PRIMARY KEY,email TEXT,ciphertext TEXT,pending TEXT);`);
 const value={id:randomUUID(),name,preferences:'Remote',authorization:'research',workspaceName:null};
 core.workspaces.save(value.id,'job-search',value);core.db.prepare('INSERT INTO candidates VALUES(?,?)').run(value.id,JSON.stringify(value));return value;
}

async function fixture(t){
 const base=await mkdtemp(path.join(tmpdir(),'jobloop-backup-test-')),data=path.join(base,'data');await mkdir(data);
 const store=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),profile=seedCandidate(store),candidate=path.join(data,'candidates',profile.id);
 await mkdir(path.join(candidate,'documents'),{recursive:true});await mkdir(path.join(candidate,'runtime'));
 await writeFile(path.join(candidate,'CV.pdf'),'Synthetic CV');await writeFile(path.join(candidate,'documents','letter.md'),'Synthetic letter');await writeFile(path.join(candidate,'runtime','token.txt'),'TRANSIENT-TOKEN');
 await writeFile(path.join(candidate,'AGENTS.md'),'generated instructions');await mkdir(path.join(candidate,'.codex'));await writeFile(path.join(candidate,'.codex','config.toml'),'runtime configuration');
 changeProfile(store,profile.id,{cvPath:path.join(candidate,'CV.pdf')});
 const job=store.workspaces.records.put(profile.id,'fixture',{id:randomUUID(),candidateId:profile.id,url:'https://example.test/jobs/test',company:'Test Employer',role:'Engineer',status:'found'});
 store.db.prepare('INSERT INTO account_credentials VALUES(?,?,?,NULL)').run(profile.id,'ada@example.test','CIPHERTEXT-PORTAL-SECRET');
 new AutomationStore(store);
 const telegram=new TelegramStore({db:store.db,generic:true,profile:id=>profileRow(store,id)});telegram.saveConfig(profile.id,{bot:{id:123456,username:'test'},enabled:true,secret:'TELEGRAM-CIPHERTEXT'});
 store.db.exec('CREATE TABLE jev_settings(id INTEGER PRIMARY KEY,ciphertext TEXT NOT NULL,model TEXT NOT NULL)');store.db.prepare('INSERT INTO jev_settings VALUES(1,?,?)').run('JEV-CIPHERTEXT','model');
 store.db.prepare('INSERT INTO prompts(candidate_id,kind,text,at) VALUES(?,?,?,?)').run(profile.id,'start','Prompt private content',new Date().toISOString());
 t.after(async()=>{try{store.close();}catch{}await rm(base,{recursive:true,force:true});});
 return {base,data,store,profile,candidate,job,backup:path.join(base,'export'),create:destination=>createBackup({dataDirectory:data,db:store.db,destination:destination??path.join(base,'export'),appVersion:'0.1.0'})};
}
async function manifest(directory,edit){const file=path.join(directory,'manifest.json'),value=JSON.parse(await readFile(file,'utf8'));await edit(value);await writeFile(file,JSON.stringify(value));}

test('portable backup includes committed WAL data and documents while removing credentials and transient files',async t=>{
 const f=await fixture(t),result=await f.create();assert.equal(result.candidates,1);assert.equal(result.jobs,1);assert.equal(result.secrets,'excluded');
 const summary=await inspectBackup(f.backup);assert.equal(summary.files,3);
 const db=new DatabaseSync(path.join(f.backup,'jobloop.sqlite'),{readOnly:true});
 try{assert.equal(db.prepare('SELECT count(*) AS n FROM candidates').get().n,1);assert.equal(db.prepare('SELECT ciphertext,email FROM account_credentials').get().ciphertext,null);assert.equal(db.prepare('SELECT email FROM account_credentials').get().email,'ada@example.test');for(const table of ['telegram_configs','jev_settings','prompts'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);}finally{db.close();}
 const bytes=await readFile(path.join(f.backup,'jobloop.sqlite'));assert.ok(!bytes.includes('PORTAL-SECRET'));assert.ok(!bytes.includes('TELEGRAM-CIPHERTEXT'));assert.ok(!bytes.includes('JEV-CIPHERTEXT'));
 assert.equal(profileRow(f.store,f.profile.id).name,'Ada Lovelace');assert.equal(f.store.db.prepare('SELECT ciphertext FROM account_credentials').get().ciphertext,'CIPHERTEXT-PORTAL-SECRET');
 assert.deepEqual((await readdir(path.join(f.backup,'candidates',f.profile.id))).sort(),['CV.pdf','documents']);
});

test('backup rejects live data destinations and candidate symlinks without creating partial exports',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.create(path.join(f.data,'bad-backup')),/dışında/);
 await mkdir(path.join(f.base,'outside'));await writeFile(path.join(f.base,'outside','file.txt'),'external');await symlink(path.join(f.base,'outside'),path.join(f.candidate,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(()=>f.create(),/sembolik/);
 assert.equal((await readdir(f.base)).some(name=>name.startsWith('.jobloop-backup-')||name==='export'),false);
});

test('restore validates hashes, traversal, duplicate names, case conflicts, symlinks and future schemas',async t=>{
 const f=await fixture(t);await f.create();const original=await readFile(path.join(f.backup,'manifest.json'),'utf8');
 const cases=[value=>{value.files[1].path='candidates/../../outside.txt';},value=>{value.files.push({...value.files[0]});},value=>{value.files.push({...value.files[1],path:value.files[1].path.toUpperCase()});},value=>{value.schemaVersion=DATA_SCHEMA_VERSION+1;},value=>{value.files[0].bytes=3*1024*1024*1024;}];
 for(const edit of cases){await manifest(f.backup,edit);await assert.rejects(()=>inspectBackup(f.backup));await writeFile(path.join(f.backup,'manifest.json'),original);}
 await writeFile(path.join(f.backup,'candidates',f.profile.id,'CV.pdf'),'tampered');await assert.rejects(()=>inspectBackup(f.backup),/değiştirilmiş/);
 await rm(path.join(f.backup,'candidates',f.profile.id),{recursive:true});await symlink(f.candidate,path.join(f.backup,'candidates',f.profile.id),process.platform==='win32'?'junction':'dir');await assert.rejects(()=>inspectBackup(f.backup),/bağlantı/);
 assert.equal(f.store.db.prepare('SELECT data FROM candidates').all().map(r=>JSON.parse(r.data)).length,1);
});

test('restore stages safely, keeps current data until restart, rebases CVs and pauses all automatic activity',async t=>{
 const f=await fixture(t);f.store.db.prepare('INSERT INTO campaigns VALUES(?,?)').run(f.profile.id,JSON.stringify({status:'running',task:{id:'task',jobId:f.job.id,kind:'application'},wakeAt:0}));
 const worker=f.store.workspaces.workers.add(f.profile.id);f.store.db.prepare('INSERT INTO worker_state VALUES(?,?,?,?)').run(f.profile.id,worker.id,'campaign',JSON.stringify({status:'running',task:null}));
 f.store.db.exec('CREATE TABLE background_tasks(candidate_id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE background_runs(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,data TEXT NOT NULL)');
 f.store.db.prepare('INSERT INTO background_tasks VALUES(?,?)').run(f.profile.id,JSON.stringify({enabled:true}));f.store.db.prepare('INSERT INTO background_runs VALUES(?,?,?)').run('run',f.profile.id,JSON.stringify({id:'run',candidateId:f.profile.id,status:'running'}));
 f.store.db.prepare('UPDATE workspace_records SET data=? WHERE id=?').run(JSON.stringify({...f.job,status:'submitting',sessionId:'session',resumeContext:{tabId:'old'}}),f.job.id);
 await f.create();changeProfile(f.store,f.profile.id,{workspaceName:'Newer live data'});
 const target=path.join(f.base,'another-computer');await mkdir(target);const targetStore=new WorkspaceDatabase(path.join(target,'jobloop.sqlite'));seedCandidate(targetStore,'Existing Candidate');
 const staged=await stageRestore({dataDirectory:target,directory:f.backup,db:targetStore.db,appVersion:'0.2.0'});assert.equal(staged.restartRequired,true);assert.equal(targetStore.db.prepare('SELECT data FROM candidates').all().map(r=>JSON.parse(r.data))[0].name,'Existing Candidate');assert.equal((await inspectBackup(staged.recoveryBackup)).candidates,1);targetStore.close();
 assert.equal((await applyPendingRestore({dataDirectory:target})).restored,true);
 const restored=new WorkspaceDatabase(path.join(target,'jobloop.sqlite'));
 try{assert.equal(profileRow(restored,f.profile.id).cvPath,path.join(target,'candidates',f.profile.id,'CV.pdf'));assert.equal(await readFile(profileRow(restored,f.profile.id).cvPath,'utf8'),'Synthetic CV');assert.equal(row(restored,'campaigns',f.profile.id).status,'paused');assert.equal(JSON.parse(restored.db.prepare("SELECT data FROM worker_state WHERE worker_id=? AND kind='campaign'").get(worker.id).data).status,'paused');assert.equal(restored.workspaces.records.get(f.profile.id,f.job.id).status,'uncertain');assert.equal(restored.workspaces.records.get(f.profile.id,f.job.id).sessionId,null);assert.equal(JSON.parse(restored.db.prepare('SELECT data FROM background_tasks WHERE candidate_id=?').get(f.profile.id).data).enabled,false);assert.equal(profileRow(restored,f.profile.id).workspaceName,null);}finally{restored.close();}
 assert.equal(profileRow(f.store,f.profile.id).workspaceName,'Newer live data');assert.deepEqual(await applyPendingRestore({dataDirectory:target}),{restored:false});
});

test('interrupted restore rolls back the original database and files before opening Store',async t=>{
 const f=await fixture(t);await f.create();await stageRestore({dataDirectory:f.data,directory:f.backup,db:f.store.db,appVersion:'0.1.0'});f.store.close();
 const pending=JSON.parse(await readFile(path.join(f.data,'pending-restore.json'),'utf8')),rollbackName='.restore-rollback-'+randomUUID(),rollback=path.join(f.data,rollbackName);await mkdir(rollback);
 await writeFile(path.join(f.candidate,'documents','after-backup.txt'),'live recovery');
 await writeFile(path.join(f.data,'restore-transaction.json'),JSON.stringify({version:1,stageName:pending.stageName,rollbackName,originals:['jobloop.sqlite','candidates']}));
 await rename(path.join(f.data,'jobloop.sqlite'),path.join(rollback,'jobloop.sqlite'));await rename(path.join(f.data,'candidates'),path.join(rollback,'candidates'));
 await rename(path.join(f.data,pending.stageName,'jobloop.sqlite'),path.join(f.data,'jobloop.sqlite'));
 assert.deepEqual(await applyPendingRestore({dataDirectory:f.data}),{restored:false,recovered:true});assert.equal(await readFile(path.join(f.candidate,'documents','after-backup.txt'),'utf8'),'live recovery');
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));assert.equal(restored.db.prepare('SELECT data FROM candidates').all().map(r=>JSON.parse(r.data)).length,1);restored.close();
});

test('legacy data receives a recoverable backup before schema adoption and every app version change',async t=>{
 const f=await fixture(t);f.store.db.exec('PRAGMA user_version=0');f.store.close();
 const result=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.ok(result.backup);assert.equal((await inspectBackup(result.backup)).schemaVersion,0);assert.equal((await inspectBackup(result.backup)).secrets,'os-encrypted-same-user');
 const upgraded=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,DATA_SCHEMA_VERSION);upgraded.close();
 await completeDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.deepEqual(await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'}),{backup:null});
 assert.ok((await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.3.0'})).backup);
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));await stageRestore({dataDirectory:f.data,directory:result.backup,db:restored.db,appVersion:'0.3.0'});restored.close();await applyPendingRestore({dataDirectory:f.data});
 const old=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));assert.equal(profileRow(old,f.profile.id).name,'Ada Lovelace');assert.equal(old.db.prepare('SELECT ciphertext FROM account_credentials').get().ciphertext,'CIPHERTEXT-PORTAL-SECRET');assert.equal(JSON.parse(old.db.prepare('SELECT data FROM telegram_configs').get().data).enabled,false);old.close();
});

test('newer schema is refused before Store modifies data',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'jobloop-future-schema-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'jobloop.sqlite'),db=new DatabaseSync(file);db.exec(`CREATE TABLE sentinel(value TEXT); PRAGMA user_version=${DATA_SCHEMA_VERSION+1}`);db.close();
 assert.throws(()=>new WorkspaceDatabase(file),/daha yeni/);await assert.rejects(()=>prepareDataUpgrade({dataDirectory:directory,appVersion:'0.1.0'}),/daha yeni/);
 const check=new DatabaseSync(file,{readOnly:true});assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name),['sentinel']);check.close();
});

test('schema 28 Telegram receipts survive upgrade and restoring its backup',async t=>{
 const f=await fixture(t),telegram=new TelegramStore({db:f.store.db,profile:id=>profileRow(f.store,id)});
 const receipt=telegram.enqueue(f.profile.id,'new-job:'+f.job.id,{kind:'new_job',jobId:f.job.id});
 telegram.sent(receipt.id,42,123456);telegram.deleted(receipt.id);
 f.store.db.exec('PRAGMA user_version=28');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,28);
 const core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));
 const read=db=>({receipt:db.prepare('SELECT status,message_id,data FROM telegram_outbox WHERE id=?').get(receipt.id),history:db.prepare('SELECT bot_id,job_id FROM telegram_job_deliveries WHERE candidate_id=?').all(f.profile.id)});
 const preserved=read(core.db);assert.equal(preserved.receipt.status,'deleted');assert.equal(preserved.receipt.message_id,42);assert.equal(preserved.history[0].job_id,f.job.id);
 assert.equal(core.db.prepare('PRAGMA user_version').get().user_version,DATA_SCHEMA_VERSION);
 await stageRestore({dataDirectory:f.data,directory:upgrade.backup,db:core.db,appVersion:'0.2.0'});core.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));try{assert.deepEqual(read(restored.db),preserved);}finally{restored.close();}
});

test('schema 29 upgrade preserves Telegram preferences and later backups restore automatic score waiting state',async t=>{
 const f=await fixture(t),telegram=new TelegramStore({db:f.store.db,profile:id=>profileRow(f.store,id)});
 const data={name:'Ada',newJobs:true,notifications:true,questions:true};
 f.store.db.prepare('INSERT INTO telegram_links VALUES(?,?,?,?,?,?)').run(f.profile.id,'123456','11','11',JSON.stringify(data),0);
 const receipt=telegram.enqueue(f.profile.id,'new-job:'+f.job.id,{kind:'new_job',jobId:f.job.id});
 f.store.db.exec('PRAGMA user_version=29');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,29);
 const core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite')),next=new TelegramStore({db:core.db,profile:id=>profileRow(core,id)});
 assert.deepEqual(next.link(f.profile.id).data,data);next.preferences(f.profile.id,{...data,newJobsMinScore:65});next.waitForScore(receipt.id);
 const backup=await createBackup({dataDirectory:f.data,db:core.db,destination:path.join(f.base,'score-backup'),appVersion:'0.2.0',kind:'upgrade'});
 next.preferences(f.profile.id,{...data,newJobsMinScore:null});
 await stageRestore({dataDirectory:f.data,directory:backup.path,db:core.db,appVersion:'0.2.0'});core.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));
 try{
  assert.equal(JSON.parse(restored.db.prepare('SELECT data FROM telegram_links WHERE candidate_id=?').get(f.profile.id).data).newJobsMinScore,65);
  assert.equal(restored.db.prepare('SELECT status FROM telegram_outbox WHERE id=?').get(receipt.id).status,'waiting_score');
 }finally{restored.close();}
});

test('schema 12 upgrades preserve workspace data while temporary Jev bodies stay out of backups',async t=>{
 const f=await fixture(t),old=new AutomationStore(f.store),a=old.create('housing',{goal:'Homes',criteria:{location:'Berlin',budget:'1500',requirements:'2 rooms'},sources:['https://example.test/homes']});
 f.store.db.exec('PRAGMA user_version=12');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,12);
 const core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite')),db=new AutomationStore(core);assert.equal(db.get(a.id).goal,'Homes');
 const task=db.jevTasks.create(a.id,'assigned',{operation:'collect_details'}),evidence=db.jevTasks.evidence(task,{url:a.sources[0],text:'TEMPORARY_BODY_NOT_IN_BACKUP'});
 assert.equal(db.jevTasks.readEvidence(a.id,'assigned',evidence.id).text,'TEMPORARY_BODY_NOT_IN_BACKUP');
 const destination=path.join(f.base,'jev-backup');await createBackup({dataDirectory:f.data,db:core.db,destination,appVersion:'0.2.0'});
 assert.equal((await readFile(path.join(destination,'jobloop.sqlite'))).includes(Buffer.from('TEMPORARY_BODY_NOT_IN_BACKUP')),false);
 await stageRestore({dataDirectory:f.data,directory:destination,db:core.db,appVersion:'0.2.0'});core.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));t.after(()=>restored.close());const saved=new AutomationStore(restored);
 assert.deepEqual(saved.jevTasks.list(a.id,'assigned'),[]);assert.throws(()=>saved.jevTasks.readEvidence(a.id,'assigned',evidence.id),/süresi doldu/);assert.equal(saved.get(a.id).goal,'Homes');
});

test('log retention removes old and over-limit prompts, keeps application history and bounds closed terminal logs',async t=>{
 const f=await fixture(t),now=Date.now();f.store.db.exec('DELETE FROM prompts');const insert=f.store.db.prepare('INSERT INTO prompts(candidate_id,kind,text,at) VALUES(?,?,?,?)');
 insert.run(f.profile.id,'start','old',new Date(now-31*86400000).toISOString());for(let index=0;index<4;index++)insert.run(f.profile.id,'input',String(index),new Date(now).toISOString());
 assert.equal(prunePromptLogs(f.store.db,{now,perCandidate:2,total:3}),3);assert.equal(f.store.db.prepare('SELECT * FROM prompts WHERE candidate_id=?').all(f.profile.id).length,2);assert.equal(f.store.workspaces.records.list(f.profile.id).length,1);
 const old=path.join(f.data,'background','old','terminal.log'),large=path.join(f.data,'background','new','terminal.log'),active=path.join(f.data,'background','active','terminal.log');
 for(const file of [old,large,active]){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,Buffer.alloc(200000,'a'));}await utimes(old,new Date(now-31*86400000),new Date(now-31*86400000));
 const result=await pruneLogs({dataDirectory:f.data,db:f.store.db,now,activeBackgroundRunIds:['active']});assert.equal(result.terminalFiles,1);await assert.rejects(()=>stat(old),{code:'ENOENT'});assert.equal((await stat(large)).size,150000);assert.equal((await stat(active)).size,200000);
 assert.equal((await dataManagementStatus({dataDirectory:f.data,db:f.store.db,appVersion:'0.1.0'})).prompts,2);await pruneLogs({dataDirectory:f.data,db:f.store.db,clear:true,activeBackgroundRunIds:['active']});assert.equal(f.store.db.prepare('SELECT * FROM prompts WHERE candidate_id=?').all(f.profile.id).length,0);assert.equal(f.store.workspaces.records.list(f.profile.id).length,1);assert.equal((await stat(active)).size,200000);
});

test('automatic backups copied to another installation discard OS-bound secrets',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.data,'backups'));const backup=await createBackup({dataDirectory:f.data,db:f.store.db,destination:path.join(f.data,'backups','upgrade-copy'),appVersion:'0.1.0',kind:'upgrade'});
 const destination=path.join(f.base,'other');await mkdir(destination);const target=new WorkspaceDatabase(path.join(destination,'jobloop.sqlite'));
 const staged=await stageRestore({dataDirectory:destination,directory:backup.path,db:target.db,appVersion:'0.1.0'});assert.equal(staged.secrets,'excluded');target.close();await applyPendingRestore({dataDirectory:destination});
 const restored=new WorkspaceDatabase(path.join(destination,'jobloop.sqlite'));try{assert.equal(restored.db.prepare('SELECT ciphertext FROM account_credentials').get().ciphertext,null);assert.equal(restored.db.prepare('SELECT count(*) AS n FROM telegram_configs').get().n,0);}finally{restored.close();}
});

test('a corrupted pending restore is canceled while current records remain usable',async t=>{
 const f=await fixture(t);await f.create();await stageRestore({dataDirectory:f.data,directory:f.backup,db:f.store.db,appVersion:'0.1.0'});f.store.close();
 const pending=JSON.parse(await readFile(path.join(f.data,'pending-restore.json'),'utf8'));await writeFile(path.join(f.data,pending.stageName,'jobloop.sqlite'),'corrupt');
 await assert.rejects(()=>applyPendingRestore({dataDirectory:f.data}),/mevcut veriler korundu/);assert.deepEqual(await applyPendingRestore({dataDirectory:f.data}),{restored:false});
 const current=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));assert.equal(profileRow(current,f.profile.id).name,'Ada Lovelace');current.close();
});

test('backup validation rejects unsafe record IDs and executable SQLite objects',async t=>{
 const f=await fixture(t);await f.create();
 async function updateDatabaseHash(){await manifest(f.backup,async value=>{const file=value.files.find(file=>file.path==='jobloop.sqlite'),bytes=await readFile(path.join(f.backup,file.path));file.bytes=bytes.length;file.sha256=createHash('sha256').update(bytes).digest('hex');});}
 const db=new DatabaseSync(path.join(f.backup,'jobloop.sqlite'));db.prepare('UPDATE candidates SET data=?').run(JSON.stringify({...f.profile,id:'../outside'}));db.close();await updateDatabaseHash();await assert.rejects(()=>inspectBackup(f.backup),/kimliği/);
 const other=new DatabaseSync(path.join(f.backup,'jobloop.sqlite'));other.prepare('UPDATE candidates SET data=?').run(JSON.stringify(f.profile));other.exec("CREATE TRIGGER unexpected AFTER UPDATE ON candidates BEGIN DELETE FROM jobs; END");other.close();await updateDatabaseHash();await assert.rejects(()=>inspectBackup(f.backup),/nesneleri/);
});

test('automatic backup retention covers updater snapshots and keeps recovery backups',async t=>{
 const f=await fixture(t),directory=path.join(f.data,'backups');await mkdir(directory);
 for(let index=0;index<7;index++){const folder=path.join(directory,index%2?'upgrade-'+index:'before-update-'+index);await mkdir(folder);await writeFile(path.join(folder,'manifest.json'),JSON.stringify({format:'jobloop-backup',kind:'upgrade',createdAt:new Date(1700000000000+index*1000).toISOString()}));}
 await mkdir(path.join(directory,'before-restore-keep'));await completeDataUpgrade({dataDirectory:f.data,appVersion:'0.1.0'});
 const names=await readdir(directory);assert.equal(names.length,6);assert.ok(names.includes('before-restore-keep'));assert.ok(!names.includes('before-update-0'));assert.ok(!names.includes('upgrade-1'));
});

test('portable exports and same-install restores clear every worker task review',async t=>{
 const f=await fixture(t),worker=f.store.workspaces.workers.add(f.profile.id),taskId='reviewed-task';
 f.store.db.prepare('INSERT INTO task_context_reviews VALUES(?,?,?)').run(f.profile.id,taskId,'main worker review');f.store.db.prepare('INSERT INTO worker_state VALUES(?,?,?,?)').run(f.profile.id,worker.id,'review',JSON.stringify({taskId,knowledge:'secondary worker review'}));
 await f.create();
 const exported=new DatabaseSync(path.join(f.backup,'jobloop.sqlite'),{readOnly:true});
 try{assert.equal(exported.prepare('SELECT count(*) AS n FROM task_context_reviews').get().n,0);assert.equal(exported.prepare("SELECT count(*) AS n FROM worker_state WHERE kind='review'").get().n,0);assert.equal(exported.prepare('SELECT count(*) AS n FROM workspace_workers').get().n,1);}finally{exported.close();}
 await mkdir(path.join(f.data,'backups'));const backup=await createBackup({dataDirectory:f.data,db:f.store.db,destination:path.join(f.data,'backups','upgrade-review'),appVersion:'0.1.0',kind:'upgrade'});
 await stageRestore({dataDirectory:f.data,directory:backup.path,db:f.store.db,appVersion:'0.1.0'});f.store.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));
 try{assert.equal(restored.db.prepare('SELECT data FROM task_context_reviews WHERE candidate_id=?').get(f.profile.id),undefined);assert.equal(restored.db.prepare("SELECT data FROM worker_state WHERE worker_id=? AND kind='review'").get(worker.id),undefined);assert.equal(restored.workspaces.workers.list(f.profile.id).length,2);}finally{restored.close();}
});

test('restore rebases canonical CV paths when the source data root uses a directory alias',async t=>{
 const f=await fixture(t),alias=path.join(f.base,'source-alias');await symlink(f.data,alias,process.platform==='win32'?'junction':'dir');
 changeProfile(f.store,f.profile.id,{cvPath:await realpath(path.join(f.candidate,'CV.pdf'))});
 await createBackup({dataDirectory:alias,db:f.store.db,destination:f.backup,appVersion:'0.1.0'});
 const saved=JSON.parse(await readFile(path.join(f.backup,'manifest.json'),'utf8'));assert.equal(saved.sourceDirectory,alias);assert.equal(saved.canonicalSourceDirectory,await realpath(f.data));
 const target=path.join(f.base,'restored-alias');await mkdir(target);const current=new WorkspaceDatabase(path.join(target,'jobloop.sqlite'));
 await stageRestore({dataDirectory:target,directory:f.backup,db:current.db,appVersion:'0.1.0'});current.close();await applyPendingRestore({dataDirectory:target});
 const restored=new WorkspaceDatabase(path.join(target,'jobloop.sqlite'));
 try{assert.equal(profileRow(restored,f.profile.id).cvPath,path.join(target,'candidates',f.profile.id,'CV.pdf'));assert.equal(await readFile(profileRow(restored,f.profile.id).cvPath,'utf8'),'Synthetic CV');}finally{restored.close();}
});

for(const root of ['C:\\Users\\Example\\JobLoop','\\\\server\\share\\JobLoop'])test(`Windows source paths preserve CVs across case and separator changes: ${root}`,async t=>{
 const f=await fixture(t),windowsCv=root.toLowerCase()+'\\CANDIDATES\\'+f.profile.id+'\\cv.PDF';changeProfile(f.store,f.profile.id,{cvPath:windowsCv});await f.create();
 // A Windows-produced archive is restored on this test's native OS; no Windows filesystem is required.
 await manifest(f.backup,value=>{value.sourceDirectory=root.replaceAll('\\','/');delete value.canonicalSourceDirectory;});assert.equal((await inspectBackup(f.backup)).candidates,1);
 const target=path.join(f.base,'windows-import');await mkdir(target);const current=new WorkspaceDatabase(path.join(target,'jobloop.sqlite'));
 await stageRestore({dataDirectory:target,directory:f.backup,db:current.db,appVersion:'0.1.0'});current.close();await applyPendingRestore({dataDirectory:target});
 const restored=new WorkspaceDatabase(path.join(target,'jobloop.sqlite'));
 try{assert.equal(profileRow(restored,f.profile.id).cvPath,path.join(target,'candidates',f.profile.id,'CV.pdf'));assert.equal(await readFile(profileRow(restored,f.profile.id).cvPath,'utf8'),'Synthetic CV');}finally{restored.close();}
});

test('optional canonical source metadata stays compatible and rejects relative or malformed roots',async t=>{
 const f=await fixture(t);await f.create();const original=await readFile(path.join(f.backup,'manifest.json'),'utf8');
 await manifest(f.backup,value=>delete value.canonicalSourceDirectory);assert.equal((await inspectBackup(f.backup)).candidates,1);
 for(const canonicalSourceDirectory of ['../outside','relative','\\root-relative',42,'/bad\0root']){await writeFile(path.join(f.backup,'manifest.json'),original);await manifest(f.backup,value=>{value.canonicalSourceDirectory=canonicalSourceDirectory;});await assert.rejects(()=>inspectBackup(f.backup),/geçersiz/);}
});

test('schema 17 upgrades preserve legacy scores and new score calculations survive backup and restore',async t=>{
 const f=await fixture(t),legacy={status:'scored',score:88,summary:'Legacy score',revision:1};
 f.store.workspaces.records.update(f.profile.id,f.job.id,item=>({...item,assessment:legacy}));f.store.db.exec('PRAGMA user_version=17');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,17);
 const core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));assert.equal(core.db.prepare('PRAGMA user_version').get().user_version,DATA_SCHEMA_VERSION);
 assert.deepEqual(core.workspaces.records.get(f.profile.id,f.job.id).assessment,legacy);
 const calculation=calculateScorecard(unknownScorecard(),scoringPolicy({criteria:{ranking:'Eşik 60'}}),{listing:'',sources:{}}),assessment={...legacy,score:82,scoringVersion:4,eligibility:'mismatch',eligibilityReason:'Mandatory license absent',calculation};
 core.workspaces.records.update(f.profile.id,f.job.id,item=>({...item,assessment}));
 const scoreRecovery={attempt:2,runId:'synthetic-run',reason:'idle',requeue:false};
 const scoreTask=core.workspaces.tasks.enqueue(f.profile.id,{recordOperation:'score',recordId:f.job.id,scoreRecovery});
 const destination=path.join(f.base,'score-backup');await createBackup({dataDirectory:f.data,db:core.db,destination,appVersion:'0.2.0'});
 await stageRestore({dataDirectory:f.data,directory:destination,db:core.db,appVersion:'0.2.0'});core.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));t.after(()=>restored.close());assert.deepEqual(restored.workspaces.records.get(f.profile.id,f.job.id).assessment,assessment);assert.deepEqual(restored.workspaces.tasks.get(f.profile.id,scoreTask.id).scoreRecovery,scoreRecovery);
});

test('schema 19 discards old disk caches while queue, records and protocol metadata survive upgrade and restore',async t=>{
 const f=await fixture(t),db=new AutomationStore(f.store),a=db.create('housing',{goal:'Berlin homes',criteria:{location:'Berlin',budget:'1500',requirements:'2 rooms'},sources:['https://example.test/']});
 db.review(a.id);const task=f.store.workspaces.tasks.enqueue(a.id,{operation:'scan',capability:'browser.observe',sourceUrl:a.sources[0],sources:a.sources}),run=db.begin(a.id,{kind:'run',taskId:task.id});
 db.observe(a.id,run.id,a.sources[0],'Results',[a.sources[0]+'one']);db.saveScanProgress(a.id,run.id,{pendingUrls:[a.sources[0]+'one'],reason:'Pending detail'},{url:a.sources[0],text:'Results'});
 db.putRun({...db.run(run.id),protocol:'contract',evidenceEpoch:'previous-process'});
 // Frozen schema-19 rows represent already-installed disk caches.
 f.store.db.exec(`CREATE TABLE automation_jev_tasks(id TEXT PRIMARY KEY,automation_id TEXT REFERENCES automations(id),task_id TEXT,data TEXT);
  CREATE TABLE automation_jev_evidence(id TEXT PRIMARY KEY,jev_task_id TEXT REFERENCES automation_jev_tasks(id),url TEXT,data TEXT);
  CREATE TABLE automation_browser_evidence(id TEXT PRIMARY KEY,automation_id TEXT REFERENCES automations(id),task_id TEXT,search_id TEXT,record_id TEXT,data TEXT);`);
 f.store.db.prepare('INSERT INTO automation_jev_tasks VALUES(?,?,?,?)').run('old-helper',a.id,task.id,JSON.stringify({id:'old-helper',status:'needs_agent',batch:{id:'old-batch'}}));
 f.store.db.prepare('INSERT INTO automation_jev_evidence VALUES(?,?,?,?)').run('old-evidence','old-helper',a.sources[0]+'one',JSON.stringify({text:'OLD_RAW_JEV_BODY'}));
 f.store.db.prepare('INSERT INTO automation_browser_evidence VALUES(?,?,?,?,?,?)').run('old-page',a.id,task.id,'default','',JSON.stringify({text:'OLD_RAW_BROWSER_BODY'}));
 f.store.db.exec('PRAGMA user_version=19');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,19);
 const core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite')),upgraded=new AutomationStore(core);
 const caches=()=>core.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('automation_jev_tasks','automation_jev_evidence','automation_browser_evidence')").all();assert.deepEqual(caches(),[]);
 assert.equal(core.db.prepare('PRAGMA user_version').get().user_version,DATA_SCHEMA_VERSION);assert.ok(upgraded.run(run.id).scan.pendingUrls.includes(a.sources[0]+'one'));assert.equal(core.workspaces.records.get(f.profile.id,f.job.id).id,f.job.id);
 assert.equal(upgraded.run(run.id).protocol,'contract');assert.deepEqual(upgraded.jevTasks.list(a.id,task.id),[]);
 const page={id:'ram-page',url:a.sources[0]+'one',text:'NEW_RAM_BODY_NOT_IN_BACKUP'};upgraded.browserEvidence.save(upgraded.run(run.id),page);
 const helper=upgraded.jevTasks.create(a.id,task.id,{operation:'collect_details'}),evidence=upgraded.jevTasks.evidence(helper,{url:page.url,text:'NEW_RAM_JEV_BODY_NOT_IN_BACKUP'});
 helper.batch={id:'ram-batch',urls:[page.url]};upgraded.jevTasks.save(helper);
 const destination=path.join(f.base,'memory-backup');await createBackup({dataDirectory:f.data,db:core.db,destination,appVersion:'0.2.0'});
 const bytes=await readFile(path.join(destination,'jobloop.sqlite'));for(const marker of ['OLD_RAW_JEV_BODY','OLD_RAW_BROWSER_BODY',page.text,'NEW_RAM_JEV_BODY_NOT_IN_BACKUP'])assert.equal(bytes.includes(Buffer.from(marker)),false);
 await stageRestore({dataDirectory:f.data,directory:destination,db:core.db,appVersion:'0.2.0'});core.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));t.after(()=>restored.close());const restoredDb=new AutomationStore(restored);
 assert.equal(restoredDb.browserEvidence.get(run,page.id),null);assert.throws(()=>restoredDb.jevTasks.fullEvidence(a.id,task.id,evidence.id),/süresi doldu/);
 assert.ok(restoredDb.run(run.id).scan.pendingUrls.includes(page.url));assert.equal(restoredDb.run(run.id).protocol,'contract');assert.equal(restored.workspaces.records.get(f.profile.id,f.job.id).id,f.job.id);
});

test('schema 20 access waits upgrade with a backup; new resume metadata survives restore without raw pages',async t=>{
 const f=await fixture(t),db=new AutomationStore(f.store),source='https://source.example/list',a=db.create('housing',{goal:'Berlin homes',criteria:{location:'Berlin',budget:'1500',requirements:'2 rooms'},sources:[source]});
 db.review(a.id);const task=f.store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:source,sources:[source]}),run=db.begin(a.id,{kind:'run',taskId:task.id}),wait=db.siteAccess.block(source,'verification');
 db.putRun({...db.run(run.id),siteWait:wait,resumeContext:{url:source,tabId:'retained-tab'}});db.finish(a.id,run.id,'blocked',wait.message);
 f.store.db.exec('PRAGMA user_version=20');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,20);
 const core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite')),upgraded=new AutomationStore(core);rememberSourceAccess(upgraded,upgraded.run(run.id));
 const recovery=upgraded.get(a.id).sourceState[source].accessRecovery;assert.equal(recovery.retryAt,wait.retryAt);assert.equal(recovery.state,'waiting');assert.equal(core.db.prepare('PRAGMA user_version').get().user_version,DATA_SCHEMA_VERSION);
 const helper=upgraded.jevTasks.create(a.id,task.id,{operation:'collect_details'});upgraded.jevTasks.evidence(helper,{url:source,text:'ACCESS_RECOVERY_RAW_RAM_ONLY'});
 const destination=path.join(f.base,'access-backup');await createBackup({dataDirectory:f.data,db:core.db,destination,appVersion:'0.2.0'});
 assert.equal((await readFile(path.join(destination,'jobloop.sqlite'))).includes(Buffer.from('ACCESS_RECOVERY_RAW_RAM_ONLY')),false);
 await stageRestore({dataDirectory:f.data,directory:destination,db:core.db,appVersion:'0.2.0'});core.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));t.after(()=>restored.close());const restoredDb=new AutomationStore(restored);
 assert.deepEqual(restoredDb.get(a.id).sourceState[source].accessRecovery,recovery);assert.equal(restoredDb.run(run.id).resumeContext.tabId,'retained-tab');assert.deepEqual(restoredDb.jevTasks.list(a.id,task.id),[]);assert.equal(restoredDb.siteAccess.status(source).retryAt,wait.retryAt);
});

test('schema 22 singleton tasks survive upgrade and batch assignments survive backup restore',async t=>{
 const f=await fixture(t),db=new AutomationStore(f.store),a=db.create('job-search',{goal:'Synthetic jobs',criteria:{preferences:'Remote',ranking:'Relevant experience'},sources:['https://example.test/jobs']});db.review(a.id);
 const seed=db.begin(a.id,'run'),items=[0,1].map(i=>db.record(a.id,seed.id,{url:'https://example.test/jobs/'+i,title:'Role '+i,summary:'Synthetic'}));db.finish(a.id,seed.id,'completed','Saved');
 const single=f.store.workspaces.tasks.enqueue(a.id,{operation:'record-score',recordOperation:'score',recordId:items[0].id,request:{manual:true,revision:1}});
 f.store.db.exec('PRAGMA user_version=22');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,22);
 const core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite')),queue=core.workspaces.tasks;
 assert.equal(queue.get(a.id,single.id).recordId,items[0].id);assert.equal(queue.get(a.id,single.id).recordIds,undefined);
 queue.finish(a.id,single.id,'cancelled');const ids=items.map(item=>item.id),batch=queue.enqueue(a.id,{recordOperation:'score',operation:'record-score',recordId:ids[0],recordIds:ids,request:{manual:true,revision:1}});
 const destination=path.join(f.base,'batch-export');await createBackup({dataDirectory:f.data,db:core.db,destination,appVersion:'0.2.0'});
 await stageRestore({dataDirectory:f.data,directory:destination,db:core.db,appVersion:'0.2.0'});core.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));try{assert.deepEqual(restored.workspaces.tasks.get(a.id,batch.id).recordIds,ids);assert.notEqual(restored.workspaces.tasks.get(a.id,batch.id).state,'pending');}finally{restored.close();}
});

test('schema 24 upgrade preserves browser sources and new source methods survive backup restore',async t=>{
 const f=await fixture(t),db=new AutomationStore(f.store),a=db.create('job-search',{goal:'Synthetic jobs',criteria:{preferences:'Remote',ranking:'Relevant experience'},sources:['https://example.test/jobs']});
 const url=a.sources[0],scope=sourceScanScope(a,url);f.store.db.exec('PRAGMA user_version=24');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,24);
 const core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite')),upgraded=new AutomationStore(core);
 assert.equal(core.db.prepare('PRAGMA user_version').get().user_version,DATA_SCHEMA_VERSION);assert.equal(sourceScanScope(upgraded.get(a.id),url),scope);
 assert.ok(!upgraded.sources(a.id)[0].tool);upgraded.saveSource(a.id,url,{tool:'freehire-search',instructions:'Search using current criteria'});upgraded.review(a.id);
 const task=core.workspaces.tasks.enqueue(a.id,{operation:'trial',sourceUrl:url,sources:[url],lockKey:'source:'+url}),run=upgraded.begin(a.id,{kind:'trial',taskId:task.id});
 recordSourceRead(upgraded,a.id,run.id,{url,command:'source search',summary:'Synthetic current JSON result'});upgraded.finish(a.id,run.id,'completed','Checked');
 const destination=path.join(f.base,'sources-export');await createBackup({dataDirectory:f.data,db:core.db,destination,appVersion:'0.2.0'});
 await stageRestore({dataDirectory:f.data,directory:destination,db:core.db,appVersion:'0.2.0'});core.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));try{
  const restoredDb=new AutomationStore(restored),source=restoredDb.sources(a.id)[0];assert.equal(source.tool,'freehire-search');assert.equal(source.instructions,'Search using current criteria');assert.equal(source.trial,null,'Restored sources require a fresh access check');
  assert.equal(restoredDb.run(run.id).sourceReads[0].reportedBy,'agent');assert.deepEqual(restoredDb.run(run.id).observations,[]);
 }finally{restored.close();}
});

test('schema 25 copies existing source skills once and preserves scan memory through upgrade and restore',async t=>{
 const f=await fixture(t),db=new AutomationStore(f.store),url='https://example.test/jobs',plain='https://plain.test/list';
 const a=db.create('job-search',{goal:'Synthetic jobs',criteria:{preferences:'Remote',ranking:'Relevant experience'},sources:[url,plain]});
 db.put({...a,sourceSettings:{[url]:{tool:'freehire-search',instructions:'Keep this method',query:'My search',intervalMinutes:87}}});db.review(a.id);db.skipTrial(a.id);
 const task=f.store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:url,sources:[url],lockKey:'source:'+url}),run=db.begin(a.id,{kind:'run',taskId:task.id});
 const pending=url+'/pending';db.saveScanProgress(a.id,run.id,{pendingUrls:[pending],reason:'Read next detail',cursor:'page=2'},{url,text:'Synthetic response'});db.finish(a.id,run.id,'interrupted','Resume later');
 f.store.db.exec('PRAGMA user_version=25');f.store.close();
 const upgrade=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.equal((await inspectBackup(upgrade.backup)).schemaVersion,25);
 let core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite')),upgraded=new AutomationStore(core),source=upgraded.get(a.id).sourceSettings[url];
 assert.match(source.skill,/freehire/i);assert.equal(source.instructions,'Keep this method');assert.equal(source.query,'My search');assert.equal(source.intervalMinutes,87);assert.equal(upgraded.get(a.id).sourceSettings[plain]?.skill,undefined);
 const scope=sourceScanScope(upgraded.get(a.id),url);assert.equal(upgraded.run(run.id).scanPlan.scopeKey,scope);assert.deepEqual(upgraded.run(run.id).scan.pendingUrls,[pending]);
 const nextTask=core.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:url,sources:[url],lockKey:'source:'+url}),next=upgraded.begin(a.id,{kind:'run',taskId:nextTask.id});
 assert.equal(next.scanPlan.id,run.scanPlan.id);assert.deepEqual(next.scan.pendingUrls,[pending]);upgraded.finish(a.id,next.id,'interrupted','Keep memory');
 upgraded.saveSource(a.id,url,{skill:''});core.close();core=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));upgraded=new AutomationStore(core);assert.equal(upgraded.get(a.id).sourceSettings[url].skill,'','A cleared local skill is not reloaded from the catalog');
 upgraded.saveSource(a.id,url,{skill:'My independent skill'});
 const destination=path.join(f.base,'local-skills-export');await createBackup({dataDirectory:f.data,db:core.db,destination,appVersion:'0.2.0'});
 await stageRestore({dataDirectory:f.data,directory:destination,db:core.db,appVersion:'0.2.0'});core.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new WorkspaceDatabase(path.join(f.data,'jobloop.sqlite'));try{assert.equal(new AutomationStore(restored).get(a.id).sourceSettings[url].skill,'My independent skill');}finally{restored.close();}
});
