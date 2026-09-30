import {randomUUID,createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,readdir,lstat,realpath,readFile,rename,rm,rmdir,copyFile,chmod,open} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';

const settingsName='data-location.json',pendingName='pending-data-location.json',markerName='.loop-storage.json';
const directories=['candidates','automations','background','browsers','plugins','backups','imports'];
const files=['data-version.json','backup-owner.json','telegram.json'];
const inside=(parent,child)=>child===parent||child.startsWith(parent+path.sep);
const exists=async file=>{try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
async function json(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function save(file,value){
 const temporary=file+'.'+randomUUID()+'.tmp',handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
 await rename(temporary,file);
}
async function checkedDirectory(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('Geçerli bir veri klasörü seç.');
 const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('Veri konumu gerçek bir klasör olmalı.');
 return realpath(directory);
}
export async function currentDataDirectory(bootstrapDirectory){
 const saved=await json(path.join(bootstrapDirectory,settingsName));
 if(!saved)return checkedDirectory(bootstrapDirectory);
 if(saved.version!==1)throw Error('Veri konumu ayarı okunamadı.');
 const directory=await checkedDirectory(saved.directory);
 if(!await exists(path.join(directory,'jobloop.sqlite')))throw Error('Seçilen veri klasöründeki veritabanı bulunamadı: '+directory);
 return directory;
}
export async function requestDataLocation({bootstrapDirectory,dataDirectory,destination}){
 const source=await checkedDirectory(dataDirectory),target=await checkedDirectory(destination);
 if(source===target)return {changed:false,directory:source};
 if(inside(source,target)||inside(target,source)||inside(target,await realpath(bootstrapDirectory)))throw Error('Mevcut veri klasörüyle iç içe olmayan boş bir klasör seç.');
 if((await readdir(target)).length)throw Error('Seçilen klasör boş olmalı. İçindeki dosyalar değiştirilmedi.');
 if(await exists(path.join(source,'pending-restore.json')))throw Error('Önce bekleyen geri yüklemeyi tamamla.');
 if(await exists(path.join(bootstrapDirectory,pendingName)))throw Error('Veri klasörünü değiştirmek için yeniden başlatma bekleniyor.');
 const request={version:1,id:randomUUID(),source,destination:target};
 await save(path.join(bootstrapDirectory,pendingName),request);
 return {changed:true,directory:target,restartRequired:true};
}
async function existingDataDirectory(directory,{allowPendingLocation=false}={}){
 const target=await checkedDirectory(directory);
 if(await exists(path.join(target,'manifest.json')))throw Error('Bu bir yedek klasörü. Yedekten geri yükle seçeneğini kullan.');
 const file=path.join(target,'jobloop.sqlite');
 if(!await exists(file))throw Error('Seçilen klasörde jobloop.sqlite bulunamadı. Mevcut AutoJev veri klasörünü seç.');
 const info=await lstat(file);
 if(!info.isFile()||info.isSymbolicLink())throw Error('Veritabanı gerçek bir dosya olmalı.');
 if(await exists(path.join(target,'pending-restore.json'))||!allowPendingLocation&&await exists(path.join(target,pendingName)))throw Error('Seçilen klasörde bekleyen geri yükleme veya veri konumu değişikliği var. Önce bu işlemi tamamla.');
 const db=new DatabaseSync(file,{readOnly:true});
 try{checkDatabase(db);}finally{db.close();}
 return target;
}
export async function requestExistingDataLocation({bootstrapDirectory,dataDirectory,destination}){
 const source=await checkedDirectory(dataDirectory),target=await checkedDirectory(destination);
 if(source===target)return {changed:false,directory:source};
 if(await exists(path.join(source,'pending-restore.json')))throw Error('Önce bekleyen geri yüklemeyi tamamla.');
 if(await exists(path.join(bootstrapDirectory,pendingName)))throw Error('Veri klasörünü değiştirmek için yeniden başlatma bekleniyor.');
 await existingDataDirectory(target);
 await save(path.join(bootstrapDirectory,pendingName),{version:1,id:randomUUID(),mode:'open',source,destination:target});
 return {changed:true,directory:target,restartRequired:true};
}
async function digest(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function copyTree(source,target){
 const info=await lstat(source);
 if(info.isSymbolicLink()){
  throw Error('Bağlantı dosyası taşınamadı: '+source);
 }
 if(info.isDirectory()){
  await mkdir(target,{recursive:true,mode:0o700});
  for(const entry of await readdir(source)){
   if(['runtime','node_modules','SingletonLock','SingletonCookie','SingletonSocket','RunningChromeVersion','DevToolsActivePort'].includes(entry))continue;
   await copyTree(path.join(source,entry),path.join(target,entry));
  }
 }else if(info.isFile()){
  await mkdir(path.dirname(target),{recursive:true,mode:0o700});await copyFile(source,target);await chmod(target,0o600|(info.mode&0o100));
  if(await digest(source)!==await digest(target))throw Error('Dosya doğrulaması başarısız: '+source);
 }else throw Error('Desteklenmeyen veri dosyası: '+source);
}
function checkDatabase(db){
 if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').get())throw Error('Taşınan veritabanı doğrulanamadı.');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('workspaces','candidates')").get())throw Error('Loop veritabanı bulunamadı.');
}
export function relocatePaths(db,source,destination){
 const rewrite=value=>{
  if(typeof value==='string')return inside(source,value)?destination+value.slice(source.length):value;
  if(Array.isArray(value))return value.map(rewrite);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewrite(item)]));
  return value;
 };
 const quote=name=>'"'+name.replaceAll('"','""')+'"';
 db.exec('BEGIN');
 try{
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
   const columns=db.prepare(`PRAGMA table_info(${quote(name)})`).all().filter(c=>c.type.toUpperCase()==='TEXT').map(c=>c.name);
   for(const column of columns)for(const row of db.prepare(`SELECT rowid AS record_row,${quote(column)} AS value FROM ${quote(name)} WHERE ${quote(column)} IS NOT NULL`).all()){
    let value=row.value,changed;
    try{changed=JSON.stringify(rewrite(JSON.parse(value)));}catch{changed=rewrite(value);}
    if(changed!==value)db.prepare(`UPDATE ${quote(name)} SET ${quote(column)}=? WHERE rowid=?`).run(changed,row.record_row);
   }
  }
  checkDatabase(db);db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
// Called before opening the app database, after the previous process has shut down.
// The original data remains intact; only a verified destination becomes active.
export async function resolveDataDirectory({bootstrapDirectory}){
 const current=await currentDataDirectory(bootstrapDirectory),pendingFile=path.join(bootstrapDirectory,pendingName),request=await json(pendingFile);
 if(!request)return current;
 if(request.mode==='open'){
  if(request.version!==1||!/^[a-f0-9-]{36}$/.test(request.id)||![request.source,request.destination].includes(current)||typeof request.destination!=='string'||!path.isAbsolute(request.destination))throw Error('Bekleyen veri konumu seçimi geçersiz.');
  // When returning to the bootstrap folder, its pending request is this switch.
  const destination=await existingDataDirectory(request.destination,{allowPendingLocation:request.destination===await realpath(bootstrapDirectory)});
  if(destination!==request.destination)throw Error('Seçilen veri klasörünün konumu değişti.');
  await save(path.join(bootstrapDirectory,settingsName),{version:1,directory:destination});
  await rm(pendingFile,{force:true});return destination;
 }
 if(current===request.destination&&(await json(path.join(current,markerName)))?.id===request.id){await rm(pendingFile,{force:true});return current;}
 if(request.version!==1||!/^[a-f0-9-]{36}$/.test(request.id)||request.source!==current||typeof request.destination!=='string'||!path.isAbsolute(request.destination)||inside(current,request.destination)||inside(request.destination,current))throw Error('Bekleyen veri taşıma kaydı geçersiz.');
 const destination=request.destination,stage=destination+'.loop-moving-'+request.id;
 const marker={version:1,id:request.id,source:current,directory:destination};
 const installed=await json(path.join(destination,markerName));
 if(installed?.id!==request.id){
  if(await exists(destination)){
   if(await checkedDirectory(destination)!==destination||(await readdir(destination)).length)throw Error('Hedef klasör değişti veya boş değil; mevcut veriler korunuyor.');
  }
  if(await exists(stage)){
   const prior=await json(path.join(stage,markerName));if(prior?.id!==request.id)throw Error('Taşıma klasörü doğrulanamadı.');
   await rm(stage,{recursive:true});
  }
  await mkdir(stage,{mode:0o700});await save(path.join(stage,markerName),marker);
  try{
   const sourceDb=new DatabaseSync(path.join(current,'jobloop.sqlite'),{readOnly:true});
   try{checkDatabase(sourceDb);await backup(sourceDb,path.join(stage,'jobloop.sqlite'));}finally{sourceDb.close();}
   await chmod(path.join(stage,'jobloop.sqlite'),0o600);
   for(const name of [...directories,...files])if(await exists(path.join(current,name)))await copyTree(path.join(current,name),path.join(stage,name));
   const moved=new DatabaseSync(path.join(stage,'jobloop.sqlite'));
   try{relocatePaths(moved,current,destination);moved.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{moved.close();}
   if(await exists(destination)){if((await readdir(destination)).length)throw Error('Hedef klasöre dosya eklendi; taşıma durduruldu.');await rmdir(destination);}
   await rename(stage,destination);
  }catch(error){throw new Error('Veriler taşınamadı; eski klasör korundu. '+error.message,{cause:error});}
 }
 const verify=new DatabaseSync(path.join(destination,'jobloop.sqlite'),{readOnly:true});try{checkDatabase(verify);}finally{verify.close();}
 await save(path.join(bootstrapDirectory,settingsName),{version:1,directory:destination});
 await rm(pendingFile,{force:true});return destination;
}

export async function cancelDataLocation(bootstrapDirectory){
 const file=path.join(bootstrapDirectory,pendingName),request=await json(file);
 if(request&&request.mode!=='open'&&/^[a-f0-9-]{36}$/.test(request.id)&&typeof request.destination==='string'&&path.isAbsolute(request.destination)){
  const stage=request.destination+'.loop-moving-'+request.id;
  if((await json(path.join(stage,markerName)))?.id===request.id)await rm(stage,{recursive:true,force:true});
 }
 await rm(file,{force:true});
}
