import {continueScoringRun,unreportedScoringRun,requeueScoringRun} from './scoring-recovery.mjs';
import {taskHasRecord} from './record-task-scope.mjs';
import {SourceRetryChecks} from './source-retry-check.mjs';
import {CONVERSATION_WORKER,isConversation,conversationWaiting} from './workspace-conversation.mjs';
import {conversationContextVersion} from './automation-task-context.mjs';
import {queueProfileUpdate,applyProfileUpdate} from './profile-updates.mjs';
import {automationRunHistory} from './automation-continuation.mjs';
import {setupAgentHistory,setupAgentSettings,setupAgentSettingsKey,resetSetupAgentHistory} from './setup-agent.mjs';
import {enqueueScoreBatch,enqueueRecordOperation,dispatchRecordOperations,recordTask,resumeRecordOperation,pendingRecordQuestion} from './record-operations.mjs';
import {sourceTrialReady} from './automation-trial.mjs';
import {TaskRuns} from './task-runs.mjs';
import {recoverRecordOperations} from './record-recovery.mjs';
import {workerKey} from './worker-key.mjs';
import {randomUUID} from 'node:crypto';
import {sourceInput} from './automation-sources.mjs';
import {automationAttention,dismissAutomationAttention} from './automation-attention.mjs';
import {SourceAccessRecovery,rememberSourceAccess,finishSourceAccess} from './source-access-recovery.mjs';
import {continueSourceRun,unreportedInterviewRun,unreportedSourceRun,requeueSourceRun,recoverUnreportedSources,recoverExhaustedSourceRetries} from './automation-recovery.mjs';
// Template definitions select operations; the common queue owns dependencies,
// worker leases and record/source exclusivity. No template-name dispatch here.
export class WebTasks extends TaskRuns {
 async saveProfile(id,input,options){
  this.assertNotStopping(id);
  if(this.restarting.has(id))throw Error('Çalışma alanı güncelleniyor.');
  const saved=queueProfileUpdate(this.db,id,input,options);
  if(!saved.profileUpdate)return {saved:true,applied:true};
  this.restarting.add(id);this.changed(id);
  try{
   const results=await Promise.allSettled(this.slots(id).filter(slot=>slot.run.kind!=='interview').map(slot=>this.finish(id,'interrupted','Yeni profil uygulanıyor.',slot.workerId)));
   const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
   if(!applyProfileUpdate(this.db,id))throw Error('Çalışan görevler henüz durdurulamadı. Tekrar kaydet.');
  }catch(error){
   const a=this.db.get(id);if(a.profileUpdate)this.db.put({...a,profileUpdate:{...a.profileUpdate,error:error.message}});
   throw error;
  }finally{this.restarting.delete(id);this.changed(id);}
  await this.tick();return {saved:true,applied:true};
 }
 constructor(db,options){super({
  separateCapacity:worker=>worker===CONVERSATION_WORKER,
  idleGraceMs:10000,
  continueIdle:(id,runId)=>continueScoringRun(db,id,runId)??continueSourceRun(db,id,runId),
  unreported:(id,runId,reason)=>unreportedScoringRun(db,id,runId,reason)??unreportedInterviewRun(db,id,runId)??unreportedSourceRun(db,id,runId,reason,(options?.now??Date.now)()),
  recover:()=>{const interrupted=db.list().flatMap(a=>db.store.workspaces.tasks.list(a.id,{states:['running','reported','paused']}));db.recover();for(const previous of interrupted){
   const queue=db.store.workspaces.tasks,a=db.get(previous.workspaceId),task=queue.get(a.id,previous.id),source=a.sourceState?.[task.sourceUrl],scan=task.scan??source?.scan;
   if(task.stopRequested)queue.finish(a.id,task.id,'cancelled','Tarama kullanıcı tarafından durduruldu.');
   else if(task.sourceUrl&&!task.recordId&&['interrupted','partial'].includes(task.completionState??task.state)&&a.status==='enabled'&&!source?.blocked)queue.put({...task,state:'pending',workerId:null,scan,completionState:null});
   else queue.finish(a.id,task.id,task.completionState??'interrupted','Önceki uygulama oturumu kapandı');
  }for(const a of db.list())if(Object.values(a.sourceState??{}).some(s=>s.stopping))db.put({...a,sourceState:Object.fromEntries(Object.entries(a.sourceState).map(([url,s])=>[url,{...s,stopping:false}]))});recoverUnreportedSources(db,(options?.now??Date.now)());recoverRecordOperations(db);recoverExhaustedSourceRetries(db);},config:id=>db.get(id),run:id=>db.run(id),save:run=>db.putRun(run),
  due:now=>db.list().filter(a=>a.status==='enabled'&&a.nextRunAt<=now).map(a=>a.id),
  begin:(id,input='run',worker)=>{const run=db.begin(id,input,worker),a=db.get(id),source=a.sourceState?.[run.sourceUrl];if(!run.recordId&&(source?.recovery||source?.accessRecovery))db.put({...a,sourceState:{...a.sourceState,[run.sourceUrl]:{...source,recovery:null,accessRecovery:null}}});return run;},
  report:(id,runId,status,summary,goalReached)=>{const result=db.finish(id,runId,status,summary,{release:false});rememberSourceAccess(db,result);if(goalReached&&result.kind==='run'&&result.status==='completed'&&!result.recordId&&!result.recordOperation)db.pause(id,'complete');return result;},
  finish:(id,runId,status,summary)=>{
   if(db.run(runId).status==='running')db.finish(id,runId,status,summary);
   const run=db.run(runId);rememberSourceAccess(db,run);finishSourceAccess(db,run);if(!run.taskId)return;
   const queue=db.store.workspaces.tasks,task=queue.get(id,run.taskId);
   if(requeueScoringRun(db,run)){}
   else if(['partial','interrupted'].includes(run.status)&&run.sourceUrl&&!run.recordId&&db.get(id).status==='enabled')requeueSourceRun(db,run);
   else queue.finish(id,run.taskId,run.status==='timeout'?'failed':run.status,run.summary);
   const waiting=db.get(id).sourceState?.[run.sourceUrl]?.accessRecovery;
   if(!(waiting?.runId===run.id&&waiting.state==='waiting')&&['completed','failed','blocked','cancelled'].includes(queue.get(id,run.taskId).state)){db.jevTasks.release(id,run.taskId);db.browserEvidence.release(id,run.taskId);db.scoringListingTexts?.delete(run.id);}
  },
  closeFailed:(id,runId,error)=>{const run=db.run(runId),summary='Oturum kapatılamadı: '+error.message;if(run.status==='running')db.finish(id,runId,'failed',summary);else db.putRun({...run,status:'failed',summary});if(run.taskId){const q=db.store.workspaces.tasks;q.put({...q.get(id,run.taskId),state:'paused'});}if(!isConversation(run))db.pause(id,'blocked');},
  afterFinish:async(id,runId)=>{
   const run=db.run(runId),pending=(db.get(id).questions??[]).some(q=>q.answer==null&&q.taskId===run.taskId);
   const completeSource=run.kind==='run'&&!run.recordId&&run.sourceUrl&&run.scan?.complete&&run.scan.completion!=='user_stop';
   const completeRecord=run.recordId&&db.result(id,run.recordId).status==='completed';
   const pendingContexts=(db.get(id).questions??[]).filter(q=>q.answer==null).map(q=>q.browserContext).filter(Boolean);
   await options?.onRunFinished?.(id,run,{retainForAccess:db.get(id).sourceState?.[run.sourceUrl]?.accessRecovery?.runId===run.id,closeTabs:run.status==='completed'&&!pending&&Boolean(completeSource||completeRecord),pendingTabIds:pendingContexts.map(context=>context.tabId).filter(Boolean),pendingUrls:pendingContexts.map(context=>context.url).filter(Boolean)});
  }
 },options);this.db=db;this.queue=db.store.workspaces.tasks;this.workers=db.store.workspaces.workers;this.dispatching=false;this.restarting=new Set();this.pausing=new Map();this.browserReady=options?.browserReady??(()=>true);this.sourceChecks=new SourceRetryChecks(db,{probe:options?.probeSource,now:this.now,changed:this.changed,isClosed:()=>this.closed});this.sourceAccess=new SourceAccessRecovery(this,{closeTabs:options?.onRunFinished});}
 assertNotStopping(id){if(this.pausing.has(id))throw Error('Çalışma alanı durduruluyor. Kapanış tamamlanınca yeniden başlat.');}
 async start(id,input,workerId='main'){this.assertNotStopping(id);return super.start(id,input,workerId);}
 plan(id,batchId,source){
  const a=this.db.get(id),template=this.db.template(a.templateId),tasks=this.queue.list(id,{batchId});
  if(tasks.some(t=>t.operation==='trial'))return tasks.filter(t=>t.operation==='trial');
  if(!sourceTrialReady(a,source.url)){
   for(const task of tasks)if(task.state==='pending')this.queue.finish(id,task.id,'cancelled','Kaynağın ilk turu deneme olacak');
   return [this.queue.enqueue(id,{batchId,sourceUrl:source.url,operation:'trial',capability:'browser.observe',subject:source.url,sources:[source.url],lockKey:'source:'+source.url})];
  }
  for(const step of template.workflow){
   const subjects=step.scope==='source'?[{key:source.url,sources:[source.url]}]:this.db.results(id,{all:true}).filter(r=>!r.trial&&!['completed','uncertain','executing','dismissed'].includes(r.status)&&(r.sourceUrl?r.sourceUrl===source.url:new URL(r.url).origin===new URL(source.url).origin)).map(r=>({key:r.id,recordId:r.id,sources:[r.url]}));
   for(const subject of subjects){
    const parents=tasks.filter(t=>step.after.includes(t.operation)&&(!t.recordId||!subject.recordId||t.recordId===subject.recordId));
    if(step.after.some(parent=>!parents.some(t=>t.operation===parent))||parents.some(t=>t.state!=='completed'))continue;
    if(subject.recordId){const record=this.db.result(id,subject.recordId);if(step.capability==='browser.prepare'&&source.mode==='observe'||step.capability==='browser.act'&&(source.mode==='observe'||record.status!=='prepared'||source.mode==='prepare'&&record.approvedDigest!==record.digest))continue;}if(tasks.some(t=>t.operation===step.id&&t.subject===subject.key))continue;
    const task=this.queue.enqueue(id,{batchId,sourceUrl:source.url,operation:step.id,capability:step.capability,subject:subject.key,recordId:subject.recordId,sources:subject.sources,lockKey:(subject.recordId?'record:':'source:')+subject.key,dependsOn:parents.map(t=>t.id)});tasks.push(task);
   }
  }return tasks;
 }
 sourceState(id,url,patch){const a=this.db.get(id);if(Object.entries(patch).every(([key,value])=>Object.is(a.sourceState?.[url]?.[key],value)))return a;return this.db.put({...a,sourceState:{...a.sourceState,[url]:{...a.sourceState?.[url],...patch}}});}
 clearRetry(id,key){const a=this.db.get(id);if(!a.retryPlan?.[key])return;const retryPlan={...a.retryPlan};delete retryPlan[key];this.db.put({...a,retryPlan});this.changed(id);}
 retryLater(id,key,cancel=false){
  const a=this.db.get(id);if(cancel){this.clearRetry(id,key);return {cancelled:true};}
  const issue=automationAttention({...this.db.snapshot(id),activeRuns:this.slots(id).map(s=>s.run)}).find(i=>i.id===key);
  if(!issue?.retry||issue.closing)throw Error('Bu müdahale için yeniden deneme şu anda planlanamaz.');
  const at=this.now()+2*60*60*1000;
  if(issue.kind==='site_access'){if(issue.accessExhausted)throw Error('Otomatik denemeler durduruldu. Engel giderildikten sonra devam et.');const accessRecovery=this.sourceAccess.current(id,key);this.sourceState(id,key,{accessRecovery:{...accessRecovery,retryAt:at}});this.changed(id);return {at};}
  this.db.put({...a,retryPlan:{...a.retryPlan,[key]:{at,revision:a.revision}}});this.changed(id);return {at};
 }
 async dismissAttention(id,key,dismissKey){
  const issue=automationAttention({...this.db.snapshot(id),activeRuns:this.slots(id).map(s=>s.run)}).find(i=>i.id===key);
  if(!issue?.dismissKey||issue.dismissKey!==dismissKey||issue.closing)throw Error('Bu müdahale değişti veya oturum hâlâ kapanıyor.');
  if(issue.kind==='site_access'){await this.sourceAccess.reset(id,key,issue.runId,{dismissed:true});return {dismissed:true};}
  const result=dismissAutomationAttention(this.db,id,key,dismissKey);this.changed(id);return result;
 }
 resetSources(id,urls){
  const a=this.db.get(id);for(const task of this.queue.list(id,{states:['pending']}))if(!task.recordOperation&&(!task.sourceUrl||urls.includes(task.sourceUrl))&&!a.sourceState?.[task.sourceUrl]?.accessRecovery&&!this.slots(id).some(s=>s.run.sourceUrl===task.sourceUrl))this.queue.finish(id,task.id,'cancelled','Yeni kaynak turu');
  for(const url of urls){if(a.sourceState?.[url]?.accessRecovery)continue;const wait=this.db.sourceWait(id,{url},a);this.clearRetry(id,url);this.sourceState(id,url,{batchId:null,blocked:false,blocker:null,recovery:null,siteBlocked:Boolean(wait?.waiting),nextRunAt:wait?.waiting?wait.retryAt:this.now()});}
  return a;
 }
 async tick({workspaceId,workerId}={}){
  if(this.closed||this.dispatching)return;this.dispatching=true;
  try{recoverUnreportedSources(this.db,this.now());recoverExhaustedSourceRetries(this.db);const ready=[];for(const saved of this.db.list()){
   if(this.restarting.has(saved.id)||this.pausing.has(saved.id))continue;
   if(saved.profileUpdate){
    if(saved.profileUpdate.error)continue;
    if(this.slots(saved.id).some(slot=>slot.run.kind!=='interview')||!applyProfileUpdate(this.db,saved.id))continue;
    this.changed(saved.id);
   }
   this.sourceAccess.tick(saved.id);
   if(!this.browserReady(saved.id))continue;
   ready.push(saved.id);
   // Give explicit requests every available worker before any workspace can
   // spend shared capacity on older source tasks or automatic record work.
   await dispatchRecordOperations(this,saved.id,{manualOnly:true});
  }
  for(const id of ready){
   if(this.closed||this.pausing.has(id)||this.restarting.has(id))continue;
   let a=this.db.get(id);if(a.profileUpdate)continue;
   for(const [key,retry] of Object.entries(a.retryPlan??{})){
    if(retry.revision!==a.revision){this.clearRetry(a.id,key);continue;}
    if(retry.at>this.now())continue;
    const issue=automationAttention({...this.db.snapshot(a.id),activeRuns:this.slots(a.id).map(s=>s.run)}).find(i=>i.id===key);
    if(!issue?.retry){this.clearRetry(a.id,key);continue;}
    if(issue.closing||this.capacityUsed>=this.concurrency||a.status!=='enabled'&&this.slots(a.id).length)continue;
    const worker=issue.retry==='trial'?this.workers.list(a.id).find(w=>w.enabled!==false):null;
    if(issue.retry==='trial'&&!worker)continue;
    this.clearRetry(a.id,key);
    try{if(issue.retry==='source')await this.runSource(a.id,issue.sourceUrl);else void this.start(a.id,'trial',worker.id).catch(()=>{});}
    catch(error){this.db.message(a.id,'system','Planlanan deneme başlatılamadı: '+error.message);this.changed(a.id);}
   }
   for(const task of this.queue.list(a.id).filter(t=>t.resumeSourceAfterAnswer&&!['running','reported','paused'].includes(t.state))){
    this.queue.put({...task,resumeSourceAfterAnswer:false});
    if(a.status==='enabled'&&!task.stopRequested&&['blocked','failed'].includes(task.state)&&a.sources.includes(task.sourceUrl)&&a.sourceSettings?.[task.sourceUrl]?.enabled!==false){this.resetSources(a.id,[task.sourceUrl]);this.sourceState(a.id,task.sourceUrl,{onceCompleted:false});this.changed(a.id);}
   }
   a=this.db.get(a.id);
   await dispatchRecordOperations(this,a.id);
   if(this.closed||this.pausing.has(a.id)||this.restarting.has(a.id))continue;
   a=this.db.get(a.id);
   if(a.status!=='enabled')continue;
   if(this.slots(a.id).some(s=>!isConversation(s.run)&&(s.run.kind==='interview'||s.run.kind==='trial'&&!s.run.sourceUrl)))continue;
   const pending=[];
   for(const source of this.db.schedulingSources(a.id,a)){
    if(!source.enabled||source.stopping||a.onceSources&&!a.onceSources.includes(source.url))continue;
    // Skip due turns during an existing search instead of queuing a duplicate.
    if(this.slots(a.id).some(s=>s.run.sourceUrl===source.url))continue;
    if(['waiting','resetting'].includes(source.accessRecovery?.state))continue;
    if(source.accessRecovery?.state==='fresh'&&source.nextRunAt>this.now())continue;
    if((a.questions??[]).some(q=>!q.conversation&&q.answer==null&&!q.recordId&&(!q.sourceUrl||q.sourceUrl===source.url)))continue;
    if(source.siteWait?.waiting)continue;
    if(source.siteBlocked&&!source.blocker?.recordId){
     this.sourceState(a.id,source.url,{blocked:false,siteBlocked:false,batchId:null,nextRunAt:this.now(),onceCompleted:false});
     Object.assign(source,{blocked:false,batchId:null,nextRunAt:this.now(),onceCompleted:false});
    }
    let batchId=source.batchId;
    if(!batchId){
     if(source.blocked||source.nextRunAt>this.now()||a.once&&source.onceCompleted)continue;
     batchId=randomUUID();this.sourceState(a.id,source.url,{batchId});
    }
    const tasks=source.blocked?this.queue.list(a.id,{batchId}):this.plan(a.id,batchId,source);
    if(source.blocked)for(const task of tasks.filter(t=>t.state==='pending'))this.queue.finish(a.id,task.id,'cancelled','Kaynak engellendi');
    const waiting=source.blocked?[]:tasks.filter(t=>t.state==='pending');
    if(!waiting.length&&!this.slots(a.id).some(s=>s.run.batchId===batchId)){
     const blocked=source.blocked||tasks.some(t=>['blocked','failed','interrupted'].includes(t.state));
     this.sourceState(a.id,source.url,{batchId:null,blocked,nextRunAt:blocked?null:this.now()+source.intervalMinutes*60000,onceCompleted:Boolean(a.once)});
    }else pending.push(...waiting.filter(task=>!task.retryAt||task.retryAt<=this.now()));
   }
   const current=this.db.get(a.id),sources=this.db.schedulingSources(a.id,current),eligible=sources.filter(s=>s.enabled&&(!a.onceSources||a.onceSources.includes(s.url)));
   if(a.once&&!this.slots(a.id).some(s=>!isConversation(s.run))&&!pending.length&&eligible.every(s=>!s.siteWait&&(s.blocked||s.onceCompleted)&&!(a.questions??[]).some(q=>!q.conversation&&q.answer==null&&!q.recordId&&(!q.sourceUrl||q.sourceUrl===s.url)))){
    this.db.put({...this.db.get(a.id),once:false,onceSources:null,status:'paused',nextRunAt:null});this.changed(a.id);continue;
   }
   const next=sources.filter(s=>s.enabled&&!s.siteWait?.exhausted&&(!s.blocked||s.siteWait)).map(s=>s.siteWait?.retryAt??s.nextRunAt??this.now());
   const nextRunAt=next.length?Math.min(...next):null;
   if(current.nextRunAt!==nextRunAt)this.db.put({...current,nextRunAt});
   pending.sort((x,y)=>x.createdAt-y.createdAt);
   for(const worker of this.workers.list(a.id).sort((x,y)=>a.id===workspaceId?Number(y.id===workerId)-Number(x.id===workerId):0)){
    if(worker.enabled===false||this.active.has(workerKey(a.id,worker.id))||this.capacityUsed>=this.concurrency)continue;
    const index=pending.findIndex(task=>this.sourceChecks.ready(a.id,task));if(index<0)continue;
    const [task]=pending.splice(index,1);
    // Reservation occurs synchronously inside start before provider awaits.
    void this.start(a.id,{kind:task.operation==='trial'?'trial':'run',taskId:task.id},worker.id).catch(()=>{});
   }
  }}finally{this.dispatching=false;}
 }
 async runRecords(id,itemIds){const task=enqueueScoreBatch(this,id,itemIds);await this.tick();return this.queue.get(id,task.id);}
 async runRecord(id,itemId,kind,input={}){const task=enqueueRecordOperation(this,id,itemId,kind,{manual:true,digest:input.digest,direct:input.direct});await this.tick();return this.queue.get(id,task.id);}
 async dismissRecord(id,itemId){
  const item=this.db.dismiss(id,itemId,{stopActive:true});this.changed(id);
  await Promise.all(this.slots(id).filter(slot=>taskHasRecord(slot.run,itemId)).map(slot=>this.finish(id,'interrupted','Kullanıcı bu kaydı eledi.',slot.workerId)));
  for(const task of this.queue.list(id,{states:['pending','running','reported','paused']}))if(taskHasRecord(task,itemId))this.queue.finish(id,task.id,'cancelled','Kullanıcı bu kaydı eledi.');
  this.changed(id);return item;
 }
 async runOnce(id){this.assertNotStopping(id);this.db.enable(id);const urls=this.db.sources(id).filter(s=>s.enabled).map(s=>s.url);this.resetSources(id,urls);for(const url of urls)this.sourceState(id,url,{onceCompleted:false});this.db.put({...this.db.get(id),once:true,onceSources:urls});await this.tick();return this.slots(id)[0]?.run??null;}
 async runSource(id,url){
  this.assertNotStopping(id);
  const source=this.db.sources(id).find(s=>s.url===url);if(!source)throw Error('Kaynak bu çalışma alanına ait değil');if(!source.enabled)throw Error('Önce kaynağı aç');
  if(this.slots(id).some(s=>s.run.sourceUrl===url))throw Error('Bu kaynak zaten çalışıyor');
  if(source.siteWait?.exhausted){
   if(source.accessRecovery?.state==='waiting')return this.sourceAccess.resume(id,url,source.accessRecovery.runId);
   this.db.siteAccess.acknowledge(source.accessRecovery?.waits??[source.siteWait]);
   this.sourceState(id,url,{accessRecovery:null});
  }
  const a=this.db.get(id);if(a.status!=='enabled')this.db.enable(id,{sourceUrl:url});
  else if(a.once)this.db.put({...a,onceSources:[...new Set([...(a.onceSources??a.sources),url])]});
  this.resetSources(id,[url]);this.sourceState(id,url,{onceCompleted:false});await this.tick();return this.db.sources(id).find(s=>s.url===url);
 }
 // Relearn: the next turn of this source is a trial again, run by the trial agent.
 async relearnSource(id,url){
  this.assertNotStopping(id);
  const source=this.db.sources(id).find(s=>s.url===url);if(!source)throw Error('Kaynak bu çalışma alanına ait değil');
  if(source.scanning)await this.stopSource(id,url);
  this.clearRetry(id,url);
  for(const task of this.queue.list(id,{states:['pending']}))if(task.sourceUrl===url&&!task.recordOperation)this.queue.finish(id,task.id,'cancelled','Kaynak yeniden öğrenilecek');
  this.db.relearnSource(id,url);this.sourceState(id,url,{batchId:null});
  this.changed(id);
  if(source.enabled&&this.db.get(id).status==='enabled')await this.tick();
  return this.db.sources(id).find(s=>s.url===url);
 }
 async stopSource(id,url){
  const source=this.db.sources(id).find(s=>s.url===url);if(!source)throw Error('Kaynak bu çalışma alanına ait değil');
  const summary='Tarama kullanıcı tarafından durduruldu.',matches=run=>['run','trial'].includes(run.kind)&&!run.recordId&&!run.recordOperation&&(run.sourceUrl===url||!run.sourceUrl&&run.sources?.length===1&&run.sources[0]===url);
  const runs=this.db.runs(id).filter(run=>run.status==='running'&&matches(run)),slots=this.slots(id).filter(slot=>matches(slot.run)),taskIds=new Set(runs.map(run=>run.taskId));
  const nextRunAt=this.now()+source.intervalMinutes*60000,accessTask=source.accessRecovery?this.db.run(source.accessRecovery.runId).taskId:null;
  this.queue.atomic(()=>{
   this.clearRetry(id,url);this.sourceState(id,url,{stopping:true,batchId:null,blocked:false,siteBlocked:false,blocker:null,recovery:null,accessRecovery:null,nextRunAt,onceCompleted:Boolean(this.db.get(id).once),lastStatus:'interrupted',lastResult:summary});
   if(accessTask){this.queue.put({...this.queue.get(id,accessTask),stopRequested:true});this.queue.finish(id,accessTask,'cancelled',summary);this.db.jevTasks.release(id,accessTask);this.db.browserEvidence.release(id,accessTask);}
   for(const run of runs)this.db.putRun({...run,stopRequested:true});
   for(const task of this.queue.list(id,{states:['pending','running','reported','paused']}))if(!task.recordId&&!task.recordOperation&&(task.sourceUrl===url||taskIds.has(task.id))){this.queue.put({...task,stopRequested:true});if(task.state==='pending')this.queue.finish(id,task.id,'cancelled',summary);}
  });this.changed(id);
  try{await Promise.all(slots.map(slot=>this.finish(id,'interrupted',summary,slot.workerId)));}catch(error){this.sourceState(id,url,{stopping:false});this.changed(id);throw error;}
  for(const run of runs)if(this.db.run(run.id).status==='running')this.db.finish(id,run.id,'interrupted',summary);
  for(const task of this.queue.list(id,{states:['pending','running','reported','paused']}))if(task.stopRequested&&!task.recordId&&(task.sourceUrl===url||taskIds.has(task.id)))this.queue.finish(id,task.id,'cancelled',summary);
  this.sourceState(id,url,{stopping:false,batchId:null,blocked:false,siteBlocked:false,blocker:null,recovery:null,nextRunAt,lastStatus:'interrupted',lastResult:summary});this.changed(id);
  return this.db.sources(id).find(s=>s.url===url);
 }
 async saveSourcesInterval(id,intervalMinutes){
  this.db.saveSourcesInterval(id,intervalMinutes);
  this.changed(id);await this.tick();return this.db.sources(id);
 }
 async saveSource(id,url,input){
  // Validate before stopping anything. Turning a source off only stops its workers.
  sourceInput(this.db.get(id),url,input);
  if(input.enabled===false){
   if(this.db.sources(id).find(source=>source.url===url).scanning)await this.stopSource(id,url);
   this.clearRetry(id,url);
   for(const task of this.queue.list(id,{states:['pending']}))if(task.sourceUrl===url&&!task.recordOperation)this.queue.finish(id,task.id,'cancelled','Kaynak kapatıldı');
   this.sourceState(id,url,{batchId:null});
  }
  const before=this.db.sources(id).find(s=>s.url===url);this.db.saveSource(id,url,input);
  if(input.enabled===true&&!before.enabled)this.resetSources(id,[url]);
  this.changed(id);await this.tick();return this.db.sources(id).find(s=>s.url===url);
 }
 conversationWorker(id){this.db.get(id);return CONVERSATION_WORKER;}
 assertConversationAvailable(id){this.assertNotStopping(id);if(this.conversationChanges?.has(id))throw Error('Kurulum agenti güncelleniyor.');}
 async configureConversation(id,settings,{restart=false}={}){
  if(settings)settings=this.db.normalizeSetupAgentSettings(settings);
  this.assertConversationAvailable(id);this.conversationChanges??=new Set();this.conversationChanges.add(id);
  try{
   const before=setupAgentSettings(this.db,id),reset=restart||setupAgentSettingsKey(before)!==setupAgentSettingsKey(settings??before);
   const active=this.slots(id).find(slot=>slot.run.kind==='interview');
   setupAgentHistory(this.db,id);
   if(reset&&active)await this.finish(id,'interrupted',restart?'Kurulum agenti yeniden başlatıldı.':'Kurulum agenti ayarları değişti.',active.workerId);
   if(settings)this.db.saveSetupAgentSettings(id,settings);
   if(reset)resetSetupAgentHistory(this.db,id);
   this.changed(id);
   if(reset&&(active||restart))return await this.start(id,'interview',CONVERSATION_WORKER);
   return {saved:true,restarted:false};
  }finally{this.conversationChanges.delete(id);}
 }
 async setup(id){
  this.assertConversationAvailable(id);
  const active=this.slots(id).find(s=>s.run.kind==='interview');if(active)return active.run;
  const worker=this.conversationWorker(id);
  if((this.db.get(id).questions??[]).some(q=>q.answer==null&&!q.recordId&&!q.sourceUrl&&(worker===CONVERSATION_WORKER?q.conversation:!q.conversation)))return {waitingForAnswers:true};
  return this.start(id,'interview',worker);
 }
 async answer(id,questionId,value){
  this.assertConversationAvailable(id);
  const answer=this.db.answerQuestion(id,questionId,value);this.changed(id);
  if(answer.conversation){
   if(!(this.db.get(id).questions??[]).some(q=>q.conversation&&q.answer==null)){
    const active=this.slots(id).find(s=>isConversation(s.run));
    if(active?.run.interactive)await this.sendConversation(id,active,'Kayıtlı sorunun yanıtı: '+JSON.stringify({question:answer.text,answer:answer.answer,values:answer.answerValues}),{messageId:null,inputQuestionIds:[questionId]});
    else{if(active)await this.finish(id,'interrupted','Sohbet yanıtla devam ediyor.',active.workerId);await this.start(id,{kind:'interview',inputQuestionIds:[questionId]},CONVERSATION_WORKER);}
   }return answer;
  }
  if(answer.recordId){
   // The outcome answer already resolved the record; the user picks the next step.
   if(answer.outcome)return answer;
   if(!pendingRecordQuestion(this.db.get(id),this.db.result(id,answer.recordId))){
    try{const active=recordTask(this.db,id,answer.recordId);if(active&&active.state!=='pending'){this.queue.put({...active,resumeRecordAfterAnswer:true});return answer;}const item=this.db.result(id,answer.recordId);const origin=answer.taskId?this.queue.get(id,answer.taskId):null;resumeRecordOperation(this,id,item,origin);await this.tick();}catch(error){this.db.message(id,'system','Yanıt kaydedildi. Kayıt işlemi: '+error.message);}
   }return answer;
  }
  if(answer.sourceUrl){
   const a=this.db.get(id);
   const recovery=a.sourceState?.[answer.sourceUrl]?.accessRecovery;
   if(recovery?.state==='waiting'&&recovery.runId===answer.runId){await this.sourceAccess.resume(id,answer.sourceUrl,recovery.runId,answer.answer);return answer;}
   if(!(a.questions??[]).some(q=>!q.conversation&&q.answer==null&&!q.recordId&&(!q.sourceUrl||q.sourceUrl===answer.sourceUrl))&&answer.taskId){
    const task=this.queue.get(id,answer.taskId);this.queue.put({...task,resumeSourceAfterAnswer:true});await this.tick();
   }
   return answer;
  }
  if((this.db.get(id).questions??[]).some(q=>!q.conversation&&!q.recordId&&!q.sourceUrl&&q.answer==null))return answer;
  try{const interview=this.slots(id).find(s=>s.run.kind==='interview');if(interview)await this.finish(id,'interrupted','Kurulum yanıtla devam ediyor.',interview.workerId);await this.setup(id);}catch(error){this.db.message(id,'system','Yanıtın kaydedildi. Agent devam edemedi: '+error.message);this.changed(id);}
  return answer;
 }
 async message(id,text){
  this.assertConversationAvailable(id);
  const active=this.slots(id).find(s=>s.run.kind==='interview');
  if(active){
   if(!conversationWaiting(this.db.run(active.run.id))||active.finishing||active.worker?.isBusy?.())throw Error('Sohbet agent’ı yanıtını hazırlıyor. Yanıt tamamlanınca yeni mesaj gönderebilirsin.');
   const message=this.db.message(id,'user',text,{conversation:true,runId:active.run.id});this.changed(id);
   return this.sendConversation(id,active,message.text,{messageId:message.id,inputQuestionIds:[]});
  }
  const worker=this.conversationWorker(id),message=this.db.message(id,'user',text,{conversation:true});this.changed(id);
  return this.start(id,{kind:'interview',messageId:message.id},worker);
 }
 async sendConversation(id,slot,text,input={}){
  if(slot.finishing||this.closed)throw Error('Sohbet kapanıyor.');
  const before=this.db.run(slot.run.id),changed=before.contextVersion!==conversationContextVersion(this.db.get(id));
  slot.seenWorking=false;slot.run=this.db.putRun({...before,...input,awaitingMessage:false,lastMessageAt:this.now()});this.changed(id);
  try{
   const worker=slot.worker??await slot.ready;
   await worker.message(changed?'Workspace profile or permissions changed. Read get_automation_context once before acting.\n\n'+text:text);
   return this.db.run(slot.run.id);
  }catch(error){if(!slot.finishing){slot.run=this.db.putRun({...this.db.run(slot.run.id),awaitingMessage:true});this.changed(id);}throw error;}
 }
 report(id,runId,status,summary,goalReached=false){
  const result=this.complete(id,runId,status,summary,{goalReached}),run=this.db.run(runId);
  if(status==='blocked'&&run.kind==='trial'&&!run.sourceUrl&&run.siteWait&&!run.siteWait.exhausted){
   const a=this.db.get(id);this.db.put({...a,retryPlan:{...a.retryPlan,[runId]:{at:run.siteWait.retryAt,revision:a.revision}}});this.changed(id);
  }
  return result;
 }
 pause(id,status='paused'){
  if(this.pausing.has(id))return this.pausing.get(id);
  // Revoke queued work before releasing any worker slot. Manual tasks can
  // normally run in a paused workspace, but cannot cross an explicit stop.
  this.queue.atomic(()=>{
   this.db.pause(id,status);
   for(const task of this.queue.list(id)){
    if(task.resumeRecordAfterVerification||task.resumeRecordAfterAnswer||task.resumeSourceAfterAnswer)this.queue.put({...task,resumeRecordAfterVerification:false,resumeRecordAfterAnswer:false,resumeSourceAfterAnswer:false});
    if(['pending','running','reported','paused'].includes(task.state)&&task.recordOperation)this.queue.put({...this.queue.get(id,task.id),stopRequested:true});
    if(task.state==='pending')this.queue.finish(id,task.id,'cancelled','Çalışma durduruldu');
   }
  });
  const slots=this.slots(id);for(const slot of slots)slot.controller.abort();
  const stopping=Promise.resolve().then(async()=>{
   const results=await Promise.allSettled(slots.map(slot=>this.finish(id,'interrupted','Kullanıcı durdurdu.',slot.workerId)));
   for(const source of this.db.sources(id))this.sourceState(id,source.url,{batchId:null});
   this.db.put({...this.db.get(id),batchId:null,once:false,onceSources:null,retryPlan:{}});this.changed(id);
   const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
  }).finally(()=>this.pausing.delete(id));
  this.pausing.set(id,stopping);return stopping;
 }
 async restart(id){
  if(this.restarting.has(id))throw Error('Çalışma alanı yeniden başlatılıyor.');
  const a=this.db.get(id),runs=this.slots(id).map(slot=>this.db.run(slot.run.id)),conversation=runs.find(isConversation),setup=runs.find(run=>run.kind==='interview'&&!isConversation(run));
  this.restarting.add(id);
  try{
   await this.pause(id);
   for(const worker of [...this.workers.list(id),{id:CONVERSATION_WORKER}]){
    const history=this.db.store.workspaces.history(id,worker.id);
    for(const provider of ['codex','claude','opencode'])history.forgetConversation(id,provider,history.conversation(id,provider));
   }
   this.db.db.prepare("UPDATE automation_runs SET data=json_set(data,'$.conversation',NULL) WHERE automation_id=? AND json_extract(data,'$.conversation') IS NOT NULL").run(id);
   if(setup)return await this.start(id,setup.kind,setup.workerId);
   if(conversation&&a.status!=='enabled'&&!runs.some(run=>!isConversation(run)))return await this.start(id,{kind:'interview',messageId:conversation.messageId,inputQuestionIds:conversation.inputQuestionIds},CONVERSATION_WORKER);
   this.db.enable(id);
   if(a.once)this.db.put({...this.db.get(id),once:true,onceSources:a.onceSources});
   if(conversation)await this.start(id,{kind:'interview',messageId:conversation.messageId,inputQuestionIds:conversation.inputQuestionIds},CONVERSATION_WORKER);
  }finally{this.restarting.delete(id);}
  await this.tick();return this.slots(id)[0]?.run??null;
 }
 async add(id,input){const worker=this.workers.add(id,input);this.changed(id);await this.tick();return worker;}
 restartState(id,worker){
  // Browser settings can close the session before the restart confirmation.
  // Keep the last worker task's kind so unfinished setup never becomes a trial.
  const slot=this.slots(id).find(s=>s.workerId===worker),run=slot?this.db.run(slot.run.id):this.db.runs(id).find(r=>(r.workerId??'main')===worker);
  return run?{kind:run.kind,resume:run.kind==='interview'&&!isConversation(run),runId:run.id}:null;
 }
 async startWorker(id,worker,restart){
  this.assertNotStopping(id);
  this.workers.get(id,worker);
  if(worker===CONVERSATION_WORKER)return restart?this.configureConversation(id,null,{restart:true}):this.setup(id);
  if(restart?.runId&&!restart.resume){
   const previous=this.db.run(restart.runId),conversation=previous.conversation;
   if(previous.automationId!==id||(previous.workerId??'main')!==worker)throw Error('Yeniden başlatılacak oturum bu worker’a ait değil.');
   // Source retries use the run's conversation, not just worker history. Clear
   // both references while retaining the durable task, queue and browser tabs.
   if(conversation)automationRunHistory(this.db,previous,this.db.store.workspaces.history(id,worker),conversation.profileId).forgetConversation(id,conversation.provider,conversation.nativeId);
  }
  this.workers.setEnabled(id,worker,true);if(restart?.kind==='interview')return this.start(id,'interview',worker);const a=this.db.get(id);if(a.status!=='enabled'){this.db.enable(id);this.resetSources(id,this.db.sources(id).filter(s=>s.enabled&&!s.blocked).map(s=>s.url));}await this.tick({workspaceId:id,workerId:worker});
 }
 async stopWorker(id,worker){this.workers.get(id,worker);if(worker!==CONVERSATION_WORKER)this.workers.setEnabled(id,worker,false);await this.finish(id,'interrupted',worker===CONVERSATION_WORKER?'Sohbet durduruldu.':'Worker durduruldu.',worker);this.changed(id);}
 async remove(id,worker){if(worker==='main'||worker===CONVERSATION_WORKER)throw Error('İlk worker kaldırılamaz.');await this.stopWorker(id,worker);this.workers.remove(id,worker);this.changed(id);}
}
