export const reusableFactKeys=['contact','location','citizenship','work_authorization','sponsorship','notice_period','salary_expectation','language_levels','experience','technologies','education','work_preferences','target_roles'];
export const consentScopes=['submission','recruitment_privacy','group_recruitment','other'];

// Keep the exact question and explicit answer, rather than guessing what a yes
// means. Consent and ambiguous free-text replies never become general facts.
export function reusableAnswers(questions){
 const latest=new Map();
 for(const q of questions.filter(q=>q.answerValues).sort((a,b)=>(a.answeredAt??a.createdAt??'').localeCompare(b.answeredAt??b.createdAt??''))){
  const gaps=q.applicationBlocker?.review?.missingFacts??[];
  for(const field of q.fields??[]){
   if(field.consentScope||!Object.hasOwn(q.answerValues,field.id))continue;
   const legacyKey=q.applicationBlocker?.kind==='required_form_field'&&q.fields.length===1&&gaps.length===1?gaps[0].key:null;
   const key=field.factKey??legacyKey;
   if(!reusableFactKeys.includes(key))continue;
   // Old bundled consent forms did not identify each field's scope.
   if(q.applicationBlocker?.kind==='uncovered_consent'&&!field.factKey)continue;
   const value=q.answerValues[field.id];
   latest.set(`${key}:${field.id}`,{key,fieldId:field.id,question:field.label,value,sourceId:q.id,answeredAt:q.answeredAt??q.createdAt});
  }
 }
 return [...latest.values()];
}
