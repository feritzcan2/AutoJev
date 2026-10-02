import {taskRecordIds,recordScoredInTask} from './record-task-scope.mjs';
// Reconnect shutdowns and the former app-generated unreported scoring failure.
// User stops and actual tool/provider failures are never revived.
const shutdownMessages=new Set(['Uygulama kapatıldı.','Uygulama kapandı. Kaydedilen sonuçlar korunuyor.','Önceki uygulama oturumu kapandı']);
export function recoverRecordOperations(db){
 const queue=db.store.workspaces.tasks;
 for(const a of db.list()){
  const latest=new Map();for(const task of queue.list(a.id))if(task.recordId&&task.recordOperation)for(const itemId of taskRecordIds(task))latest.set(itemId,task);
  for(const task of new Set(latest.values())){
   if(taskRecordIds(task).some(itemId=>latest.get(itemId)?.id!==task.id))continue;
   if(task.stopRequested||task.toolFailure)continue;
   const unreportedScore=task.recordOperation==='score'&&task.state==='failed'&&['Agent sonuç bildirmeden durdu. Agent ekranını kontrol et.','Agent oturumu sonuç bildirmeden kapandı.'].includes(task.summary);
   if(unreportedScore){
    if(task.request?.revision!==a.revision||(task.scoreRecovery?.attempt??0)>=3||!task.request?.manual&&a.status!=='enabled')continue;
    const items=taskRecordIds(task).map(itemId=>db.result(a.id,itemId));
    if(items.some(item=>item.trial||!['found','prepared'].includes(item.status)))continue;
    const remaining=items.filter(item=>!recordScoredInTask(db,task,item));
    if(!remaining.length){queue.finish(a.id,task.id,'completed','Bütün puanlar kaydedilmiş; tamamlanma durumu düzeltildi.');continue;}
    queue.put({...task,state:'pending',workerId:null,completionState:null,summary:`Kaydedilen puanlar korundu; kalan ${remaining.length} kayıttan devam edecek.`,recoveredAt:db.now()});
    continue;
   }
   if(task.state!=='interrupted'||!shutdownMessages.has(task.summary))continue;
   const item=db.result(a.id,task.recordId);if(['completed','dismissed'].includes(item.status))continue;
   const kind=item.status==='uncertain'?'verify':task.recordOperation,op=db.template(a.templateId).recordOperations?.[kind];if(!op)continue;
   queue.put({...task,state:'pending',workerId:null,completionState:null,recordOperation:kind,operation:op.id,capability:op.capability,
    request:kind==='verify'?{manual:true,revision:a.revision,at:db.now()}:task.request,
    summary:'Uygulama kapanırken yarım kaldı. Tarayıcı bağlandığında devam edecek.',recoveredAt:db.now()});
  }
 }
}
