import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../app/store.mjs';
test('resume identity survives restart and stays scoped to candidate and provider',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jobloop-resume-'));let store;
 try{
  store=new Store(join(dir,'state.sqlite'));
  const a=store.saveProfile({name:'A',preferences:'Remote'}),b=store.saveProfile({name:'B',preferences:'Berlin'});
  store.saveConversation(a.id,'codex','codex-thread');store.saveConversation(a.id,'claude','claude-thread');
  store.close();store=new Store(join(dir,'state.sqlite'));
  assert.equal(store.conversation(a.id,'codex'),'codex-thread');assert.equal(store.conversation(a.id,'claude'),'claude-thread');assert.equal(store.conversation(b.id,'codex'),null);
  store.saveProfile({...a,name:'Updated'});assert.equal(store.conversation(a.id,'codex'),'codex-thread');
  store.saveConversation(a.id,'codex','new-thread');assert.equal(store.conversation(a.id,'codex'),'new-thread');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
