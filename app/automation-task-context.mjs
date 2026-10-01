import {scanWorkSummary,scanPlanView,scanProgressView} from './scan-work.mjs';
import {isConversation,conversationRequest} from './workspace-conversation.mjs';
import {setupAgentOnboarding} from './setup-agent.mjs';
import {findOperation,operationFor} from './template-contract.mjs';
import {sourceMode} from './automation-sources.mjs';
import {SOURCE_SCAN_INSTRUCTIONS} from './source-scan.mjs';
import {directRecordInstructions} from './record-operation-definitions.mjs';
import {createHash} from 'node:crypto';

const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
function contextRun(run){
 return {...pick(run,['id','taskId','kind','operation','recordOperation','sourceUrl','recordId','status','startedAt','finishedAt','summary','revision','resumeContext','pageProgress','observedPage','actionId','recovery']),browserSteps:run.browserSteps??0,navigationCount:run.navigation?.length??0,observations:(run.observations??[]).slice(-3).map(({url,at})=>({url,at}))};
}
const questionContext=q=>pick(q,['id','text','fields','answer','answerValues','createdAt','answeredAt','recordId','sourceUrl','taskId','resolution']);
export const conversationContextVersion=a=>createHash('sha256').update(JSON.stringify(pick(a,['revision','title','goal','criteria','instructions','facts','mode','sources','sourceSettings','referenceData','planDraft']))).digest('hex');

// Keep current rules and exact authorizations; old runs and unrelated rows are
// available through lookup tools instead of replaying them at every start.
export function automationTaskContext(db,id,active,{section}={}){
 const saved=db.get(id),conversation=isConversation(active),draft=conversation&&saved.planDraft?.baseRevision===saved.revision?saved.planDraft:null;
 const a=draft?{...saved,...draft.plan}:saved,definition=db.template(a.templateId),interview=active.kind==='interview';
 if(section){
  if(!conversation)throw Error('Ek bağlam bölümleri yalnızca bağımsız sohbet için kullanılabilir.');
  if(section==='profile')return {automation:pick(a,['id','title','goal','criteria','sources','instructions','facts','table']),referenceData:a.referenceData?pick(a.referenceData,['profile','applicationPolicy','ranking']):null,draftPending:Boolean(draft)};
  if(section==='template')return {template:definition};
  if(section==='questions')return {questions:(a.questions??[]).filter(q=>!q.recordId&&!q.sourceUrl).map(questionContext)};
  throw Error('Bilinmeyen bağlam bölümü.');
 }
 const request=conversation?conversationRequest(db,id,active):null;
 if(conversation)return {
  automation:{...pick(a,['id','templateId','title','goal','criteria','instructions','facts','revision']),mode:saved.mode},
  template:pick(definition,['id','title']),
  messages:request?.message?[{role:'user',text:request.message,at:request.at}]:[],
  questions:(a.questions??[]).filter(q=>q.conversation&&(q.answer==null||(active.inputQuestionIds??active.continuation?.questionIds??[]).includes(q.id))).map(questionContext),
  conversation:{independent:true,persistent:true,setupComplete:!setupAgentOnboarding(db,id),profileChanges:'draft',draftPending:Boolean(draft),instructions:'Use the existing conversation history. If setupComplete is false, read get_automation_context section template, lead the initial setup and save the unapproved profile for review. Otherwise answer the current message directly; inspect specific records only when needed. Other workers continue. Profile changes are drafts for review. After reply_to_user, call finish_automation_run to wait for the next message in this same session.'},
  currentRun:pick(active,['id','taskId','kind','workerId']),documentsDirectory:'documents/',
  contextScope:{note:'History is not loaded automatically, including on fresh sessions. Use get_workspace_history only for relevant earlier messages or worker run evidence. Request get_automation_context section profile, template or questions only when needed. Look up current records with get_automation_result; historical scores may be stale.'}
 };
 const assignedRecord=active.recordId?db.result(id,active.recordId):null;
 const source=active.sourceUrl?db.sources(id).find(s=>s.url===active.sourceUrl):null;
 const assignedSource=source?pick(source,['url','name','query','enabled','mode','searchMethod','integrationId','fallback','intervalMinutes','trial','learnedSkill']):null;
 const questions=(a.questions??[]).filter(q=>{
  if(interview)return !q.recordId&&(conversation?Boolean(q.conversation)||!q.sourceUrl:!q.conversation);
  if(q.conversation)return false;
  if(q.recordId)return q.recordId===active.recordId;
  const scope=db.questionScope(id,q);
  return !scope.sourceUrl||scope.sourceUrl===active.sourceUrl;
 }).map(questionContext);
 let remaining=30000;const messages=[];
 if(interview)for(const m of db.messages(id).reverse()){if(m.text.length>remaining)break;messages.unshift(m);remaining-=m.text.length;}
 const results=interview?db.results(id).slice(0,10).map(r=>pick(r,['id','url','title','status','trial'])):[];
 const referenceData=a.referenceData?pick(a.referenceData,['profile','applicationPolicy','ranking']):null;
 const operation=active.kind==='run'&&active.operation&&findOperation(definition,active.operation)?operationFor(definition,active.operation):null;
 return {
  automation:{...pick(a,['id','templateId','title','goal','criteria','instructions','facts','status','revision','reviewedRevision','table','browserMode']),mode:active.kind==='trial'?'observe':sourceMode(a,active.sourceUrl),sources:active.sources??a.sources},
  assignedSource,assignedRecord,assignedOperation:operation,
  sourceExamples:!active.recordId&&active.sourceUrl?db.results(id,{all:true}).filter(r=>r.sourceUrl===active.sourceUrl).slice(0,3).map(r=>pick(r,['url','title','status'])):[],
  template:interview?definition:{...pick(definition,['id','version','title','guidance','records','table']),recordOperations:active.recordOperation?{[active.recordOperation]:operation}:{},workflow:operation?[operation]:[]},
  questions,referenceData,messages,results,
  ...(conversation?{conversation:{independent:true,profileChanges:'draft',draftPending:Boolean(draft),instructions:'Answer the user’s current request. Other workers continue their assigned tasks. Do not restart onboarding, stop workers or change their instructions. save_automation_plan saves a proposed profile for review; it does not apply it or alter running work. Explain when a change is a draft. Only ask questions needed for the current request.'}}:{}),
  scanProgress:scanProgressView(active),...(active.kind==='run'&&active.sourceUrl&&!active.recordId?{scanWork:scanWorkSummary(active)}:{}),...(active.scanPlan?{scanPlan:scanPlanView(active.scanPlan),scanInstructions:SOURCE_SCAN_INSTRUCTIONS}:{}),
  currentRun:contextRun(active),
  previousRuns:db.runs(id).filter(r=>r.id!==active.id&&r.kind===active.kind&&(r.recordId??null)===(active.recordId??null)&&(!active.sourceUrl||r.sourceUrl===active.sourceUrl)).slice(0,1).map(contextRun),
  recordAuthorization:active.recordOperation?{operation:active.recordOperation,explicitUserRequest:active.request?.manual===true,directExecution:active.recordOperation==='execute'&&active.request?.manual===true&&active.request?.direct===true,approvedProposalDigest:active.recordOperation==='execute'&&active.request?.manual?active.request.digest??null:null,rule:active.recordOperation==='score'?'Score only the assigned listing using the current criteria.ranking and saved profile/documents. Save with record_automation_score. Do not change proposals or submit.':active.recordOperation==='execute'&&active.request?.manual===true&&active.request?.direct===true?directRecordInstructions:'prepare: no external submission; execute: reserve the exact proposal before submitting, obey limits; verify: inspect prior outcome without resubmitting. An explicit execute request authorizes only this record and digest, without changing workspace or source permissions.'}:null,
  contextScope:{recordId:active.recordId??null,sourceUrl:active.sourceUrl??null,note:'This is the complete task context. Other saved records and audit history are omitted. Use lookup_scan_results for observed listing URLs, get_automation_result for a specific full record, or get_workspace_records for an explicit table query. Do not read unrelated records or reread unchanged context.'},
  documentsDirectory:'documents/',runtime:{local:true,appMustStayOpen:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,now:new Date(db.now?.()??Date.now()).toISOString()}
 };
}
