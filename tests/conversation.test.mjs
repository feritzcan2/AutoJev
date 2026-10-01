import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
test('resume identity survives restart and stays scoped to candidate and provider',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jobloop-resume-'));let store;
 try{
  store=new WorkspaceDatabase(join(dir,'state.sqlite'));
  const a=store.workspaces.save('a','job-search',{title:'A'}),b=store.workspaces.save('b','housing',{title:'B'});
  store.workspaces.history(a.id).saveConversation(a.id,'codex','codex-thread');store.workspaces.history(a.id).saveConversation(a.id,'claude','claude-thread');
  store.close();store=new WorkspaceDatabase(join(dir,'state.sqlite'));
  assert.equal(store.workspaces.history(a.id).conversation(a.id,'codex'),'codex-thread');assert.equal(store.workspaces.history(a.id).conversation(a.id,'claude'),'claude-thread');assert.equal(store.workspaces.history(b.id).conversation(b.id,'codex'),null);
  store.workspaces.save(a.id,a.templateId,{...a,title:'Updated'});assert.equal(store.workspaces.history(a.id).conversation(a.id,'codex'),'codex-thread');
  store.workspaces.history(a.id).saveConversation(a.id,'codex','new-thread');assert.equal(store.workspaces.history(a.id).conversation(a.id,'codex'),'new-thread');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
