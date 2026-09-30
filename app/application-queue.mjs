// Only UI/Telegram queue actions create this durable, job-scoped authorization.
// A worker must hold the matching application task to use it.
export function manualApplicationAuthorized(job,task){
 return Boolean(!task?.verificationOnly&&!job?.manualApplication?.verificationOnly&&!job?.preparation?.hold&&job?.manualApplication?.requestId&&task?.manualRequestId===job.manualApplication.requestId&&task.jobId===job.id&&['application','verify'].includes(task.kind));
}
export function uncertainRetryPeerAllowed(job,task){
 return Boolean(job?.duplicateApplication?.status==='uncertain'&&job?.retryAuthorization?.kind==='uncertain_submission'&&task?.repeatUncertain&&manualApplicationAuthorized(job,task));
}
export function hasManualApplicationWork(store,id,c){
 c??=store.workerState.campaign(id);
 return store.jobs(id).some(j=>j.manualApplication&&!j.followupStopped&&(!j.duplicateApplication||j.manualApplication.repeatUncertain&&j.duplicateApplication.status==='uncertain')&&!['submitted','already_submitted','skipped'].includes(j.status)&&
  (c?.pendingRetries?.[j.id]||c?.pendingResumes?.[j.id]||c?.pendingRecoveries?.[j.id]||['working','prepared','submitting','uncertain'].includes(j.status)));
}

// Existing manual retries retain their intent after upgrading. Automatic answer
// resumptions and browser recoveries never acquire submission authorization.
export function migrateManualApplications(store){
 for(const p of store.candidates()){
  const c=store.campaign(p.id);
  for(const [id,request] of Object.entries(c?.pendingRetries??{})){
   if(!request.requestId)continue;
   const job=store.job(p.id,id);
   if(job.preparation?.hold||job.manualApplication||job.followupStopped||job.duplicateApplication&&!(request.repeatUncertain&&job.duplicateApplication.status==='uncertain')||['submitted','already_submitted','skipped'].includes(job.status))continue;
   store.saveJob({...job,manualApplication:{...request}},'manual_application_requested');
   for(const worker of store.workers(p.id)){
    const view=store.forWorker(worker.id),state=view.campaign(p.id);
    if(state?.task?.jobId===id&&['application','verify'].includes(state.task.kind)){
     state.task.manualRequestId=request.requestId;state.task.retryRequestId=request.requestId;state.task.verificationOnly=Boolean(request.verificationOnly);state.task.applyMode=request.verificationOnly?'prepare':'auto';view.saveCampaign(p.id,state);
    }
   }
  }
 }
}

export function applicationQueueState(store,candidate,job,{campaign=store.campaign(candidate),tasks=store.workerState.tasks(candidate)}={}){
 if(store.queueState)return store.queueState(candidate,job);
 const verificationOnly=job.status==='uncertain',actionLabel=verificationOnly?'Öncelikli doğrula':'Öncelikli başvur';
 const action={verificationOnly,actionLabel},unavailable=message=>({...action,state:'unavailable',message});
 if(job.duplicateApplication)return unavailable('Bu ilan önceki bir başvuruyla eşleşiyor. AutoJev’den kontrol et.');
 if(job.followupStopped)return unavailable('Bu başvurunun takibi bırakılmış.');
 if(['submitted','already_submitted'].includes(job.status)||['manual_submitted','already_submitted'].includes(job.manualOutcome))return unavailable('Bu başvuru zaten tamamlanmış.');
 const task=tasks.find(w=>w.task.jobId===job.id)?.task;
 if(['working','submitting'].includes(job.status)||task&&!task.report&&['application','preparation','verify'].includes(task.kind))return {...action,state:'active',message:verificationOnly?'Agent bu başvurunun sonucunu zaten kontrol ediyor.':'Agent bu başvuruyu zaten işliyor.'};
 if(!['found','blocked','prepared','uncertain'].includes(job.status))return unavailable('Yalnızca yeni veya bilgi / işlem bekleyen başvurular sıraya alınabilir.');
 if(campaign?.pendingRetries?.[job.id])return {...action,state:'queued',message:verificationOnly?'Bu başvuru zaten öncelikli doğrulama sırasında.':'Bu ilan zaten başvuru sırasında. Öncelikli işlenecek.'};
 return {...action,state:'available',message:verificationOnly?'Gönderim sonucu kesinleşmedi. Mevcut başvuruyu öncelikli kontrol et; yeniden başvuru gönderilmez.':'Bu ilana başvur: kaynak modu, profil yetkisi, puan eşiği ve başvuru hedefini yalnızca bu ilan için geçer.'};
}
