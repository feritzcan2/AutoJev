import {manualApplicationAuthorized} from './application-queue.mjs';
// Task-start review survives session replacement; current facts are still checked below.
export function validateQuestionInput(store,id,jobId,input,readKnowledge){
 const issues=[];
 if(jobId)try{validateQuestionReview(store,id,input,readKnowledge);}catch(error){issues.push(error.message);}
 try{validateQuestionConsent(store,id,jobId,input);}catch(error){issues.push(error.message);}
 if(issues.length)throw Error(issues.join('\n'));
}
export function validateQuestionConsent(store,id,jobId,input){
 const profile=store.profile(id),job=jobId?store.job(id,jobId):null,source=job?.sourceId?store.source(id,job.sourceId):null;
 const scopes=new Set((input.fields??[]).map(f=>f.consentScope).filter(Boolean));
 if(input.applicationBlocker?.kind==='uncovered_consent'){
  if(!input.applicationBlocker.consentScope&&!scopes.size)throw Error('Onayın kapsamını consentScope ile belirt');
  if(input.applicationBlocker.consentScope)scopes.add(input.applicationBlocker.consentScope);
 }
 for(const scope of scopes){
  if(scope==='submission'&&(manualApplicationAuthorized(job,store.campaign(id)?.task)||profile.authorization==='submit'&&(!source||source.applyMode==='auto'))||scope==='recruitment_privacy'&&profile.applicationPolicy.acceptPrivacy||scope==='group_recruitment'&&profile.applicationPolicy.groupRecruitmentConsent)throw Error('Bu işlem kayıtlı ayarlarda zaten onaylı; tekrar onay sorma ve mevcut yetki kapsamında devam et.');
 }
}
export function questionKnowledge(store,id){
 const p=store.profile(id);
 return JSON.stringify({candidateId:id,facts:p.facts,preferences:p.preferences,learnedFacts:p.learnedFacts,cvPath:p.cvPath,answers:store.questions(id).filter(q=>q.answer!==null).map(q=>({id:q.id,answer:q.answer}))});
}
export function validateQuestionReview(store,id,input,readKnowledge){
 const recovery=input.applicationBlocker?.recovery;
 const evidence=[input.applicationBlocker?.evidence,recovery?.captchaCheck?.evidence].join(' ');
 if(/(?:exceed(?:ing|ed|s)?[\s\S]{0,160}(?:quota|limit)|(?:quota|limit)[\s\S]{0,60}(?:exceed|exhaust))/i.test(evidence))throw Error('Site kotası adayın çözebileceği bir CAPTCHA değildir. Soru açma; mevcut blocked/uncertain durumunu ve taslağı koruyup gerçek kanıtla requiresUserInput=false teknik engel raporla.');
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
  const loginText=[input.question,input.applicationBlocker.evidence,input.applicationBlocker.reasonUnknown,recovery.userActionReason].join(' ').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/ı/g,'i');
  if(/\b(login|log in|sign in|sign-in|giris|oturum ac|google ile)\b/.test(loginText)){
   if(!['failed','user_required'].includes(recovery.loginCheck?.state)||!recovery.loginCheck?.evidence?.trim())throw Error('Giriş ekranı tek başına kullanıcı engeli değildir. Önce kayıtlı bilgilerle veya adayın mevcut Google hesabıyla desteklenen girişi dene. Gerçek kalan engeli recovery.loginCheck={state:failed veya user_required,evidence} ile belirt; şifre veya doğrulama kodu kaydetme.');
   if(recovery.loginCheck.state==='failed'&&!recovery.attempts?.some(a=>a.method?.trim()&&a.result?.trim()))throw Error('Başarısız giriş için recovery.attempts içinde denenen yöntemi ve gözlenen sonucu belirt; aynı hatalı girişi tekrarlama.');
  }

  if(!recovery.userActionReason?.trim())throw Error('Erişim engelinde recovery.userActionReason ile gereken kullanıcı eylemini belirt.');
  return; // Login/MFA/tool access cannot be resolved by rereading a CV or task context.
 }
 let reviewed;try{reviewed=JSON.parse(readKnowledge);}catch{}
 if(reviewed?.candidateId!==id)throw Error('Bu görev için profil incelemesi yok. Görev başında get_task_context bir kez okunmalı.');
 const review=input.applicationBlocker?.review;
 if(!review?.cvChecked||!review?.missingFacts?.length)throw Error('applicationBlocker.review içinde cvChecked ve missingFacts belirt. CV yoksa bunu cvChecked içinde açıkla; varsa önce oku. Her eksik için key ve gap yaz.');
 const profile=store.profile(id);
 const answers=store.reusableAnswers(id);
 const issues=[];
 for(const fact of review.missingFacts){
  const known=[...answers.filter(a=>a.key===fact.key).map(a=>`${a.question}: ${JSON.stringify(a.value)}`),profile.learnedFacts?.[fact.key]?.value].filter(Boolean).join('; ');
  if(known&&!fact.knownValueGap?.trim())issues.push(`Bu konuda kayıtlı bilgi var: ${fact.key} = ${known}. Kullan; yalnızca karşılamadığı zorunlu ayrıntı veya gerçek çelişki varsa knownValueGap içinde açıkla.`);
 }
 for(const field of input.fields??[]){
  if(field.factKey&&(!review.missingFacts.some(f=>f.key===field.factKey)||field.consentScope))issues.push(`${field.id}: factKey yalnızca incelenen genel aday bilgisine ait olmalı; onaylara factKey ekleme.`);
 }
 if(input.applicationBlocker.kind==='access'){
  const recovery=input.applicationBlocker.recovery;
  if(!recovery?.userActionReason?.trim())issues.push('Erişim engelinde recovery.userActionReason ile neden kullanıcının müdahalesi gerektiğini belirt. Form giriş hatası eksik aday bilgisi değildir.');
  if(recovery?.kind==='form_entry'&&(!recovery.visualCheck||recovery.visualCheck.method!=='screenshot'||!['empty','invalid'].includes(recovery.visualCheck.result)||!recovery.visualCheck.evidence?.trim()))issues.push('Boş AX/DOM değeri yeterli değil; iletişim değerleri gizlenebilir. Alanı ekrana getirip güncel screenshot ile görsel kontrol et. Doluysa devam et; gerçekten boş/hatalıysa recovery.visualCheck içinde kanıtı belirt.');
  if(recovery?.kind==='form_entry'&&(!recovery.attempts||recovery.attempts.length<2||new Set(recovery.attempts.map(a=>a.method.trim().toLowerCase())).size<2))issues.push('Elle form doldurmayı istemeden önce iki farklı güvenli giriş yöntemini dene; recovery.attempts içinde yöntem ve gözlenen sonucu kaydet. Submit işlemini tekrar deneme.');
 }
 if(issues.length)throw Error(issues.join('\n'));
}
