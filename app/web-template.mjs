import {SourceRetryChecks} from './source-retry-check.mjs';
import {enqueueRecordOperation,dispatchRecordOperations,recordTask,resumeRecordOperation,pendingRecordQuestion} from './record-operations.mjs';
import {automationTrialReady} from './automation-trial.mjs';
import {TaskRuns} from './task-runs.mjs';
import {recoverRecordOperations} from './record-recovery.mjs';
import {workerKey} from './worker-key.mjs';
import {randomUUID} from 'node:crypto';
import {sourceInput} from './automation-sources.mjs';
import {automationAttention} from './automation-attention.mjs';
import {continueSourceRun,unreportedInterviewRun,unreportedSourceRun,requeueSourceRun,recoverUnreportedSources,recoverExhaustedSourceRetries} from './automation-recovery.mjs';
// Template definitions select operations; the common queue owns dependencies,
// worker leases and record/source exclusivity. No template-name dispatch here.
export class WebTasks extends TaskRuns {
 constructor(db,options){super({
  idleGraceMs:10000,
  continueIdle:(id,runId)=>continueSourceRun(db,id,runId),
  unreported:(id,runId,reason)=>unreportedInterviewRun(db,id,runId)??unreportedSourceRun(db,id,runId,reason,(options?.now??Date.now)()),
  recover:()=>{const interrupted=db.list().flatMap(a=>db.store.workspaces.tasks.list(a.id,{states:['running','reported','paused']}));db.recover();for(const previous of interrupted){
   const queue=db.store.workspaces.tasks,a=db.get(previous.workspaceId),task=queue.get(a.id,previous.id),source=a.sourceState?.[task.sourceUrl],scan=task.scan??source?.scan;
   if(task.stopRequested)queue.finish(a.id,task.id,'cancelled','Tarama kullanıcı tarafından durduruldu.');
   else if(task.sourceUrl&&!task.recordId&&['interrupted','partial'].includes(task.completionState??task.state)&&a.status==='enabled'&&!source?.blocked)queue.put({...task,state:'pending',workerId:null,scan,completionState:null});
   else queue.finish(a.id,task.id,task.completionState??'interrupted','Önceki uygulama oturumu kapandı');
  }for(const a of db.list())if(Object.values(a.sourceState??{}).some(s=>s.stopping))db.put({...a,sourceState:Object.fromEntries(Object.entries(a.sourceState).map(([url,s])=>[url,{...s,stopping:false}]))});recoverUnreportedSources(db,(options?.now??Date.now)());recoverRecordOperations(db);recoverExhaustedSourceRetries(db);},config:id=>db.get(id),run:id=>db.run(id),save:run=>db.putRun(run),
  due:now=>db.list().filter(a=>a.status==='enabled'&&a.nextRunAt<=now).map(a=>a.id),
  begin:(id,input='run',worker)=>{const run=db.begin(id,input,worker),a=db.get(id),source=a.sourceState?.[run.sourceUrl];if(source?.recovery)db.put({...a,sourceState:{...a.sourceState,[run.sourceUrl]:{...source,recovery:null}}});return run;},
  report:(id,runId,status,summary,goalReached)=>{const result=db.finish(id,runId,status,summary,{release:false});if(goalReached&&result.kind==='run'&&result.status==='completed')db.pause(id,'complete');return result;},
  finish:(id,runId,status,summary)=>{
   if(db.run(runId).status==='running')db.finish(id,runId,status,summary);
   const run=db.run(runId);if(!run.taskId)return;
   const queue=db.store.workspaces.tasks,task=queue.get(id,run.taskId);
   if(['partial','interrupted'].includes(run.status)&&run.sourceUrl&&!run.recordId&&db.get(id).status==='enabled')requeueSourceRun(db,run);
   else queue.finish(id,run.taskId,run.status==='timeout'?'failed':run.status,run.summary);
  },
  closeFailed:(id,runId,error)=>{const run=db.run(runId),summary='Oturum kapatılamadı: '+error.message;if(run.status==='running')db.finish(id,runId,'failed',summary);else db.putRun({...run,status:'failed',summary});if(run.taskId){const q=db.store.workspaces.tasks;q.put({...q.get(id,run.taskId),state:'paused'});}db.pause(id,'blocked');},
  afterFinish:async(id,runId)=>{
   const run=db.run(runId),pending=(db.get(id).questions??[]).some(q=>q.answer==null&&q.taskId===run.taskId);
   const completeSource=run.kind==='run'&&!run.recordId&&run.sourceUrl&&run.scan?.complete&&run.scan.completion!=='user_stop';
   const completeRecord=run.recordId&&db.result(id,run.recordId).status==='completed';
   const pendingContexts=(db.get(id).questions??[]).filter(q=>q.answer==null).map(q=>q.browserContext).filter(Boolean);
   await options?.onRunFinished?.(id,run,{closeTabs:run.status==='completed'&&!pending&&Boolean(completeSource||completeRecord),pendingTabIds:pendingContexts.map(context=>context.tabId).filter(Boolean),pendingUrls:pendingContexts.map(context=>context.url).filter(Boolean)});
  }
 },options);this.db=db;this.queue=db.store.workspaces.tasks;this.workers=db.store.workspaces.workers;this.dispatching=false;this.restarting=new Set();this.browserReady=options?.browserReady??(()=>true);this.sourceChecks=new SourceRetryChecks(db,{probe:options?.probeSource,now:this.now,changed:this.changed,isClosed:()=>this.closed});}
 plan(id,batchId,source){
  const a=this.db.get(id),template=this.db.template(a.templateId),tasks=this.queue.list(id,{batchId});
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
 sourceState(id,url,patch){const a=this.db.get(id);return this.db.put({...a,sourceState:{...a.sourceState,[url]:{...a.sourceState?.[url],...patch}}});}
 clearRetry(id,key){const a=this.db.get(id);if(!a.retryPlan?.[key])return;const retryPlan={...a.retryPlan};delete retryPlan[key];this.db.put({...a,retryPlan});this.changed(id);}
 retryLater(id,key,cancel=false){
  const a=this.db.get(id);if(cancel){this.clearRetry(id,key);return {cancelled:true};}
  const issue=automationAttention({...this.db.snapshot(id),activeRuns:this.slots(id).map(s=>s.run)}).find(i=>i.id===key);
  if(!issue?.retry||issue.closing)throw Error('Bu müdahale için yeniden deneme şu anda planlanamaz.');
  const at=this.now()+2*60*60*1000;
  if(a.endAt&&a.endAt<=at)throw Error('İki saat sonrası otomasyonun bitiş tarihini geçiyor. Önce bitiş tarihini güncelle.');
  this.db.put({...a,retryPlan:{...a.retryPlan,[key]:{at,revision:a.revision}}});this.changed(id);return {at};
 }
 resetSources(id,urls){
  const a=this.db.get(id);for(const task of this.queue.list(id,{states:['pending']}))if(!task.recordOperation&&(!task.sourceUrl||urls.includes(task.sourceUrl)))this.queue.finish(id,task.id,'cancelled','Yeni kaynak turu');
  for(const url of urls){this.clearRetry(id,url);this.sourceState(id,url,{batchId:null,blocked:false,blocker:null,recovery:null,siteBlocked:false,nextRunAt:this.now()});}
  return a;
 }
 async tick(){
  if(this.closed||this.dispatching)return;this.dispatching=true;
  try{recoverUnreportedSources(this.db,this.now());recoverExhaustedSourceRetries(this.db);for(const saved of this.db.list()){
   if(this.restarting.has(saved.id))continue;
   if(!this.browserReady(saved.id))continue;
   let a=saved;
   for(const [key,retry] of Object.entries(a.retryPlan??{})){
    const issue=automationAttention({...this.db.snapshot(a.id),activeRuns:this.slots(a.id).map(s=>s.run)}).find(i=>i.id===key);
    if(retry.revision!==a.revision||!issue?.retry||a.endAt&&a.endAt<=this.now()){this.clearRetry(a.id,key);continue;}
    if(retry.at>this.now()||issue.closing||this.active.size>=this.concurrency||a.status!=='enabled'&&this.slots(a.id).length)continue;
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
   if(a.status!=='enabled')continue;if(a.endAt&&a.endAt<=this.now()){await this.pause(a.id,'complete');continue;}
   if(this.slots(a.id).some(s=>s.run.kind!=='run'))continue;
   const pending=[];
   for(const source of this.db.sources(a.id)){
    if(!source.enabled||source.stopping||a.onceSources&&!a.onceSources.includes(source.url))continue;
    if((a.questions??[]).some(q=>q.answer==null&&!q.recordId&&(!q.sourceUrl||q.sourceUrl===source.url)))continue;
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
   const sources=this.db.sources(a.id),eligible=sources.filter(s=>s.enabled&&(!a.onceSources||a.onceSources.includes(s.url)));
   if(a.once&&!this.slots(a.id).length&&!pending.length&&eligible.every(s=>!s.siteWait&&(s.blocked||s.onceCompleted)&&!(a.questions??[]).some(q=>q.answer==null&&!q.recordId&&(!q.sourceUrl||q.sourceUrl===s.url)))){
    this.db.put({...this.db.get(a.id),once:false,onceSources:null,status:'paused',nextRunAt:null});this.changed(a.id);continue;
   }
   const next=sources.filter(s=>s.enabled&&(!s.blocked||s.siteWait)).map(s=>s.siteWait?.retryAt??s.nextRunAt??this.now());
   this.db.put({...this.db.get(a.id),nextRunAt:next.length?Math.min(...next):null});
   pending.sort((x,y)=>x.createdAt-y.createdAt);
   for(const worker of this.workers.list(a.id)){
    if(worker.enabled===false||this.active.has(workerKey(a.id,worker.id))||this.active.size>=this.concurrency)continue;
    const index=pending.findIndex(task=>this.sourceChecks.ready(a.id,task));if(index<0)break;
    const [task]=pending.splice(index,1);
    // Reservation occurs synchronously inside start before provider awaits.
    void this.start(a.id,{kind:'run',taskId:task.id},worker.id).catch(()=>{});
   }
  }}finally{this.dispatching=false;}
 }
 async runRecord(id,itemId,kind,input={}){const task=enqueueRecordOperation(this,id,itemId,kind,{manual:true,digest:input.digest,direct:input.direct});await this.tick();return this.queue.get(id,task.id);}
 async dismissRecord(id,itemId){
  const item=this.db.dismiss(id,itemId,{stopActive:true});this.changed(id);
  await Promise.all(this.slots(id).filter(slot=>slot.run.recordId===itemId).map(slot=>this.finish(id,'interrupted','Kullanıcı bu kaydı eledi.',slot.workerId)));
  for(const task of this.queue.list(id,{states:['pending','running','reported','paused']}))if(task.recordId===itemId)this.queue.finish(id,task.id,'cancelled','Kullanıcı bu kaydı eledi.');
  this.changed(id);return item;
 }
 async runOnce(id){this.db.enable(id);const urls=this.db.sources(id).filter(s=>s.enabled).map(s=>s.url);this.resetSources(id,urls);for(const url of urls)this.sourceState(id,url,{onceCompleted:false});this.db.put({...this.db.get(id),once:true,onceSources:urls});await this.tick();return this.slots(id)[0]?.run??null;}
 async runSource(id,url){
  const source=this.db.sources(id).find(s=>s.url===url);if(!source)throw Error('Kaynak bu çalışma alanına ait değil');if(!source.enabled)throw Error('Önce kaynağı aç');
  if(this.slots(id).some(s=>s.run.sourceUrl===url))throw Error('Bu kaynak zaten çalışıyor');
  const a=this.db.get(id);if(a.status!=='enabled'){this.db.enable(id);this.db.put({...this.db.get(id),once:true,onceSources:[url]});}
  else if(a.once)this.db.put({...a,onceSources:[...new Set([...(a.onceSources??a.sources),url])]});
  this.resetSources(id,[url]);this.sourceState(id,url,{onceCompleted:false});await this.tick();return this.db.sources(id).find(s=>s.url===url);
 }
 async stopSource(id,url){
  const source=this.db.sources(id).find(s=>s.url===url);if(!source)throw Error('Kaynak bu çalışma alanına ait değil');
  const summary='Tarama kullanıcı tarafından durduruldu.',matches=run=>run.kind==='run'&&!run.recordId&&!run.recordOperation&&(run.sourceUrl===url||!run.sourceUrl&&run.sources?.length===1&&run.sources[0]===url);
  const runs=this.db.runs(id).filter(run=>run.status==='running'&&matches(run)),slots=this.slots(id).filter(slot=>matches(slot.run)),taskIds=new Set(runs.map(run=>run.taskId));
  const nextRunAt=this.now()+source.intervalMinutes*60000;
  this.queue.atomic(()=>{
   this.clearRetry(id,url);this.sourceState(id,url,{stopping:true,batchId:null,blocked:false,siteBlocked:false,blocker:null,recovery:null,nextRunAt,onceCompleted:Boolean(this.db.get(id).once),lastStatus:'interrupted',lastResult:summary});
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
 async setup(id){
  const active=this.slots(id);if(active.length){if(active.length===1&&active[0].run.kind==='interview')return active[0].run;throw Error('Önce çalışan görevi durdur');}
  if((this.db.get(id).questions??[]).some(q=>q.answer==null))return {waitingForAnswers:true};
  return this.start(id,'interview');
 }
 async answer(id,questionId,value){
  const answer=this.db.answerQuestion(id,questionId,value);this.changed(id);
  if(answer.recordId){
   if(!pendingRecordQuestion(this.db.get(id),this.db.result(id,answer.recordId))){
    try{const active=recordTask(this.db,id,answer.recordId);if(active&&active.state!=='pending'){this.queue.put({...active,resumeRecordAfterAnswer:true});return answer;}const item=this.db.result(id,answer.recordId);const origin=answer.taskId?this.queue.get(id,answer.taskId):null;resumeRecordOperation(this,id,item,origin);await this.tick();}catch(error){this.db.message(id,'system','Yanıt kaydedildi. Kayıt işlemi: '+error.message);}
   }return answer;
  }
  if(answer.sourceUrl){
   const a=this.db.get(id);
   if(!(a.questions??[]).some(q=>q.answer==null&&!q.recordId&&(!q.sourceUrl||q.sourceUrl===answer.sourceUrl))&&answer.taskId){
    const task=this.queue.get(id,answer.taskId);this.queue.put({...task,resumeSourceAfterAnswer:true});await this.tick();
   }
   return answer;
  }
  if((this.db.get(id).questions??[]).some(q=>q.answer==null))return answer;
  try{await this.pause(id);await this.setup(id);}catch(error){this.db.message(id,'system','Yanıtın kaydedildi. Agent devam edemedi: '+error.message);this.changed(id);}
  return answer;
 }
 async message(id,text,workerId='main'){await this.pause(id);this.db.message(id,'user',text);this.changed(id);return this.start(id,'interview',workerId);}
 report(id,runId,status,summary,goalReached=false){
  const result=this.complete(id,runId,status,summary,{goalReached}),run=this.db.run(runId);
  if(status==='blocked'&&run.kind==='trial'&&run.siteWait){
   const a=this.db.get(id);this.db.put({...a,retryPlan:{...a.retryPlan,[runId]:{at:run.siteWait.retryAt,revision:a.revision}}});this.changed(id);
  }
  return result;
 }
 async pause(id,status='paused'){
  this.db.pause(id,status);await Promise.all(this.slots(id).map(slot=>this.finish(id,'interrupted','Kullanıcı durdurdu.',slot.workerId)));
  for(const task of this.queue.list(id,{states:['pending']}))this.queue.finish(id,task.id,'cancelled','Çalışma durduruldu');
  for(const source of this.db.sources(id))this.sourceState(id,source.url,{batchId:null});
  this.db.put({...this.db.get(id),batchId:null,once:false,onceSources:null,retryPlan:{}});this.changed(id);
 }
 async restart(id){
  if(this.restarting.has(id))throw Error('Çalışma alanı yeniden başlatılıyor.');
  const a=this.db.get(id),runs=this.slots(id).map(slot=>this.db.run(slot.run.id)),setup=runs.find(run=>run.kind!=='run');
  this.restarting.add(id);
  try{
   await this.pause(id);
   for(const worker of this.workers.list(id)){
    const history=this.db.store.workspaces.history(id,worker.id);
    for(const provider of ['codex','claude'])history.forgetConversation(id,provider,history.conversation(id,provider));
   }
   if(setup)return await this.start(id,setup.kind,setup.workerId);
   if(!automationTrialReady(this.db.get(id)))return await this.start(id,'trial');
   if(runs.some(run=>run.actionId&&this.db.result(id,run.actionId).status==='uncertain')){this.db.pause(id,'blocked');this.changed(id);return null;}
   this.db.enable(id);
   if(a.once)this.db.put({...this.db.get(id),once:true,onceSources:a.onceSources});
  }finally{this.restarting.delete(id);}
  await this.tick();return this.slots(id)[0]?.run??null;
 }
 async add(id,input){const worker=this.workers.add(id,input);this.changed(id);await this.tick();return worker;}
 restartState(id,worker){
  // Browser settings can close the session before the restart confirmation.
  // Keep the last worker task's kind so unfinished setup never becomes a trial.
  const run=this.slots(id).find(s=>s.workerId===worker)?.run??this.db.runs(id).find(r=>(r.workerId??'main')===worker);
  return run?{kind:run.kind,resume:run.kind==='interview'}:null;
 }
 async startWorker(id,worker,restart){this.workers.get(id,worker);this.workers.setEnabled(id,worker,true);if(['interview','trial'].includes(restart?.kind))return this.start(id,restart.kind,worker);const a=this.db.get(id);if(!automationTrialReady(a))return this.start(id,'trial',worker);if(a.status!=='enabled'){this.db.enable(id);this.resetSources(id,this.db.sources(id).filter(s=>s.enabled&&!s.blocked).map(s=>s.url));}await this.tick();}
 async stopWorker(id,worker){this.workers.get(id,worker);this.workers.setEnabled(id,worker,false);await this.finish(id,'interrupted','Worker durduruldu.',worker);this.changed(id);}
 async remove(id,worker){if(worker==='main')throw Error('İlk worker kaldırılamaz.');await this.stopWorker(id,worker);this.workers.remove(id,worker);this.changed(id);}
}
