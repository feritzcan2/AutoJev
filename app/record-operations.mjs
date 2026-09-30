import {sourceMode} from './automation-sources.mjs';
import {automationReady} from './automation-trial.mjs';
import {workerKey} from './worker-key.mjs';

const live=['pending','running','reported','paused'];
const waitingForAnswer='Önce bu kayıt için bekleyen soruları yanıtla';
export function recordSource(a,item){return item.sourceUrl??a.sources.find(url=>new URL(url).origin===new URL(item.url).origin)??null;}
export function pendingRecordQuestion(a,item){return (a.questions??[]).find(q=>q.answer==null&&(q.recordId?q.recordId===item.id:!q.sourceUrl||q.sourceUrl===recordSource(a,item)));}
export function recordTask(db,id,itemId){return db.store.workspaces.tasks.list(id,{states:live}).find(t=>t.recordId===itemId);}
export function recordOperationError(a,item,kind,{manual=false,digest,direct=false,now=Date.now()}={}){
 if(item.trial)return 'Araştırma örneği üzerinde işlem yapılamaz';
 if(kind==='verify')return item.status==='uncertain'?null:'Yalnızca sonucu belirsiz bir işlem doğrulanabilir';
 if(['completed','executing','uncertain','dismissed'].includes(item.status))return 'Bu kayıt yeniden gönderilemez';
 if(!automationReady(a))return 'Önce kurulumu kontrol edip kaydet';
 if(pendingRecordQuestion(a,item))return waitingForAnswer;
 const mode=sourceMode(a,recordSource(a,item));
 if(!manual&&mode==='observe')return 'Kaynak yalnızca bul modunda';
 if(kind==='prepare')return null;
 if(kind!=='execute')return 'Bilinmeyen kayıt işlemi';
 if(direct===true)return manual===true?null:'Doğrudan işlem için kullanıcı isteği gerekli';
 if(item.status!=='prepared'||!item.proposal||item.revision!==a.revision)return 'Önce güncel işlem taslağını hazırla';
 if(manual&&digest!==item.digest)return 'Taslak değişti; güncel içeriği yeniden incele';
 if(!manual&&(mode!=='auto'||item.requiresReview)&&item.approvedDigest!==item.digest)return 'İşlem onay bekliyor';
 return null;
}

export function enqueueRecordOperation(runtime,id,itemId,kind,{manual=true,digest,direct=false}={}){
 const {db,queue}=runtime;
 const wake=task=>{
  // Explicit preparation requests use the existing worker pool. Background
  // ticks still respect workers the user stopped; no new workers are created.
  if(manual&&task.state==='pending'){
   const workers=runtime.workers.list(id);
   if(kind==='prepare'||kind==='execute'&&direct===true){
    const pending=queue.list(id,{states:['pending']}).filter(t=>(t.recordOperation==='prepare'||t.recordOperation==='execute'&&t.request?.direct===true)&&(t.request?.manual||db.get(id).status==='enabled')).filter(t=>{try{validateRecordTask(db,id,t,runtime.now());return true;}catch{return false;}});
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
  if(existing){if(existing.recordOperation===kind&&(existing.request?.direct===true)===(direct===true)&&(!digest||existing.request?.digest===digest)){
   if(manual&&existing.state==='pending'&&!existing.request?.manual)return queue.put({...existing,request:{...existing.request,manual:true,at:runtime.now()}});
   return existing;
  }throw Error('Bu kayıt için başka bir görev zaten sırada veya çalışıyor');}
  const sourceUrl=recordSource(a,item),request={manual,revision:a.revision,...(kind==='execute'?(direct===true?{direct:true}:{digest:item.digest}):{}),at:runtime.now()};
  const task=queue.enqueue(id,{recordOperation:kind,operation:op.id,capability:op.capability,recordId:item.id,subject:item.id,sourceUrl,sources:[item.url],lockKey:'record:'+item.id,request,recordVersion:item.digest??String(item.updatedAt)});
  db.event(id,'record_operation_queued',{itemId,kind,taskId:task.id,manual});return task;
 });
 wake(task);runtime.changed(id);return task;
}

export function validateRecordTask(db,id,task,now){
 if(!task.recordOperation)return;
 const a=db.get(id),item=db.result(id,task.recordId),request=task.request??{};
 if(request.revision!==a.revision&&task.recordOperation!=='verify')throw Error('Görev sıradayken kurulum değişti; işlemi yeniden hazırla');
 const error=recordOperationError(a,item,task.recordOperation,{manual:request.manual,digest:request.digest,direct:request.direct,now});if(error)throw Object.assign(Error(error),error===waitingForAnswer?{code:'RECORD_QUESTION_PENDING'}:{});
}


// An answer supplies missing facts; only the original direct request can carry
// submission authority forward. Stops, cancellation and setup edits revoke it.
export function resumeRecordOperation(runtime,id,item,task){
 const direct=task?.recordOperation==='execute'&&task.request?.manual===true&&task.request?.direct===true&&task.request.revision===runtime.db.get(id).revision&&['completed','blocked'].includes(task.completionState??task.state);
 return enqueueRecordOperation(runtime,id,item.id,item.status==='uncertain'?'verify':direct?'execute':'prepare',{direct});
}

export async function dispatchRecordOperations(runtime,id){
 const {db,queue}=runtime,a=db.get(id),ops=db.template(a.templateId).recordOperations;
 if(!ops||runtime.slots(id).some(s=>s.run.kind!=='run'))return;
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
 if(a.status==='enabled'&&a.mode!=='observe'&&!customRecordWorkflow){
  const previous=queue.list(id),activeRecords=new Set(previous.filter(t=>live.includes(t.state)).map(t=>t.recordId));
  for(const item of db.results(id,{all:true})){
   // Scheduling needs source permissions, not the UI projection that loads
   // every result and run. Read those settings once with the workspace.
   if(a.sourceSettings?.[recordSource(a,item)]?.enabled===false||activeRecords.has(item.id))continue;
   const kind=item.status==='found'?'prepare':item.status==='prepared'?'execute':null;
   if(!kind||!ops[kind]||recordOperationError(a,item,kind,{now:runtime.now()}))continue;
   // Interrupted/cancelled preparation can resume without replaying an external
   // action. Completed, blocked and failed attempts still require new input.
   if(previous.some(t=>t.recordId===item.id&&t.recordOperation===kind&&t.request?.revision===a.revision&&t.recordVersion===(item.digest??String(item.updatedAt))&&!(kind==='prepare'&&['cancelled','interrupted'].includes(t.state))))continue;
   enqueueRecordOperation(runtime,id,item.id,kind,{manual:false});
   activeRecords.add(item.id);
  }
 }
 const pending=queue.list(id,{states:['pending']}).filter(t=>t.recordOperation&&(t.request?.manual||a.status==='enabled')).sort((x,y)=>Number(Boolean(y.request?.manual))-Number(Boolean(x.request?.manual)));
 for(const worker of runtime.workers.list(id)){
  if(worker.enabled===false||runtime.active.has(workerKey(id,worker.id))||runtime.active.size>=runtime.concurrency)continue;
  let task;
  while((task=pending.shift())){
   try{validateRecordTask(db,id,task,runtime.now());break;}catch(error){if(error.code!=='RECORD_QUESTION_PENDING'){queue.finish(id,task.id,'cancelled',error.message);runtime.changed(id);}task=null;}
  }
  if(!task)break;
  void runtime.start(id,{kind:'run',taskId:task.id},worker.id).catch(()=>{});
 }
}

export function recordOperationState(db,id,item,{a=db.get(id),definition=db.template(a.templateId),tasks=db.store.workspaces.tasks.list(id)}={}){
 const task=tasks.find(t=>t.recordId===item.id&&live.includes(t.state)),last=tasks.findLast(t=>t.recordId===item.id&&t.recordOperation);
 const kind=item.status==='uncertain'?'verify':item.status==='prepared'&&item.revision===a.revision?'execute':['found','prepared'].includes(item.status)?'prepare':null;
 const operation=kind&&definition.recordOperations?.[kind];
 const error=operation?recordOperationError(a,item,kind,{manual:true,digest:item.digest,now:db.now()}):null;
 const directOp=['found','prepared'].includes(item.status)&&definition.recordOperations?.execute;
 const directError=directOp?recordOperationError(a,item,'execute',{manual:true,direct:true,now:db.now()}):null;
 const question=(a.questions??[]).find(q=>q.recordId===item.id&&q.answer==null);
 let retryOperation=null;
 if(!task&&last&&['blocked','failed','interrupted'].includes(last.state)&&!item.trial&&!['completed','executing','dismissed'].includes(item.status)){
  const retryKind=item.status==='uncertain'?'verify':last.recordOperation,direct=retryKind==='execute'&&last.request?.direct===true;
  if(definition.recordOperations?.[retryKind]){
   const reason=recordOperationError(a,item,retryKind,{manual:true,direct,digest:item.digest,now:db.now()});
   retryOperation={kind:retryKind,direct,review:retryKind==='execute'&&!direct,disabled:Boolean(reason),reason};
  }
 }
 return {retryOperation,directOperation:directOp?{kind:'execute',label:directOp.label,disabled:Boolean(directError||task),reason:directError}:null,question:question?{id:question.id,text:question.text}:null,lastTask:last?{kind:last.recordOperation,state:last.state,summary:last.summary,at:last.finishedAt??last.startedAt??last.createdAt}:null,task:task?{id:task.id,kind:task.recordOperation,state:task.state,workerId:task.workerId,at:task.startedAt??task.createdAt,manual:task.request?.manual===true}:null,operation:operation?{kind,label:operation.label,reviewLabel:operation.reviewLabel,disabled:Boolean(error||task),reason:error}:null};
}
