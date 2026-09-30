const running={prepare:'Hazırlanıyor',execute:'Uygulanıyor',verify:'Doğrulanıyor'};
const queued={prepare:'Hazırlama sırada',execute:'Uygulama sırada',verify:'Doğrulama sırada'};
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
