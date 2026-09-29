import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityView,workerActivityView,ageLabel,sourceResultView,applicationActivity,pendingQuestions} from '../src/activity.js';
import {Store} from '../app/store.mjs';
const base={profile:{id:'a'},active:{candidateId:'a',sessionId:'s',state:'Working'},campaign:{status:'running',task:{id:'t',kind:'application',jobId:'j',seenWorking:true}},jobs:[{id:'j',company:'Example',role:'Counsel',url:'https://example.test'}],questions:[],events:[]};
test('live action follows session and task; timestamps are not fabricated',()=>{
 const event={kind:'agent_activity',at:'2026-09-25T10:00:00Z',data:{sessionId:'s',taskId:'t',jobId:'j',message:'CV yükleniyor'}};
 const live=activityView({...base,events:[event]});assert.equal(live.detail,'CV yükleniyor');assert.equal(live.title,'Example · Counsel');assert.equal(ageLabel(live.at,Date.parse(event.at)+12000),'Son bildirim: 12 saniye önce');
 const stale=activityView({...base,events:[{...event,data:{...event.data,sessionId:'old'}}]});assert.equal(stale.at,null);assert.doesNotMatch(stale.detail,/CV/);
 const otherTask=activityView({...base,events:[{...event,data:{...event.data,taskId:'old'}}]});assert.equal(otherTask.at,null);
});
test('permission wait, pause, scheduled scan and no active agent remain honest',()=>{
 assert.equal(activityView({...base,active:{...base.active,state:'AwaitingInput'}}).tone,'waiting');
 assert.equal(activityView({...base,campaign:{status:'paused',note:'Paused'}}).title,'Duraklatıldı');
 assert.equal(activityView({...base,active:null,campaign:null}).title,'Agent kapalı');
 assert.match(activityView({...base,active:null,campaign:{status:'running',task:null,nextSearchAt:Date.now()+60000,note:'No results'}}).title,/Sonraki kontrol/);
});
test('source-specific search names the source being scanned',()=>{
 const view=activityView({...base,campaign:{status:'running',task:{id:'search-1',kind:'search',sourceId:'linkedin',seenWorking:true}},jobs:[],sources:[{id:'linkedin',name:'LinkedIn'}]});
 assert.equal(view.title,'LinkedIn taranıyor');
});
test('source row shows scanning until that source task finishes',()=>{
 const source={id:'linkedin',lastRunAt:null,lastFound:0,lastResult:'Henüz taranmadı'};
 assert.deepEqual(sourceResultView(source,{status:'running',task:{kind:'search',sourceId:'linkedin',seenWorking:true}}),{title:'Taranıyor',detail:'Agent şu anda bu kaynağı tarıyor.',scanning:true});
 assert.equal(sourceResultView(source,{status:'running',task:{kind:'search',sourceId:'indeed'}}).title,'Taranmayı bekliyor');
});
test('activity reports cannot access another candidate or claim an unrelated campaign job',()=>{
 const s=new Store(':memory:');try{const a=s.saveProfile({name:'A',preferences:'Berlin'}),b=s.saveProfile({name:'B',preferences:'Berlin'});const j=s.addJob(b.id,{company:'X',role:'R',location:'Berlin',url:'https://example.test/jobs/1',fit:'fit'}).job;assert.throws(()=>s.reportActivity(a.id,'session',{jobId:j.id,message:'Filling'}));s.reportActivity(a.id,'session',{message:'İlanlar aranıyor'});const snap=s.snapshot(a.id);assert.equal(snap.events[0].kind,'agent_activity');assert.equal(snap.events[0].data.message,'İlanlar aranıyor');assert.equal(snap.jobs.length,0);assert.throws(()=>s.reportActivity(a.id,'session',{message:' '}));}finally{s.close();}
});

test('empty profile renders without crashing',()=>{assert.equal(activityView(null).title,'Agent kapalı');assert.equal(activityView({}).canWrite,false);});

test('questions for completed or skipped applications leave the pending list',()=>{
 const questions=['submitted','already_submitted','skipped','blocked'].map((status,i)=>({id:String(i),jobId:status,answer:null}));
 const jobs=questions.map(q=>({id:q.jobId,status:q.jobId}));
 assert.deepEqual(pendingQuestions({questions,jobs}).map(q=>q.jobId),['blocked']);
});

test('a queued question retry follows its worker even when another worker supplies the campaign summary',()=>{
 const questions=[{id:'retry',jobId:'j',answer:null},{id:'other',jobId:'other',answer:null},{id:'profile',answer:null}];
 const queued={status:'running',pendingRecoveries:{j:'retry'},task:null};
 const busy={status:'running',task:{kind:'application',jobId:'other'}};
 const snapshot={questions,workers:[{id:'main',campaign:queued},{id:'second',campaign:busy}],campaign:busy};
 assert.deepEqual(pendingQuestions(snapshot).map(q=>q.id),['other','profile']);
 queued.status='paused';
 assert.deepEqual(pendingQuestions(snapshot).map(q=>q.id),['retry','other','profile']);
 queued.status='running';queued.failures=1;
 assert.deepEqual(pendingQuestions(snapshot).map(q=>q.id),['retry','other','profile']);
});

test('queued search is not presented as scanning while agent is idle',()=>{const snapshot={...base,active:{...base.active,state:'Idle'},campaign:{status:'running',task:{kind:'search',sourceId:'join',seenWorking:false}}};assert.equal(activityView(snapshot).title,'Görevin başlaması bekleniyor');assert.equal(sourceResultView({id:'join'},snapshot.campaign).scanning,false);});

test('application row indicator follows current candidate task and actual runtime state',()=>{
 assert.equal(applicationActivity(base,'j').tone,'active');
 assert.equal(applicationActivity(base,'other'),null);
 assert.equal(applicationActivity({...base,active:{...base.active,candidateId:'other'}},'j'),null);
 assert.equal(applicationActivity({...base,campaign:{...base.campaign,status:'paused'}},'j'),null);
 assert.equal(applicationActivity({...base,active:{...base.active,state:'Idle'}},'j').label,'Tur sonucu bekleniyor');
 assert.equal(applicationActivity({...base,active:{...base.active,state:'AwaitingInput'}},'j').tone,'waiting');
});

test('worker cards show their own task, state and history while another worker pauses',()=>{
 const main={id:'main',name:'Worker 1',campaign:base.campaign,active:base.active};
 const second={id:'second',name:'Worker 2',campaign:{status:'running',task:{id:'search',kind:'search',sourceId:'linkedin',seenWorking:true}},active:{candidateId:'a',sessionId:'s2',state:'Working'}};
 const at='2026-09-28T10:00:00Z',events=[
  {kind:'agent_activity',at,data:{workerId:'second',sessionId:'s2',taskId:'search',message:'LinkedIn taranıyor'}},
  {kind:'agent_activity',at,data:{workerId:'main',sessionId:'s',taskId:'t',jobId:'j',message:'CV yükleniyor'}},
  {kind:'agent_activity',at,data:{sessionId:'s2',taskId:'previous',message:'Önceki worker işlemi'}}
 ];
 const snapshot={...base,workers:[main,second],sources:[{id:'linkedin',name:'LinkedIn'}],events};
 const a=workerActivityView(snapshot,main),b=workerActivityView(snapshot,second);
 assert.equal(a.title,'Example · Counsel');assert.equal(a.detail,'CV yükleniyor');assert.equal(a.url,'https://example.test');assert.equal(a.history.length,1);
 assert.equal(b.title,'LinkedIn taranıyor');assert.equal(b.detail,'LinkedIn taranıyor');assert.equal(b.url,null);assert.equal(b.history.length,2);
 second.active=null;second.campaign={status:'stopped',note:'Worker durduruldu',task:null};
 assert.equal(workerActivityView(snapshot,second).title,'Durduruldu');assert.equal(workerActivityView(snapshot,main).state,'Çalışıyor');
});
