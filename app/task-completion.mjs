import {manualApplicationAuthorized} from './application-queue.mjs';
import {rankDecision} from './ranking.mjs';
import {missingDocumentReplies} from './application-replies.mjs';
import {preparationView} from './preparation.mjs';
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
 const manual=manualApplicationAuthorized(job,task);
 const maySubmit=manual||profile.authorization==='submit'&&(!source||source.applyMode==='auto');
 if(report.outcome==='done'){
  if(job.followupStopped)return;
  if(task.kind==='preparation'){
   if(['submitted','already_submitted','skipped'].includes(job.status))return;
   const preparation=preparationView(job,profile);
   if(['ready','partial'].includes(preparation?.status)&&!preparation.stale)return;
   throw Error('Hazırlık paketi tamamlanmadı. Gereksinimleri, dosyaları, cevapları ve form kapsamını save_preparation ile kaydet.');
  }
  if(!manual&&task.kind==='verify'&&job.status==='blocked'&&job.validationFailure?.submissionPrevented&&(task.verificationOnly||profile.authorization==='research'||source?.applyMode==='find_only'))return;
  if(!manual&&!rankDecision(profile,job).eligible&&rankDecision(profile,job).state!=='pending'&&!['uncertain','submitting'].includes(job.status))return;
  if(['submitted','already_submitted'].includes(job.status)&&(job.proof||['manual_submitted','already_submitted'].includes(job.manualOutcome)))return;
  if(job.status==='skipped'&&job.note?.trim())return;
  if(job.status==='prepared'&&!maySubmit&&profile.authorization!=='research'&&source?.applyMode!=='find_only'&&task.kind!=='verify')return;
  throw Error('Başvuru işi bitmedi. Gönderim kanıtı veya gerekçeli eleme kaydet. Otomatik gönderim açıkken prepared yeterli değildir. Gerçek bir engelde soruyu ask_candidate ile kaydet: gönderim başlamadıysa blocked, gönderim başladıysa uncertain kullan; sonra blocked bildir. Kullanıcı atla dediyse stop_application_followup kullan. Aynı görevde devam et; belirsiz gönderimi tekrar gönderme.');
 }
 if(report.outcome!=='blocked')throw Error('Başvuru görevi no_results ile kapatılamaz. Aynı başvuruyu tamamla veya kayıtlı engeli bildir.');
 if(!['blocked','uncertain'].includes(job.status))throw Error('Engel için başvurunun durumunu blocked olarak kaydet; gönderim belirsizse uncertain durumunu koru.');
 if(job.status==='blocked'&&job.missingDocuments&&missingDocumentReplies(job,store.questions(id)).some(q=>q.id===job.missingDocuments.questionId))return;
 const question=store.questions(id).some(q=>q.jobId===job.id&&(q.answer===null||(c.pendingResumes?.[job.id]===q.id&&task.resumeQuestionId!==q.id)));
 if(question)return;
 if(report.blocker?.kind==='technical'&&report.blocker.requiresUserInput===false&&report.blocker.evidence?.trim()&&report.blocker.reason?.trim())return;
 throw Error('Yeni bilgi gerekiyorsa başvuruya bağlı ask_candidate sorusu gerekli. Zorunlu belgeler için zaten yok yanıtı varsa defer_missing_documents kullan; aynı belgeleri veya ileride temin edilip edilemeyeceğini tekrar sorma. Kullanıcı başvuruyu gönderdiğini açıkça bildirdiyse record_candidate_submission kullan. Kullanıcı yanıtı gerektirmeyen teknik engelde blocker={kind:technical,requiresUserInput:false,evidence,reason} bildir.');
}
