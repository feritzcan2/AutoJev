// A retry request is scheduling state, not a new candidate-information blocker.
// Keep durable submission statuses intact; derive the board status from the queue.
export function jobDisplayStatus(snapshot,job){
 if(job.status==='already_submitted')return 'submitted';
 const worker=snapshot?.workers?.find(w=>w.campaign?.task?.jobId===job.id);
 if(worker)return jobDisplayStatus({...snapshot,workers:undefined,campaign:worker.campaign,active:worker.active},job);
 if(job.status!=='blocked'||job.followupStopped||job.duplicateApplication)return job.status;
 const campaign=snapshot?.campaign,task=campaign?.task;
 if(task?.jobId===job.id&&task.report)return job.status;
 const queued=campaign?.pendingRetries?.[job.id]||campaign?.pendingResumes?.[job.id]||campaign?.pendingRecoveries?.[job.id];
 if(!queued)return job.status;
 const active=snapshot?.active;
 if(campaign.status==='running'&&task?.jobId===job.id&&['application','preparation'].includes(task.kind)&&task.seenWorking&&active?.candidateId===snapshot?.profile?.id&&['Working','Compacting'].includes(active.state))return 'working';
 return 'queued';
}
