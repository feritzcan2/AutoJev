import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {Setups} from '../app/setup.mjs';
import {restartAgentFresh} from '../app/agent-restart.mjs';
import {browserWaitView} from '../src/browser-status.js';
import {activityView} from '../src/activity.js';

function fixture(t){
 const store=new Store(':memory:');t.after(()=>store.close());
 const p=store.saveProfile({name:'Approval test',preferences:'Remote',browserMode:'jev'});
 store.setCv(p.id,'/tmp/CV.txt');
 let ready=false,active=null,time=Date.now(),launches=0;
 const deps={browserReady:()=>({ready}),active:()=>active,changed:()=>{},now:()=>time,
  launch:async id=>{launches++;active={candidateId:id,sessionId:'agent',state:'Working'};},
  stop:async()=>{active=null;},send:async()=>assert.fail('Unexpected dispatch')};
 const campaigns=new Campaigns(store,deps);
 return {store,p,deps,campaigns,get launches(){return launches;},allow:()=>{ready=true;},elapse:ms=>{time+=ms;}};
}
function unranked(f){return f.store.addJob(f.p.id,{company:'Example',role:'Engineer',location:'Remote',fit:'Backend',url:'https://example.test/job'}).job;}

for(const kind of ['search','rank'])test(`${kind}: delayed approval launches no agent, then starts exactly once`,async t=>{
 const f=fixture(t);if(kind==='rank')unranked(f);
 await f.campaigns.start(f.p.id);
 for(let minute=0;minute<15;minute++){f.elapse(60000);await f.campaigns.tick();await f.campaigns.start(f.p.id);}
 assert.equal(f.launches,0);
 const waiting=f.store.campaign(f.p.id);assert.equal(waiting.browserWait,true);assert.equal(waiting.failures,0);assert.equal(waiting.status,'running');
 assert.match(waiting.note,/henüz başlatılmadı/);
 f.allow();await f.campaigns.tick();await f.campaigns.tick();
 assert.equal(f.launches,1);assert.equal(f.store.campaign(f.p.id).task.kind,kind);assert.equal(f.store.campaign(f.p.id).browserWait,undefined);
});

test('stopping an approval wait prevents a later approval from starting an agent',async t=>{
 const f=fixture(t);await f.campaigns.start(f.p.id);await f.campaigns.pause(f.p.id,'stopped');
 f.allow();await f.campaigns.tick();assert.equal(f.launches,0);assert.equal(f.store.campaign(f.p.id).status,'stopped');
});

test('restart of a saved ranking task waits for Chrome and preserves its task identity',async t=>{
 const f=fixture(t),job=unranked(f);
 f.store.saveCampaign(f.p.id,{status:'running',target:100,intervalMinutes:30,task:{id:'saved-rank',kind:'rank',jobId:job.id,createdAt:0},attempts:{}});
 await restartAgentFresh({store:f.store,campaigns:f.campaigns,stop:f.deps.stop},f.p.id);
 f.elapse(15*60000);await f.campaigns.tick();assert.equal(f.launches,0);
 assert.equal(f.store.campaign(f.p.id).task.id,'saved-rank');assert.equal(f.store.campaign(f.p.id).status,'running');
 f.allow();await f.campaigns.tick();await f.campaigns.tick();assert.equal(f.launches,1);assert.equal(f.store.campaign(f.p.id).task.id,'saved-rank');
});

test('losing Chrome during launch preparation keeps the task pending without a failure',async t=>{
 const f=fixture(t);unranked(f);f.allow();
 f.campaigns.launch=async()=>{throw Object.assign(Error('Chrome pending'),{code:'BROWSER_WAIT'});};
 await f.campaigns.start(f.p.id);const saved=f.store.campaign(f.p.id);
 assert.equal(saved.browserWait,true);assert.equal(saved.failures,0);assert.equal(saved.status,'running');assert.ok(saved.task.recovery);
 // Losing the connection again while resuming must also stay pending.
 await f.campaigns.tick();assert.equal(f.store.campaign(f.p.id).status,'running');assert.equal(f.store.campaign(f.p.id).failures,0);
 f.campaigns.launch=f.deps.launch;await f.campaigns.tick();await f.campaigns.tick();
 assert.equal(f.launches,1);assert.equal(f.store.campaign(f.p.id).task.id,saved.task.id);
});

for(const improve of [false,true])test(`${improve?'profile improvement':'onboarding'} waits for permission without consuming its pending turn`,async t=>{
 const f=fixture(t),setups=new Setups(f.store,f.deps);
 if(improve)f.store.beginProfileImprovement(f.p.id);else f.store.saveSetup(f.p.id,{status:'intake',stage:'source'});
 await setups.begin(f.p.id);for(let i=0;i<5;i++)await setups.tick();
 assert.equal(f.launches,0);assert.equal(f.store.setup(f.p.id).needsTurn,true);assert.equal(f.store.setup(f.p.id).browserWait,true);
 f.allow();await setups.tick();await setups.tick();
 assert.equal(f.launches,1);assert.equal(f.store.setup(f.p.id).browserWait,false);assert.equal(f.store.setup(f.p.id).needsTurn,false);
});

test('setup retries a launch-time connection loss and cancelling improvement prevents launch',async t=>{
 const f=fixture(t),setups=new Setups(f.store,{...f.deps,launch:async()=>{throw Object.assign(Error('Pending'),{code:'BROWSER_WAIT'});}});
 f.store.beginProfileImprovement(f.p.id);f.allow();await setups.begin(f.p.id);
 assert.equal(f.store.setup(f.p.id).needsTurn,true);assert.equal(f.store.setup(f.p.id).browserWait,true);assert.equal(f.store.setup(f.p.id).error,null);
 f.store.finishProfileImprovement(f.p.id);setups.launch=f.deps.launch;await setups.tick();assert.equal(f.launches,0);
});

test('approval UI distinguishes waiting, connection failure, ready and stopped states',()=>{
 const snapshot={profile:{id:'candidate',browserMode:'jev'},campaign:{status:'running',browserWait:true},browserStatus:{state:'connecting',ready:false}};
 assert.equal(browserWaitView(snapshot).starting,true);assert.equal(browserWaitView(snapshot).canRetry,false);
 assert.equal(activityView(snapshot).title,'Chrome izni bekleniyor');assert.match(activityView(snapshot).detail,/henüz başlatılmadı/);
 snapshot.browserStatus={state:'waiting',ready:false,message:'Chrome kapalı'};
 assert.equal(browserWaitView(snapshot).error,'Chrome kapalı');assert.equal(browserWaitView(snapshot).canRetry,true);
 snapshot.browserStatus={state:'ready',ready:true};assert.equal(browserWaitView(snapshot),null);
 snapshot.browserStatus={state:'connecting',ready:false};snapshot.campaign.status='stopped';assert.equal(browserWaitView(snapshot),null);
 snapshot.setup={status:'running',browserWait:true};assert.equal(browserWaitView(snapshot).starting,true);
 snapshot.profile.browserMode='existing';assert.equal(browserWaitView(snapshot),null);
});
