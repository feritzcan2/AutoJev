import test from 'node:test';
import assert from 'node:assert/strict';
import {ContextCompaction,contextCompactPercent,compactionPending} from '../app/context-compaction.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';

const usage=(percent,updatedAt=1)=>({percent,peakPercent:90,updatedAt,caughtUp:true,pending:false});
function fixture(provider='codex',send){
 let now=100;const calls=[];
 const session={candidateId:'candidate',sessionId:'session',provider,state:'Working'};
 const controller=new ContextCompaction({send:send??(async session=>{calls.push(session.sessionId);return{accepted:true};}),now:()=>now});
 return{session,controller,calls,time:n=>now=n};
}
test('compaction defaults to disabled; legacy profiles get the default without changing restart',()=>{
 assert.equal(contextCompactPercent(),0);
 for(const bad of [-1,101,null,'50',0.5,NaN])assert.throws(()=>contextCompactPercent(bad));
 const store=new WorkspaceDatabase(':memory:');try{
  const p=store.workspaces.save('local','job-search',{title:'Local',agentSettings:{provider:'claude',contextRestartPercent:40}});
  assert.equal(p.agentSettings.contextCompactPercent,0);
  delete p.agentSettings.contextCompactPercent;
  store.db.prepare('UPDATE workspaces SET data=? WHERE id=?').run(JSON.stringify(p),p.id);
  assert.equal(store.workspaces.get(p.id).agentSettings.contextCompactPercent,0);
  assert.equal(store.workspaces.get(p.id).agentSettings.contextRestartPercent,40);
  assert.equal(store.workspaces.save(p.id,p.templateId,{...p,agentSettings:{...p.agentSettings,contextCompactPercent:0}}).agentSettings.contextCompactPercent,0);
  assert.throws(()=>store.workspaces.save(p.id,p.templateId,{...p,agentSettings:{...p.agentSettings,contextCompactPercent:101}}));
  assert.equal(store.workspaces.get(p.id).agentSettings.contextCompactPercent,0);
 }finally{store.close();}
});
for(const provider of ['codex','claude'])test(`${provider}: threshold sends during Working without a completed task and only once`,async()=>{
 const f=fixture(provider);
 await f.controller.tick(f.session,usage(79.9),80);assert.equal(f.calls.length,0);
 await Promise.all([f.controller.tick(f.session,usage(80),80),f.controller.tick(f.session,usage(95),80)]);
 assert.deepEqual(f.calls,['session']);assert.equal(compactionPending(f.session),true);
 f.controller.delivery(f.session,{state:'submitted'});
 assert.equal(f.session.compaction.state,'submitted','transport is not completion');
 await f.controller.tick(f.session,usage(90,2),80);assert.equal(f.calls.length,1);
 assert.equal(f.controller.signal(f.session,'Compacting'),true);
 assert.equal(f.controller.signal(f.session,'Idle'),true);
 assert.equal(f.session.compaction.state,'awaiting_usage');
 await f.controller.tick(f.session,usage(85,3),80);assert.equal(f.calls.length,1,'a still-large summary does not loop');
 await f.controller.tick(f.session,usage(20,4),80);assert.equal(f.session.compaction.state,'completed');
 await f.controller.tick(f.session,usage(80,5),80);assert.equal(f.calls.length,2);
});
test('disabled, unknown, pending backlog and permission prompts do not send',async()=>{
 const f=fixture();
 for(const sample of [null,{...usage(80),caughtUp:false},{...usage(80),pending:true},{...usage(80),percent:null}])await f.controller.tick(f.session,sample,80);
 await f.controller.tick(f.session,usage(100));
 await f.controller.tick(f.session,usage(80),0);
 for(const state of ['Compacting','AwaitingInput','Unknown','Exited','Failed']){f.session.state=state;await f.controller.tick(f.session,usage(80),80);}
 assert.equal(f.calls.length,0);
});
test('live threshold changes use current percentage, never the lifetime peak',async()=>{
 const f=fixture();await f.controller.tick(f.session,usage(30),50);assert.equal(f.calls.length,0);
 await f.controller.tick(f.session,usage(30),30);assert.equal(f.calls.length,1);
});
test('only definitely unwritten deferred requests retry; ambiguous errors stay latched',async()=>{
 let attempts=0;const f=fixture('claude',async()=>{if(++attempts===1)return{deferred:true};throw Error('receipt lost');});
 await f.controller.tick(f.session,usage(85),80);assert.equal(f.session.compaction.state,'waiting');
 await f.controller.tick(f.session,usage(85),80);assert.equal(attempts,1);
 f.time(3000);await f.controller.tick(f.session,usage(85),80);assert.equal(attempts,2);assert.equal(f.session.compaction.state,'unconfirmed');
 f.time(9000);await f.controller.tick(f.session,usage(95,3),80);assert.equal(attempts,2);
});
test('queued request waits through a long Working turn; idle timeout never reports completion',async()=>{
 const f=fixture();await f.controller.tick(f.session,usage(85),80);f.controller.delivery(f.session,{state:'submitted'});
 f.time(300000);await f.controller.tick(f.session,usage(95,2),80);assert.equal(compactionPending(f.session),true);
 f.session.state='Idle';f.controller.signal(f.session,'Idle');f.time(331000);await f.controller.tick(f.session,usage(95,3),80);
 assert.equal(f.session.compaction.state,'unconfirmed');assert.equal(f.calls.length,1);
});
test('provider start before transport receipt does not regress compaction state',async()=>{
 const f=fixture();await f.controller.tick(f.session,usage(85),80);f.controller.signal(f.session,'Compacting');f.controller.delivery(f.session,{state:'submitted'});
 assert.equal(f.session.compaction.state,'compacting');
});
test('Codex command lifecycle does not count as another failed campaign turn; rollout proves compaction',async()=>{
 const f=fixture();await f.controller.tick(f.session,{...usage(85),compactionId:'old'},80);
 f.controller.delivery(f.session,{state:'submitted'});
 assert.equal(f.controller.signal(f.session,'Idle'),false,'finish the real task normally');
 assert.equal(f.controller.signal(f.session,'Working'),true,'queued slash command is not a new campaign task');
 assert.equal(f.controller.signal(f.session,'Idle'),true,'do not recover the unfinished task a second time');
 await f.controller.tick(f.session,{...usage(30,3),compactionId:'new'},80);
 assert.equal(f.session.compaction.state,'verified');assert.equal(compactionPending(f.session),false);
 assert.equal(f.session.compaction.latched,false);
 await f.controller.tick(f.session,{...usage(85,4),compactionId:'new'},80);assert.equal(f.calls.length,2);
});
test('another candidate/session has an independent crossing',async()=>{
 const f=fixture();await f.controller.tick(f.session,usage(85),80);
 await f.controller.tick({...f.session,sessionId:'replacement',compaction:null},usage(85),80);assert.deepEqual(f.calls,['session','replacement']);
});
