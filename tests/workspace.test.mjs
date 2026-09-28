import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {BackgroundStore} from '../app/background-store.mjs';

test('workspace name persists separately from candidate identity and deletion removes only its data',()=>{
  const store=new Store(':memory:');
  try{
    const background=new BackgroundStore(store);
    const first=store.saveProfile({name:'Ada Lovelace',preferences:'Remote'});
    const second=store.saveProfile({name:'Grace Hopper',preferences:'Hybrid'});
    const job=store.addJob(first.id,{url:'https://example.com/job',company:'Example',role:'Engineer',location:'Berlin',fit:'Relevant role'}).job;
    store.ask(first.id,{jobId:job.id,question:'Start date?'});
    background.putTask(first.id,{candidateId:first.id,enabled:false});
    background.putRun({id:'test-run',candidateId:first.id,status:'completed'});
    assert.equal(store.renameWorkspace(first.id,'  Berlin search  ').workspaceName,'Berlin search');
    assert.equal(store.profile(first.id).name,'Ada Lovelace');
    assert.throws(()=>store.renameWorkspace(first.id,'   '),/geçerli bir metin/);
    store.saveProfile({...store.profile(first.id),preferences:'Berlin remote'});
    assert.equal(store.profile(first.id).workspaceName,'Berlin search');
    store.deleteWorkspace(first.id);
    assert.throws(()=>store.profile(first.id),/bulunamadı/);
    assert.equal(store.profile(second.id).name,'Grace Hopper');
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
    for(const table of ['jobs','questions','background_tasks','background_runs','events'])assert.equal(store.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE candidate_id=?`).get(first.id).count,0);
  }finally{store.close();}
});

import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeWorkspaceInstructions,STARTUP_INSTRUCTIONS} from '../app/workspace-instructions.mjs';
test('Claude imports one shared instruction source and preserves user additions across launches',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'jobloop-instructions-'));
 try{
  await writeFile(path.join(dir,'CLAUDE.md'),'Keep user preference.\n');
  await writeWorkspaceInstructions(dir,'Rules v1');
  await writeWorkspaceInstructions(dir,'Rules v2');
  assert.equal(await readFile(path.join(dir,'CLAUDE.md'),'utf8'),'@AGENTS.md\n\nKeep user preference.\n');
  assert.equal(await readFile(path.join(dir,'AGENTS.md'),'utf8'),'Rules v2');
  assert.ok(!STARTUP_INSTRUCTIONS.includes('read current run-job-search once'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
