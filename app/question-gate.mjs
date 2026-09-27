// Reads are scoped to the candidate/session token, never shared between candidates.
export function questionKnowledge(store,id){
 const p=store.profile(id);
 return JSON.stringify({facts:p.facts,preferences:p.preferences,learnedFacts:p.learnedFacts,cvPath:p.cvPath,answers:store.questions(id).filter(q=>q.answer!==null).map(q=>({id:q.id,answer:q.answer}))});
}
export function validateQuestionReview(store,id,input,readKnowledge){
 if(readKnowledge!==questionKnowledge(store,id))throw Error('Soru sormadan önce güncel profil ve yanıtları get_task_context ile oku (yalnızca tam geçmiş gerekiyorsa list_applications). Kayıtlar değiştiyse yeniden oku.');
 const review=input.applicationBlocker?.review;
 if(!review?.cvChecked||!review?.missingFacts?.length)throw Error('applicationBlocker.review içinde cvChecked ve missingFacts belirt. CV yoksa bunu cvChecked içinde açıkla; varsa önce oku. Her eksik için key ve gap yaz.');
 const profile=store.profile(id);
 for(const fact of review.missingFacts){
  const known=profile.learnedFacts?.[fact.key]?.value;
  if(known&&!fact.knownValueGap?.trim())throw Error(`Bu konuda kayıtlı bilgi var: ${fact.key} = ${known}. Kullan; yalnızca karşılamadığı zorunlu ayrıntı veya gerçek çelişki varsa knownValueGap içinde açıkla.`);
 }
 if(input.applicationBlocker.kind==='access'){
  const recovery=input.applicationBlocker.recovery;
  if(!recovery?.userActionReason?.trim())throw Error('Erişim engelinde recovery.userActionReason ile neden kullanıcının müdahalesi gerektiğini belirt. Form giriş hatası eksik aday bilgisi değildir.');
  if(recovery.kind==='form_entry'&&(!recovery.visualCheck||recovery.visualCheck.method!=='screenshot'||!['empty','invalid'].includes(recovery.visualCheck.result)||!recovery.visualCheck.evidence?.trim()))throw Error('Boş AX/DOM değeri yeterli değil; iletişim değerleri gizlenebilir. Alanı ekrana getirip güncel screenshot ile görsel kontrol et. Doluysa devam et; gerçekten boş/hatalıysa recovery.visualCheck içinde kanıtı belirt.');
  if(recovery.kind==='form_entry'&&(!recovery.attempts||recovery.attempts.length<2||new Set(recovery.attempts.map(a=>a.method.trim().toLowerCase())).size<2))throw Error('Elle form doldurmayı istemeden önce iki farklı güvenli giriş yöntemini dene; recovery.attempts içinde yöntem ve gözlenen sonucu kaydet. Submit işlemini tekrar deneme.');
 }
}
