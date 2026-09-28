import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {documentPath} from './artifacts.mjs';

export const preparationHeld=job=>job?.preparation?.hold===true;
export const preparationAuthorized=(job,task)=>Boolean(preparationHeld(job)&&task?.kind==='preparation'&&task.jobId===job.id&&task.preparationRequestId===job.preparation.requestId);
export const preparationProfileKey=profile=>createHash('sha256').update(JSON.stringify([profile.name,profile.facts,profile.preferences,profile.cvPath,profile.cvRevision])).digest('hex');
export function preparationView(job,profile){
 const p=job.preparation;if(!p)return null;
 const currentProfileKey=preparationProfileKey(profile);
 return {...p,currentProfileKey,stale:Boolean(p.profileKey&&p.profileKey!==currentProfileKey)};
}
export function hasPreparationWork(store,id,c){
 return store.jobs(id).some(j=>preparationHeld(j)&&!j.followupStopped&&!j.duplicateApplication&&!['submitted','already_submitted','skipped','uncertain','submitting'].includes(j.status)&&
  (['queued','inspecting','drafting'].includes(j.preparation.status)||c?.pendingResumes?.[j.id]||c?.pendingRecoveries?.[j.id]));
}
export function preparationQueueState(store,id,job){
 if(job.duplicateApplication||job.followupStopped||!['found','blocked','prepared','working'].includes(job.status))return 'unavailable';
 if(store.workerState.tasks(id).some(w=>w.task.jobId===job.id&&!w.task.report&&w.task.kind!=='rank')||job.status==='working')return 'active';
 return preparationHeld(job)&&job.preparation.status==='queued'?'queued':'available';
}
const string=(value,label,max=3000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${label}: geçerli bir metin gerekli`);return value.trim();};
const enumValue=(value,values,label)=>{if(!values.includes(value))throw Error(`Geçersiz ${label}`);return value;};
function assertOwner(store,candidate,jobId,sessionId){
 const job=store.job(candidate,jobId),c=store.campaign(candidate);
 if(c?.status!=='running'||c.task?.report||!preparationAuthorized(job,c.task)||job.followupStopped||job.duplicateApplication||['submitted','already_submitted','skipped','submitting','uncertain'].includes(job.status)||job.sessionId&&job.sessionId!==sessionId)throw Error('Etkin hazırlık görevi bu ilana ve oturuma ait olmalı.');
 return job;
}
export async function savePreparation(store,candidate,input,sessionId){
 const job=assertOwner(store,candidate,input.jobId,sessionId),previous=job.preparation;
 const profileKey=preparationProfileKey(store.profile(candidate));
 if(input.profileKey!==profileKey)throw Error('Profil veya CV değişti. get_task_context ile yeni bilgileri al ve etkilenen belgeleri güncelle.');
 if(input.revision!==previous.revision)throw Error('Hazırlık değişti. list_applications(jobId) ile son sürümü al; kullanıcı düzenlemelerini koru.');
 const status=enumValue(input.status,['inspecting','drafting','waiting','partial','ready'],'hazırlık durumu');
 const coverage=enumValue(input.coverage,['partial','complete'],'form kapsamı');
 const formUrl=new URL(string(input.formUrl,'Form bağlantısı'));
 if(!['http:','https:'].includes(formUrl.protocol)||formUrl.username||formUrl.password)throw Error('Geçersiz form bağlantısı');
 if(!Array.isArray(input.requirements)||input.requirements.length>60)throw Error('En fazla 60 gereksinim kaydedilebilir');
 const ids=new Set(),requirements=[];
 for(const raw of input.requirements){
  const id=string(raw.id,'Gereksinim kimliği',100);if(!/^[a-zA-Z0-9_-]+$/.test(id)||ids.has(id))throw Error('Gereksinim kimlikleri benzersiz olmalı');ids.add(id);
  const r={id,label:string(raw.label,'Gereksinim',300),kind:enumValue(raw.kind,['document','answer'],'gereksinim türü'),required:enumValue(raw.required,['required','optional','unknown'],'zorunluluk'),status:enumValue(raw.status,['pending','ready','missing','omitted'],'belge durumu'),evidence:string(raw.evidence,'Form kanıtı')};
  for(const key of ['format','language','source','note'])if(raw[key])r[key]=string(raw[key],key);
  for(const key of ['maxBytes','maxLength'])if(raw[key]!==undefined){if(!Number.isInteger(raw[key])||raw[key]<1)throw Error('Geçersiz dosya/metin sınırı');r[key]=raw[key];}
  if(raw.documentPath)r.documentPath=string(raw.documentPath,'Dosya yolu',1000);
  if(raw.acceptedExtensions){if(!Array.isArray(raw.acceptedExtensions)||!raw.acceptedExtensions.length||raw.acceptedExtensions.some(e=>!/^\.[a-z0-9]{1,8}$/.test(e)))throw Error('Geçersiz dosya formatları');r.acceptedExtensions=[...new Set(raw.acceptedExtensions)];}
  if(raw.answer)r.answer=string(raw.answer,'Yanıt',12000);
  const edited=previous.requirements?.find(item=>item.id===id&&item.userEdited);
  if(edited){if(edited.documentPath)r.documentPath=edited.documentPath;if(edited.answer)r.answer=edited.answer;r.userEdited=true;}
  if(r.status==='ready'){
   if(r.kind==='document'){
    const file=await documentPath(store.candidateDirectory(candidate),r.documentPath),info=await stat(file);
    if(!info.size||r.maxBytes&&info.size>r.maxBytes)throw Error(`${r.label}: dosya boş veya boyut sınırını aşıyor`);
    if(r.acceptedExtensions&&!r.acceptedExtensions.includes(path.extname(file).toLowerCase()))throw Error(`${r.label}: dosya formatı uygun değil`);
    r.documentHash=createHash('sha256').update(await readFile(file)).digest('hex');
   }else{string(r.answer,'Hazır yanıt',12000);if(r.maxLength&&r.answer.length>r.maxLength)throw Error(`${r.label}: yanıt karakter sınırını aşıyor`);}
  }
  if(r.status==='omitted'&&r.required!=='optional')throw Error('Yalnızca isteğe bağlı gereksinim atlanabilir');
  requirements.push(r);
 }
 for(const edited of previous.requirements??[])if(edited.userEdited&&!ids.has(edited.id))requirements.push(edited);
 if(status==='ready'&&(coverage!=='complete'||requirements.some(r=>r.required==='unknown'||r.required==='required'&&r.status!=='ready')))throw Error('Hazır için form tamamen incelenmeli ve zorunlu gereksinimler tamamlanmalı');
 // Filesystem checks yield; recheck ownership and revision before committing.
 const latest=assertOwner(store,candidate,input.jobId,sessionId);
 if(latest.preparation.revision!==previous.revision)throw Error('Hazırlık kontrol sırasında değişti; son sürümü al.');
 if(profileKey!==preparationProfileKey(store.profile(candidate)))throw Error('Profil kontrol sırasında değişti; yeni bilgilerle hazırlığı güncelle.');
 const preparation={...latest.preparation,status,coverage,formUrl:formUrl.href,coverageNote:string(input.coverageNote,'İncelenen adımlar'),note:string(input.note,'Hazırlık özeti'),requirements,profileKey,revision:previous.revision+1,checkedAt:new Date().toISOString()};
 store.saveJob({...latest,preparation,note:preparation.note,sessionId,...(['ready','partial'].includes(status)?{status:'found',sessionId:null}:{})},'preparation_updated');
 return {jobId:job.id,preparation};
}
export async function editPreparation(store,candidate,jobId,{revision,requirementId,content}){
 const job=store.job(candidate,jobId),p=job.preparation;
 if(!preparationHeld(job)||job.followupStopped||!['found','blocked','prepared'].includes(job.status)||store.workerState.tasks(candidate).some(w=>w.task.jobId===jobId&&!w.task.report))throw Error('Düzenlemek için hazırlık görevinin tamamlanmasını bekle.');
 if(p.revision!==revision)throw Error('Hazırlık değişti. Paneli yeniden aç.');
 const item=p.requirements.find(r=>r.id===requirementId);if(!item)throw Error('Gereksinim bulunamadı');
 const value=string(content,'İçerik',12000),updated={...item,userEdited:true,status:'ready'};
 if(item.kind==='answer'){if(item.maxLength&&value.length>item.maxLength)throw Error('Yanıt karakter sınırını aşıyor');updated.answer=value;}
 else{
  const original=await documentPath(store.candidateDirectory(candidate),item.documentPath);
  if(!['.md','.txt'].includes(path.extname(original)))throw Error('Yalnızca metin belgeleri düzenlenebilir');
  const extension=path.extname(original),target=path.join(path.dirname(original),`${path.basename(original,extension)}-edit-${randomUUID().slice(0,8)}${extension}`);
  if(item.maxBytes&&Buffer.byteLength(value)>item.maxBytes)throw Error('Belge boyut sınırını aşıyor');
  await writeFile(target,value,{flag:'wx',mode:0o600});updated.documentPath=path.relative(await realpath(store.candidateDirectory(candidate)),target);updated.documentHash=createHash('sha256').update(value).digest('hex');
 }
 const latest=store.job(candidate,jobId);
 if(latest.preparation?.revision!==revision||!preparationHeld(latest)||store.workerState.tasks(candidate).some(w=>w.task.jobId===jobId&&!w.task.report))throw Error('Hazırlık değişti. Paneli yeniden aç.');
 const preparation={...latest.preparation,revision:revision+1,requirements:latest.preparation.requirements.map(r=>r.id===requirementId?updated:r)};
 return store.saveJob({...latest,preparation},'preparation_edited');
}
