import {automationTrialReady,automationReady} from './automation-trial.mjs';
// Durable source failures remain visible even while other workers are running.
import {providerLimitAttention} from './provider-limit.mjs';
import {isConversation} from './workspace-conversation.mjs';
export function automationAttention(snapshot,{includeDismissed=false}={}){
 const {automation={},sources=[],runs=[],activeRuns=[]}=snapshot??{};
 const issues=[];
 for(const question of automation.questions??[])if(question.answer==null){
  const matches=runs.filter(r=>(r.recordId??null)===(question.recordId??null)&&r.startedAt<=question.createdAt&&(!r.finishedAt||r.finishedAt>=question.createdAt)),run=runs.find(r=>r.id===question.runId)??(matches.length===1?matches[0]:null);
  const context=question.browserContext??run?.resumeContext??{};
  const conversation=!question.recordId&&(question.conversation===true||run?.kind==='interview'||!question.sourceUrl&&!context.sourceUrl);
  issues.push({id:question.id,kind:'question',name:'Yanıt bekleniyor',message:question.text,recordId:question.recordId,canDismissRecord:question.canDismissRecord,fields:question.fields,...context,conversation});
 }
 const limitIssue=(run,worker,limit)=>{
  const attention=providerLimitAttention(limit),source=sources.find(s=>s.url===run.sourceUrl);
  return {id:'usage-limit:'+run.id,kind:'usage_limit',runId:run.id,workerId:run.workerId??worker?.id??'main',name:[worker?.name??'Agent',source?.name].filter(Boolean).join(' · '),title:attention.title,message:attention.detail,sourceUrl:run.sourceUrl,sessionOpen:run.status==='running',automaticResume:limit.automaticResume,resetLabel:limit.resetLabel,retry:null};
 };
 for(const active of activeRuns){
  const run=runs.find(r=>r.id===active.id)??active,worker=snapshot.workers?.find(w=>w.id===(run.workerId??'main')),limit=worker?.active?.usageLimit??run.usageLimit;
  if(run.status==='running'&&limit)issues.push(limitIssue(run,worker,limit));
 }
 for(const item of snapshot?.results??[]){
  const last=item.recordAction?.lastTask,failure=last?.toolFailure;
  if(!failure||!['reported','blocked','failed','paused'].includes(last.state)||['completed','dismissed'].includes(item.status))continue;
  issues.push({id:'tool-failure:'+failure.runId,kind:'repeated_tool_error',runId:failure.runId,recordId:item.id,name:item.title,message:last.summary,retry:null});
 }
 for(const source of sources){
  if(!source.enabled||!source.blocked||source.scanning)continue;
  const run=runs.find(r=>r.id===source.lastRunId)??runs.find(r=>r.sourceUrl===source.url&&r.status!=='running');
  if(run?.usageLimit){if(!issues.some(i=>i.runId===run.id))issues.push(limitIssue(run,snapshot.workers?.find(w=>w.id===(run.workerId??'main')),{...run.usageLimit,automaticResume:false}));continue;}
  const saved=source.blocker??run?.resumeContext??{};
  const access=source.accessRecovery;
  const uncertain=Boolean(saved.recordId??run?.recordId)||snapshot.results?.some(r=>r.sourceUrl===source.url&&['executing','uncertain'].includes(r.status));
  issues.push({id:source.url,sourceUrl:source.url,name:source.name,workerId:saved.workerId??run?.workerId,
   dismissKey:JSON.stringify([source.lastRunId??saved.runId,source.lastRunAt,source.lastStatus,source.lastResult,saved.tabId,saved.url]),
   kind:access&&['waiting','resetting'].includes(access.state)?'site_access':run?.toolFailure||(saved.stop??run?.stop)?.kind==='technical'||(source.lastStatus??run?.status)==='failed'?'technical':undefined,
   ...(access?{runId:access.runId,accessRetryAt:source.siteWait?.exhausted?null:access.retryAt,accessExhausted:Boolean(source.siteWait?.exhausted||access.retryAt===null),cleanupError:access.cleanupError}:{}),
   retryAt:automation.retryPlan?.[source.url]?.at??null,
   closing:access?.state==='resetting'||activeRuns.some(r=>r.sourceUrl===source.url||r.id===run?.id),
   message:source.siteWait?.message??source.lastResult??run?.summary??'Bu kaynakta devam etmek için müdahale gerekiyor.',
   url:saved.url??run?.observations?.at(-1)?.url??source.scan?.evidenceUrl??source.url,tabId:saved.tabId,
   retry:!uncertain&&automationReady(automation)?'source':null});
 }
 const conversation=runs.find(isConversation);
 if(conversation&&['blocked','failed','timeout'].includes(conversation.status)&&!activeRuns.some(isConversation)&&!issues.some(issue=>issue.runId===conversation.id)){
  if(conversation.usageLimit)issues.push(limitIssue(conversation,snapshot.workers?.find(w=>w.id===conversation.workerId),{...conversation.usageLimit,automaticResume:false}));
  else issues.push({id:conversation.id,kind:'conversation',name:'Sohbet',message:conversation.summary,workerId:conversation.workerId,retry:null});
 }
 const latest=runs[0];
 if(!issues.length&&!activeRuns.length&&latest&&!(latest.kind==='trial'&&automation.trial?.status==='skipped'&&automationTrialReady(automation))&&['blocked','failed','timeout'].includes(latest.status)&&!latest.sourceUrl&&latest.revision===automation.revision){
  if(latest.usageLimit)return [limitIssue(latest,snapshot.workers?.find(w=>w.id===(latest.workerId??'main')),{...latest.usageLimit,automaticResume:false})];
  issues.push({id:latest.id,kind:latest.kind==='interview'?'setup':latest.toolFailure||latest.stop?.kind==='technical'?'technical':undefined,name:latest.kind==='trial'?'Kaynak denemesi':'Agent',message:latest.summary,workerId:latest.workerId,
   ...(latest.kind!=='interview'?{dismissKey:JSON.stringify([latest.id,latest.status,latest.summary])}:{}),
   retryAt:automation.retryPlan?.[latest.id]?.at??null,
   url:latest.resumeContext?.url??latest.observations?.at(-1)?.url,tabId:latest.resumeContext?.tabId,
   retry:latest.kind==='trial'?'trial':null});
 }
 return includeDismissed?issues:issues.filter(issue=>!issue.dismissKey||automation.dismissedAttention?.[issue.id]!==issue.dismissKey);
}

export function dismissAutomationAttention(db,id,issueId,dismissKey){
 const snapshot=db.snapshot(id),issues=automationAttention(snapshot,{includeDismissed:true}),issue=issues.find(item=>item.id===issueId);
 if(!issue?.dismissKey||issue.dismissKey!==dismissKey||issue.retryAt)throw Error('Bu müdahale değişti veya artık kapatılamıyor. Listeyi yenileyip tekrar dene.');
 // Keep only acknowledgements for current incidents. New failures get a new key.
 const dismissedAttention=Object.fromEntries(issues.filter(item=>item.dismissKey&&snapshot.automation.dismissedAttention?.[item.id]===item.dismissKey).map(item=>[item.id,item.dismissKey]));
 dismissedAttention[issue.id]=issue.dismissKey;
 db.put({...db.get(id),dismissedAttention});
 return {dismissed:true};
}
