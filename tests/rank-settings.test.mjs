import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {rankWeights} from '../app/rank-criteria.mjs';
import {rankInput} from './rank-fixture.mjs';

const custom={technical:0,experience:0,role:25,preferences:75};
const listing={company:'Example',role:'Backend',location:'Remote',url:'https://example.test/job',fit:'Backend evidence'};
function rankedJob(store,id,url=listing.url){
 const job=store.addJob(id,{...listing,role:`Backend ${url}`,url}).job,input=rankInput(store,id);
 for(const [key,score] of Object.entries({technical:90,experience:80,role:40,preferences:20}))input.dimensions[key].score=score;
 return store.rankJob(id,job.id,input);
}

test('user weights update saved totals and queue order without another assessment',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'A',preferences:'Backend',authorization:'submit'});
  for(const source of store.sources(p.id))store.saveSource(p.id,{...source,enabled:false});
  const first=rankedJob(store,p.id),second=store.addJob(p.id,{...listing,role:'Second role',url:'https://example.test/second'}).job;
  store.rankJob(p.id,second.id,rankInput(store,p.id,60));
  const profileKey=store.profile(p.id).rankingProfileKey,campaigns=new Campaigns(store,{}),state={status:'running',attempts:{},target:100,intervalMinutes:30,wakeAt:0};
  assert.equal(first.rank.score,70);assert.equal(campaigns.choose(p.id,state).jobId,first.id);
  store.saveRankSettings(p.id,{threshold:50,weights:custom});
  const updated=store.job(p.id,first.id);
  assert.equal(updated.rank.score,25);assert.deepEqual(updated.rank.weights,custom);
  assert.deepEqual({...updated.rank,score:first.rank.score,weights:first.rank.weights},first.rank);
  assert.equal(updated.updatedAt,first.updatedAt);assert.equal(updated.status,first.status);
  assert.equal(campaigns.choose(p.id,state).jobId,second.id);
  assert.equal(store.snapshot(p.id).jobs.find(j=>j.id===first.id).rankDecision.state,'below_threshold');
  assert.equal(store.taskContext(p.id).profile.rankingProfileKey,profileKey);
  assert.deepEqual(store.taskContext(p.id).profile.rankWeights,custom);
  assert.equal(rankedJob(store,p.id,'https://example.test/new').rank.score,25);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='job_ranked'").get().n,3);
  store.saveProfile({...store.profile(p.id),facts:'Updated facts'});
  assert.deepEqual(store.profile(p.id).rankWeights,custom);
  store.saveProfile({...store.profile(p.id),rankWeights});
  assert.equal(store.job(p.id,first.id).rank.score,70);
 }finally{store.close();}
});

test('weights and totals persist, are candidate-scoped, and support legacy assessments',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jobloop-weights-'));let store=new Store(join(dir,'db'));
 try{
  const p=store.saveProfile({name:'A',preferences:'Backend'}),other=store.saveProfile({name:'B',preferences:'Remote'});
  const original=rankedJob(store,p.id),foreign=rankedJob(store,other.id);
  const legacy={...p};delete legacy.rankWeights;delete original.rank.weights;
  store.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(legacy),p.id);
  store.db.prepare('UPDATE workspace_records SET data=? WHERE id=?').run(JSON.stringify(original),original.id);
  assert.deepEqual(store.profile(p.id).rankWeights,rankWeights);
  store.saveRankSettings(p.id,{threshold:30,weights:custom});
  store.close();store=new Store(join(dir,'db'));
  assert.deepEqual(store.profile(p.id).rankWeights,custom);assert.equal(store.profile(p.id).rankThreshold,30);
  assert.equal(store.job(p.id,original.id).rank.score,25);
  assert.deepEqual(store.job(other.id,foreign.id),foreign);assert.deepEqual(store.profile(other.id).rankWeights,rankWeights);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('invalid weights cannot partially save a threshold or change scores',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'A',preferences:'Backend'}),job=rankedJob(store,p.id);
  const invalid=[null,[],{}, {...rankWeights,technical:41},{...rankWeights,technical:-1},{...rankWeights,technical:40.5},{...rankWeights,technical:'40'},{...rankWeights,other:0},{technical:0,experience:0,role:0,preferences:0}];
  for(const weights of invalid)assert.throws(()=>store.saveRankSettings(p.id,{threshold:10,weights}));
  for(const input of [null,{}, {threshold:10}, {weights:custom}, {threshold:undefined,weights:custom}, {threshold:101,weights:custom}])assert.throws(()=>store.saveRankSettings(p.id,input));
  assert.equal(store.profile(p.id).rankThreshold,50);assert.deepEqual(store.profile(p.id).rankWeights,rankWeights);assert.deepEqual(store.job(p.id,job.id),job);
  store.saveRankSettings(p.id,{threshold:90,weights:{technical:100,experience:0,role:0,preferences:0}});
  assert.equal(store.job(p.id,job.id).rank.score,90);assert.equal(store.snapshot(p.id).jobs[0].rankDecision.eligible,false);
 }finally{store.close();}
});

test('reweighting preserves user overrides, completed statuses and unavailable results',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'A',preferences:'Backend'}),job=rankedJob(store,p.id);
  store.saveRankThreshold(p.id,90);store.queueRankedJob(p.id,job.id);
  const override=store.job(p.id,job.id).rankOverride;
  const done=rankedJob(store,p.id,'https://example.test/done');store.setManualJobStatus(p.id,done.id,'already_submitted');
  const missing=store.addJob(p.id,{...listing,role:'Missing role',url:'https://example.test/missing'}).job;
  store.rankJob(p.id,missing.id,{profileKey:store.profile(p.id).rankingProfileKey,status:'unavailable',summary:'Browser denied access',browserCheck:{backend:'existing',url:missing.url,evidence:'Browser denied access'}});
  const unavailable=store.job(p.id,missing.id);
  store.saveRankSettings(p.id,{threshold:90,weights:custom});
  assert.deepEqual(store.job(p.id,job.id).rankOverride,override);
  assert.equal(store.snapshot(p.id).jobs.find(j=>j.id===job.id).rankDecision.eligible,true);
  assert.equal(store.job(p.id,done.id).status,'already_submitted');assert.deepEqual(store.job(p.id,missing.id),unavailable);
 }finally{store.close();}
});

test('profile and all totals roll back together if a stored score cannot be updated',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'A',preferences:'Backend'}),first=rankedJob(store,p.id),second=rankedJob(store,p.id,'https://example.test/second');
  store.db.exec("CREATE TRIGGER reject_reweight BEFORE UPDATE ON workspace_records WHEN old.record_key='https://example.test/second' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(()=>store.saveRankSettings(p.id,{threshold:20,weights:custom}),/test failure/);
  assert.equal(store.profile(p.id).rankThreshold,50);assert.deepEqual(store.profile(p.id).rankWeights,rankWeights);
  assert.deepEqual(store.job(p.id,first.id),first);assert.deepEqual(store.job(p.id,second.id),second);
 }finally{store.close();}
});
