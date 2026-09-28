import test from 'node:test';
import assert from 'node:assert/strict';
import {jobDisplayStatus} from '../src/job-status.js';
test('queued retries are queued even while paused, actual blockers remain blocked',()=>{
 const job={id:'j',status:'blocked'};
 for(const status of ['running','paused','stopped'])for(const key of ['pendingRetries','pendingResumes','pendingRecoveries']){
  const snapshot={campaign:{status,[key]:{j:{}}}};
  assert.equal(jobDisplayStatus(snapshot,job),'queued');
  assert.equal(jobDisplayStatus(snapshot,{id:'other',status:'blocked'}),'blocked');
  for(const status of ['uncertain','submitting','submitted','already_submitted','skipped'])assert.equal(jobDisplayStatus(snapshot,{...job,status}),status==='already_submitted'?'submitted':status);
 }
});
test('running queued job is active; reported blocker is waiting again',()=>{
 const job={id:'j',status:'blocked'},snapshot={profile:{id:'candidate'},active:{candidateId:'candidate',state:'Working'},campaign:{status:'running',pendingRetries:{j:{}},task:{jobId:'j',kind:'application',seenWorking:true}}};
 assert.equal(jobDisplayStatus(snapshot,job),'working');
 snapshot.campaign.task.report={outcome:'blocked'};
 assert.equal(jobDisplayStatus(snapshot,job),'blocked');
 delete snapshot.campaign.task;delete snapshot.campaign.pendingRetries.j;
 assert.equal(jobDisplayStatus(snapshot,job),'blocked');
});
