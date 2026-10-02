import {taskHasRecord,batchScoring,recordScoredInTask} from './record-task-scope.mjs';
import {scoringPolicy} from './scoring-policy.mjs';
import {jevContextTasks} from './jev-tasks.mjs';
import {scanWorkSummary,scanPlanView,scanProgressView} from './scan-work.mjs';
import {isConversation,conversationRequest} from './workspace-conversation.mjs';
import {setupAgentOnboarding} from './setup-agent.mjs';
import {findOperation,operationFor} from './template-contract.mjs';
import {sourceMode} from './automation-sources.mjs';
import {sourceToolContext} from './source-tools.mjs';
import {SOURCE_SCAN_INSTRUCTIONS} from './source-scan.mjs';
import {directRecordInstructions} from './record-operation-definitions.mjs';
import {createHash} from 'node:crypto';

const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
function contextRun(run){
 return {...pick(run,['id','taskId','kind','operation','recordOperation','sourceUrl','recordId','recordIds','status','startedAt','finishedAt','summary','revision','resumeContext','pageProgress','observedPage','actionId','recovery','protocolReset']),browserSteps:run.browserSteps??0,navigationCount:run.navigation?.length??0,observations:(run.observations??[]).slice(-3).map(({url,at})=>({url,at}))};
}
const questionContext=q=>pick(q,['id','text','fields','answer','answerValues','createdAt','answeredAt','recordId','sourceUrl','taskId','resolution']);
export const conversationContextVersion=a=>createHash('sha256').update(JSON.stringify(pick(a,['revision','title','goal','criteria','instructions','facts','mode','sources','sourceSettings','referenceData','planDraft','sourceDraft','profileUpdate']))).digest('hex');

// Keep current rules and exact authorizations; old runs and unrelated rows are
// available through lookup tools instead of replaying them at every start.
export function automationTaskContext(db,id,active,{section}={}){
 const saved=db.get(id),conversation=isConversation(active),draft=conversation&&saved.planDraft?.baseRevision===saved.revision?saved.planDraft:null;
 const base=conversation&&saved.profileUpdate?{...saved,...saved.profileUpdate.plan}:saved,a={...base,...draft?.plan,...(conversation&&saved.sourceDraft?{sources:saved.sourceDraft.sources}:{})},definition=db.template(a.templateId),interview=active.kind==='interview';
 if(section){
  if(!conversation)throw Error('Ek bağlam bölümleri yalnızca bağımsız sohbet için kullanılabilir.');
  if(section==='profile')return {automation:pick(a,['id','title','goal','criteria','sources','instructions','facts','table']),referenceData:a.referenceData?pick(a.referenceData,['profile','applicationPolicy','ranking']):null,draftPending:Boolean(draft),sourceDraftPending:Boolean(saved.sourceDraft)};
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
  conversation:{independent:true,persistent:true,setupComplete:!setupAgentOnboarding(db,id),profileChanges:'draft',draftPending:Boolean(draft),sourceDraftPending:Boolean(saved.sourceDraft),instructions:'Use the existing conversation history. If setupComplete is false, read get_automation_context section template, lead the initial setup and save the unapproved profile for review. Otherwise answer the current message directly; inspect specific records only when needed. Other workers continue. Profile changes are reviewed on Çalışma alanı profili. Source suggestions are reviewed and applied separately on Kaynaklar; saving the profile does not apply sources. After reply_to_user, call finish_automation_run to wait for the next message in this same session.'},
  profileUpdate:saved.profileUpdate?{saved:true,pending:true,error:saved.profileUpdate.error??null,instructions:'The user saved this profile. Workers are being stopped so it can apply before they restart. The setup conversation stays open. If error is present, the profile is not applied; ask the user to retry saving.'}:null,
  currentRun:pick(active,['id','taskId','kind','workerId']),documentsDirectory:'documents/',
  contextScope:{note:'History is not loaded automatically, including on fresh sessions. Use get_workspace_history only for relevant earlier messages or worker run evidence. Request get_automation_context section profile, template or questions only when needed. Look up current records with get_automation_result; historical scores may be stale.'}
 };
 const batch=batchScoring(active),assignedRecord=!batch&&active.recordId?db.result(id,active.recordId):null;
 const assignedRecords=batch?active.recordIds.map(itemId=>{const item=db.result(id,itemId);return {...pick(item,['id','key','url','title','summary','cells','status']),scoredInThisRun:item.assessment?.runId===active.id,scoredInThisTask:recordScoredInTask(db,active,item)};}):null;
 const savedPage=assignedRecord?db.browserEvidence.latest(active,assignedRecord.url):null;
 const source=active.sourceUrl?db.sources(id).find(s=>s.url===active.sourceUrl):null;
 const assignedSource=source?{...pick(source,['url','name','query','enabled','mode','intervalMinutes','trial','instructions','tool','skill']),...(source.tool?{cli:sourceToolContext(source.tool)}:{})}:null;
 const questions=(a.questions??[]).filter(q=>{
  if(interview)return !q.recordId&&(conversation?Boolean(q.conversation)||!q.sourceUrl:!q.conversation);
  if(q.conversation)return false;
  if(q.recordId)return taskHasRecord(active,q.recordId);
  const scope=db.questionScope(id,q);
  return !scope.sourceUrl||scope.sourceUrl===active.sourceUrl;
 }).map(questionContext);
 let remaining=30000;const messages=[];
 if(interview)for(const m of db.messages(id).reverse()){if(m.text.length>remaining)break;messages.unshift(m);remaining-=m.text.length;}
 const results=interview?db.results(id).slice(0,10).map(r=>pick(r,['id','url','title','status','trial'])):[];
 const referenceData=a.referenceData?pick(a.referenceData,['profile','applicationPolicy','ranking']):null;
 let operation=active.kind==='run'&&active.operation&&findOperation(definition,active.operation)?operationFor(definition,active.operation):null;
 if(batch)operation={...operation,instructions:'Batch scoring: skip assignedRecords with scoredInThisTask=true. Score every remaining record with the current criteria.ranking and scoringPolicy, reading each listing or its Jev brief. Save record_automation_score with its itemId; use score=null for inaccessible listings. Ask missing facts with the relevant recordId and continue the other records. Use a separate read-only tab; do not alter proposals, fill or submit forms. Finish only after every assigned record has a saved score or a record-scoped question.',successCriteria:'Every assigned record has an assessment saved in this task or a record-scoped question.'};
 return {
  automation:{...pick(a,['id','templateId','title','goal','criteria','instructions','facts','status','revision','reviewedRevision','table','browserMode']),mode:active.kind==='trial'?'observe':sourceMode(a,active.sourceUrl),sources:active.sources??a.sources},
  assignedSource,assignedRecord,...(batch?{assignedRecords}:{}),assignedOperation:operation,
  ...(savedPage?{savedListing:{snapshotId:savedPage.id,url:savedPage.url,observedAt:savedPage.at,totalCharacters:savedPage.text.length,instructions:'Use browser_read_part or browser_search to reuse this exact listing text for scoring. It is historical evidence; actions and availability require a current observation.'}}:{}),
  ...(definition.recordOperations?.score?{scoringPolicy:scoringPolicy(saved)}:{}),
  ...(a.browserMode==='jev'?{jevTasks:jevContextTasks(db.jevTasks.list(id,active.taskId??active.id),active.scan?.work?.activeSearchId??'default'),jevGuidance:'Jev mode: resume saved pending details with browser_jev_run collect_details before any new search; use scan_results for discovery. jevTasks lists the RAM-only helper tasks of this task; assessmentRefreshRequired means resume that task first. Final assessments and source completion remain yours.'}:{}),
  sourceExamples:!active.recordId&&active.sourceUrl?db.results(id,{all:true}).filter(r=>r.sourceUrl===active.sourceUrl).slice(0,3).map(r=>pick(r,['url','title','status'])):[],
  template:interview?definition:{...pick(definition,['id','version','title','guidance','records','table']),recordOperations:active.recordOperation?{[active.recordOperation]:operation}:{},workflow:operation?[operation]:[]},
  questions,referenceData,messages,results,
  ...(conversation?{conversation:{independent:true,profileChanges:'draft',draftPending:Boolean(draft),instructions:'Answer the user’s current request. Other workers continue their assigned tasks. Do not restart onboarding, stop workers or change their instructions. save_automation_plan saves a proposed profile for review; it does not apply it or alter running work. Explain when a change is a draft. Only ask questions needed for the current request.'}}:{}),
  scanProgress:scanProgressView(active),...(active.kind==='run'&&active.sourceUrl&&!active.recordId?{scanWork:scanWorkSummary(active)}:{}),...(active.scanPlan?{scanPlan:scanPlanView(active.scanPlan),scanInstructions:SOURCE_SCAN_INSTRUCTIONS}:{}),
  currentRun:contextRun(active),
  ...(active.continuation?.reason==='site_access_response'?{sourceRecovery:{response:active.continuation.response,instructions:'The user responded to this source access intervention. Resume its retained tab and pending work. Verify the current page normally; if access is still blocked, release the source again.'}}:{}),
  ...(active.freshSource?{sourceRecovery:{instructions:'The previous access intervention expired or was dismissed. Its tabs were closed. Start a new scan at the assigned source entry; do not revive old helper IDs, pending URLs or browser history. Saved results remain available for duplicate checks.'}}:{}),
  previousRuns:active.freshSource?[]:db.runs(id).filter(r=>r.id!==active.id&&r.kind===active.kind&&(r.recordId??null)===(active.recordId??null)&&(!active.sourceUrl||r.sourceUrl===active.sourceUrl)).slice(0,1).map(contextRun),
  recordAuthorization:active.recordOperation?{operation:active.recordOperation,explicitUserRequest:active.request?.manual===true,directExecution:active.recordOperation==='execute'&&active.request?.manual===true&&active.request?.direct===true,approvedProposalDigest:active.recordOperation==='execute'&&active.request?.manual?active.request.digest??null:null,...(batch?{recordIds:active.recordIds}:{}),rule:batch?'Score only assignedRecords. Save each individual assessment with record_automation_score(itemId, score). Finish after all assigned records are handled. Do not change proposals or submit.':active.recordOperation==='score'?'Score only the assigned listing using the current criteria.ranking and saved profile/documents. Save with record_automation_score. Do not change proposals or submit.':active.recordOperation==='execute'&&active.request?.manual===true&&active.request?.direct===true?directRecordInstructions:'prepare: no external submission; execute: reserve the exact proposal before submitting, obey limits; verify: inspect prior outcome without resubmitting. An explicit execute request authorizes only this record and digest, without changing workspace or source permissions.'}:null,
  contextScope:{recordId:assignedRecord?.id??null,...(batch?{recordIds:active.recordIds}:{}),sourceUrl:active.sourceUrl??null,note:'This is the complete task context. Other saved records and audit history are omitted. Use lookup_scan_results for observed listing URLs, get_automation_result for a specific full record, or get_workspace_records for an explicit table query. Do not read unrelated records or reread unchanged context.'},
  documentsDirectory:'documents/',runtime:{local:true,appMustStayOpen:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,now:new Date(db.now?.()??Date.now()).toISOString()}
 };
}
