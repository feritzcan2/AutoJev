import test from 'node:test';
import assert from 'node:assert/strict';
import {ContextCompaction,contextCompactPercent,compactionPending} from '../app/context-compaction.mjs';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';

const usage=(percent,updatedAt=1)=>({percent,peakPercent:90,updatedAt,caughtUp:true,pending:false});
function fixture(provider='codex',send){
 let now=100;const calls=[];
 const session={candidateId:'candidate',sessionId:'session',provider,state:'Working'};
 const controller=new ContextCompaction({send:send??(async session=>{calls.push(session.sessionId);return{accepted:true};}),now:()=>now});
 return{session,controller,calls,time:n=>now=n};
}
test('80 percent is the default, explicit zero disables; legacy profiles get the default without changing restart',()=>{
 assert.equal(contextCompactPercent(),80);
 for(const bad of [-1,101,null,'50',0.5,NaN])assert.throws(()=>contextCompactPercent(bad));
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'Local',preferences:'Remote',agentSettings:{provider:'claude',contextRestartPercent:40}});
  assert.equal(p.agentSettings.contextCompactPercent,80);
  delete p.agentSettings.contextCompactPercent;
  store.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(p),p.id);
  assert.equal(store.profile(p.id).agentSettings.contextCompactPercent,80);
  assert.equal(store.profile(p.id).agentSettings.contextRestartPercent,40);
  assert.equal(store.saveProfile({...p,agentSettings:{...p.agentSettings,contextCompactPercent:0}}).agentSettings.contextCompactPercent,0);
  assert.throws(()=>store.saveProfile({...p,agentSettings:{...p.agentSettings,contextCompactPercent:101}}));
  assert.equal(store.profile(p.id).agentSettings.contextCompactPercent,0);
 }finally{store.close();}
});
for(const provider of ['codex','claude'])test(`${provider}: threshold sends during Working without a completed task and only once`,async()=>{
 const f=fixture(provider);
 await f.controller.tick(f.session,usage(79.9));assert.equal(f.calls.length,0);
 await Promise.all([f.controller.tick(f.session,usage(80)),f.controller.tick(f.session,usage(95))]);
 assert.deepEqual(f.calls,['session']);assert.equal(compactionPending(f.session),true);
 f.controller.delivery(f.session,{state:'submitted'});
 assert.equal(f.session.compaction.state,'submitted','transport is not completion');
 await f.controller.tick(f.session,usage(90,2));assert.equal(f.calls.length,1);
 assert.equal(f.controller.signal(f.session,'Compacting'),true);
 assert.equal(f.controller.signal(f.session,'Idle'),true);
 assert.equal(f.session.compaction.state,'awaiting_usage');
 await f.controller.tick(f.session,usage(85,3));assert.equal(f.calls.length,1,'a still-large summary does not loop');
 await f.controller.tick(f.session,usage(20,4));assert.equal(f.session.compaction.state,'completed');
 await f.controller.tick(f.session,usage(80,5));assert.equal(f.calls.length,2);
});
test('disabled, unknown, pending backlog and permission prompts do not send',async()=>{
 const f=fixture();
 for(const sample of [null,{...usage(80),caughtUp:false},{...usage(80),pending:true},{...usage(80),percent:null}])await f.controller.tick(f.session,sample);
 await f.controller.tick(f.session,usage(80),0);
 for(const state of ['Compacting','AwaitingInput','Unknown','Exited','Failed']){f.session.state=state;await f.controller.tick(f.session,usage(80));}
 assert.equal(f.calls.length,0);
});
test('live threshold changes use current percentage, never the lifetime peak',async()=>{
 const f=fixture();await f.controller.tick(f.session,usage(30),50);assert.equal(f.calls.length,0);
 await f.controller.tick(f.session,usage(30),30);assert.equal(f.calls.length,1);
});
test('only definitely unwritten deferred requests retry; ambiguous errors stay latched',async()=>{
 let attempts=0;const f=fixture('claude',async()=>{if(++attempts===1)return{deferred:true};throw Error('receipt lost');});
 await f.controller.tick(f.session,usage(85));assert.equal(f.session.compaction.state,'waiting');
 await f.controller.tick(f.session,usage(85));assert.equal(attempts,1);
 f.time(3000);await f.controller.tick(f.session,usage(85));assert.equal(attempts,2);assert.equal(f.session.compaction.state,'unconfirmed');
 f.time(9000);await f.controller.tick(f.session,usage(95,3));assert.equal(attempts,2);
});
test('queued request waits through a long Working turn; idle timeout never reports completion',async()=>{
 const f=fixture();await f.controller.tick(f.session,usage(85));f.controller.delivery(f.session,{state:'submitted'});
 f.time(300000);await f.controller.tick(f.session,usage(95,2));assert.equal(compactionPending(f.session),true);
 f.session.state='Idle';f.controller.signal(f.session,'Idle');f.time(331000);await f.controller.tick(f.session,usage(95,3));
 assert.equal(f.session.compaction.state,'unconfirmed');assert.equal(f.calls.length,1);
});
test('provider start before transport receipt does not regress compaction state',async()=>{
 const f=fixture();await f.controller.tick(f.session,usage(85));f.controller.signal(f.session,'Compacting');f.controller.delivery(f.session,{state:'submitted'});
 assert.equal(f.session.compaction.state,'compacting');
});
test('Codex command lifecycle does not count as another failed campaign turn; rollout proves compaction',async()=>{
 const f=fixture();await f.controller.tick(f.session,{...usage(85),compactionId:'old'});
 f.controller.delivery(f.session,{state:'submitted'});
 assert.equal(f.controller.signal(f.session,'Idle'),false,'finish the real task normally');
 assert.equal(f.controller.signal(f.session,'Working'),true,'queued slash command is not a new campaign task');
 assert.equal(f.controller.signal(f.session,'Idle'),true,'do not recover the unfinished task a second time');
 await f.controller.tick(f.session,{...usage(30,3),compactionId:'new'});
 assert.equal(f.session.compaction.state,'verified');assert.equal(compactionPending(f.session),false);
 assert.equal(f.session.compaction.latched,false);
 await f.controller.tick(f.session,{...usage(85,4),compactionId:'new'});assert.equal(f.calls.length,2);
});
test('another candidate/session has an independent crossing',async()=>{
 const f=fixture();await f.controller.tick(f.session,usage(85));
 await f.controller.tick({...f.session,sessionId:'replacement',compaction:null},usage(85));assert.deepEqual(f.calls,['session','replacement']);
});
test('scheduler preserves the reported task boundary and waits for compaction before dispatch',async()=>{
 const store=new Store(':memory:');let active=null,busy=false;const calls=[];
 try{
  const p=store.saveProfile({name:'Local',preferences:'Remote'});
  const c=new Campaigns(store,{active:()=>active,contextBusy:()=>busy,changed:()=>{},launch:async()=>{active={candidateId:p.id,sessionId:'session',state:'Working'};calls.push('launch');},send:async()=>calls.push('send'),stop:async()=>{}});
  await c.start(p.id);c.signal(p.id,'Working');
  c.report(p.id,'session',{taskId:store.campaign(p.id).task.id,outcome:'no_results',note:'Done'});
  active.state='Idle';busy=true;c.signal(p.id,'Idle');await c.tick();
  assert.equal(store.campaign(p.id).task,null);assert.deepEqual(calls,['launch']);
  busy=false;await c.tick();assert.deepEqual(calls,['launch','send']);
 }finally{store.close();}
});

for(const provider of ['claude','codex'])test(`${provider}: compact Idle releases a validated report and dispatches the next task`,async()=>{
 const store=new Store(':memory:');let now=100,session=null;const calls=[];
 try{
  const p=store.saveProfile({name:'Compact',preferences:'Remote'});
  const c=new Campaigns(store,{now:()=>now,active:()=>session,changed:()=>{},contextBusy:()=>compactionPending(session),launch:async()=>{session={candidateId:p.id,sessionId:'s',provider,state:'Working'};calls.push('launch');},send:async()=>calls.push('send')});
  const compact=new ContextCompaction({send:async()=>({accepted:true}),settled:s=>c.afterCompaction(s.candidateId)});
  const signal=state=>{session.state=state;if(!compact.signal(session,state))c.signal(p.id,state);};
  await c.start(p.id);signal('Working');const first=store.campaign(p.id).task.id;
  await compact.tick(session,usage(95));compact.delivery(session,{state:'submitted'});
  c.report(p.id,'s',{taskId:first,outcome:'no_results',note:'Saved result'});
  if(provider==='codex'){signal('Idle');signal('Working');}else signal('Compacting');
  signal('Idle');assert.equal(store.campaign(p.id).task,null);await c.tick();
  assert.notEqual(store.campaign(p.id).task.id,first);assert.deepEqual(calls,['launch','send']);
 }finally{store.close();}
});

test('compact resumes an unfinished task once without manufacturing completion or repeated failures',async()=>{
 const store=new Store(':memory:');let now=100,session=null;const prompts=[];
 try{
  const p=store.saveProfile({name:'Compact',preferences:'Remote'});
  const c=new Campaigns(store,{now:()=>now,active:()=>session,changed:()=>{},contextBusy:()=>compactionPending(session),launch:async()=>{session={candidateId:p.id,sessionId:'s',provider:'claude',state:'Working'};},send:async text=>prompts.push(text)});
  const compact=new ContextCompaction({send:async()=>({accepted:true}),settled:s=>c.afterCompaction(s.candidateId)});
  const signal=state=>{session.state=state;if(!compact.signal(session,state))c.signal(p.id,state);};
  await c.start(p.id);signal('Working');const first=store.campaign(p.id).task.id;
  await compact.tick(session,usage(95));compact.delivery(session,{state:'submitted'});signal('Compacting');signal('Idle');
  assert.equal(store.campaign(p.id).task.id,first);assert.equal(store.campaign(p.id).task.report,null);assert.equal(store.campaign(p.id).task.recoveryAttempts,1);
  c.afterCompaction(p.id);assert.equal(store.campaign(p.id).task.recoveryAttempts,1);
  now+=5001;await c.tick();assert.equal(prompts.length,1);assert.match(prompts[0],/SAME interrupted task/);assert.equal(store.campaign(p.id).task.id,first);
 }finally{store.close();}
});

test('compact does not resume a worker stopped by the user',async()=>{
 const store=new Store(':memory:');let session=null;
 try{
  const p=store.saveProfile({name:'Compact',preferences:'Remote'});
  const c=new Campaigns(store,{active:()=>session,changed:()=>{},launch:async()=>{session={candidateId:p.id,sessionId:'s',state:'Working'};},stop:async()=>{}});
  await c.start(p.id);c.signal(p.id,'Working');await c.pause(p.id,'stopped');session.state='Idle';c.afterCompaction(p.id);
  assert.equal(store.campaign(p.id).status,'stopped');assert.equal(store.campaign(p.id).task,null);
 }finally{store.close();}
});
