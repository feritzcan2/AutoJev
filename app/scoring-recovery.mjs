import {taskRecordIds,recordScoredInTask} from './record-task-scope.mjs';

const MAX_CONTINUATIONS=3;
function state(db,id,runId){
 const run=db.run(runId);
 if(run.automationId!==id||run.recordOperation!=='score'||!run.taskId||run.status!=='running')return null;
 const a=db.get(id),task=db.store.workspaces.tasks.get(id,run.taskId);
 if(run.stopRequested||task.stopRequested||run.toolFailure||task.toolFailure||run.actionId||run.revision!==a.revision||a.profileUpdate)return null;
 const items=taskRecordIds(run).map(itemId=>db.result(id,itemId));
 if(items.some(item=>!['found','prepared'].includes(item.status)||item.trial))return null;
 const scored=items.filter(item=>recordScoredInTask(db,run,item));
 const waiting=items.filter(item=>!scored.includes(item)&&(a.questions??[]).some(q=>q.recordId===item.id&&q.answer==null));
 const remaining=items.filter(item=>!scored.includes(item)&&!waiting.includes(item));
 return {run,task,scored,waiting,remaining,total:items.length};
}
function advance(db,id,s,reason,requeue=false){
 const recovery={attempt:(s.task.scoreRecovery?.attempt??0)+1,runId:s.run.id,reason,requeue};
 db.store.workspaces.tasks.put({...s.task,scoreRecovery:recovery});
 return recovery;
}
const progress=s=>`${s.total} kaydın ${s.scored.length} puanı kaydedildi; ${s.remaining.length} kayıt kaldı${s.waiting.length?`, ${s.waiting.length} kayıt yanıt bekliyor`:''}.`;
export function continueScoringRun(db,id,runId){
 const s=state(db,id,runId);
 if(!s||!s.remaining.length||(s.task.scoreRecovery?.attempt??0)>=MAX_CONTINUATIONS)return null;
 advance(db,id,s,'idle');
 return {repeat:true,message:'The scoring task is unfinished. Continue in this same session; do not reread unchanged context or profile documents. '+
  `${s.scored.length} scores are already saved and must not be repeated. Score ONLY these remaining assigned records: `+
  JSON.stringify(s.remaining.map(item=>({itemId:item.id,url:item.url})))+
  '. Reuse available listing reads. If details cannot be retrieved, save score=null and status=unavailable, never a fabricated zero or mismatch. Preserve proposals and forms. After saving every remaining assessment call finish_automation_run. Records with pending questions are waiting for the user.'};
}
export function unreportedScoringRun(db,id,runId,reason){
 const s=state(db,id,runId);if(!s)return null;
 if(!s.remaining.length)return {status:'completed',summary:progress(s)};
 // A closed provider cannot receive a continuation. Requeue the same task;
 // durable scores identify completed records across provider sessions/restarts.
 if(reason==='exit'&&(s.task.scoreRecovery?.attempt??0)<MAX_CONTINUATIONS){
  advance(db,id,s,'exit',true);
  return {status:'interrupted',summary:progress(s)+' Agent oturumu kapandı; kalan kayıtlardan devam edilecek.'};
 }
 return {status:'blocked',summary:progress(s)+((s.task.scoreRecovery?.attempt??0)>=MAX_CONTINUATIONS?' Agent 3 otomatik devam denemesine rağmen görevi bitirmedi.':' Agent ile devam bağlantısı kurulamadı.')+' Kaydedilen puanlar korundu.'};
}
export function requeueScoringRun(db,run){
 if(run.recordOperation!=='score'||run.status!=='interrupted'||run.stopRequested)return false;
 const queue=db.store.workspaces.tasks,task=queue.get(run.automationId,run.taskId);
 if(task.stopRequested||task.toolFailure||task.scoreRecovery?.runId!==run.id||!task.scoreRecovery.requeue)return false;
 queue.put({...task,state:'pending',workerId:null,completionState:null,retryAt:db.now()+5000,scoreRecovery:{...task.scoreRecovery,requeue:false},summary:run.summary});
 return true;
}
