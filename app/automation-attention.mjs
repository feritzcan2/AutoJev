// Durable source failures remain visible even while other workers are running.
export function automationAttention(snapshot){
 const {automation={},sources=[],runs=[],activeRuns=[]}=snapshot??{};
 const issues=[];
 for(const source of sources){
  if(!source.enabled||!source.blocked||source.scanning)continue;
  const run=runs.find(r=>r.id===source.lastRunId)??runs.find(r=>r.sourceUrl===source.url&&r.status!=='running');
  const saved=source.blocker??run?.resumeContext??{};
  const uncertain=Boolean(saved.recordId??run?.recordId)||snapshot.results?.some(r=>r.sourceUrl===source.url&&['executing','uncertain'].includes(r.status));
  issues.push({id:source.url,sourceUrl:source.url,name:source.name,workerId:saved.workerId??run?.workerId,
   retryAt:automation.retryPlan?.[source.url]?.at??null,
   closing:activeRuns.some(r=>r.sourceUrl===source.url||r.id===run?.id),
   message:source.lastResult??run?.summary??'Bu kaynakta devam etmek için müdahale gerekiyor.',
   url:saved.url??run?.observations?.at(-1)?.url??source.scan?.evidenceUrl??source.url,tabId:saved.tabId,
   retry:!uncertain&&automation.trial?.status==='passed'&&automation.reviewedRevision===automation.revision?'source':null});
 }
 const latest=runs[0];
 if(!issues.length&&!activeRuns.length&&latest&&['blocked','failed','timeout'].includes(latest.status)&&!latest.sourceUrl&&latest.revision===automation.revision){
  issues.push({id:latest.id,name:latest.kind==='trial'?'Kaynak denemesi':'Agent',message:latest.summary,
   retryAt:automation.retryPlan?.[latest.id]?.at??null,
   url:latest.resumeContext?.url??latest.observations?.at(-1)?.url,tabId:latest.resumeContext?.tabId,
   retry:latest.kind==='trial'?'trial':null});
 }
 return issues;
}
