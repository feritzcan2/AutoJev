import {automationTrialReady} from './automation-trial.mjs';
// Durable source failures remain visible even while other workers are running.
import {providerLimitAttention} from './provider-limit.mjs';
export function automationAttention(snapshot){
 const {automation={},sources=[],runs=[],activeRuns=[]}=snapshot??{};
 const issues=[];
 for(const question of automation.questions??[])if(question.answer==null){
  const matches=runs.filter(r=>(r.recordId??null)===(question.recordId??null)&&r.startedAt<=question.createdAt&&(!r.finishedAt||r.finishedAt>=question.createdAt)),run=matches.length===1?matches[0]:null;
  const context=question.browserContext??run?.resumeContext??{};
  issues.push({id:question.id,kind:'question',name:'Yanıt bekleniyor',message:question.text,recordId:question.recordId,fields:question.fields,...context});
 }
 const limitIssue=(run,worker,limit)=>{
  const attention=providerLimitAttention(limit),source=sources.find(s=>s.url===run.sourceUrl);
  return {id:'usage-limit:'+run.id,kind:'usage_limit',runId:run.id,workerId:run.workerId??worker?.id??'main',name:[worker?.name??'Agent',source?.name].filter(Boolean).join(' · '),title:attention.title,message:attention.detail,sourceUrl:run.sourceUrl,sessionOpen:run.status==='running',automaticResume:limit.automaticResume,resetLabel:limit.resetLabel,retry:null};
 };
 for(const active of activeRuns){
  const run=runs.find(r=>r.id===active.id)??active,worker=snapshot.workers?.find(w=>w.id===(run.workerId??'main')),limit=worker?.active?.usageLimit??run.usageLimit;
  if(run.status==='running'&&limit)issues.push(limitIssue(run,worker,limit));
 }
 for(const source of sources){
  if(!source.enabled||!source.blocked||source.scanning)continue;
  const run=runs.find(r=>r.id===source.lastRunId)??runs.find(r=>r.sourceUrl===source.url&&r.status!=='running');
  if(run?.usageLimit){if(!issues.some(i=>i.runId===run.id))issues.push(limitIssue(run,snapshot.workers?.find(w=>w.id===(run.workerId??'main')),{...run.usageLimit,automaticResume:false}));continue;}
  const saved=source.blocker??run?.resumeContext??{};
  const uncertain=Boolean(saved.recordId??run?.recordId)||snapshot.results?.some(r=>r.sourceUrl===source.url&&['executing','uncertain'].includes(r.status));
  issues.push({id:source.url,sourceUrl:source.url,name:source.name,workerId:saved.workerId??run?.workerId,
   kind:(saved.stop??run?.stop)?.kind==='technical'||(source.lastStatus??run?.status)==='failed'?'technical':undefined,
   retryAt:automation.retryPlan?.[source.url]?.at??null,
   closing:activeRuns.some(r=>r.sourceUrl===source.url||r.id===run?.id),
   message:source.lastResult??run?.summary??'Bu kaynakta devam etmek için müdahale gerekiyor.',
   url:saved.url??run?.observations?.at(-1)?.url??source.scan?.evidenceUrl??source.url,tabId:saved.tabId,
   retry:!uncertain&&automationTrialReady(automation)&&automation.reviewedRevision===automation.revision?'source':null});
 }
 const latest=runs[0];
 if(!issues.length&&!activeRuns.length&&latest&&!(latest.kind==='trial'&&automation.trial?.status==='skipped'&&automationTrialReady(automation))&&['blocked','failed','timeout'].includes(latest.status)&&!latest.sourceUrl&&latest.revision===automation.revision){
  if(latest.usageLimit)return [limitIssue(latest,snapshot.workers?.find(w=>w.id===(latest.workerId??'main')),{...latest.usageLimit,automaticResume:false})];
  issues.push({id:latest.id,kind:latest.kind==='interview'?'setup':undefined,name:latest.kind==='trial'?'Kaynak denemesi':'Agent',message:latest.summary,workerId:latest.workerId,
   retryAt:automation.retryPlan?.[latest.id]?.at??null,
   url:latest.resumeContext?.url??latest.observations?.at(-1)?.url,tabId:latest.resumeContext?.tabId,
   retry:latest.kind==='trial'?'trial':null});
 }
 return issues;
}
