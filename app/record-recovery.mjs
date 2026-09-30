// Reconnect only work interrupted by app shutdown. User stops and failed
// attempts retain their own retry policy; an attempted write becomes verify.
const shutdownMessages=new Set(['Uygulama kapatıldı.','Uygulama kapandı. Kaydedilen sonuçlar korunuyor.','Önceki uygulama oturumu kapandı']);
export function recoverRecordOperations(db){
 const queue=db.store.workspaces.tasks;
 for(const a of db.list()){
  const latest=new Map();for(const task of queue.list(a.id))if(task.recordId&&task.recordOperation)latest.set(task.recordId,task);
  for(const task of latest.values()){
   if(task.state!=='interrupted'||task.stopRequested||!shutdownMessages.has(task.summary))continue;
   const item=db.result(a.id,task.recordId);if(['completed','dismissed'].includes(item.status))continue;
   const kind=item.status==='uncertain'?'verify':task.recordOperation,op=db.template(a.templateId).recordOperations?.[kind];if(!op)continue;
   queue.put({...task,state:'pending',workerId:null,completionState:null,recordOperation:kind,operation:op.id,capability:op.capability,
    request:kind==='verify'?{manual:true,revision:a.revision,at:db.now()}:task.request,
    summary:'Uygulama kapanırken yarım kaldı. Tarayıcı bağlandığında devam edecek.',recoveredAt:db.now()});
  }
 }
}
