import {rankDecision} from './ranking.mjs';
// A completed provider turn is not proof that an application task is complete.
export function validateTaskCompletion(store,id,c,report){
 const task=c.task;if(!task?.jobId)return;
 const job=store.job(id,task.jobId),profile=store.profile(id),source=job.sourceId?store.source(id,job.sourceId):null;
 if(task.kind==='rank'){
  const state=rankDecision(profile,job).state;
  if(report.outcome==='done'&&!['pending','unavailable'].includes(state))return;
  if(report.outcome==='blocked'&&state==='unavailable')return;
  throw Error('Puanlama işi tamamlanmadı: record_job_rank ile güncel değerlendirmeyi kaydet; erişilemeyen ilanı unavailable kaydedip blocked bildir.');
 }
 const maySubmit=profile.authorization==='submit'&&(!source||source.applyMode==='auto');
 if(report.outcome==='done'){
  if(!rankDecision(profile,job).eligible&&rankDecision(profile,job).state!=='pending'&&!['uncertain','submitting'].includes(job.status))return;
  if(job.status==='submitted'&&job.proof)return;
  if(job.status==='skipped'&&job.note?.trim())return;
  if(job.status==='prepared'&&!maySubmit&&profile.authorization!=='research'&&source?.applyMode!=='find_only'&&task.kind!=='verify')return;
  throw Error('Başvuru işi bitmedi. Gönderim kanıtı veya gerekçeli eleme kaydet. Otomatik gönderim açıkken prepared yeterli değildir. Gerçek bir engelde soruyu ask_candidate ile kaydet, başvuruyu blocked yap ve blocked bildir. Aynı görevde devam et; belirsiz gönderimi tekrar gönderme.');
 }
 if(report.outcome!=='blocked')throw Error('Başvuru görevi no_results ile kapatılamaz. Aynı başvuruyu tamamla veya kayıtlı engeli bildir.');
 if(!['blocked','uncertain'].includes(job.status))throw Error('Engel için başvurunun durumunu blocked olarak kaydet; gönderim belirsizse uncertain durumunu koru.');
 const question=store.questions(id).some(q=>q.jobId===job.id&&(q.answer===null||(c.pendingResumes?.[job.id]===q.id&&task.resumeQuestionId!==q.id)));
 if(question)return;
 if(report.blocker?.kind==='technical'&&report.blocker.requiresUserInput===false&&report.blocker.evidence?.trim()&&report.blocker.reason?.trim())return;
 throw Error('Beklediğin kullanıcı yanıtını bu başvuruya bağlı ask_candidate sorusu olarak kaydetmeden işi kapatamazsın. Terminalde soru yazmak yeterli değil. Kullanıcı yanıtı gerektirmeyen teknik engelde blocker={kind:technical,requiresUserInput:false,evidence,reason} bildir.');
}
