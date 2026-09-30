// Engine changes are explicit user settings changes. Stop the old writer before
// archiving drafts; never turn a pending send into a new application.
export async function saveProfileWithBrowserChange({store,campaigns,stop,resetBrowser},input){
 const previous=input.id?store.profile(input.id):null;
 const engineChanged=previous&&input.browserMode!==undefined&&input.browserMode!==previous.browserMode;
 const profileChanged=previous&&input.chromeProfile!==undefined&&(input.chromeProfile?.directory??null)!==(previous.chromeProfile?.directory??null);
 if(!engineChanged&&!profileChanged)return store.saveProfile(input);
 const before=campaigns.summary?.(input.id)??store.campaign(input.id),wasRunning=before?.status==='running';
 if(before)await campaigns.pause(input.id);else await stop(input.id);
 await resetBrowser(input.id);
 store.db.exec('SAVEPOINT browser_engine_change');
 let profile;
 try{
  profile=store.saveProfile(input);
  if(engineChanged)restartDraftsForBrowser(store,input.id,previous.browserMode,profile.browserMode);
  for(const worker of store.workers(input.id))for(const provider of ['codex','claude','opencode']){
   const scoped=store.forWorker(worker.id),nativeId=scoped.conversation(input.id,provider);
   if(nativeId)scoped.forgetConversation(input.id,provider,nativeId);
  }
  store.db.exec('RELEASE browser_engine_change');
 }catch(error){store.db.exec('ROLLBACK TO browser_engine_change');store.db.exec('RELEASE browser_engine_change');throw error;}
 // Changing accounts requires an explicit restart; preserve the original drafts.
 if(wasRunning&&!profileChanged)await campaigns.start(input.id,{target:before.target,intervalMinutes:before.intervalMinutes});
 return profile;
}

export function restartDraftsForBrowser(store,id,from,to){
 const at=new Date().toISOString(),restarted=[];
 const campaign=store.campaign(id)??{status:'paused',target:100,intervalMinutes:30,task:null,attempts:{},failures:0};
 campaign.pendingRetries??={};campaign.attempts??={};
 for(const job of store.jobs(id)){
  if(!['working','prepared','blocked'].includes(job.status)||job.proof||job.followupStopped||job.duplicateApplication||job.verificationContinuation||['submitting','uncertain'].includes(job.browserProgress?.submissionState))continue;
  job.previousBrowserDraft={from,to,at,status:job.status,note:job.note,resumeContext:job.resumeContext??null,browserProgress:job.browserProgress??null};
  job.resumeContext=null;delete job.browserWorkerId;delete job.browserProgress;delete job.validationFailure;
  job.sessionId=null;job.status='blocked';
  job.note='Tarayıcı motoru değişti. Yeni seçili motorla ilanı açıp formu baştan hazırla; kayıtlı aday yanıtlarını kullan.';
  store.saveJob(job,'application_browser_reset');
  // Supersede obsolete technical handoffs without fabricating candidate answers.
  // Missing facts, consent and all answered questions remain available.
  for(const q of store.questions(id))if(q.jobId===job.id&&q.answer===null&&q.applicationBlocker?.kind==='access')
   store.db.prepare('UPDATE questions SET resolution=? WHERE id=? AND candidate_id=?').run(JSON.stringify({kind:'browser_engine_changed',from,to,at}),q.id,id);
  delete campaign.attempts[job.id];
  for(const key of ['pendingResumes','pendingRecoveries'])if(campaign[key])delete campaign[key][job.id];
  campaign.pendingRetries[job.id]={requestId:`browser-change:${to}:${job.id}:${at}`,queuedAt:Date.now()};
  restarted.push(job.id);
 }
 // Search checkpoints also contain engine-specific tab IDs.
 for(const source of store.sources(id))if(source.resumeContext){
  source.resumeContext=null;
  store.db.prepare('UPDATE sources SET data=? WHERE id=? AND candidate_id=?').run(JSON.stringify(source),source.id,id);
 }
 campaign.wakeAt=0;
 store.saveCampaign(id,campaign);
 store.event(id,'browser_engine_changed',{from,to,restarted});
 return restarted;
}
