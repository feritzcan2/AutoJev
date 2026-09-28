import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink,rename,utimes,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../app/store.mjs';
import {AccountVault} from '../app/account-vault.mjs';
import {TelegramStore} from '../app/telegram-store.mjs';
import {BackgroundStore} from '../app/background-store.mjs';
import {createBackup,inspectBackup,stageRestore,applyPendingRestore,prepareDataUpgrade,completeDataUpgrade,pruneLogs,dataManagementStatus,DATA_SCHEMA_VERSION} from '../app/data-management.mjs';
import {prunePromptLogs} from '../app/data-management-schema.mjs';

async function fixture(t){
 const base=await mkdtemp(path.join(tmpdir(),'jobloop-backup-test-')),data=path.join(base,'data');await mkdir(data);
 const store=new Store(path.join(data,'jobloop.sqlite')),profile=store.saveProfile({name:'Ada Lovelace',preferences:'Remote'}),candidate=path.join(data,'candidates',profile.id);
 await mkdir(path.join(candidate,'documents'),{recursive:true});await mkdir(path.join(candidate,'runtime'));
 await writeFile(path.join(candidate,'CV.pdf'),'Synthetic CV');await writeFile(path.join(candidate,'documents','letter.md'),'Synthetic letter');await writeFile(path.join(candidate,'runtime','token.txt'),'TRANSIENT-TOKEN');
 await writeFile(path.join(candidate,'AGENTS.md'),'generated instructions');await mkdir(path.join(candidate,'.codex'));await writeFile(path.join(candidate,'.codex','config.toml'),'runtime configuration');
 store.setCv(profile.id,path.join(candidate,'CV.pdf'));
 const job=store.addJob(profile.id,{url:'https://example.test/jobs/test',company:'Test Employer',role:'Engineer',location:'Remote',fit:'Fixture'}).job;
 new AccountVault(store.db,{encrypt:value=>'CIPHERTEXT-'+value,decrypt:value=>value}).save(profile.id,{email:'ada@example.test',password:'PORTAL-SECRET'});
 const telegram=new TelegramStore(store);telegram.saveConfig(profile.id,{bot:{id:123456,username:'test'},enabled:true,secret:'TELEGRAM-CIPHERTEXT'});
 store.db.exec('CREATE TABLE jev_settings(id INTEGER PRIMARY KEY,ciphertext TEXT NOT NULL,model TEXT NOT NULL)');store.db.prepare('INSERT INTO jev_settings VALUES(1,?,?)').run('JEV-CIPHERTEXT','model');
 store.logPrompt(profile.id,{kind:'start',text:'Prompt private content'});
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
 assert.equal(f.store.profile(f.profile.id).name,'Ada Lovelace');assert.equal(f.store.db.prepare('SELECT ciphertext FROM account_credentials').get().ciphertext,'CIPHERTEXT-PORTAL-SECRET');
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
 assert.equal(f.store.candidates().length,1);
});

test('restore stages safely, keeps current data until restart, rebases CVs and pauses all automatic activity',async t=>{
 const f=await fixture(t);f.store.saveCampaign(f.profile.id,{status:'running',task:{id:'task',jobId:f.job.id,kind:'application'},wakeAt:0});
 const worker=f.store.workerState.add(f.profile.id);f.store.workerState.write(f.profile.id,worker.id,'campaign',{status:'running',task:null});
 const background=new BackgroundStore(f.store);background.putTask(f.profile.id,{enabled:true});background.putRun({id:'run',candidateId:f.profile.id,status:'running'});
 f.store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({...f.job,status:'submitting',sessionId:'session',resumeContext:{tabId:'old'}}),f.job.id);
 await f.create();f.store.renameWorkspace(f.profile.id,'Newer live data');
 const target=path.join(f.base,'another-computer');await mkdir(target);const targetStore=new Store(path.join(target,'jobloop.sqlite'));targetStore.saveProfile({name:'Existing Candidate',preferences:'Local'});
 const staged=await stageRestore({dataDirectory:target,directory:f.backup,db:targetStore.db,appVersion:'0.2.0'});assert.equal(staged.restartRequired,true);assert.equal(targetStore.candidates()[0].name,'Existing Candidate');assert.equal((await inspectBackup(staged.recoveryBackup)).candidates,1);targetStore.close();
 assert.equal((await applyPendingRestore({dataDirectory:target})).restored,true);
 const restored=new Store(path.join(target,'jobloop.sqlite'));
 try{assert.equal(restored.profile(f.profile.id).cvPath,path.join(target,'candidates',f.profile.id,'CV.pdf'));assert.equal(await readFile(restored.profile(f.profile.id).cvPath,'utf8'),'Synthetic CV');assert.equal(restored.campaign(f.profile.id).status,'paused');assert.equal(restored.forWorker(worker.id).campaign(f.profile.id).status,'paused');assert.equal(restored.job(f.profile.id,f.job.id).status,'uncertain');assert.equal(restored.job(f.profile.id,f.job.id).sessionId,null);assert.equal(new BackgroundStore(restored).task(f.profile.id).enabled,false);assert.equal(restored.profile(f.profile.id).workspaceName,null);}finally{restored.close();}
 assert.equal(f.store.profile(f.profile.id).workspaceName,'Newer live data');assert.deepEqual(await applyPendingRestore({dataDirectory:target}),{restored:false});
});

test('interrupted restore rolls back the original database and files before opening Store',async t=>{
 const f=await fixture(t);await f.create();await stageRestore({dataDirectory:f.data,directory:f.backup,db:f.store.db,appVersion:'0.1.0'});f.store.close();
 const pending=JSON.parse(await readFile(path.join(f.data,'pending-restore.json'),'utf8')),rollbackName='.restore-rollback-'+randomUUID(),rollback=path.join(f.data,rollbackName);await mkdir(rollback);
 await writeFile(path.join(f.candidate,'documents','after-backup.txt'),'live recovery');
 await writeFile(path.join(f.data,'restore-transaction.json'),JSON.stringify({version:1,stageName:pending.stageName,rollbackName,originals:['jobloop.sqlite','candidates']}));
 await rename(path.join(f.data,'jobloop.sqlite'),path.join(rollback,'jobloop.sqlite'));await rename(path.join(f.data,'candidates'),path.join(rollback,'candidates'));
 await rename(path.join(f.data,pending.stageName,'jobloop.sqlite'),path.join(f.data,'jobloop.sqlite'));
 assert.deepEqual(await applyPendingRestore({dataDirectory:f.data}),{restored:false,recovered:true});assert.equal(await readFile(path.join(f.candidate,'documents','after-backup.txt'),'utf8'),'live recovery');
 const restored=new Store(path.join(f.data,'jobloop.sqlite'));assert.equal(restored.candidates().length,1);restored.close();
});

test('legacy data receives a recoverable backup before schema adoption and every app version change',async t=>{
 const f=await fixture(t);f.store.db.exec('PRAGMA user_version=0');f.store.close();
 const result=await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.ok(result.backup);assert.equal((await inspectBackup(result.backup)).schemaVersion,0);assert.equal((await inspectBackup(result.backup)).secrets,'os-encrypted-same-user');
 const upgraded=new Store(path.join(f.data,'jobloop.sqlite'));assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,DATA_SCHEMA_VERSION);upgraded.close();
 await completeDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'});assert.deepEqual(await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.2.0'}),{backup:null});
 assert.ok((await prepareDataUpgrade({dataDirectory:f.data,appVersion:'0.3.0'})).backup);
 const restored=new Store(path.join(f.data,'jobloop.sqlite'));await stageRestore({dataDirectory:f.data,directory:result.backup,db:restored.db,appVersion:'0.3.0'});restored.close();await applyPendingRestore({dataDirectory:f.data});
 const old=new Store(path.join(f.data,'jobloop.sqlite'));assert.equal(old.profile(f.profile.id).name,'Ada Lovelace');assert.equal(old.db.prepare('SELECT ciphertext FROM account_credentials').get().ciphertext,'CIPHERTEXT-PORTAL-SECRET');assert.equal(JSON.parse(old.db.prepare('SELECT data FROM telegram_configs').get().data).enabled,false);old.close();
});

test('newer schema is refused before Store modifies data',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'jobloop-future-schema-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'jobloop.sqlite'),db=new DatabaseSync(file);db.exec(`CREATE TABLE sentinel(value TEXT); PRAGMA user_version=${DATA_SCHEMA_VERSION+1}`);db.close();
 assert.throws(()=>new Store(file),/daha yeni/);await assert.rejects(()=>prepareDataUpgrade({dataDirectory:directory,appVersion:'0.1.0'}),/daha yeni/);
 const check=new DatabaseSync(file,{readOnly:true});assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name),['sentinel']);check.close();
});

test('log retention removes old and over-limit prompts, keeps application history and bounds closed terminal logs',async t=>{
 const f=await fixture(t),now=Date.now();f.store.db.exec('DELETE FROM prompts');const insert=f.store.db.prepare('INSERT INTO prompts(candidate_id,kind,text,at) VALUES(?,?,?,?)');
 insert.run(f.profile.id,'start','old',new Date(now-31*86400000).toISOString());for(let index=0;index<4;index++)insert.run(f.profile.id,'input',String(index),new Date(now).toISOString());
 assert.equal(prunePromptLogs(f.store.db,{now,perCandidate:2,total:3}),3);assert.equal(f.store.prompts(f.profile.id).length,2);assert.equal(f.store.jobs(f.profile.id).length,1);
 const old=path.join(f.data,'background','old','terminal.log'),large=path.join(f.data,'background','new','terminal.log'),active=path.join(f.data,'background','active','terminal.log');
 for(const file of [old,large,active]){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,Buffer.alloc(200000,'a'));}await utimes(old,new Date(now-31*86400000),new Date(now-31*86400000));
 const result=await pruneLogs({dataDirectory:f.data,db:f.store.db,now,activeBackgroundRunIds:['active']});assert.equal(result.terminalFiles,1);await assert.rejects(()=>stat(old),{code:'ENOENT'});assert.equal((await stat(large)).size,150000);assert.equal((await stat(active)).size,200000);
 assert.equal((await dataManagementStatus({dataDirectory:f.data,db:f.store.db,appVersion:'0.1.0'})).prompts,2);await pruneLogs({dataDirectory:f.data,db:f.store.db,clear:true,activeBackgroundRunIds:['active']});assert.equal(f.store.prompts(f.profile.id).length,0);assert.equal(f.store.jobs(f.profile.id).length,1);assert.equal((await stat(active)).size,200000);
});

test('automatic backups copied to another installation discard OS-bound secrets',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.data,'backups'));const backup=await createBackup({dataDirectory:f.data,db:f.store.db,destination:path.join(f.data,'backups','upgrade-copy'),appVersion:'0.1.0',kind:'upgrade'});
 const destination=path.join(f.base,'other');await mkdir(destination);const target=new Store(path.join(destination,'jobloop.sqlite'));
 const staged=await stageRestore({dataDirectory:destination,directory:backup.path,db:target.db,appVersion:'0.1.0'});assert.equal(staged.secrets,'excluded');target.close();await applyPendingRestore({dataDirectory:destination});
 const restored=new Store(path.join(destination,'jobloop.sqlite'));try{assert.equal(restored.db.prepare('SELECT ciphertext FROM account_credentials').get().ciphertext,null);assert.equal(restored.db.prepare('SELECT count(*) AS n FROM telegram_configs').get().n,0);}finally{restored.close();}
});

test('a corrupted pending restore is canceled while current records remain usable',async t=>{
 const f=await fixture(t);await f.create();await stageRestore({dataDirectory:f.data,directory:f.backup,db:f.store.db,appVersion:'0.1.0'});f.store.close();
 const pending=JSON.parse(await readFile(path.join(f.data,'pending-restore.json'),'utf8'));await writeFile(path.join(f.data,pending.stageName,'jobloop.sqlite'),'corrupt');
 await assert.rejects(()=>applyPendingRestore({dataDirectory:f.data}),/mevcut veriler korundu/);assert.deepEqual(await applyPendingRestore({dataDirectory:f.data}),{restored:false});
 const current=new Store(path.join(f.data,'jobloop.sqlite'));assert.equal(current.profile(f.profile.id).name,'Ada Lovelace');current.close();
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
 const f=await fixture(t),worker=f.store.workerState.add(f.profile.id),taskId='reviewed-task';
 f.store.saveTaskReview(f.profile.id,taskId,'main worker review');f.store.forWorker(worker.id).saveTaskReview(f.profile.id,taskId,'secondary worker review');
 await f.create();
 const exported=new DatabaseSync(path.join(f.backup,'jobloop.sqlite'),{readOnly:true});
 try{assert.equal(exported.prepare('SELECT count(*) AS n FROM task_context_reviews').get().n,0);assert.equal(exported.prepare("SELECT count(*) AS n FROM worker_state WHERE kind='review'").get().n,0);assert.equal(exported.prepare('SELECT count(*) AS n FROM agent_workers').get().n,1);}finally{exported.close();}
 await mkdir(path.join(f.data,'backups'));const backup=await createBackup({dataDirectory:f.data,db:f.store.db,destination:path.join(f.data,'backups','upgrade-review'),appVersion:'0.1.0',kind:'upgrade'});
 await stageRestore({dataDirectory:f.data,directory:backup.path,db:f.store.db,appVersion:'0.1.0'});f.store.close();await applyPendingRestore({dataDirectory:f.data});
 const restored=new Store(path.join(f.data,'jobloop.sqlite'));
 try{assert.equal(restored.taskReview(f.profile.id,taskId),undefined);assert.equal(restored.forWorker(worker.id).taskReview(f.profile.id,taskId),undefined);assert.equal(restored.workers(f.profile.id).length,2);}finally{restored.close();}
});

test('restore rebases canonical CV paths when the source data root uses a directory alias',async t=>{
 const f=await fixture(t),alias=path.join(f.base,'source-alias');await symlink(f.data,alias,process.platform==='win32'?'junction':'dir');
 f.store.setCv(f.profile.id,await realpath(path.join(f.candidate,'CV.pdf')));
 await createBackup({dataDirectory:alias,db:f.store.db,destination:f.backup,appVersion:'0.1.0'});
 const saved=JSON.parse(await readFile(path.join(f.backup,'manifest.json'),'utf8'));assert.equal(saved.sourceDirectory,alias);assert.equal(saved.canonicalSourceDirectory,await realpath(f.data));
 const target=path.join(f.base,'restored-alias');await mkdir(target);const current=new Store(path.join(target,'jobloop.sqlite'));
 await stageRestore({dataDirectory:target,directory:f.backup,db:current.db,appVersion:'0.1.0'});current.close();await applyPendingRestore({dataDirectory:target});
 const restored=new Store(path.join(target,'jobloop.sqlite'));
 try{assert.equal(restored.profile(f.profile.id).cvPath,path.join(target,'candidates',f.profile.id,'CV.pdf'));assert.equal(await readFile(restored.profile(f.profile.id).cvPath,'utf8'),'Synthetic CV');}finally{restored.close();}
});

for(const root of ['C:\\Users\\Example\\JobLoop','\\\\server\\share\\JobLoop'])test(`Windows source paths preserve CVs across case and separator changes: ${root}`,async t=>{
 const f=await fixture(t),windowsCv=root.toLowerCase()+'\\CANDIDATES\\'+f.profile.id+'\\cv.PDF';f.store.setCv(f.profile.id,windowsCv);await f.create();
 // A Windows-produced archive is restored on this test's native OS; no Windows filesystem is required.
 await manifest(f.backup,value=>{value.sourceDirectory=root.replaceAll('\\','/');delete value.canonicalSourceDirectory;});assert.equal((await inspectBackup(f.backup)).candidates,1);
 const target=path.join(f.base,'windows-import');await mkdir(target);const current=new Store(path.join(target,'jobloop.sqlite'));
 await stageRestore({dataDirectory:target,directory:f.backup,db:current.db,appVersion:'0.1.0'});current.close();await applyPendingRestore({dataDirectory:target});
 const restored=new Store(path.join(target,'jobloop.sqlite'));
 try{assert.equal(restored.profile(f.profile.id).cvPath,path.join(target,'candidates',f.profile.id,'CV.pdf'));assert.equal(await readFile(restored.profile(f.profile.id).cvPath,'utf8'),'Synthetic CV');}finally{restored.close();}
});

test('optional canonical source metadata stays compatible and rejects relative or malformed roots',async t=>{
 const f=await fixture(t);await f.create();const original=await readFile(path.join(f.backup,'manifest.json'),'utf8');
 await manifest(f.backup,value=>delete value.canonicalSourceDirectory);assert.equal((await inspectBackup(f.backup)).candidates,1);
 for(const canonicalSourceDirectory of ['../outside','relative','\\root-relative',42,'/bad\0root']){await writeFile(path.join(f.backup,'manifest.json'),original);await manifest(f.backup,value=>{value.canonicalSourceDirectory=canonicalSourceDirectory;});await assert.rejects(()=>inspectBackup(f.backup),/geçersiz/);}
});
