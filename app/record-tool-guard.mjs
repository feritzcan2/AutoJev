import {createHash} from 'node:crypto';
import {jobUrlKey} from './job-urls.mjs';

const LIMIT=3;
const operationNames={score:'Puanlama',prepare:'Hazırlama',execute:'Uygulama',verify:'Doğrulama'};
const hash=value=>createHash('sha256').update(value).digest('hex');
function operationKey(run,name,args){
 let target=run.recordId;
 if(name.startsWith('browser_')){
  const url=args?.url??run.resumeContext?.url;
  if(url){try{target=jobUrlKey(url);}catch{target=String(url);}}
 }
 return hash(JSON.stringify([name,target,name==='browser_interact'?args?.action:null]));
}

// The task owns the counters, so rebuilding a workflow or resuming an
// interrupted run cannot reset them. Only this operation succeeding clears it.
export function recordToolGuard({db,run,report,changed}){
 const id=run.automationId,queue=db.store.workspaces.tasks;
 let pending=Promise.resolve();
 const saveFailure=(name,operation,error)=>{
  const active=db.run(run.id);if(active.status!=='running')return error.message;
  const message=String(error.message).trim().replace(/\s+/g,' ').slice(0,2000),key=hash(operation+'\n'+message);
  const task=queue.get(id,run.taskId),failures={...task.toolFailures},count=(failures[key]?.count??0)+1;
  failures[key]={operation,tool:name,message,count};
  let summary;
  queue.atomic(()=>{
   queue.put({...task,toolFailures:failures});
   if(count>=LIMIT){
    const failure={tool:name,message,count,runId:run.id,at:db.now()};
    summary=`${operationNames[run.recordOperation]??'Kayıt işlemi'} durduruldu: aynı işlem ${LIMIT} kez aynı hatayla başarısız oldu. Son hata: ${message}`;
    queue.put({...queue.get(id,run.taskId),toolFailure:failure});
    db.putRun({...db.run(run.id),toolFailure:failure});
    db.message(id,'system',summary,{runId:run.id,recordId:run.recordId});
   }
  });
  if(summary){report(id,run.id,'blocked',summary,false);changed(id);return summary+' Görev durduruldu; başka araç çağırma.';}
  return `${message}\nAynı işlem aynı hatayla ${count}/${LIMIT} kez başarısız oldu. Nedeni düzelt; üçüncü hatada görev otomatik durdurulur.`;
 };
 const call=async(name,args,execute)=>{
  name=typeof name==='string'?name:'unknown';
  const active=db.run(run.id),task=queue.get(id,run.taskId);
  if(task.toolFailure)throw Error('Tekrarlanan hata nedeniyle görev durduruldu. Sonuçlar tablosundan kaydı kontrol et.');
  if(active.status!=='running')throw Error('Görev artık çalışmıyor.');
  const operation=operationKey(active,name,args);
  let value;
  try{value=await execute();}
  catch(error){error.message=saveFailure(name,operation,error);throw error;}
  // A rejected submission proof carries a fresh snapshot for recovery rather
  // than throwing. It is still a failed save and must obey the same limit.
  if(value?.status==='evidence_rejected'&&value.saved===false)return {...value,message:saveFailure(name,operation,Error(value.error))};
  const latest=queue.get(id,run.taskId),failures=latest.toolFailures;
  if(failures&&Object.values(failures).some(f=>f.operation===operation))queue.put({...latest,toolFailures:Object.fromEntries(Object.entries(failures).filter(([,f])=>f.operation!==operation))});
  return value;
 };
 // Serialize this record's MCP calls: parallel retries must not execute a
 // fourth failing operation before the third response closes the worker.
 return (name,args,execute)=>{
  const next=pending.then(()=>call(name,args,execute));pending=next.catch(()=>{});return next;
 };
}
