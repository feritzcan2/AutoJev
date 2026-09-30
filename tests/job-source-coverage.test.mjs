import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {applicationProtocol} from '../app/extensions/job-search/mcp.mjs';
import {sourceCoverage} from '../app/source-coverage.mjs';

test('search coverage rejects an untracked finish and resumes saved partial work',async()=>{
 const store=new Store(':memory:');let now=Date.now()+10000,active=null;
 const profile=store.saveProfile({name:'Coverage',preferences:'Berlin',authorization:'research'});
 const [source,...others]=store.sources(profile.id);
 for(const other of others)store.saveSource(profile.id,{...other,enabled:false});
 const campaign=new Campaigns(store,{now:()=>now,active:()=>active,changed:()=>{},launch:async id=>{active={candidateId:id,sessionId:'session'};},send:async()=>{},stop:async()=>{active=null;}});
 try{
  await campaign.start(profile.id);const task=store.campaign(profile.id).task;
  const protocol=applicationProtocol({store,browser:null,campaigns:campaign},{workspaceId:profile.id,sessionId:'session'});
  await assert.rejects(protocol.callResult('report_campaign_work',{taskId:task.id,outcome:'done',note:'First page only'}),/kapsam kanıtı/);
  assert.equal(store.source(profile.id,source.id).lastRunAt,null);
  const pending='https://www.linkedin.com/jobs/view/123';
  await protocol.callResult('save_source_progress',{sourceId:source.id,complete:false,pendingUrls:[pending],nextStep:'Run the saved search with --page 2',evidence:'First result page had a next page'});
  campaign.signal(profile.id,'Working');
  await protocol.callResult('report_campaign_work',{taskId:task.id,outcome:'partial',note:'First page checked; more results remain',coverage:{complete:false,pendingUrls:[pending],nextStep:'Run the saved search with --page 2',evidence:'First result page had a next page'}});
  campaign.signal(profile.id,'Idle');
  const saved=store.source(profile.id,source.id),due=saved.nextRunAt;
  assert.equal(saved.lastStatus,'partial');assert.equal(saved.scanProgress.pendingUrls[0],pending);assert.equal(due,now+60000);
  store.saveSource(profile.id,{...saved,intervalMinutes:30});store.restoreSourceSchedule(profile.id);
  assert.equal(store.source(profile.id,source.id).nextRunAt,due);
  now=due+1;await campaign.tick();
  const resumed=store.campaign(profile.id).task;
  assert.equal(resumed.kind,'search');assert.equal(resumed.sourceId,source.id);
  assert.equal(store.taskContext(profile.id).source.scanProgress.nextStep,'Run the saved search with --page 2');
  campaign.signal(profile.id,'Working');
  assert.throws(()=>campaign.report(profile.id,'session',{taskId:resumed.id,outcome:'done',note:'Remaining pages checked',coverage:{complete:true,pendingUrls:[],evidence:'Final page had no next result page'}}),/save_source_progress/);
  await protocol.callResult('save_source_progress',{sourceId:source.id,complete:true,pendingUrls:[],evidence:'Final page had no next result page'});
  campaign.report(profile.id,'session',{taskId:resumed.id,outcome:'done',note:'Remaining pages checked',coverage:{complete:true,pendingUrls:[],evidence:'Final page had no next result page'}});
  campaign.signal(profile.id,'Idle');
  const completed=store.source(profile.id,source.id);
  assert.equal(completed.lastStatus,'done');assert.equal(completed.scanProgress,null);assert.equal(completed.nextRunAt,now+completed.intervalMinutes*60000);
 }finally{store.close();}
});

test('partial coverage needs a concrete continuation and complete coverage has none',()=>{
 assert.throws(()=>sourceCoverage({complete:false,pendingUrls:[],evidence:'More results exist'}),/Kısmi taramada/);
 assert.throws(()=>sourceCoverage({complete:true,pendingUrls:['https://example.test/next'],evidence:'Page one'},{outcome:'done'}),/Bekleyen/);
 assert.deepEqual(sourceCoverage({complete:false,pendingUrls:[],nextStep:'Search page 3',evidence:'Page 2 of 3'}),{complete:false,pendingUrls:[],nextStep:'Search page 3',evidence:'Page 2 of 3'});
});
