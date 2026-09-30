import {reusableFactKeys} from './candidate-answers.mjs';

const omit=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));

// Full records stay in the store/UI. Agent writes return the saved outcome,
// including eligibility and duplicate guards, without echoing supplied prose.
export function jobReceipt(job,rankDecision){
 return {...pick(job,['id','canonicalJobId','duplicateCount','url','company','role','location','status','sourceId','duplicateApplication','followupStopped','rankRetry']),
  rank:job.rank?pick(job.rank,['status','score','availability','profileKey','rankedAt']):null,rankDecision};
}

export function compactTaskContext(context){
 const task=context.campaign?.task;
 if(!task||context.setup?.mode==='improve'&&context.setup.needsTurn||context.setup&&context.setup.status!=='complete')return context; // Setup and direct conversations keep their full context.
 const research=['search','rank'].includes(task.kind);
 const facts=new Set(context.reusableAnswers.map(a=>`${a.key}:${a.fieldId}`));
 const covered=q=>!q.jobId&&q.answerValues&&q.fields?.length&&q.fields.every(field=>{
  const gaps=q.applicationBlocker?.review?.missingFacts??[];
  const key=field.factKey??(q.applicationBlocker?.kind==='required_form_field'&&q.fields.length===1&&gaps.length===1?gaps[0].key:null);
  return !field.consentScope&&reusableFactKeys.includes(key)&&Object.hasOwn(q.answerValues,field.id)&&facts.has(`${key}:${field.id}`);
 });
 const setup=context.setup;
 const application=['application','preparation','verify','verification'].includes(task.kind);
 const job=context.job?{...context.job}:null;
 if(application&&job){
  // Preserve every operational field, including proofs and recovery guards.
  // Ranking explanations are available through list_applications(jobId).
  delete job.fit;
  if(job.rank)job.rank=omit(job.rank,['dimensions','strengths','evidence']);
 }
 const profile={...context.profile};
 // UI/provider configuration is not candidate knowledge. Keep browser/account,
 // facts, provenance, preferences and authorization byte-for-byte intact.
 delete profile.agentSettings;delete profile.workspaceName;
 return {...context,profile,job,
  ...(['submitting','uncertain'].includes(job?.status)?{submissionRecovery:{nextAction:'Inspect the existing tab for confirmation; record_submission directly when observed. Do not reset status to working/prepared/submitting or click Submit again.',validation:'Only explicit fresh field errors proving submission was prevented permit record_validation_failure.',continuation:'continue_verification requires an answered access/verification question for this job AND an explicit remaining site step. No confirmation alone is insufficient. If no evidence resolves the outcome, preserve uncertain and report the verification task honestly.'}}:{}),
  setup:setup?.status==='complete'&&!setup.needsTurn?pick(setup,['status','stage','mode','needsTurn','error']):setup,
  source:context.source?pick(context.source,['id','name','kind','url','query','applyMode','searchMethod','fallback','integrationId','resumeContext','scanProgress']):null,
  questions:context.questions.filter(q=>(!research||q.answer!==null)&&!covered(q)).map(q=>{const out=pick(q,['id','jobId','question','fields','answer','answerValues','createdAt','answeredAt','resolution','applicationBlocker']);if(q.answer!==null&&q.answer!==undefined&&out.fields)out.fields=out.fields.map(f=>{const field=pick(f,['id','label','type','help','factKey','consentScope']);if(f.options){const answer=q.answerValues?.[f.id];field.options=answer===undefined?f.options:f.options.filter(o=>(Array.isArray(answer)?answer:[answer]).includes(typeof o==='string'?o:o.value));}return field;});return out;}),
  // Jev retains these tabs server-side. Native tools still need their exact
  // identities for turn-scoped handoff, even during research.
  unfinishedTabs:context.unfinishedTabs.filter(t=>!research||t.resumeContext.browser!=='Jev Chrome').map(t=>t.jobId===job?.id?{...t,resumeContext:pick(t.resumeContext,['browser','tabId','url'])}:t)};
}
