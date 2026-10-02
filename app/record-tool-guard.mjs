import {createHash} from 'node:crypto';
import {jobUrlKey} from './job-urls.mjs';

const LIMIT=3;
const operationNames={score:'Puanlama',prepare:'Hazırlama',execute:'Uygulama',verify:'Doğrulama'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const category=message=>/arguments[.:\[]/.test(message)?'arguments':/Serbest toplam|scorecard|alıntısı|candidateQuote|listingQuote/.test(message)?'scorecard':/Sayfa gözlemi eski/.test(message)?'snapshot':null;
const recoveryHint=kind=>kind==='arguments'?'Listelenen tüm alan hatalarını tek çağrıda düzelt; diğer geçerli alanları koruyarak tam argümanları yeniden gönder. Bu hata için sayfayı tekrar okuman gerekmez.':kind==='scorecard'?'Güncel araç şemasını ve scoringPolicy bölümünü kullan; eksik alanları tek seferde düzelt.':kind==='snapshot'?'Güncel bağlamdaki savedListing veya son snapshot.id ile devam et; kayıtlı metin yoksa browser_read kullan.':'Hata nedenini düzeltmeden aynı işlemi yineleme.';
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
  const kind=category(message),failureKey=kind?hash(name+'\n'+kind):key;
  const task=queue.get(id,run.taskId),failures={...task.toolFailures},count=(failures[failureKey]?.count??0)+1;
  failures[failureKey]={operation,tool:name,message,count,category:kind};
  let summary;
  queue.atomic(()=>{
   queue.put({...task,toolFailures:failures});
   if(count>=LIMIT){
    const failure={tool:name,message,count,runId:run.id,at:db.now()};
    summary=`${operationNames[run.recordOperation]??(run.sourceUrl?'Kaynak taraması':'Kayıt işlemi')} durduruldu: aynı işlem ${LIMIT} kez aynı hata türüyle başarısız oldu. Son hata: ${message}`;
    queue.put({...queue.get(id,run.taskId),toolFailure:failure});
    db.putRun({...db.run(run.id),toolFailure:failure,stop:{kind:'technical',evidence:message}});
    db.message(id,'system',summary,{runId:run.id,recordId:run.recordId});
   }
  });
  if(summary){report(id,run.id,'blocked',summary,false);changed(id);return summary+' Görev durduruldu; başka araç çağırma.';}
  return `${message}\nAynı işlem aynı hata türüyle ${count}/${LIMIT} kez başarısız oldu. ${recoveryHint(kind)} Üçüncü hatada görev otomatik durdurulur.`;
 };
 const call=async(name,args,execute)=>{
  name=typeof name==='string'?name:'unknown';
  const active=db.run(run.id),task=queue.get(id,run.taskId);
  if(task.toolFailure)throw Error('Tekrarlanan hata nedeniyle görev durduruldu. Kaynak veya kayıt görevindeki hata açıklamasını kontrol et.');
  if(active.status!=='running')throw Error('Görev artık çalışmıyor.');
  const operation=operationKey(active,name,args);
  let value;
  try{value=await execute();}
  catch(error){
   if(['JEV_REVIEW_REQUIRED','JEV_WORK_REMAINS'].includes(error?.code))throw error;
   // DOMException.message is read-only. Keep its cause/code without masking
   // the actual timeout or transport failure with an assignment TypeError.
   const wrapped=new Error(saveFailure(name,operation,error instanceof Error?error:Error(String(error))),{cause:error});
   for(const key of ['code','validationPath','validationIssues','siteWait','wait','url'])if(error?.[key]!==undefined)Object.defineProperty(wrapped,key,{value:error[key],enumerable:true});
   throw wrapped;
  }
  // A rejected submission proof carries a fresh snapshot for recovery rather
  // than throwing. It is still a failed save and must obey the same limit.
  if(value?.status==='evidence_rejected'&&value.saved===false)return {...value,message:saveFailure(name,operation,Error(value.error))};
  if(value?.status==='running')return value;
  const latest=queue.get(id,run.taskId),failures=latest.toolFailures;
  if(failures)queue.put({...latest,toolFailures:Object.fromEntries(Object.entries(failures).filter(([,f])=>f.operation!==operation&&!(f.category&&f.tool===name)))});
  return value;
 };
 // Serialize this record's MCP calls: parallel retries must not execute a
 // fourth failing operation before the third response closes the worker.
 return (name,args,execute)=>{
  const next=pending.then(()=>call(name,args,execute));pending=next.catch(()=>{});return next;
 };
}
