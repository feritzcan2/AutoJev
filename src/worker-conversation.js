// One worker’s transcript, built from saved records rather than terminal bytes.
// Web workspaces keep a message table; job workspaces keep prompts and events.
const runKinds={interview:'Görüşme',trial:'Deneme',run:'Çalışma'};
const runStatuses={running:'Çalışıyor',completed:'Tamamlandı',partial:'Kısmi',blocked:'Engellendi',failed:'Başarısız',timeout:'Süre doldu',stopped:'Durduruldu',interrupted:'Kesildi'};
const time=value=>Number.isFinite(Date.parse(value))?Date.parse(value):0;
const entry=(id,role,text,at,extra={})=>({id,role,text:String(text??'').trim(),at:at??null,...extra});

function jobEvent(event,worker,snapshot){
 const d=event.data??{},session=worker.active?.sessionId;
 const mine=d.workerId?d.workerId===worker.id:d.sessionId?d.sessionId===session:worker.id==='main';
 if(!mine)return null;
 const id=`event:${event.seq}`;
 switch(event.kind){
  case 'agent_activity':return d.message?entry(id,'agent',d.message,event.at):null;
  case 'question_asked':{const open=(snapshot.questions??[]).find(q=>q.question===d.question);return entry(id,'agent',d.question,event.at,{label:'Soru',pending:open?open.answer===null:true});}
  case 'question_answered':return entry(id,'user',d.answer??'Yanıt kaydedildi',event.at,{label:'Yanıt'});
  case 'job_found':return entry(id,'system',`${d.company} · ${d.role}: ilan bulundu`,event.at,{label:'Bulundu'});
  case 'job_updated':return entry(id,'system',`${d.company}: ${d.note??d.status}`,event.at,{label:'Güncelleme'});
  case 'submission_recorded':return entry(id,'system',`${d.company}: gönderim onayı kaydedildi`,event.at,{label:'Gönderim'});
  case 'agent_context_restart':return entry(id,'system',`Context eşiği aşıldı${d.peakPercent==null?'':` (%${d.peakPercent.toLocaleString('tr-TR',{maximumFractionDigits:1})})`}; yeni oturum hazırlanıyor`,event.at,{label:'Oturum'});
  default:return null;
 }
}

// `transcript` carries the provider’s own conversation records for this worker.
export function workerConversation(snapshot,worker,transcript=[]){
 if(!snapshot||!worker)return [];
 const entries=transcript.map(m=>entry(`native:${m.id}`,m.role,m.text,m.at,m.role==='task'?{label:'Görev'}:{})),native=new Set(entries.map(e=>e.text));
 if(snapshot.automation){
  // The setup conversation belongs to the workspace and runs on the main worker; extra workers only carry their own runs.
  if(worker.id==='main')for(const m of snapshot.messages??[]){const document=m.role==='system'?/^Kullanıcı bir belge ekledi: \S+ \((.+?)\)\./.exec(m.text):null;entries.push(document?entry(`message:${m.id}`,'system',`Belge eklendi: ${document[1]}`,m.at,{label:'Belge'}):entry(`message:${m.id}`,m.role==='assistant'?'agent':m.role==='user'?'user':'system',m.text,m.at));}
  // A run still in progress is described by the task strip above; only finished turns become records.
  for(const run of snapshot.runs??[])if((run.workerId??'main')===worker.id&&run.summary&&run.status!=='running')entries.push(entry(`run:${run.id}`,'system',`${runKinds[run.kind]??run.kind} · ${run.summary}`,run.finishedAt??run.startedAt,{label:runStatuses[run.status]??run.status}));
 }else{
  const session=worker.active?.sessionId??null;
  for(const p of snapshot.prompts??[]){
   if(p.kind!=='message')continue;
   const mine=p.sessionId?p.sessionId===session:worker.id==='main';
   // Job workspaces only send app-generated task prompts; the provider transcript already carries them when available.
   if(mine&&!native.has(String(p.text).trim()))entries.push(entry(`prompt:${p.seq}`,'task',p.text,p.at,{label:'Görev'}));
  }
  for(const event of snapshot.events??[]){const item=jobEvent(event,worker,snapshot);if(item)entries.push(item);}
 }
 return entries.filter(e=>e.text).sort((a,b)=>time(a.at)-time(b.at)||a.id.localeCompare(b.id));
}

export const conversationSignature=entries=>entries.map(e=>`${e.id}\u0001${e.role}\u0001${e.text}\u0001${e.label??''}\u0001${e.pending?1:0}`).join('\u0002');
