import {browserWaitView} from './browser-status.js';
const runtimeNames={Working:'Çalışıyor',AwaitingInput:'Giriş / onay bekliyor',Idle:'Tur tamamlandı',Compacting:'Konuşma özetleniyor',Failed:'Agent hatası',Interrupted:'Kesildi',Unknown:'Durum bekleniyor'};
export function isQuestionRetryPending(snapshot,jobId){
 const worker=snapshot?.workers?.find(w=>w.campaign?.task?.jobId===jobId);
 const campaign=worker?.campaign??snapshot?.campaign;
 return Boolean(jobId&&campaign?.status==='running'&&(!campaign.failures||campaign.task)&&!campaign.waitingReason&&campaign.pendingRecoveries?.[jobId]);
}
export function pendingQuestions(snapshot){
 const jobs=new Map((snapshot?.jobs??[]).map(job=>[job.id,job]));
 return (snapshot?.questions??[]).filter(q=>q.answer===null&&(!q.jobId||!['submitted','already_submitted','skipped'].includes(jobs.get(q.jobId)?.status))&&!isQuestionRetryPending(snapshot,q.jobId));
}
export function sourceResultView(source,campaign){
  const scanning=campaign?.status==='running'&&(campaign.tasks??[campaign.task]).some(task=>task?.kind==='search'&&task.sourceId===source.id&&task.seenWorking===true);
  if(scanning)return{title:'Taranıyor',detail:'Agent şu anda bu kaynağı tarıyor.',scanning:true};
  return{title:source.lastRunAt?(source.lastFound?`${source.lastFound} yeni ilan`:'Yeni ilan yok'):'Taranmayı bekliyor',detail:source.lastResult,scanning:false};
}
export function activityView(snapshot,now=Date.now()){
  const campaign=snapshot?.campaign,task=campaign?.task;
  const active=snapshot?.active&&snapshot.active.candidateId===snapshot?.profile?.id?snapshot.active:null;
  const events=snapshot?.events??[];
  let report=active?events.find(e=>e.kind==='agent_activity'&&e.data.sessionId===active.sessionId&&(!task||e.data.taskId===task.id)):null;
  if(!report&&active&&task?.jobId){const update=events.find(e=>e.kind==='job_updated'&&e.data.id===task.jobId&&e.data.sessionId===active.sessionId&&Date.parse(e.at)>=task.createdAt);if(update)report={...update,data:{...update.data,jobId:update.data.id,message:update.data.note}};}
  const job=snapshot?.jobs?.find(j=>j.id===(report?.data.jobId??task?.jobId));
  const source=snapshot?.sources?.find(item=>item.id===task?.sourceId);
  const question=pendingQuestions(snapshot).find(q=>!task||!q.jobId||q.jobId===task.jobId);
  let title='Agent kapalı',detail='Başlamak için aday profilini ve agent ayarlarını seç.',tone='neutral';
  const browserWait=browserWaitView(snapshot);
  if(browserWait){title=browserWait.title;detail=browserWait.detail;tone='waiting';}
  else if(campaign?.status==='complete'){title='Hedef tamamlandı';detail=campaign.note;}
  else if(campaign?.status==='paused'||campaign?.status==='stopped'){title=campaign.status==='paused'?'Duraklatıldı':'Durduruldu';detail=campaign.note;}
  else if(active&&task){
    title=job?`${job.company} · ${job.role}`:task.kind==='search'?(source?`${source.name} taranıyor`:'Uygun ilanlar araştırılıyor'):'Başvuru üzerinde çalışılıyor';
    detail=report?.data.message??(task.kind==='verify'?'Önceki gönderimin sonucu doğrulanacak.':task.seenWorking?'Agent henüz ayrıntılı işlem bildirmedi.':'İş agent’a iletiliyor.');tone='active';
    if(!task.seenWorking||active.state==='Idle'){title=task.seenWorking?'Tur sonucu bekleniyor':'Görevin başlaması bekleniyor';detail=task.seenWorking?'Agent hazır; görev sonucu henüz kapanmadı.':'Görev kuyruğa alındı; agentın çalışmaya başladığı henüz doğrulanmadı.';tone='waiting';}
    if(active.state==='AwaitingInput'){detail='Agent terminalde giriş veya onay bekliyor.';tone='waiting';}
    else if(active.state==='Compacting')detail='Agent konuşmasını özetliyor; yeni işlem bildirimi bekleniyor.';
    else if(active.state==='Failed'||active.state==='Interrupted'){detail=runtimeNames[active.state];tone='waiting';}
  }else if(question&&campaign?.status==='running'){title='Yanıtın bekleniyor';detail=question.question;tone='waiting';}
  else if(campaign?.status==='running'){
    const next=Math.max(campaign.wakeAt??0,campaign.nextSearchAt??0);
    title=campaign.waitingReason==='source_apply_mode'?'Kaynaklar sadece bul modunda':campaign.waitingReason==='no_enabled_sources'?'Arama kaynakları kapalı':next>now?`Sonraki kontrol ${new Date(next).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'})}`:'Sıradaki iş hazırlanıyor';detail=campaign.note;tone='waiting';
  }else if(active){title=runtimeNames[active.state]??'Agent bağlı';detail=report?.data.message??'Ayrıntıları terminalden takip edebilirsin.';}
  return{title,detail,tone,url:job?.url??null,state:browserWait?'Chrome bekleniyor':active?(runtimeNames[active.state]??'Bağlı'):campaign?.status==='running'?'Bekliyor':'Agent kapalı',at:report?.at??null,lastReport:report?.data.message??null,canWrite:Boolean(active),canPause:campaign?.status==='running',history:events.filter(e=>['agent_activity','job_found','job_updated','submission_recorded','question_asked','question_answered','agent_context_restart'].includes(e.kind)).slice(0,8)};
}
export function ageLabel(at,now=Date.now()){
  if(!at)return 'Henüz işlem bildirimi yok';
  const seconds=Math.max(0,Math.floor((now-Date.parse(at))/1000));
  if(!Number.isFinite(seconds))return 'Güncelleme zamanı bilinmiyor';
  return `Son bildirim: ${seconds<60?seconds+' saniye':seconds<3600?Math.floor(seconds/60)+' dakika':Math.floor(seconds/3600)+' saat'} önce`;
}

export function workerActivityView(snapshot,worker,now=Date.now()){
 const task=worker.campaign?.task,session=worker.active?.sessionId;
 const events=(snapshot?.events??[]).filter(event=>{
  const data=event.data??{};
  if(data.workerId)return data.workerId===worker.id;
  if(data.sessionId&&snapshot.workers?.some(w=>w.active?.sessionId===data.sessionId))return data.sessionId===session;
  if(data.jobId&&task?.jobId===data.jobId)return true;
  return worker.id==='main';
 });
 return activityView({...snapshot,workers:undefined,campaign:worker.campaign,active:worker.active,events,questions:(snapshot?.questions??[]).filter(q=>task?.jobId&&q.jobId===task.jobId)},now);
}

export function applicationActivity(snapshot,jobId){
 const worker=snapshot?.workers?.find(w=>w.campaign?.task?.jobId===jobId);
 if(worker){const activity=applicationActivity({...snapshot,workers:undefined,campaign:worker.campaign,active:worker.active},jobId);return activity?{...activity,workerId:worker.id,workerName:worker.name,kind:worker.campaign.task.kind}:null;}
 const {campaign,active,profile}=snapshot??{};
 if(campaign?.status!=='running'||campaign.task?.jobId!==jobId||!active||active.candidateId!==profile?.id)return null;
 if(active.state==='Working')return{kind:campaign.task.kind,tone:'active',label:campaign.task.kind==='rank'?'Agent ilanı puanlıyor':campaign.task.kind==='preparation'?'Agent başvuru paketini hazırlıyor':'Agent bu başvuruda çalışıyor'};
 if(active.state==='Compacting')return{tone:'waiting',label:'Agent konuşmasını özetliyor'};
 if(active.state==='AwaitingInput')return{tone:'waiting',label:'Agent giriş / onay bekliyor'};
 if(active.state==='Idle')return{tone:'waiting',label:campaign.task.seenWorking?'Tur sonucu bekleniyor':'Agentın başlaması bekleniyor'};
 return null;
}
