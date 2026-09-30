import {sourceMode} from './automation-sources.mjs';
import {automationTrialReady} from './automation-trial.mjs';
import {workerKey} from './worker-key.mjs';

const live=['pending','running','reported','paused'];
export function recordSource(a,item){return item.sourceUrl??a.sources.find(url=>new URL(url).origin===new URL(item.url).origin)??null;}
export function recordTask(db,id,itemId){return db.store.workspaces.tasks.list(id,{states:live}).find(t=>t.recordId===itemId);}
export function recordOperationError(a,item,kind,{manual=false,digest,now=Date.now()}={}){
 if(item.trial)return 'Araştırma örneği üzerinde işlem yapılamaz';
 if(kind==='verify')return item.status==='uncertain'?null:'Yalnızca sonucu belirsiz bir işlem doğrulanabilir';
 if(['completed','executing','uncertain','dismissed'].includes(item.status))return 'Bu kayıt yeniden gönderilemez';
 if(a.reviewedRevision!==a.revision||!automationTrialReady(a))return 'Önce kurulumu kontrol edip denemeyi çalıştır veya geç';
 if(a.endAt&&a.endAt<=now)return 'Otomasyonun bitiş tarihi geçti';
 if((a.questions??[]).some(q=>q.answer==null&&(!q.recordId||q.recordId===item.id)))return 'Önce bu kayıt için bekleyen soruları yanıtla';
 const mode=sourceMode(a,recordSource(a,item));
 if(!manual&&mode==='observe')return 'Kaynak yalnızca bul modunda';
 if(kind==='prepare')return null;
 if(kind!=='execute')return 'Bilinmeyen kayıt işlemi';
 if(item.status!=='prepared'||!item.proposal||item.revision!==a.revision)return 'Önce güncel işlem taslağını hazırla';
 if(manual&&digest!==item.digest)return 'Taslak değişti; güncel içeriği yeniden incele';
 if(!manual&&(mode!=='auto'||item.requiresReview)&&item.approvedDigest!==item.digest)return 'İşlem onay bekliyor';
 return null;
}

export function enqueueRecordOperation(runtime,id,itemId,kind,{manual=true,digest}={}){
 const {db,queue}=runtime;
 const wake=task=>{
  // Explicit preparation requests use the existing worker pool. Background
  // ticks still respect workers the user stopped; no new workers are created.
  if(manual&&task.state==='pending'){
   const workers=runtime.workers.list(id);
   if(kind==='prepare'){
    const pending=queue.list(id,{states:['pending']}).filter(t=>t.recordOperation==='prepare'&&(t.request?.manual||db.get(id).status==='enabled')).filter(t=>{try{validateRecordTask(db,id,t,runtime.now());return true;}catch{return false;}});
    let needed=pending.length-workers.filter(w=>w.enabled!==false&&!runtime.active.has(workerKey(id,w.id))).length;
    for(const worker of workers){if(needed<=0)break;if(worker.enabled===false&&!runtime.active.has(workerKey(id,worker.id))){runtime.workers.setEnabled(id,worker.id,true);needed--;runtime.changed(id);}}
   }else if(!workers.some(w=>w.enabled!==false)){runtime.workers.setEnabled(id,'main',true);runtime.changed(id);}
  }
  return task;
 };
 return queue.atomic(()=>{
  const a=db.get(id),item=db.result(id,itemId),op=db.template(a.templateId).recordOperations?.[kind];
  if(!op)throw Error('Template bu kayıt işlemini desteklemiyor');
  const error=recordOperationError(a,item,kind,{manual,digest,now:runtime.now()});if(error)throw Error(error);
  const existing=recordTask(db,id,itemId);
  if(existing){if(existing.recordOperation===kind&&(!digest||existing.request?.digest===digest)){
   if(manual&&existing.state==='pending'&&!existing.request?.manual){const promoted=queue.put({...existing,request:{...existing.request,manual:true,at:runtime.now()}});runtime.changed(id);return wake(promoted);}
   return wake(existing);
  }throw Error('Bu kayıt için başka bir görev zaten sırada veya çalışıyor');}
  const sourceUrl=recordSource(a,item),request={manual,revision:a.revision,...(kind==='execute'?{digest:item.digest}:{}),at:runtime.now()};
  const task=queue.enqueue(id,{recordOperation:kind,operation:op.id,capability:op.capability,recordId:item.id,subject:item.id,sourceUrl,sources:[item.url],lockKey:'record:'+item.id,request,recordVersion:item.digest??String(item.updatedAt)});
  db.event(id,'record_operation_queued',{itemId,kind,taskId:task.id,manual});runtime.changed(id);return wake(task);
 });
}

export function validateRecordTask(db,id,task,now){
 if(!task.recordOperation)return;
 const a=db.get(id),item=db.result(id,task.recordId),request=task.request??{};
 if(request.revision!==a.revision&&task.recordOperation!=='verify')throw Error('Görev sıradayken kurulum değişti; işlemi yeniden hazırla');
 const error=recordOperationError(a,item,task.recordOperation,{manual:request.manual,digest:request.digest,now});if(error)throw Error(error);
}

export async function dispatchRecordOperations(runtime,id){
 const {db,queue}=runtime,a=db.get(id),ops=db.template(a.templateId).recordOperations;
 if(!ops||runtime.slots(id).some(s=>s.run.kind!=='run'))return;
 // Old templates with explicit record workflow steps keep their own scheduler.
 for(const task of queue.list(id).filter(t=>t.resumeRecordAfterAnswer&&!live.includes(t.state))){
  queue.put({...task,resumeRecordAfterAnswer:false});
  const item=db.result(id,task.recordId);
  if(!recordTask(db,id,item.id)&&!['completed','executing','dismissed'].includes(item.status)){
   try{enqueueRecordOperation(runtime,id,item.id,item.status==='uncertain'?'verify':'prepare');}catch(error){db.message(id,'system','Yanıt kaydedildi. Kayıt işlemi: '+error.message);}
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
   // Do not repeat a failed attempt or repeatedly prepare unchanged findings.
   if(previous.some(t=>t.recordId===item.id&&t.recordOperation===kind&&t.request?.revision===a.revision&&t.recordVersion===(item.digest??String(item.updatedAt))))continue;
   enqueueRecordOperation(runtime,id,item.id,kind,{manual:false});
   activeRecords.add(item.id);
  }
 }
 const pending=queue.list(id,{states:['pending']}).filter(t=>t.recordOperation&&(t.request?.manual||a.status==='enabled')).sort((x,y)=>Number(Boolean(y.request?.manual))-Number(Boolean(x.request?.manual)));
 for(const worker of runtime.workers.list(id)){
  if(worker.enabled===false||runtime.active.has(workerKey(id,worker.id))||runtime.active.size>=runtime.concurrency)continue;
  let task;
  while((task=pending.shift())){
   try{validateRecordTask(db,id,task,runtime.now());break;}catch(error){queue.finish(id,task.id,'cancelled',error.message);runtime.changed(id);task=null;}
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
 const question=(a.questions??[]).find(q=>q.recordId===item.id&&q.answer==null);
 return {question:question?{id:question.id,text:question.text}:null,lastTask:last?{kind:last.recordOperation,state:last.state,summary:last.summary,at:last.finishedAt??last.startedAt??last.createdAt}:null,task:task?{id:task.id,kind:task.recordOperation,state:task.state,workerId:task.workerId,at:task.startedAt??task.createdAt,manual:task.request?.manual===true}:null,operation:operation?{kind,label:operation.label,reviewLabel:operation.reviewLabel,disabled:Boolean(error||task),reason:error}:null};
}
