export const directRecordInstructions='The user explicitly requested direct execution for this assigned record. No prior preparation task or separate draft review is required. Inspect the actual destination and form, read the saved profile, documents, criteria and template preparation guidance, and use only verified facts. In this same task save the complete intended action with record_automation_result (destination, answers, documents and commitments), then call reserve_automation_action before uploading or submitting. Stop if reservation fails. Read fresh confirmation and call record_automation_outcome; an ambiguous result is uncertain and must never be resent. Ask record-scoped questions for missing facts or decisions, and finish while waiting. An answer can continue the original request; it does not expand its scope or override a refusal. Existing limits and prohibitions still apply. These instructions replace only requirements for a prior saved proposal or a separate draft review in the template execution instructions.';

export const recordOperationDefaults={
 prepare:{label:'İşlemi hazırla',runningLabel:'Hazırlanıyor',instructions:'Inspect the assigned record and the actual destination form. Prepare the complete intended action using saved criteria and verified personal facts. Include the destination, all answers, document paths and any commitments in the proposal. Ask missing facts with ask_workspace_question and this recordId. Save the proposal with record_automation_result. Do not submit, send, book or create an external commitment.'},
 execute:{label:'Uygula',runningLabel:'Uygulanıyor',reviewLabel:'Onayla ve uygula',instructions:'Execute only the assigned record’s saved proposal. Recheck current availability and form requirements. If answers, documents, destination or commitments must change, save a revised proposal and stop for review. Before any external submission call reserve_automation_action for this item. Do not submit if reservation fails. After submission read fresh confirmation and call record_automation_outcome. If ambiguous, record uncertain; never submit twice.'},
 verify:{label:'Sonucu doğrula',runningLabel:'Doğrulanıyor',instructions:'Inspect only whether the assigned record’s earlier action succeeded. Use its retained page, confirmation or history. Never resubmit, reserve another action or change the proposal. Call record_automation_outcome with current evidence. If the portal explicitly identifies this exact application/action as a draft, not submitted, or rejected before submission, report not_submitted with the current snapshot and exact status/identity quote. Inspect application history/status if necessary without discarding the retained form. An unfinished form, missing attachment, or absent success message alone is not proof. If inconclusive retain uncertain and explain what is missing. After not_submitted finish completed; the application separately resumes an unchanged authorized execution or requests review. Never execute in this verification task.'}
};

export function normalizeRecordOperations(input,driver){
 if(driver.id!=='browser')return {};
 if(input===false)return false;
 if(input!=null&&(typeof input!=='object'||Array.isArray(input)))throw Error('Kayıt işlemleri geçersiz');
 const result={};
 for(const key of Object.keys(input??{}))if(!Object.hasOwn(recordOperationDefaults,key))throw Error('Bilinmeyen kayıt işlemi');
 for(const [kind,defaults] of Object.entries(recordOperationDefaults)){
  if(input?.[kind]===false){result[kind]=false;continue;}
  const saved={...defaults,...input?.[kind]};
  for(const key of ['label','runningLabel','instructions',...(kind==='execute'?['reviewLabel']:[])])if(typeof saved[key]!=='string'||!saved[key].trim()||saved[key].length>(key==='instructions'?6000:100))throw Error('Kayıt işlemi '+key+' geçersiz');
  const successCriteria=saved.successCriteria??'Save fresh observed confirmation of the intended outcome. A click or lack of an error is not confirmation.';
  if(typeof successCriteria!=='string'||!successCriteria.trim()||successCriteria.length>2000)throw Error('İşlem başarı koşulu geçersiz');
  result[kind]={kind,id:'record-'+kind,label:saved.label,runningLabel:saved.runningLabel,...(kind==='execute'?{reviewLabel:saved.reviewLabel}:{}),instructions:saved.instructions,successCriteria,scope:'record',effect:kind==='execute'?'write':kind==='prepare'?'prepare':'read',capability:kind==='execute'?'browser.act':kind==='prepare'?'browser.prepare':'browser.observe',after:[]};
 }
 return result;
}
