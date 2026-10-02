const running={score:'Puanlanıyor',prepare:'Hazırlanıyor',execute:'Uygulanıyor',verify:'Doğrulanıyor'};
const queued={score:'Puanlama sırada',prepare:'Hazırlama sırada',execute:'Uygulama sırada',verify:'Doğrulama sırada'};
export function recordOperationStatus(record){
 const {task,lastTask,question}=record.recordAction??{};
 if(question)return {id:'waiting',label:'Yanıt bekliyor',tone:'blocked',detail:question.text,active:true};
 if(task){
  if(task.state==='paused')return {id:'paused',label:'İşlem durakladı',tone:'blocked',detail:'Agent görevini kontrol et.',active:true};
  if(task.state==='pending')return {id:'queued',label:queued[task.kind]??'İşlem sırada',tone:'queued',detail:task.manual?'Boşalan ilk agent bu kaydı alacak.':'Uygun agent bekleniyor.',active:true};
  if(task.state==='reported')return {id:'finishing',label:'İşlem sonlandırılıyor',tone:'running',detail:'Agent oturumu kapanıyor.',active:true};
  return {id:'working',label:running[task.kind]??'İşlem sürüyor',tone:'running',detail:'Agent bu kayıt üzerinde çalışıyor.',active:true};
 }
 if(lastTask&&lastTask.at>=record.updatedAt&&!['completed','uncertain','executing','dismissed'].includes(record.status)){
  const label={blocked:'İşlem engellendi',failed:'İşlem başarısız',interrupted:'İşlem kesildi',cancelled:'İşlem iptal edildi'}[lastTask.state];
  if(label)return {id:'stopped',label,tone:'blocked',detail:lastTask.summary,active:false};
 }
 return null;
}
export const recordActivityAt=record=>Math.max(record.updatedAt,record.recordAction?.task?.at??0,record.recordAction?.lastTask?.at??0);
export const recordIsWorking=record=>record.status!=='dismissed'&&!record.recordAction?.question&&['running','reported'].includes(record.recordAction?.task?.state);

export const recordNeedsAnswer=record=>record.status!=='dismissed'&&Boolean(record.recordAction?.question);


export function activeRecordOperations(snapshot){
 const counts=new Map(),seen=new Set();
 for(const slot of snapshot.activeRuns??(snapshot.activeRun?[snapshot.activeRun]:[])){
  const run=snapshot.runs?.find(r=>r.id===slot.id)??slot;
  if(seen.has(run.id)||run.status!=='running'||!run.recordId||!run.recordOperation)continue;
  const worker=snapshot.workers?.find(w=>w.id===(run.workerId??'main'));
  if(!worker?.active||worker.execution?.task?.id!==run.id)continue;
  const records=run.recordIds??[run.recordId],count=records.filter(id=>!snapshot.results?.find(r=>r.id===id)?.recordAction?.scoringComplete&&!snapshot.automation?.questions?.some(q=>q.recordId===id&&q.answer==null)).length;
  if(!count)continue;seen.add(run.id);counts.set(run.recordOperation,(counts.get(run.recordOperation)??0)+count);
 }
 return ['execute','prepare','score','verify'].filter(kind=>counts.has(kind)).map(kind=>({kind,count:counts.get(kind),label:(snapshot.definition?.recordOperations?.[kind]?.runningLabel??running[kind]).toLocaleLowerCase('tr-TR')}));
}
