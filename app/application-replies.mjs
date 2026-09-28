import {isStopReply} from './application-stop.mjs';
// Interpret only saved, job-scoped replies. Page text and an agent's own note
// must never turn into a candidate statement or an application receipt.
const clean=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/ı/g,'i').replace(/[’']/g,'').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();

export function isSubmissionReply(answer){
 if(typeof answer!=='string')return false;
 const value=clean(answer);
 if(/\b(gondermedim|gonderilmedi|gonderemedim|basvurmadim|basvuramadim|degil|sanirim|galiba|emin degilim|not|never|maybe|unsure|havent|didnt|dont)\b/.test(value))return false;
 // Completing a CAPTCHA, uploading a file, or agreeing to submit is not a send.
 return /^(?:ben |basvuruyu |ben basvuruyu )?gonderdim(?: gonderildi isaretle)?$/.test(value)
  || /^(?:ben )?(?:basvurdum|basvuru yaptim|basvuruyu tamamlayip gonderdim)$/.test(value)
  || /^(?:ben tamamladim )?(?:gonderildi|basvuruldu)(?: olarak)? isaret(?:le|ke|k le)$/.test(value)
  || /^(?:i (?:have |already )?)?(?:submitted|sent)(?: the| my)? application(?: already)?$/.test(value)
  || /^(?:i (?:have )?)already applied$/.test(value);
}

const documentKinds=[['cv',/\b(cv|resume|ozgecmis)\b/],['references',/\b(referans\w*|reference\w*|zeugnisse?|arbeitszeugnis\w*)\b/],['transcript',/\b(transkript\w*|transcript\w*|not dokumu)\b/],['school',/\b(abitur|lise|diploma\w*|school certificate)\b/],['permit',/\b(calisma izni|work permit|aufenthalt\w*)\b/]];
function documents(question){
 const value=clean([question.question,question.applicationBlocker?.evidence,...(question.fields??[]).map(f=>f.label)].join(' '));
 const kinds=documentKinds.filter(([,pattern])=>pattern.test(value)).map(([kind])=>kind);
 return kinds.length?kinds:/\b(belge\w*|dosya\w*|pdf|document\w*|certificate\w*)\b/.test(value)?['document']:[];
}
function absent(value){
 return /^(?:(?:hayir|no) )?(?:(?:bu |su |o |gerekli |zorunlu )?(?:belgeler|belgelerim|dosyalar|dosyalarim|belge|dosya|referanslar|referanslarim|transkript|transkriptim) )?(?:(?:su an |simdilik )?(?:bende |elimde )?)?(?:yok|mevcut degil|bulunmuyor|hayir|no|not available|unavailable|i dont have (?:them|these documents|the documents))$/.test(clean(value));
}
function documentQuestion(question){
 const kind=question?.applicationBlocker?.kind;
 return ['required_form_field','access'].includes(kind)&&documents(question).length>0;
}
export function isMissingDocumentsReply(question){
 if(!documentQuestion(question))return false;
 // Legacy access questions can mix login and documents; a bare No is ambiguous.
 if(question.applicationBlocker.kind==='access'&&!question.answerValues&&/\b(login|password|sifre|giris|hesap|account|code|kod)\b/.test(clean(question.question))&&!documents({question:question.answer}).length)return false;
 if(question.answerValues)return missingDocumentFields(question).length>0;
 return absent(question.answer);
}
function missingDocumentFields(question){
 return (question.fields??[]).filter(f=>f.required!==false&&!f.consentScope&&documents({question:f.label}).length&&Object.hasOwn(question.answerValues??{},f.id)&&(question.answerValues[f.id]===false||absent(question.answerValues[f.id])));
}
export function sameDocumentRequirement(a,b){
 if(!documentQuestion(b))return false;
 const known=a.answerValues?missingDocumentFields(a).flatMap(f=>documents({question:f.label})):documents(a),requested=documents(b);
 return requested.length>0&&requested.every(kind=>known.includes(kind));
}
export function latestJobReply(job,questions){
 return questions.filter(q=>q.jobId===job.id&&q.answer!==null).sort((a,b)=>(b.answeredAt??b.createdAt??'').localeCompare(a.answeredAt??a.createdAt??''))[0];
}
export function missingDocumentReplies(job,questions){
 const replies=questions.filter(q=>q.jobId===job.id&&q.answer!==null&&documentQuestion(q)).sort((a,b)=>(b.answeredAt??b.createdAt??'').localeCompare(a.answeredAt??a.createdAt??''));
 return replies.filter((q,index)=>isMissingDocumentsReply(q)&&!replies.slice(0,index).some(newer=>{
  const a=documents(q),b=documents(newer);
  return a.includes('document')||b.includes('document')||a.some(kind=>b.includes(kind));
 }));
}
export function candidateReplyActions(job,questions){
 if(!job||['submitted','already_submitted','skipped'].includes(job.status)||job.followupStopped)return [];
 const reply=latestJobReply(job,questions);if(!reply)return [];
 if(isStopReply(reply.answer,job,reply))return [{tool:'stop_application_followup',questionId:reply.id,message:'The saved answer explicitly stops this application. Record the stop directly; do not ask for confirmation again or perform browser work.'}];
 const bareSend=/^(?:ben )?gonderdim$/.test(clean(reply.answer));
 const question=clean(reply.question);
 const submissionQuestion=/\b(basvuru|application|gonderim)\b/.test(question)&&/\b(durum\w*|gonder\w*|submit\w*|sent|sonuc\w*)\b/.test(question)&&!documents(reply).length&&!/\b(kod\w*|code|captcha|ekran goruntusu|screenshot|paylas\w*|yukle\w*|attach\w*|upload\w*|share)\b/.test(question);
 if(isSubmissionReply(reply.answer)&&(!bareSend||submissionQuestion))return [{tool:'record_candidate_submission',questionId:reply.id,message:'Record the candidate-reported submission. No new send, synthetic submitting state, browser proof or additional question is needed. This is not independent employer confirmation.'}];
 if(!['submitting','uncertain'].includes(job.status))return missingDocumentReplies(job,questions).map(q=>({tool:'defer_missing_documents',questionId:q.id,message:'If these required documents are still unavailable, preserve the draft and defer using this saved answer. Do not ask again whether they exist or can be supplied later. On an explicit retry first check for newly provided files.'}));
 return [];
}
