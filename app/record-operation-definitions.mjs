export const recordOperationDefaults={
 prepare:{label:'İşlemi hazırla',instructions:'Inspect the assigned record and the actual destination form. Prepare the complete intended action using saved criteria and verified personal facts. Include the destination, all answers, document paths and any commitments in the proposal. Ask missing facts with ask_workspace_question and this recordId. Save the proposal with record_automation_result. Do not submit, send, book or create an external commitment.'},
 execute:{label:'Uygula',reviewLabel:'Onayla ve uygula',instructions:'Execute only the assigned record’s saved proposal. Recheck current availability and form requirements. If answers, documents, destination or commitments must change, save a revised proposal and stop for review. Before any external submission call reserve_automation_action for this item. Do not submit if reservation fails. After submission read fresh confirmation and call record_automation_outcome. If ambiguous, record uncertain; never submit twice.'},
 verify:{label:'Sonucu doğrula',instructions:'Inspect only whether the assigned record’s earlier action succeeded. Use its retained page, confirmation or history. Never resubmit, reserve another action or change the proposal. Call record_automation_outcome with current evidence; if inconclusive retain uncertain and explain what is missing.'}
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
  for(const key of ['label','instructions',...(kind==='execute'?['reviewLabel']:[])])if(typeof saved[key]!=='string'||!saved[key].trim()||saved[key].length>(key==='instructions'?6000:100))throw Error('Kayıt işlemi '+key+' geçersiz');
  const successCriteria=saved.successCriteria??'Save fresh observed confirmation of the intended outcome. A click or lack of an error is not confirmation.';
  if(typeof successCriteria!=='string'||!successCriteria.trim()||successCriteria.length>2000)throw Error('İşlem başarı koşulu geçersiz');
  result[kind]={kind,id:'record-'+kind,label:saved.label,...(kind==='execute'?{reviewLabel:saved.reviewLabel}:{}),instructions:saved.instructions,successCriteria,scope:'record',effect:kind==='execute'?'write':kind==='prepare'?'prepare':'read',capability:kind==='execute'?'browser.act':kind==='prepare'?'browser.prepare':'browser.observe',after:[]};
 }
 return result;
}
