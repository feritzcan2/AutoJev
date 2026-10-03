import {automaticAssessmentError} from '../src/scoring-state.js';
import {taskRecordIds,taskHasRecord,batchScoring,recordScoredInTask} from './record-task-scope.mjs';
import {isConversation} from './workspace-conversation.mjs';
import {sourceMode} from './automation-sources.mjs';
import {automationReady} from './automation-trial.mjs';
import {workerKey} from './worker-key.mjs';

const live=['pending','running','reported','paused'];
const waitingForAnswer='Önce bu kayıt için bekleyen soruları yanıtla';
export function recordSource(a,item){
 if(item.sourceUrl)return item.sourceUrl;
 const sources=a.sources.filter(url=>new URL(url).origin===new URL(item.url).origin);
 return sources.length===1?sources[0]:null;
}
export function pendingRecordQuestion(a,item){return (a.questions??[]).find(q=>!q.conversation&&q.answer==null&&(q.recordId?q.recordId===item.id:!q.sourceUrl||q.sourceUrl===recordSource(a,item)));}
export function recordTask(db,id,itemId){return db.store.workspaces.tasks.list(id,{states:live}).find(t=>taskHasRecord(t,itemId));}
export function recordOperationError(a,item,kind,{manual=false,digest,direct=false,now=Date.now()}={}){
 if(item.trial)return 'Araştırma örneği üzerinde işlem yapılamaz';
 if(kind==='verify')return item.status==='uncertain'?null:'Yalnızca sonucu belirsiz bir işlem doğrulanabilir';
 if(['completed','executing','uncertain','dismissed'].includes(item.status))return 'Bu kayıt yeniden gönderilemez';
 if(!automationReady(a))return 'Önce kurulumu kontrol edip kaydet';
 if(pendingRecordQuestion(a,item))return waitingForAnswer;
 if(kind==='score')return null;
 const source=recordSource(a,item),mode=source?sourceMode(a,source):'observe';
 if(!manual&&mode==='observe')return 'Kaynak yalnızca bul modunda';
 if(kind==='prepare')return null;
 if(kind!=='execute')return 'Bilinmeyen kayıt işlemi';
 if(!manual){const error=automaticAssessmentError(item.assessment,a.revision);if(error)return error;}
 if(direct===true)return manual===true?null:'Doğrudan işlem için kullanıcı isteği gerekli';
 if(item.status!=='prepared'||!item.proposal||item.revision!==a.revision)return 'Önce güncel işlem taslağını hazırla';
 if(manual&&digest!==item.digest)return 'Taslak değişti; güncel içeriği yeniden incele';
 if(!manual&&(mode!=='auto'||item.requiresReview)&&item.approvedDigest!==item.digest)return 'İşlem onay bekliyor';
 return null;
}

export function enqueueRecordOperation(runtime,id,itemId,kind,{manual=true,digest,direct=false}={}){
 runtime.assertNotStopping(id);
 const {db,queue}=runtime;
 const wake=task=>{
  // Explicit record requests use the existing worker pool. Background
  // ticks still respect workers the user stopped; no new workers are created.
  if(manual&&task.state==='pending'){
   const workers=runtime.workers.list(id);
   if(['score','prepare'].includes(kind)||kind==='execute'&&direct===true){
    const pending=queue.list(id,{states:['pending']}).filter(t=>(['score','prepare'].includes(t.recordOperation)||t.recordOperation==='execute'&&t.request?.direct===true)&&(t.request?.manual||db.get(id).status==='enabled')).filter(t=>{try{validateRecordTask(db,id,t,runtime.now());return true;}catch{return false;}});
    let needed=pending.length-workers.filter(w=>w.enabled!==false&&!runtime.active.has(workerKey(id,w.id))).length;
    for(const worker of workers){if(needed<=0)break;if(worker.enabled===false&&!runtime.active.has(workerKey(id,worker.id))){runtime.workers.setEnabled(id,worker.id,true);needed--;runtime.changed(id);}}
   }else if(!workers.some(w=>w.enabled!==false)){runtime.workers.setEnabled(id,'main',true);runtime.changed(id);}
  }
  return task;
 };
 const task=queue.atomic(()=>{
  const a=db.get(id),item=db.result(id,itemId),op=db.template(a.templateId).recordOperations?.[kind];
  if(!op)throw Error('Template bu kayıt işlemini desteklemiyor');
  const error=recordOperationError(a,item,kind,{manual,digest,direct,now:runtime.now()});if(error)throw Error(error);
  const existing=recordTask(db,id,itemId);
  if(existing){if(!batchScoring(existing)&&existing.recordOperation===kind&&(existing.request?.direct===true)===(direct===true)&&(!digest||existing.request?.digest===digest)){
   if(manual&&existing.state==='pending'&&!existing.request?.manual)return queue.put({...existing,request:{...existing.request,manual:true,at:runtime.now()}});
   return existing;
  }throw Error('Bu kayıt için başka bir görev zaten sırada veya çalışıyor');}
  const sourceUrl=recordSource(a,item),request={manual,revision:a.revision,...(kind==='execute'?(direct===true?{direct:true}:{digest:item.digest}):{}),at:runtime.now()};
  const task=queue.enqueue(id,{recordOperation:kind,operation:op.id,capability:op.capability,recordId:item.id,subject:item.id,sourceUrl,sources:[item.url],lockKey:'record:'+item.id,request,recordVersion:item.digest??String(item.updatedAt)});
  db.event(id,'record_operation_queued',{itemId,kind,taskId:task.id,manual});return task;
 });
 wake(task);runtime.changed(id);return task;
}

export function enqueueScoreBatch(runtime,id,itemIds){
 runtime.assertNotStopping(id);
 if(!Array.isArray(itemIds)||!itemIds.length||itemIds.length>100||itemIds.some(value=>typeof value!=='string'||!value.trim()))throw Error('Puanlamak için 1–100 kayıt seç');
 const recordIds=[...new Set(itemIds)],{db,queue}=runtime;
 if(recordIds.length===1)return enqueueRecordOperation(runtime,id,recordIds[0],'score');
 const task=queue.atomic(()=>{
  const a=db.get(id),op=db.template(a.templateId).recordOperations?.score;
  if(!op)throw Error('Template bu kayıt işlemini desteklemiyor');
  const items=recordIds.map(itemId=>db.result(id,itemId));
  for(const item of items){const error=recordOperationError(a,item,'score',{manual:true});if(error)throw Error(item.title+': '+error);}
  const existing=recordTask(db,id,recordIds[0]);
  if(batchScoring(existing)&&existing.recordIds.length===recordIds.length&&recordIds.every(itemId=>existing.recordIds.includes(itemId)))return existing;
  if(recordIds.some(itemId=>recordTask(db,id,itemId)))throw Error('Seçilen kayıtlardan biri için başka bir görev zaten sırada veya çalışıyor');
  const task=queue.enqueue(id,{recordOperation:'score',operation:op.id,capability:op.capability,recordId:recordIds[0],recordIds,subject:recordIds[0],sources:items.map(item=>item.url),lockKey:'record:'+recordIds[0],request:{manual:true,revision:a.revision,at:runtime.now()}});
  db.event(id,'record_operation_queued',{itemIds:recordIds,kind:'score',taskId:task.id,manual:true});return task;
 });
 // One batch needs one worker and a separate read-only browser tab.
 if(task.state==='pending'){
  const workers=runtime.workers.list(id);
  if(!workers.some(w=>w.enabled!==false&&!runtime.active.has(workerKey(id,w.id)))){
   const worker=workers.find(w=>w.enabled===false&&!runtime.active.has(workerKey(id,w.id)));
   if(worker)runtime.workers.setEnabled(id,worker.id,true);
  }
 }
 runtime.changed(id);return task;
}

export function validateRecordTask(db,id,task,now){
 if(!task.recordOperation)return;
 const a=db.get(id),request=task.request??{};
 if(request.revision!==a.revision&&task.recordOperation!=='verify')throw Error('Görev sıradayken kurulum değişti; işlemi yeniden hazırla');
 for(const itemId of taskRecordIds(task)){
  const item=db.result(id,itemId);
  if(task.recordOperation==='score'&&task.attempts>0&&['found','prepared'].includes(item.status)&&(recordScoredInTask(db,task,item)||pendingRecordQuestion(a,item)))continue;
  const error=recordOperationError(a,item,task.recordOperation,{manual:request.manual,digest:request.digest,direct:request.direct,now});if(error)throw Object.assign(Error(error),error===waitingForAnswer?{code:'RECORD_QUESTION_PENDING'}:{});
 }
}


// An answer supplies missing facts; only the original direct request can carry
// submission authority forward. Stops, cancellation and setup edits revoke it.
export function resumeRecordOperation(runtime,id,item,task){
 if(batchScoring(task)){
  const ids=taskRecordIds(task).filter(itemId=>{
   const record=runtime.db.result(id,itemId);
   if(!['found','prepared'].includes(record.status)||recordTask(runtime.db,id,itemId)||pendingRecordQuestion(runtime.db.get(id),record))return false;
   if(record.assessment?.runId){try{if(runtime.db.run(record.assessment.runId).taskId===task.id)return false;}catch{}}
   return true;
  });
  return ids.length?enqueueScoreBatch(runtime,id,ids):null;
 }
 const direct=task?.recordOperation==='execute'&&task.request?.manual===true&&task.request?.direct===true&&task.request.revision===runtime.db.get(id).revision&&['completed','blocked'].includes(task.completionState??task.state);
 return enqueueRecordOperation(runtime,id,item.id,item.status==='uncertain'?'verify':task?.recordOperation==='score'?'score':direct?'execute':'prepare',{direct});
}

export async function dispatchRecordOperations(runtime,id,{manualOnly=false}={}){
 if(runtime.closed||runtime.pausing.has(id)||runtime.restarting.has(id))return;
 const {db,queue}=runtime,a=db.get(id),ops=db.template(a.templateId).recordOperations;
 if(!ops||a.profileUpdate||runtime.slots(id).some(s=>!isConversation(s.run)&&(s.run.kind==='interview'||s.run.kind==='trial'&&!s.run.sourceUrl)))return;
 const savedTasks=queue.list(id);
 for(const task of savedTasks.filter(t=>t.resumeRecordAfterVerification&&!live.includes(t.state))){
  queue.put({...task,resumeRecordAfterVerification:false});
  const item=db.result(id,task.recordId),proof=item.notSubmitted;
  if(task.state!=='completed'||task.stopRequested||!task.request?.manual||!proof||proof.digest!==item.digest||recordTask(db,id,item.id))continue;
  let origin;try{if(db.run(proof.runId).taskId!==task.id)continue;origin=db.run(proof.attemptRunId);}catch{continue;}
  const request=origin.request;
  if(origin.automationId!==id||origin.recordId!==item.id||origin.recordOperation!=='execute'||origin.stopRequested||!request?.manual||request.revision!==a.revision||item.revision!==a.revision)continue;
  const originTask=origin.taskId&&queue.get(id,origin.taskId);
  if(originTask?.stopRequested||/Kullanıcı|Worker durduruldu/.test(origin.summary??'')||request.direct!==true&&request.digest!==item.digest)continue;
  try{enqueueRecordOperation(runtime,id,item.id,'execute',{manual:true,direct:request.direct===true,digest:request.direct===true?undefined:request.digest});}
  catch(error){db.message(id,'system','Gönderilmediği doğrulandı. Devam için kayıt işlemini kontrol et: '+error.message);}
 }
 // Old templates with explicit record workflow steps keep their own scheduler.
 for(const task of savedTasks.filter(t=>t.resumeRecordAfterAnswer&&!live.includes(t.state))){
  queue.put({...task,resumeRecordAfterAnswer:false});
  const item=db.result(id,task.recordId);
  if(!recordTask(db,id,item.id)&&!['completed','executing','dismissed'].includes(item.status)){
   try{resumeRecordOperation(runtime,id,item,task);}catch(error){db.message(id,'system','Yanıt kaydedildi. Kayıt işlemi: '+error.message);}
  }
 }
 const customRecordWorkflow=db.template(a.templateId).workflow.some(s=>s.scope==='record');
 if(!manualOnly&&a.status==='enabled'&&a.mode!=='observe'&&!customRecordWorkflow){
  const previous=queue.list(id),activeRecords=new Set(previous.filter(t=>live.includes(t.state)).flatMap(taskRecordIds));
  for(const item of db.results(id,{all:true})){
   // Scheduling needs source permissions, not the UI projection that loads
   // every result and run. Read those settings once with the workspace.
   if(a.sourceSettings?.[recordSource(a,item)]?.enabled===false||activeRecords.has(item.id))continue;
   const kind=item.status==='found'?'prepare':item.status==='prepared'?'execute':null;
   if(!kind||!ops[kind]||recordOperationError(a,item,kind,{now:runtime.now()}))continue;
   // Interrupted preparation may resume. Explicit cancellation requires a new
   // user request; starting a worker must not recreate a cleared queue.
   if(previous.some(t=>taskHasRecord(t,item.id)&&t.recordOperation===kind&&(t.stopRequested||t.request?.revision===a.revision&&t.recordVersion===(item.digest??String(item.updatedAt))&&!(kind==='prepare'&&t.state==='interrupted'))))continue;
   enqueueRecordOperation(runtime,id,item.id,kind,{manual:false});
   activeRecords.add(item.id);
  }
 }
 const pending=queue.list(id,{states:['pending']}).filter(t=>t.recordOperation&&(!t.retryAt||t.retryAt<=runtime.now())&&(t.request?.manual||!manualOnly&&a.status==='enabled')).sort((x,y)=>Number(Boolean(y.request?.manual))-Number(Boolean(x.request?.manual)));
 for(const worker of runtime.workers.list(id)){
  if(worker.enabled===false||runtime.active.has(workerKey(id,worker.id))||runtime.capacityUsed>=runtime.concurrency)continue;
  let task;
  while(pending.length){
   task=pending.shift();
   try{validateRecordTask(db,id,task,runtime.now());break;}catch(error){if(error.code!=='RECORD_QUESTION_PENDING'){queue.finish(id,task.id,'cancelled',error.message);runtime.changed(id);}task=null;}
  }
  if(!task)continue;
  void runtime.start(id,{kind:'run',taskId:task.id},worker.id).catch(()=>{});
 }
}

export function recordOperationState(db,id,item,{a=db.get(id),definition=db.template(a.templateId),tasks=db.store.workspaces.tasks.list(id)}={}){
 const task=tasks.find(t=>taskHasRecord(t,item.id)&&live.includes(t.state)),last=tasks.findLast(t=>taskHasRecord(t,item.id)&&t.recordOperation);
 const kind=item.status==='uncertain'?'verify':item.status==='prepared'&&item.revision===a.revision?'execute':['found','prepared'].includes(item.status)?'prepare':null;
 const operation=kind&&definition.recordOperations?.[kind];
 const error=operation?recordOperationError(a,item,kind,{manual:true,digest:item.digest,now:db.now()}):null;
 const directOp=['found','prepared'].includes(item.status)&&definition.recordOperations?.execute;
 const directError=directOp?recordOperationError(a,item,'execute',{manual:true,direct:true,now:db.now()}):null;
 const question=(a.questions??[]).find(q=>q.recordId===item.id&&q.answer==null);
 const scoreOp=['found','prepared'].includes(item.status)&&definition.recordOperations?.score;
 const scoreError=scoreOp?recordOperationError(a,item,'score',{manual:true}):null;
 const scoringComplete=recordScoredInTask(db,task??last,item);
 const scoreOperation=scoreOp?{kind:'score',label:item.assessment?'Yeniden puanla':scoreOp.label,disabled:Boolean(scoreError||task),reason:scoreError}:null;
 let retryOperation=null;
 if(!scoringComplete&&!task&&last&&(last.recordOperation!=='verify'||item.status==='uncertain')&&['blocked','failed','interrupted'].includes(last.state)&&!item.trial&&!['completed','executing','dismissed'].includes(item.status)){
  const retryKind=item.status==='uncertain'?'verify':last.recordOperation,direct=retryKind==='execute'&&last.request?.direct===true;
  if(definition.recordOperations?.[retryKind]){
   const reason=recordOperationError(a,item,retryKind,{manual:true,direct,digest:item.digest,now:db.now()});
   retryOperation={kind:retryKind,direct,review:retryKind==='execute'&&!direct,disabled:Boolean(reason),reason};
  }
 }
 return {scoringComplete,scoreOperation,retryOperation,directOperation:directOp?{kind:'execute',label:directOp.label,disabled:Boolean(directError||task),reason:directError}:null,question:question?{id:question.id,text:question.text}:null,lastTask:last&&!scoringComplete?{kind:last.recordOperation,state:last.state,summary:last.summary,at:last.finishedAt??last.startedAt??last.createdAt,...(last.toolFailure?{toolFailure:last.toolFailure}:{})}:null,task:task&&!scoringComplete?{id:task.id,kind:task.recordOperation,state:task.state,workerId:task.workerId,at:task.startedAt??task.createdAt,manual:task.request?.manual===true}:null,operation:operation?{kind,label:operation.label,reviewLabel:operation.reviewLabel,disabled:Boolean(error||task),reason:error}:null};
}
