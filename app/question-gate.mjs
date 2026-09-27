// Task-start review survives session replacement; current facts are still checked below.
export function validateQuestionConsent(store,id,jobId,input){
 const profile=store.profile(id),job=jobId?store.job(id,jobId):null,source=job?.sourceId?store.source(id,job.sourceId):null;
 const scopes=new Set((input.fields??[]).map(f=>f.consentScope).filter(Boolean));
 if(input.applicationBlocker?.kind==='uncovered_consent'){
  if(!input.applicationBlocker.consentScope&&!scopes.size)throw Error('Onayın kapsamını consentScope ile belirt');
  if(input.applicationBlocker.consentScope)scopes.add(input.applicationBlocker.consentScope);
 }
 for(const scope of scopes){
  if(scope==='submission'&&profile.authorization==='submit'&&(!source||source.applyMode==='auto')||scope==='recruitment_privacy'&&profile.applicationPolicy.acceptPrivacy||scope==='group_recruitment'&&profile.applicationPolicy.groupRecruitmentConsent)throw Error('Bu işlem kayıtlı ayarlarda zaten onaylı; tekrar onay sorma ve mevcut yetki kapsamında devam et.');
 }
}
export function questionKnowledge(store,id){
 const p=store.profile(id);
 return JSON.stringify({candidateId:id,facts:p.facts,preferences:p.preferences,learnedFacts:p.learnedFacts,cvPath:p.cvPath,answers:store.questions(id).filter(q=>q.answer!==null).map(q=>({id:q.id,answer:q.answer}))});
}
export function validateQuestionReview(store,id,input,readKnowledge){
 const recovery=input.applicationBlocker?.recovery;
 if(input.applicationBlocker?.kind==='access'&&recovery?.kind==='captcha'){
  const check=recovery.captchaCheck;
  if(check?.state!=='required'||!check.evidence?.trim())throw Error('CAPTCHA sorusu için güncel gözlemde hâlâ gerekli olduğunu captchaCheck.state=required ve evidence ile belirt. Kontrol sürüyorsa veya çözüldüyse kullanıcıya sorma.');
  if(!recovery.userActionReason?.trim())throw Error('CAPTCHA için kalan kullanıcı eylemini userActionReason ile belirt.');
  if(check.capability==='supported'){
   if(!recovery.attempts?.length||recovery.attempts.length>2||recovery.attempts.some(a=>!a.method?.trim()||!a.result?.trim()))throw Error('Araç destekliyorsa kullanıcıya sormadan önce normal CAPTCHA arayüzünü sınırlı biçimde dene; attempts içinde 1–2 deneme ve gözlenen sonuçlarını belirt.');
  }else if(!['tool_disallowed','not_exposed'].includes(check.capability)||!check.limitation?.trim())throw Error('Deneme yapılamıyorsa gerçek araç kısıtını veya erişilemeyen denetimi captchaCheck.limitation içinde belirt; deneme uydurma.');
  return; // Technical challenge; a CV review cannot resolve it.
 }
 if(input.applicationBlocker?.kind==='access'&&recovery?.kind==='user_only'){
  if(!recovery.userActionReason?.trim())throw Error('Erişim engelinde recovery.userActionReason ile gereken kullanıcı eylemini belirt.');
  return; // Login/MFA/tool access cannot be resolved by rereading a CV or task context.
 }
 let reviewed;try{reviewed=JSON.parse(readKnowledge);}catch{}
 if(reviewed?.candidateId!==id)throw Error('Bu görev için profil incelemesi yok. Görev başında get_task_context bir kez okunmalı.');
 const review=input.applicationBlocker?.review;
 if(!review?.cvChecked||!review?.missingFacts?.length)throw Error('applicationBlocker.review içinde cvChecked ve missingFacts belirt. CV yoksa bunu cvChecked içinde açıkla; varsa önce oku. Her eksik için key ve gap yaz.');
 const profile=store.profile(id);
 const answers=store.reusableAnswers(id);
 for(const fact of review.missingFacts){
  const known=profile.learnedFacts?.[fact.key]?.value||answers.filter(a=>a.key===fact.key).map(a=>`${a.question}: ${JSON.stringify(a.value)}`).join('; ');
  if(known&&!fact.knownValueGap?.trim())throw Error(`Bu konuda kayıtlı bilgi var: ${fact.key} = ${known}. Kullan; yalnızca karşılamadığı zorunlu ayrıntı veya gerçek çelişki varsa knownValueGap içinde açıkla.`);
 }
 for(const field of input.fields??[]){
  if(field.factKey&&(!review.missingFacts.some(f=>f.key===field.factKey)||field.consentScope))throw Error('factKey yalnızca incelenen genel aday bilgisine ait olmalı; onaylara factKey ekleme.');
 }
 if(input.applicationBlocker.kind==='access'){
  const recovery=input.applicationBlocker.recovery;
  if(!recovery?.userActionReason?.trim())throw Error('Erişim engelinde recovery.userActionReason ile neden kullanıcının müdahalesi gerektiğini belirt. Form giriş hatası eksik aday bilgisi değildir.');
  if(recovery.kind==='form_entry'&&(!recovery.visualCheck||recovery.visualCheck.method!=='screenshot'||!['empty','invalid'].includes(recovery.visualCheck.result)||!recovery.visualCheck.evidence?.trim()))throw Error('Boş AX/DOM değeri yeterli değil; iletişim değerleri gizlenebilir. Alanı ekrana getirip güncel screenshot ile görsel kontrol et. Doluysa devam et; gerçekten boş/hatalıysa recovery.visualCheck içinde kanıtı belirt.');
  if(recovery.kind==='form_entry'&&(!recovery.attempts||recovery.attempts.length<2||new Set(recovery.attempts.map(a=>a.method.trim().toLowerCase())).size<2))throw Error('Elle form doldurmayı istemeden önce iki farklı güvenli giriş yöntemini dene; recovery.attempts içinde yöntem ve gözlenen sonucu kaydet. Submit işlemini tekrar deneme.');
 }
}
