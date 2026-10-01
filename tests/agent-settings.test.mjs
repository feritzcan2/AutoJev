import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';

for(const [provider,permission] of [['claude','auto'],['codex','bypassPermissions'],['opencode','default']]){
 test(`${provider} defaults reach job and housing templates`,t=>{
  const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());
  const db=new AutomationStore(store),profile=db.create('job-search',{agentSettings:{provider}});
  assert.equal(profile.agentSettings.permission,permission);
  assert.equal(profile.agentSettings.contextCompactPercent,0);
  assert.equal(profile.agentSettings.contextRestartPercent,0);
  assert.equal(db.get(profile.id).agentSettings.permission,permission);
  const automation=new AutomationStore(store).create('housing',{agentSettings:{provider}});
  assert.equal(automation.agentSettings.permission,permission);
  assert.equal(automation.agentSettings.contextCompactPercent,0);
  assert.equal(automation.agentSettings.contextRestartPercent,0);
 });
 for(const permission of (provider==='opencode'?['default','plan','bypassPermissions']:['default','plan','acceptEdits','bypassPermissions']))test(`${provider} preserves explicit ${permission} across saves`,t=>{
  const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());
  const db=new AutomationStore(store),profile=db.create('job-search',{agentSettings:{provider,permission}});
  assert.equal(db.save(profile.id,{title:'Updated'}).agentSettings.permission,permission);
  assert.equal(db.get(profile.id).agentSettings.permission,permission);
 });
}
