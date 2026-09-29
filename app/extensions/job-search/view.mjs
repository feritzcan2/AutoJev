export function applicationWorkerView(worker,snapshot){
 const campaign=worker.campaign,task=campaign?.task;
 const record=snapshot.jobs?.find(job=>job.id===task?.jobId),origin=snapshot.sources?.find(source=>source.id===task?.sourceId);
 return {...worker,execution:{status:campaign?.status??'idle',task:task??null,note:campaign?.note},presentation:{
  title:task?.kind==='search'?`${origin?.name??'Kaynak'} taranıyor`:record?`${record.company} · ${record.role}`:campaign?.status==='running'?'Sıradaki görev bekleniyor':'Arama, puanlama ve başvuru',
  detail:task?({search:'İlan arama',rank:'İlan puanlama',application:'Başvuru',preparation:'Başvuru hazırlığı',verify:'Gönderim kontrolü'}[task.kind]):campaign?.note??'Başlatıldığında uygun işi kuyruktan alır.'
 }};
}
