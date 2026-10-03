import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {withAgentDefaults} from '../app/agent-settings.mjs';
import {saveAgentSettings} from '../src/agent-settings-save.js';

for(const [provider,permission] of [['claude','auto'],['codex','bypassPermissions'],['opencode','default']]){
 test(`${provider} defaults reach job and housing templates`,t=>{
  const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());
  const db=new AutomationStore(store),profile=db.create('job-search',{agentSettings:{provider}});
  assert.equal(profile.agentSettings.permission,permission);
  assert.equal(profile.agentSettings.contextCompactTokens,150000);
  assert.equal(profile.agentSettings.contextRestartTokens,0);
  assert.equal(db.get(profile.id).agentSettings.permission,permission);
  const automation=new AutomationStore(store).create('housing',{agentSettings:{provider}});
  assert.equal(automation.agentSettings.permission,permission);
  assert.equal(automation.agentSettings.contextCompactTokens,150000);
  assert.equal(automation.agentSettings.contextRestartTokens,0);
 });
 for(const permission of (provider==='opencode'?['default','plan','bypassPermissions']:['default','plan','acceptEdits','bypassPermissions']))test(`${provider} preserves explicit ${permission} across saves`,t=>{
  const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());
  const db=new AutomationStore(store),profile=db.create('job-search',{agentSettings:{provider,permission}});
  assert.equal(db.save(profile.id,{title:'Updated'}).agentSettings.permission,permission);
  assert.equal(db.get(profile.id).agentSettings.permission,permission);
 });
}

const runningWorkers=[{id:'main',active:{sessionId:'keep-main'}},{id:'second',execution:{task:{id:'keep-task'}}},{id:'setup',conversation:true,active:{sessionId:'keep-setup'}},{id:'stopped'}];
for(const provider of ['codex','claude','opencode'])test(`${provider}: saving context thresholds preserves running sessions without a restart prompt`,async()=>{
 let settings=withAgentDefaults({provider}),saved=0,notified=0;
 const unexpected=()=>assert.fail('Context changes must not ask for or perform a restart');
 const api={workspaceSnapshot:async()=>({workspace:{agentSettings:settings,chromeProfile:null},workers:runningWorkers}),workspaceSettings:async(_id,input)=>{settings=input.agentSettings;saved++;},restartWorker:unexpected};
 for(const change of [{contextCompactTokens:120000},{contextRestartTokens:200000},{contextCompactTokens:0},{contextRestartTokens:0},{trialModel:null}]){
  const input={agentSettings:{...settings,...change}};
  const result=await saveAgentSettings({api,owner:'workspace',input,confirmRestart:unexpected,onSaved:()=>{notified++;}});
  assert.deepEqual(result,{restarted:0,failed:[]});assert.deepEqual(settings,input.agentSettings);
 }
 assert.equal(saved,5);assert.equal(notified,5);
});

for(const change of [{provider:'claude'},{model:'another-model'},{trialModel:'trial-model'},{permission:'plan'},{reasoning:'high'},{network:true}])test(`launch setting ${Object.keys(change)[0]} still offers a restart only for task workers`,async()=>{
 const settings=withAgentDefaults(),calls=[];
 const result=await saveAgentSettings({owner:'workspace',input:{agentSettings:{...settings,...change}},api:{
  workspaceSnapshot:async()=>({workspace:{agentSettings:settings},workers:runningWorkers}),
  workspaceSettings:async()=>calls.push('saved'),restartWorker:async(id,worker)=>calls.push(worker)
 },onSaved:()=>calls.push('notified'),confirmRestart:async count=>{assert.equal(count,2);calls.push('confirmed');return true;}});
 assert.deepEqual(result,{restarted:2,failed:[]});assert.deepEqual(calls,['saved','notified','confirmed','main','second']);
});
