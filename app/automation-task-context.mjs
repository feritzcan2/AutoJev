import {scanWorkSummary,scanPlanView,scanProgressView} from './scan-work.mjs';
import {findOperation,operationFor} from './template-contract.mjs';
import {sourceMode} from './automation-sources.mjs';
import {SOURCE_SCAN_INSTRUCTIONS} from './source-scan.mjs';
import {directRecordInstructions} from './record-operation-definitions.mjs';

const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
function contextRun(run){
 return {...pick(run,['id','taskId','kind','operation','recordOperation','sourceUrl','recordId','status','startedAt','finishedAt','summary','revision','resumeContext','pageProgress','observedPage','actionId','recovery']),browserSteps:run.browserSteps??0,navigationCount:run.navigation?.length??0,observations:(run.observations??[]).slice(-3).map(({url,at})=>({url,at}))};
}
const questionContext=q=>pick(q,['id','text','fields','answer','answerValues','createdAt','answeredAt','recordId','sourceUrl','taskId','resolution']);

// Keep current rules and exact authorizations; old runs and unrelated rows are
// available through lookup tools instead of replaying them at every start.
export function automationTaskContext(db,id,active){
 const a=db.get(id),definition=db.template(a.templateId),interview=active.kind==='interview';
 const assignedRecord=active.recordId?db.result(id,active.recordId):null;
 const source=active.sourceUrl?db.sources(id).find(s=>s.url===active.sourceUrl):null;
 const assignedSource=source?pick(source,['url','name','query','enabled','mode','searchMethod','integrationId','fallback','intervalMinutes','trial','learnedSkill']):null;
 const questions=(a.questions??[]).filter(q=>{
  if(interview)return !q.recordId;
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
  scanProgress:scanProgressView(active),...(active.kind==='run'&&active.sourceUrl&&!active.recordId?{scanWork:scanWorkSummary(active)}:{}),...(active.scanPlan?{scanPlan:scanPlanView(active.scanPlan),scanInstructions:SOURCE_SCAN_INSTRUCTIONS}:{}),
  currentRun:contextRun(active),
  previousRuns:db.runs(id).filter(r=>r.id!==active.id&&r.kind===active.kind&&(r.recordId??null)===(active.recordId??null)&&(!active.sourceUrl||r.sourceUrl===active.sourceUrl)).slice(0,1).map(contextRun),
  recordAuthorization:active.recordOperation?{operation:active.recordOperation,explicitUserRequest:active.request?.manual===true,directExecution:active.recordOperation==='execute'&&active.request?.manual===true&&active.request?.direct===true,approvedProposalDigest:active.recordOperation==='execute'&&active.request?.manual?active.request.digest??null:null,rule:active.recordOperation==='execute'&&active.request?.manual===true&&active.request?.direct===true?directRecordInstructions:'prepare: no external submission; execute: reserve the exact proposal before submitting, obey limits; verify: inspect prior outcome without resubmitting. An explicit execute request authorizes only this record and digest, without changing workspace or source permissions.'}:null,
  contextScope:{recordId:active.recordId??null,sourceUrl:active.sourceUrl??null,note:'This is the complete task context. Other saved records and audit history are omitted. Use lookup_scan_results for observed listing URLs, get_automation_result for a specific full record, or get_workspace_records for an explicit table query. Do not read unrelated records or reread unchanged context.'},
  documentsDirectory:'documents/',runtime:{local:true,appMustStayOpen:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,now:new Date(db.now?.()??Date.now()).toISOString()}
 };
}
