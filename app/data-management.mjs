import {pruneInstructionLogs} from './instruction-log.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readdir,lstat,realpath,readFile,writeFile,copyFile,chmod,rename,rm,open} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DATA_SCHEMA_VERSION,LOG_RETENTION,assertDataSchemaVersion,prunePromptLogs} from './data-management-schema.mjs';
export {DATA_SCHEMA_VERSION,LOG_RETENTION} from './data-management-schema.mjs';

const FORMAT='jobloop-backup',FORMAT_VERSION=1,MAX_FILES=20000,MAX_FILE_BYTES=512*1024*1024,MAX_TOTAL_BYTES=2*1024*1024*1024;
const excluded=new Set(['runtime','node_modules','AGENTS.md','CLAUDE.md']);
const restoreTargets=['jobloop.sqlite','jobloop.sqlite-wal','jobloop.sqlite-shm','candidates','automations','processes','browsers','background','telegram.json','google-oauth.json','mobile.json'];
const exists=async file=>{try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const within=(base,file)=>file===base||file.startsWith(base+path.sep);
const tableExists=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const iso=()=>new Date().toISOString();
const dateName=()=>iso().replace(/[:.]/g,'-');
function safeRelative(value){
 if(typeof value!=='string'||value.length>1500||value.includes('\\')||value.includes('\0')||path.posix.isAbsolute(value))throw Error('Yedekte geçersiz dosya yolu.');
 const parts=value.split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'||p.startsWith('.')||excluded.has(p)||/[<>:"|?*\x00-\x1f]/.test(p)||/[ .]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)))throw Error('Yedekte güvenli olmayan dosya yolu.');
 if(value!=='jobloop.sqlite'&&!(parts[0]==='candidates'&&parts.length>=3)&&!(parts[0]==='automations'&&parts[1]==='workspaces'&&parts.length>=4))throw Error('Yedek yalnızca çalışma alanı dosyalarını ve veritabanını içerebilir.');
 return value;
}
async function regularFile(root,relative){
 const parts=safeRelative(relative).split('/');let file=root;
 for(const [index,part] of parts.entries()){
  file=path.join(file,part);const info=await lstat(file);
  if(info.isSymbolicLink()||(index===parts.length-1?!info.isFile():!info.isDirectory()))throw Error('Yedekte bağlantı veya geçersiz dosya var.');
 }
 if(!within(root,await realpath(file)))throw Error('Yedek dosyası klasörün dışında.');
 return file;
}
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function atomicJson(file,value){
 const temporary=file+'.'+randomUUID()+'.tmp';const handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
 try{await rename(temporary,file);}catch(error){await rm(temporary,{force:true});throw error;}
}
async function backupOwner(dataDirectory,{create=false}={}){
 const file=path.join(dataDirectory,'backup-owner.json');
 if(await exists(file)){const owner=JSON.parse(await readFile(file,'utf8'));if(typeof owner.id!=='string'||!/^[a-f0-9-]{36}$/.test(owner.id))throw Error('Yedek sahipliği kaydı geçersiz.');return owner.id;}
 if(!create)return null;const id=randomUUID();await atomicJson(file,{id});return id;
}
async function privateCopy(source,destination){await mkdir(path.dirname(destination),{recursive:true,mode:0o700});await copyFile(source,destination);await chmod(destination,0o600);}
function sqliteCheck(file){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  db.exec('PRAGMA trusted_schema=OFF');assertDataSchemaVersion(db);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('trigger','view') OR sql LIKE 'CREATE VIRTUAL TABLE%'").get())throw Error('Yedek desteklenmeyen veritabanı nesneleri içeriyor.');
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Yedek veritabanı bozuk.');
  for(const name of tableExists(db,'workspaces')?['workspaces','workspace_records']:['candidates','jobs','sources','questions'])if(!tableExists(db,name))throw Error('Bu dosya bir AutoJev veritabanı değil.');
  if(db.prepare('PRAGMA foreign_key_check').get())throw Error('Yedek veritabanının ilişkileri tutarsız.');
  for(const table of ['candidates','jobs','workspace_records','workspace_workers','workspace_tasks','agent_workers','background_runs','workspaces','automation_templates','automations','automation_runs','automation_results','automation_messages'])if(tableExists(db,table))for(const row of db.prepare(`SELECT id,data FROM ${table}`).iterate()){
   const value=JSON.parse(row.data);if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,149}$/.test(row.id)||value.id!==row.id)throw Error('Yedekte geçersiz kayıt kimliği var.');
  }
  return {schemaVersion:db.prepare('PRAGMA user_version').get().user_version,candidates:tableExists(db,'candidates')?db.prepare('SELECT count(*) AS n FROM candidates').get().n:0,jobs:!tableExists(db,'candidates')?0:(tableExists(db,'workspace_records')?db.prepare('SELECT count(*) AS n FROM workspace_records WHERE workspace_id IN (SELECT id FROM candidates)'):db.prepare('SELECT count(*) AS n FROM jobs')).get().n};
 }finally{db.close();}
}
function sanitizeExport(db){
 db.exec('PRAGMA secure_delete=ON');
 if(tableExists(db,'account_credentials'))db.exec('UPDATE account_credentials SET ciphertext=NULL,pending=NULL');
 for(const table of ['captcha_settings','jev_settings','gmail_accounts','telegram_job_messages','telegram_outbox','telegram_pairs','telegram_links','telegram_configs','telegram_meta','prompts','workspace_instruction_events','workspace_conversations','agent_conversations','conversation_launch_settings','task_context_reviews'])if(tableExists(db,table))db.exec(`DELETE FROM ${table}`);
 if(tableExists(db,'worker_state'))db.exec("DELETE FROM worker_state WHERE kind LIKE 'conversation:%' OR kind IN ('review','task_context_review')");
 if(tableExists(db,'automations'))db.exec("UPDATE automations SET data=json_remove(data,'$.conversations')");
 // Remove deleted secrets from SQLite free pages in the exported copy.
 db.exec('VACUUM');
}
async function candidateFiles(root,prefix='candidates'){
 const files=[];
 async function walk(directory,relative='',depth=0){
  if(depth>20)throw Error('Aday dosyaları çok fazla iç içe klasör içeriyor.');
  for(const entry of await readdir(directory,{withFileTypes:true})){
   if(entry.name.startsWith('.')||excluded.has(entry.name))continue;
   const rel=relative?relative+'/'+entry.name:entry.name,file=path.join(directory,entry.name);
   if(entry.isSymbolicLink())throw Error('Aday dosyalarında sembolik bağlantı var; yedeği oluşturmadan önce normal bir dosyaya dönüştür.');
   if(entry.isDirectory())await walk(file,rel,depth+1);
   else if(entry.isFile()){files.push(safeRelative(prefix+'/'+rel));if(files.length>MAX_FILES-1)throw Error('Yedekte çok fazla dosya var.');}
  }
 }
 if(await exists(root)){if((await lstat(root)).isSymbolicLink())throw Error('Aday klasörü sembolik bağlantı olamaz.');await walk(root);}
 return files;
}

// Call only while writers/agents are stopped. VACUUM INTO includes committed WAL data.
// Manual backups are portable; internal upgrade backups retain this OS user's ciphertext.
export async function createBackup({dataDirectory,db=null,destination,appVersion,kind='manual'}){
 const base=await realpath(dataDirectory),internal=['upgrade','before-restore'].includes(kind);
 if(!['manual','upgrade','before-restore'].includes(kind))throw Error('Geçersiz yedek türü.');
 const parent=await realpath(path.dirname(destination)),target=path.join(parent,path.basename(destination));
 if(within(base,target)&&(!internal||parent!==path.join(base,'backups')))throw Error('Yedek için uygulama veri klasörünün dışında bir yer seç.');
 if(await exists(target))throw Error('Yedek klasörü zaten var; yeni bir klasör adı seç.');
 const temporary=path.join(parent,'.jobloop-backup-'+randomUUID());await mkdir(temporary,{mode:0o700});
 let connection=db;
 try{
  if(!connection)connection=new DatabaseSync(path.join(base,'jobloop.sqlite'),{readOnly:true});
  connection.prepare('VACUUM INTO ?').run(path.join(temporary,'jobloop.sqlite'));
  await chmod(path.join(temporary,'jobloop.sqlite'),0o600);
  if(!internal){const copy=new DatabaseSync(path.join(temporary,'jobloop.sqlite'));try{sanitizeExport(copy);}finally{copy.close();}}
  const files=['jobloop.sqlite',...await candidateFiles(path.join(base,'candidates')),...await candidateFiles(path.join(base,'automations','workspaces'),'automations/workspaces')],manifestFiles=[];let totalBytes=0;if(files.length>MAX_FILES)throw Error('Yedekte çok fazla dosya var.');
  for(const name of files){
   const source=name==='jobloop.sqlite'?path.join(temporary,name):await regularFile(base,name);
   const info=await lstat(source);totalBytes+=info.size;
   if(info.size>MAX_FILE_BYTES||totalBytes>MAX_TOTAL_BYTES)throw Error('Yedek sınırı aşıldı: dosya başına 512 MB, toplam 2 GB.');
   const output=path.join(temporary,...name.split('/'));
   if(name!=='jobloop.sqlite')await privateCopy(source,output);
   manifestFiles.push({path:name,bytes:(await lstat(output)).size,sha256:await digest(output)});
  }
  const counts=sqliteCheck(path.join(temporary,'jobloop.sqlite'));
  const manifest={format:FORMAT,version:FORMAT_VERSION,appVersion:String(appVersion),createdAt:iso(),kind,secrets:internal?'os-encrypted-same-user':'excluded',sourceDirectory:path.resolve(dataDirectory),canonicalSourceDirectory:base,...(internal?{ownerId:await backupOwner(base,{create:true})}:{}),...counts,files:manifestFiles};
  await atomicJson(path.join(temporary,'manifest.json'),manifest);await rename(temporary,target);
  return {path:target,...summary(manifest)};
 }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
 finally{if(connection&&connection!==db)connection.close();}
}
function summary(manifest){return {appVersion:manifest.appVersion,createdAt:manifest.createdAt,kind:manifest.kind,secrets:manifest.secrets,schemaVersion:manifest.schemaVersion,candidates:manifest.candidates,jobs:manifest.jobs,files:manifest.files.length,bytes:manifest.files.reduce((sum,file)=>sum+file.bytes,0)};}

export async function inspectBackup(directory){
 const requested=path.resolve(directory);if((await lstat(requested)).isSymbolicLink())throw Error('Yedek klasörü bir sembolik bağlantı olamaz.');
 const root=await realpath(requested),manifestPath=path.join(root,'manifest.json'),info=await lstat(manifestPath);
 if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw Error('Geçersiz yedek manifesti.');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 if(manifest.format!==FORMAT||manifest.version!==FORMAT_VERSION||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>MAX_FILES||!['manual','upgrade','before-restore'].includes(manifest.kind)||!['excluded','os-encrypted-same-user'].includes(manifest.secrets)||!validSourceDirectory(manifest.sourceDirectory)||manifest.canonicalSourceDirectory!==undefined&&!validSourceDirectory(manifest.canonicalSourceDirectory)||!Number.isSafeInteger(manifest.schemaVersion)||manifest.schemaVersion<0||manifest.schemaVersion>DATA_SCHEMA_VERSION||typeof manifest.appVersion!=='string'||manifest.appVersion.length>100||!Number.isFinite(Date.parse(manifest.createdAt)))throw Error('Desteklenmeyen veya geçersiz AutoJev yedeği.');
 const seen=new Set();let total=0;
 for(const entry of manifest.files){
  const name=safeRelative(entry.path),key=name.normalize('NFC').toLocaleLowerCase('en');
  if(seen.has(key)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>MAX_FILE_BYTES||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Yedekte yinelenen veya geçersiz dosya kaydı.');
  seen.add(key);total+=entry.bytes;if(total>MAX_TOTAL_BYTES)throw Error('Yedek 2 GB sınırını aşıyor.');
  const file=await regularFile(root,name);if((await lstat(file)).size!==entry.bytes||await digest(file)!==entry.sha256)throw Error('Yedek dosyası eksik veya değiştirilmiş: '+name);
 }
 for(const key of seen){const parts=key.split('/');for(let index=1;index<parts.length;index++)if(seen.has(parts.slice(0,index).join('/')))throw Error('Yedekte dosya/klasör çakışması var.');}
 if(!seen.has('jobloop.sqlite'))throw Error('Yedekte veritabanı eksik.');
 const counts=sqliteCheck(path.join(root,'jobloop.sqlite'));
 if(counts.schemaVersion!==manifest.schemaVersion||counts.candidates!==manifest.candidates||counts.jobs!==manifest.jobs)throw Error('Yedek özeti veritabanıyla uyuşmuyor.');
 return {path:root,...summary(manifest)};
}

function validSourceDirectory(value){return typeof value==='string'&&value.length<=4000&&!value.includes('\0')&&(path.posix.isAbsolute(value)||/^[A-Za-z]:[\\/]/.test(value)||/^\\\\[^\\]+\\[^\\]+/.test(value));}
function normalizedSourcePath(value){
 const windows=/^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(value);
 const normalized=(windows?path.win32.normalize(value).replaceAll('\\','/'):path.posix.normalize(value)).replace(/\/$/,'');
 return {value:normalized,key:windows?normalized.toLowerCase():normalized,windows};
}
function rewritePath(value,sourceDirectories,destination){
 if(typeof value==='string'){
  const normalized=normalizedSourcePath(value);
  for(const directory of sourceDirectories){const base=normalizedSourcePath(directory);if(normalized.windows===base.windows&&normalized.key.startsWith(base.key+'/'))return path.join(destination,...normalized.value.slice(base.value.length+1).split('/'));}
  return value;
 }
 if(Array.isArray(value))return value.map(item=>rewritePath(item,sourceDirectories,destination));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewritePath(item,sourceDirectories,destination)]));
 return value;
}
function prepareRestoredDatabase(file,manifest,dataDirectory){
 const db=new DatabaseSync(file),sourceDirectories=[manifest.sourceDirectory,manifest.canonicalSourceDirectory].filter(Boolean),windowsSource=sourceDirectories.some(directory=>normalizedSourcePath(directory).windows);
 const fileKey=value=>windowsSource?value.normalize('NFC').toLowerCase():value;
 const files=new Map(manifest.files.map(entry=>[fileKey(entry.path),entry.path]));
 try{
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; BEGIN');
  for(const table of ['candidates','jobs','workspace_records','workspace_tasks','sources','setups','campaigns','worker_state','background_tasks','background_runs','mail_signals','automations','automation_runs','automation_results','automation_messages','automation_jev_tasks','automation_jev_evidence','automation_browser_evidence']){
   if(!tableExists(db,table))continue;
   for(const row of db.prepare(`SELECT rowid,data FROM ${table}`).all()){
    let value=rewritePath(JSON.parse(row.data),sourceDirectories,dataDirectory);if(!value||typeof value!=='object')continue;
    if(table==='campaigns'||table==='worker_state'&&value.status==='running')Object.assign(value,{status:'paused',wakeAt:0,note:'Yedekten geri yüklendi. Sonuçları kontrol edip Başlat ile devam edebilirsin.'});
    if(table==='candidates'&&value.cvPath){const relative=path.relative(dataDirectory,value.cvPath).split(path.sep).join('/'),included=files.get(fileKey(relative));value.cvPath=included&&fileKey(relative).startsWith(fileKey('candidates/'+value.id+'/'))?path.join(dataDirectory,...included.split('/')):null;}
    if(table==='background_tasks')Object.assign(value,{enabled:false,connection:null,connectorAccess:null});
    if(table==='background_runs'&&value.status==='running')Object.assign(value,{status:'interrupted',finishedAt:Date.now()});
    if(table==='automations'){Object.assign(value,{status:'paused',nextRunAt:null,trial:null,reviewedRevision:null,sourceTrialsVersion:1});for(const state of Object.values(value.sourceState??{}))state.trial=null;}
    if(table==='automation_jev_tasks'&&value.status==='running')value.status='continue';
    if(table==='automation_runs'&&value.status==='running')Object.assign(value,{status:'interrupted',finishedAt:Date.now(),actionId:null});
    if(table==='workspace_tasks'){value.state='interrupted';value.finishedAt=Date.now();}
    const jobRecord=table==='jobs'||table==='workspace_records'&&value.candidateId;
    if(table==='automation_results'||table==='workspace_records'&&value.automationId){value.approvedDigest=null;if(value.status==='executing')value.status='uncertain';}
    if(table==='setups'&&value.status==='running')Object.assign(value,{status:'cancelled',needsTurn:false});
    if(table==='sources'||jobRecord)value.resumeContext=null;
    if(jobRecord){value.sessionId=null;if(value.status==='submitting'){value.status='uncertain';value.note='Yedekten geri yüklendi; tekrar göndermeden önce başvuru sonucunu doğrula.';}else if(value.status==='working'){value.status='blocked';value.note='Yedekten geri yüklendi; başvuru sonucunu kontrol et.';}}
    db.prepare(`UPDATE ${table} SET data=? WHERE rowid=?`).run(JSON.stringify(value),row.rowid);
   }
  }
  if(tableExists(db,'workspace_tasks'))db.exec("UPDATE workspace_tasks SET state='interrupted' WHERE state IN ('running','reported','paused','pending')");
  for(const table of ['workspace_instruction_events','workspace_conversations','agent_conversations','conversation_launch_settings','task_context_reviews','telegram_pairs'])if(tableExists(db,table))db.exec(`DELETE FROM ${table}`);
  if(tableExists(db,'worker_state'))db.exec("DELETE FROM worker_state WHERE kind LIKE 'conversation:%' OR kind IN ('review','task_context_review')");
 if(tableExists(db,'automations'))db.exec("UPDATE automations SET data=json_remove(data,'$.conversations')");
  // Restores never resume Telegram polling or pending deliveries automatically.
  if(tableExists(db,'telegram_configs'))for(const row of db.prepare('SELECT candidate_id,data FROM telegram_configs').all()){const value=JSON.parse(row.data);value.enabled=false;db.prepare('UPDATE telegram_configs SET data=? WHERE candidate_id=?').run(JSON.stringify(value),row.candidate_id);}
  db.exec('COMMIT; VACUUM');
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
}

// All validation happens before replacing live data. Call with idle writers; then restart.
export async function stageRestore({dataDirectory,directory,db,appVersion}){
 const info=await inspectBackup(directory),base=await realpath(dataDirectory);
 if(within(base,info.path)&&!within(path.join(base,'backups'),info.path))throw Error('Uygulama veri klasöründen geri yükleme yapılamaz.');
 if(await exists(path.join(base,'pending-restore.json')))throw Error('Bir geri yükleme zaten yeniden başlatmayı bekliyor.');
 const manifest=JSON.parse(await readFile(path.join(info.path,'manifest.json'),'utf8'));
 const id=randomUUID(),stageName='.restore-stage-'+id,stage=path.join(base,stageName);await mkdir(stage,{mode:0o700});
 try{
  for(const entry of manifest.files)await privateCopy(await regularFile(info.path,entry.path),path.join(stage,...entry.path.split('/')));
  await atomicJson(path.join(stage,'manifest.json'),manifest);await inspectBackup(stage);
  if(manifest.secrets==='os-encrypted-same-user'&&(!manifest.ownerId||manifest.ownerId!==await backupOwner(base))){const copy=new DatabaseSync(path.join(stage,'jobloop.sqlite'));try{sanitizeExport(copy);}finally{copy.close();}manifest.secrets='excluded';}
  prepareRestoredDatabase(path.join(stage,'jobloop.sqlite'),manifest,path.resolve(dataDirectory));
  const database=manifest.files.find(file=>file.path==='jobloop.sqlite');database.bytes=(await lstat(path.join(stage,'jobloop.sqlite'))).size;database.sha256=await digest(path.join(stage,'jobloop.sqlite'));
  await atomicJson(path.join(stage,'manifest.json'),manifest);await inspectBackup(stage);
  await mkdir(path.join(base,'backups'),{recursive:true,mode:0o700});
  const recovery=await createBackup({dataDirectory,db,destination:path.join(base,'backups','before-restore-'+dateName()+'-'+id),appVersion,kind:'before-restore'});
  await atomicJson(path.join(base,'pending-restore.json'),{version:1,stageName,createdAt:iso()});
  return {...info,secrets:manifest.secrets,restartRequired:true,recoveryBackup:recovery.path};
 }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}
function validateStageName(value,prefix){if(typeof value!=='string'||!value.startsWith(prefix)||!/^[a-f0-9-]{36}$/.test(value.slice(prefix.length)))throw Error('Geçersiz geri yükleme işlemi.');return value;}
async function recoverTransaction(base,journal){
 const stage=path.join(base,validateStageName(journal.stageName,'.restore-stage-')),rollback=path.join(base,validateStageName(journal.rollbackName,'.restore-rollback-'));
 if(!Array.isArray(journal.originals)||journal.originals.some(name=>!restoreTargets.includes(name)))throw Error('Geçersiz geri yükleme kaydı.');
 for(const name of restoreTargets){
  const current=path.join(base,name),old=path.join(rollback,name);
  if(await exists(old)){await rm(current,{recursive:true,force:true});await rename(old,current);}
  else if(!journal.originals.includes(name)&&!await exists(path.join(stage,name)))await rm(current,{recursive:true,force:true});
 }
 await rm(path.join(base,'pending-restore.json'),{force:true});await rm(path.join(base,'restore-transaction.json'),{force:true});
 await rm(stage,{recursive:true,force:true});await rm(rollback,{recursive:true,force:true});
}

// MUST run before any SQLite connection, browser, worker or Telegram client is opened.
export async function applyPendingRestore({dataDirectory}){
 const base=await realpath(dataDirectory),journalPath=path.join(base,'restore-transaction.json'),pendingPath=path.join(base,'pending-restore.json');
 if(await exists(journalPath)){await recoverTransaction(base,JSON.parse(await readFile(journalPath,'utf8')));return {restored:false,recovered:true};}
 if(!await exists(pendingPath))return {restored:false};
 let stageName,stage;
 try{const pending=JSON.parse(await readFile(pendingPath,'utf8'));stageName=validateStageName(pending.stageName,'.restore-stage-');stage=path.join(base,stageName);await inspectBackup(stage);}
 catch(error){await rm(pendingPath,{force:true});if(stage)await rm(stage,{recursive:true,force:true});throw Error('Yedek doğrulanamadı; mevcut veriler korundu. AutoJev’i yeniden açabilirsin. '+error.message);}
 const rollbackName='.restore-rollback-'+randomUUID(),rollback=path.join(base,rollbackName);await mkdir(rollback,{mode:0o700});
 const originals=[];for(const name of restoreTargets)if(await exists(path.join(base,name)))originals.push(name);
 const journal={version:1,stageName,rollbackName,originals};await atomicJson(journalPath,journal);
 try{
  for(const name of restoreTargets)if(originals.includes(name))await rename(path.join(base,name),path.join(rollback,name));
  for(const name of ['jobloop.sqlite','candidates','automations'])if(await exists(path.join(stage,name)))await rename(path.join(stage,name),path.join(base,name));
  sqliteCheck(path.join(base,'jobloop.sqlite'));
  // Removing the journal commits the replacement. Interrupted earlier operations roll back.
  await rm(pendingPath,{force:true});await rm(journalPath,{force:true});
  await rm(stage,{recursive:true,force:true});await rm(rollback,{recursive:true,force:true});
  return {restored:true};
 }catch(error){if(await exists(journalPath))await recoverTransaction(base,journal);throw error;}
}

// First launch adopts legacy data only after a usable backup exists. Failure aborts upgrade.
export async function prepareDataUpgrade({dataDirectory,appVersion}){
 const base=await realpath(dataDirectory),file=path.join(base,'jobloop.sqlite');if(!await exists(file))return {backup:null};
 const db=new DatabaseSync(file,{readOnly:true});let schema;
 try{schema=assertDataSchemaVersion(db);}finally{db.close();}
 const marker=path.join(base,'data-version.json'),previous=await exists(marker)?JSON.parse(await readFile(marker,'utf8')):null;
 if(previous?.appVersion===appVersion&&schema===DATA_SCHEMA_VERSION)return {backup:null};
 await mkdir(path.join(base,'backups'),{recursive:true,mode:0o700});
 const backup=await createBackup({dataDirectory,destination:path.join(base,'backups','upgrade-'+dateName()+'-'+randomUUID()),appVersion:previous?.appVersion??'legacy',kind:'upgrade'});
 return {backup:backup.path,previousVersion:previous?.appVersion??null};
}
export async function completeDataUpgrade({dataDirectory,appVersion}){
 await atomicJson(path.join(dataDirectory,'data-version.json'),{appVersion,schemaVersion:DATA_SCHEMA_VERSION,updatedAt:iso()});
 // Keep the latest five upgrade snapshots, including updater-created backups.
 // Cleanup is best effort after the version marker is safely written.
 const directory=path.join(dataDirectory,'backups');if(!await exists(directory))return;
 const entries=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink()||!/^(upgrade|before-update)-[\w.-]+$/.test(entry.name))continue;
  try{const manifest=JSON.parse(await readFile(path.join(directory,entry.name,'manifest.json'),'utf8'));if(manifest.format===FORMAT&&manifest.kind==='upgrade'&&Number.isFinite(Date.parse(manifest.createdAt)))entries.push({name:entry.name,createdAt:manifest.createdAt});}catch{}
 }
 entries.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 const warnings=[];for(const entry of entries.slice(5))try{await rm(path.join(directory,entry.name),{recursive:true,force:true});}catch(error){warnings.push(error.message);}
 return {warnings};
}

export async function pruneLogs({dataDirectory,db,now=Date.now(),clear=false,activeBackgroundRunIds=[]}){
 const instructionEvents=pruneInstructionLogs(db,{now,clear});
 const prompts=clear?(tableExists(db,'prompts')?Number(db.prepare('DELETE FROM prompts').run().changes):0):prunePromptLogs(db,{now});
 const directories=[path.join(dataDirectory,'background'),path.join(dataDirectory,'automations','runs')],files=[],active=new Set(activeBackgroundRunIds);let terminalFiles=0;
 for(const directory of directories)if(await exists(directory)&&!(await lstat(directory)).isSymbolicLink())for(const entry of await readdir(directory,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink()||entry.name==='workspaces'||active.has(entry.name))continue;
  const file=path.join(directory,entry.name,'terminal.log');if(!await exists(file))continue;
  const info=await lstat(file);if(info.isFile()&&!info.isSymbolicLink())files.push({file,mtime:info.mtimeMs,size:info.size});
 }
 files.sort((a,b)=>b.mtime-a.mtime);
 for(const [index,entry] of files.entries()){
  if(clear||entry.mtime<now-LOG_RETENTION.days*86400000||index>=LOG_RETENTION.terminalFiles){await rm(entry.file,{force:true});terminalFiles++;}
  else if(entry.size>LOG_RETENTION.terminalBytes){const handle=await open(entry.file,'r');let tail;try{tail=Buffer.alloc(LOG_RETENTION.terminalBytes);await handle.read(tail,0,tail.length,entry.size-tail.length);}finally{await handle.close();}await writeFile(entry.file,tail,{mode:0o600});}
 }
 // Remove obsolete WAL pages after pruning; a busy reader leaves the next pass to retry.
 db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 return {prompts,terminalFiles,instructionEvents};
}
export async function dataManagementStatus({dataDirectory,db,appVersion}){
 const directory=path.join(dataDirectory,'backups'),backups=[];
 if(await exists(directory))for(const entry of await readdir(directory,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;
  try{const manifest=JSON.parse(await readFile(path.join(directory,entry.name,'manifest.json'),'utf8'));if(manifest.format===FORMAT)backups.push({name:entry.name,...summary(manifest)});}catch{}
 }
 return {appVersion,schemaVersion:assertDataSchemaVersion(db),retention:LOG_RETENTION,prompts:tableExists(db,'prompts')?db.prepare('SELECT count(*) AS n FROM prompts').get().n:0,backups:backups.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),pendingRestore:await exists(path.join(dataDirectory,'pending-restore.json'))};
}
