import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';

test('workspace rename and deletion preserve the other workspace and its records',t=>{
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core);
 const first=db.create('job-search',{title:'Ada',facts:'Candidate: Ada Lovelace'}),second=db.create('housing',{title:'Grace'});
 const job=db.putResult({id:'record',automationId:first.id,key:'record',url:'https://example.test/1',title:'Engineer',status:'found'});
 db.askQuestion(first.id,{recordId:job.id,text:'Start date?'});
 db.rename(first.id,'  Berlin search  ');assert.equal(db.get(first.id).title,'Berlin search');assert.equal(db.get(first.id).facts,'Candidate: Ada Lovelace');
 assert.throws(()=>db.rename(first.id,'   '));db.save(first.id,{goal:'Berlin remote'});assert.equal(db.get(first.id).title,'Berlin search');
 db.remove(first.id);assert.throws(()=>db.get(first.id),/bulunamadı/);assert.equal(db.get(second.id).title,'Grace');
 for(const table of ['workspace_records','workspace_events'])assert.equal(core.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=?`).get(first.id).n,0);
 assert.deepEqual(core.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeWorkspaceInstructions} from '../app/workspace-instructions.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
test('Claude imports one shared instruction source and preserves user additions across launches',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'jobloop-instructions-'));
 try{
  await writeFile(path.join(dir,'CLAUDE.md'),'Keep user preference.\n');
  await writeWorkspaceInstructions(dir,'Rules v1');
  await writeWorkspaceInstructions(dir,'Rules v2');
  assert.equal(await readFile(path.join(dir,'CLAUDE.md'),'utf8'),'@AGENTS.md\n\nKeep user preference.\n');
  assert.equal(await readFile(path.join(dir,'AGENTS.md'),'utf8'),'Rules v2');
 }finally{await rm(dir,{recursive:true,force:true});}
});
