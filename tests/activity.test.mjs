import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityView,ageLabel,sourceResultView} from '../src/activity.js';
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
 assert.deepEqual(sourceResultView(source,{status:'running',task:{kind:'search',sourceId:'linkedin'}}),{title:'Taranıyor',detail:'Agent şu anda bu kaynağı tarıyor.',scanning:true});
 assert.equal(sourceResultView(source,{status:'running',task:{kind:'search',sourceId:'indeed'}}).title,'Taranmayı bekliyor');
});
test('activity reports cannot access another candidate or claim an unrelated campaign job',()=>{
 const s=new Store(':memory:');try{const a=s.saveProfile({name:'A',preferences:'Berlin'}),b=s.saveProfile({name:'B',preferences:'Berlin'});const j=s.addJob(b.id,{company:'X',role:'R',location:'Berlin',url:'https://example.test/jobs/1',fit:'fit'}).job;assert.throws(()=>s.reportActivity(a.id,'session',{jobId:j.id,message:'Filling'}));s.reportActivity(a.id,'session',{message:'İlanlar aranıyor'});const snap=s.snapshot(a.id);assert.equal(snap.events[0].kind,'agent_activity');assert.equal(snap.events[0].data.message,'İlanlar aranıyor');assert.equal(snap.jobs.length,0);assert.throws(()=>s.reportActivity(a.id,'session',{message:' '}));}finally{s.close();}
});

test('empty profile renders without crashing',()=>{assert.equal(activityView(null).title,'Agent kapalı');assert.equal(activityView({}).canWrite,false);});
