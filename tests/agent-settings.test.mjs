import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {BackgroundStore} from '../app/background-store.mjs';

for(const [provider,permission] of [['claude','auto'],['codex','bypassPermissions']]){
 test(`${provider} defaults reach profiles, automations and background workers`,t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const profile=store.saveProfile({name:'Test',preferences:'Remote',agentSettings:{provider}});
  assert.equal(profile.agentSettings.permission,permission);
  assert.equal(store.profile(profile.id).agentSettings.permission,permission);
  const automation=new AutomationStore(store).create('housing',{agentSettings:{provider}});
  assert.equal(automation.agentSettings.permission,permission);
  const background=new BackgroundStore(store);
  assert.equal(background.save(profile.id,{enabled:false,intervalMinutes:30,agentOverride:{provider}}).agentSettings.permission,permission);
  assert.equal(background.task(profile.id).agentSettings.permission,permission);
 });
 for(const permission of ['default','plan','acceptEdits','bypassPermissions'])test(`${provider} preserves explicit ${permission} across saves`,t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const profile=store.saveProfile({name:'Test',preferences:'Remote',agentSettings:{provider,permission}});
  assert.equal(store.saveProfile({...profile,name:'Updated'}).agentSettings.permission,permission);
  assert.equal(store.profile(profile.id).agentSettings.permission,permission);
 });
}
