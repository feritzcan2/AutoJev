import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';

test('WorkspaceDatabase waits for a brief independent writer lock before startup migrations',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'jobloop-store-lock-')),file=join(directory,'jobloop.sqlite');t.after(()=>rm(directory,{recursive:true,force:true}));
 const original=new WorkspaceDatabase(file),profile=original.workspaces.save('lock-fixture','job-search',{title:'Lock fixture'});original.close();
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');setTimeout(()=>{db.exec('COMMIT');db.close();},200);`,{eval:true,workerData:file});
 t.after(()=>worker.terminate());const exited=once(worker,'exit');await once(worker,'message');
 const reopened=new WorkspaceDatabase(file);
 try{assert.equal(reopened.db.prepare('PRAGMA busy_timeout').get().timeout,5000);assert.equal(reopened.workspaces.get(profile.id).title,'Lock fixture');}finally{reopened.close();}
 assert.deepEqual(await exited,[0]);
});
