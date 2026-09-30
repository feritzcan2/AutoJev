import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,realpath,chmod,stat,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {currentDataDirectory,requestDataLocation,requestExistingDataLocation,resolveDataDirectory,cancelDataLocation} from '../app/data-location.mjs';

async function fixture(t){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'loop-location-'))),source=path.join(root,'original'),destination=path.join(root,'desktop-folder');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(source);await mkdir(destination);
 const db=new DatabaseSync(path.join(source,'jobloop.sqlite'));
 db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE jobs(id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES candidates(id),data TEXT NOT NULL); CREATE TABLE secrets(id TEXT PRIMARY KEY,ciphertext TEXT NOT NULL)');
 const cv=path.join(source,'candidates','person','CV.txt');await mkdir(path.dirname(cv),{recursive:true});await writeFile(cv,'Synthetic CV');
 db.prepare('INSERT INTO candidates VALUES(?,?)').run('person',JSON.stringify({id:'person',cvPath:cv,preferences:'Keep these settings'}));
 db.prepare('INSERT INTO jobs VALUES(?,?,?)').run('application','person',JSON.stringify({id:'application',status:'submitted',proof:'Confirmed',files:[cv],outside:'/elsewhere/document.pdf'}));
 db.prepare('INSERT INTO secrets VALUES(?,?)').run('portal','encrypted-unchanged');db.close();
 return {root,source,destination,options:{bootstrapDirectory:source,dataDirectory:source,destination}};
}

test('relocation preserves application evidence, secrets and documents and persists subsequent folder changes',async t=>{
 const f=await fixture(t);assert.equal(await currentDataDirectory(f.source),f.source);
 const requested=await requestDataLocation(f.options);assert.equal(requested.restartRequired,true);
 assert.equal(await currentDataDirectory(f.source),f.source,'selection alone does not change the open database');
 const moved=await resolveDataDirectory({bootstrapDirectory:f.source});assert.equal(moved,f.destination);
 const db=new DatabaseSync(path.join(moved,'jobloop.sqlite'),{readOnly:true});
 const profile=JSON.parse(db.prepare('SELECT data FROM candidates').get().data),job=JSON.parse(db.prepare('SELECT data FROM jobs').get().data);
 assert.equal(profile.cvPath,path.join(moved,'candidates/person/CV.txt'));assert.equal(await readFile(profile.cvPath,'utf8'),'Synthetic CV');assert.deepEqual(job.files,[profile.cvPath]);assert.equal(job.status,'submitted');assert.equal(job.proof,'Confirmed');assert.equal(job.outside,'/elsewhere/document.pdf');assert.equal(db.prepare('SELECT ciphertext FROM secrets').get().ciphertext,'encrypted-unchanged');db.close();
 assert.equal(await readFile(path.join(f.source,'candidates/person/CV.txt'),'utf8'),'Synthetic CV');
 assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),moved);
 const second=path.join(f.root,'second');await mkdir(second);
 await requestDataLocation({...f.options,dataDirectory:moved,destination:second});assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),second);
 assert.equal(await currentDataDirectory(f.source),second);
});

test('occupied, nested and linked destinations leave existing data untouched',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.destination,'mine.txt'),'Keep me');
 await assert.rejects(()=>requestDataLocation(f.options),/boş/);assert.equal(await readFile(path.join(f.destination,'mine.txt'),'utf8'),'Keep me');
 const nested=path.join(f.source,'nested');await mkdir(nested);await assert.rejects(()=>requestDataLocation({...f.options,destination:nested}),/iç içe/);
 const linked=path.join(f.root,'linked');await symlink(f.destination,linked);await assert.rejects(()=>requestDataLocation({...f.options,destination:linked}),/gerçek bir klasör/);
 assert.equal(await currentDataDirectory(f.source),f.source);
});

test('a changed destination fails safely and the original can be reopened',async t=>{
 const f=await fixture(t);await requestDataLocation(f.options);await writeFile(path.join(f.destination,'new.txt'),'Unrelated');
 await assert.rejects(()=>resolveDataDirectory({bootstrapDirectory:f.source}),/boş değil/);await cancelDataLocation(f.source);
 assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),f.source);assert.equal(await readFile(path.join(f.destination,'new.txt'),'utf8'),'Unrelated');
});

test('interrupted copy is retried and interrupted pointer cleanup recognizes the completed move',async t=>{
 const f=await fixture(t);await requestDataLocation(f.options);
 const pendingFile=path.join(f.source,'pending-data-location.json'),pending=JSON.parse(await readFile(pendingFile,'utf8'));
 const stage=f.destination+'.loop-moving-'+pending.id;await mkdir(stage);await writeFile(path.join(stage,'.loop-storage.json'),JSON.stringify({id:pending.id}));await writeFile(path.join(stage,'partial-file'),'incomplete');
 assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),f.destination);
 await rm(path.join(f.source,'data-location.json'));await writeFile(pendingFile,JSON.stringify(pending));
 assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),f.destination,'installed destination survives interruption before pointer commit');
 await writeFile(pendingFile,JSON.stringify(pending));assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),f.destination,'pointer was committed before pending cleanup');
});

test('unavailable selected data never opens an empty or stale database',async t=>{
 const f=await fixture(t);await requestDataLocation(f.options);await resolveDataDirectory({bootstrapDirectory:f.source});await rm(f.destination,{recursive:true});
 await assert.rejects(()=>currentDataDirectory(f.source));
});

test('document symlinks cannot silently omit or pull unrelated data into the move',async t=>{
 const f=await fixture(t);const outside=path.join(f.root,'outside.txt');await writeFile(outside,'Outside');await symlink(outside,path.join(f.source,'candidates/person/link.txt'));await requestDataLocation(f.options);
 await assert.rejects(()=>resolveDataDirectory({bootstrapDirectory:f.source}),/Bağlantı dosyası/);assert.equal(await currentDataDirectory(f.source),f.source);assert.equal(await readFile(outside,'utf8'),'Outside');
});

test('browser process links are omitted while executable workspace tools keep their permissions',async t=>{
 const f=await fixture(t),browser=path.join(f.source,'browsers','profile'),tool=path.join(f.source,'plugins','tool.sh');
 await mkdir(browser,{recursive:true});await symlink('/not/a/copied/browser',path.join(browser,'RunningChromeVersion'));await symlink('/not/a/copied/socket',path.join(browser,'SingletonSocket'));
 await mkdir(path.dirname(tool));await writeFile(tool,'#!/bin/sh\nexit 0\n');await chmod(tool,0o700);
 await requestDataLocation(f.options);await resolveDataDirectory({bootstrapDirectory:f.source});
 assert.equal((await stat(path.join(f.destination,'plugins/tool.sh'))).mode&0o700,0o700);
 await assert.rejects(()=>stat(path.join(f.destination,'browsers/profile/RunningChromeVersion')));
});

test('opening existing data persists without copying or rewriting either database and can return to the original',async t=>{
 const f=await fixture(t);await cp(f.source,f.destination,{recursive:true});
 const db=new DatabaseSync(path.join(f.destination,'jobloop.sqlite'));db.prepare('UPDATE candidates SET data=?').run(JSON.stringify({id:'person',preferences:'Existing folder'}));db.close();
 const original=await readFile(path.join(f.source,'jobloop.sqlite')),selected=await readFile(path.join(f.destination,'jobloop.sqlite'));
 assert.equal((await requestExistingDataLocation(f.options)).restartRequired,true);
 assert.equal(await currentDataDirectory(f.source),f.source);
 const pendingFile=path.join(f.source,'pending-data-location.json'),pending=await readFile(pendingFile);
 assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),f.destination);
 assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),f.destination);
 assert.deepEqual(await readFile(path.join(f.source,'jobloop.sqlite')),original);
 assert.deepEqual(await readFile(path.join(f.destination,'jobloop.sqlite')),selected);
 // A crash after committing the pointer but before removing the request is recoverable.
 await writeFile(pendingFile,pending);assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),f.destination);
 assert.deepEqual(await requestExistingDataLocation({...f.options,dataDirectory:f.destination}),{changed:false,directory:f.destination});
 await requestExistingDataLocation({...f.options,dataDirectory:f.destination,destination:f.source});
 assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),f.source);
 assert.deepEqual(await readFile(path.join(f.source,'jobloop.sqlite')),original);
});

test('existing folder selection rejects missing, invalid, linked and backup databases',async t=>{
 const f=await fixture(t),file=path.join(f.destination,'jobloop.sqlite');
 await assert.rejects(()=>requestExistingDataLocation(f.options),/jobloop.sqlite bulunamadı/);
 await assert.rejects(()=>stat(file),{code:'ENOENT'});
 await writeFile(file,'not sqlite');await assert.rejects(()=>requestExistingDataLocation(f.options));await rm(file);
 const db=new DatabaseSync(file);db.exec('CREATE TABLE unrelated(id TEXT)');db.close();
 await assert.rejects(()=>requestExistingDataLocation(f.options),/Loop veritabanı bulunamadı/);await rm(file);
 await symlink(path.join(f.source,'jobloop.sqlite'),file);await assert.rejects(()=>requestExistingDataLocation(f.options),/gerçek bir dosya/);await rm(file);
 await cp(f.source,f.destination,{recursive:true});await writeFile(path.join(f.destination,'manifest.json'),'{}');
 await assert.rejects(()=>requestExistingDataLocation(f.options),/Yedekten geri yükle/);
 assert.equal(await currentDataDirectory(f.source),f.source);
 await assert.rejects(()=>stat(path.join(f.source,'pending-data-location.json')),{code:'ENOENT'});
});

test('existing data is revalidated at restart and failed selection leaves the current folder intact',async t=>{
 const f=await fixture(t);await cp(f.source,f.destination,{recursive:true});await requestExistingDataLocation(f.options);
 await rm(path.join(f.destination,'jobloop.sqlite'));
 await assert.rejects(()=>resolveDataDirectory({bootstrapDirectory:f.source}),/jobloop.sqlite bulunamadı/);
 await cancelDataLocation(f.source);assert.equal(await resolveDataDirectory({bootstrapDirectory:f.source}),f.source);
 assert.equal(await readFile(path.join(f.destination,'candidates/person/CV.txt'),'utf8'),'Synthetic CV');
});

test('pending restore and location requests cannot be bypassed by opening an existing folder',async t=>{
 const f=await fixture(t);await cp(f.source,f.destination,{recursive:true});
 for(const directory of [f.source,f.destination]){
  const pending=path.join(directory,'pending-restore.json');await writeFile(pending,'{}');
  await assert.rejects(()=>requestExistingDataLocation(f.options),/geri yükleme/);await rm(pending);
 }
 await requestExistingDataLocation(f.options);await assert.rejects(()=>requestExistingDataLocation(f.options),/yeniden başlatma bekleniyor/);
});
