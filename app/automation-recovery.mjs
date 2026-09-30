import {operationFor} from './template-contract.mjs';
import {sourceMode} from './automation-sources.mjs';

const TECHNICAL_RETRY_LIMIT=3;
const exhaustedSummary='Erişim sorunu sürüyor. 3 tarama turu teknik hatayla sonuçlandı; otomatik deneme durduruldu. İlerleme korundu. Devam etmek için Tekrar dene’ye bas.';

function exhaustTechnicalRetries(db,run,attempt,summary){
 const id=run.automationId,task=db.store.workspaces.tasks.get(id,run.taskId),a=db.get(id),state=a.sourceState?.[run.sourceUrl]??{};
 const stop={...run.stop,kind:'technical',retryExhausted:true,evidence:summary};
 db.putRun({...run,recovery:null,stop});
 db.store.workspaces.tasks.put({...task,retryAt:null,technicalRecovery:{reason:'technical_page',attempt,readyAt:null,exhausted:true}});
 const retryPlan={...a.retryPlan};delete retryPlan[run.sourceUrl];
 db.put({...a,retryPlan,sourceState:{...a.sourceState,[run.sourceUrl]:{...state,blocked:true,siteBlocked:false,recovery:null,nextRunAt:null,lastStatus:'blocked',lastResult:exhaustedSummary,lastRunId:run.id,blocker:{...run.resumeContext,runId:run.id,workerId:run.workerId,stop}}}});
 return {status:'blocked',summary:exhaustedSummary};
}

// Apply the limit to retries saved by earlier app versions before dispatch.
export function recoverExhaustedSourceRetries(db){
 for(const a of db.list())for(const task of db.store.workspaces.tasks.list(a.id,{states:['pending']})){
  if(task.recordId||!task.sourceUrl||(task.technicalRecovery?.attempt??0)<TECHNICAL_RETRY_LIMIT)continue;
  const run=db.runs(a.id).find(r=>r.taskId===task.id&&!r.recordId);if(!run||run.status==='running')continue;
  const outcome=exhaustTechnicalRetries(db,run,task.technicalRecovery.attempt,run.summary);
  db.putRun({...db.run(run.id),...outcome});
  db.store.workspaces.tasks.finish(a.id,task.id,'blocked',outcome.summary);
 }
}

const legacyMessages=new Set(['Agent sonuç bildirmeden durdu. Agent ekranını kontrol et.','Agent oturumu sonuç bildirmeden kapandı.']);
function resumable(db,run){
 const a=db.get(run.automationId);
 if(!['run','trial'].includes(run.kind)||!run.sourceUrl||run.recordId||run.actionId||!run.taskId||a.status!=='enabled'||!a.sources.includes(run.sourceUrl)||a.sourceSettings?.[run.sourceUrl]?.enabled===false)return false;
 if(run.kind==='trial')return true;
 const template=db.template(a.templateId);if(!template.workflow.some(step=>step.id===run.operation))return false;
 const step=operationFor(template,run.operation);
 return step.scope==='source'&&(step.effect==='read'||sourceMode(a,run.sourceUrl)==='observe')&&!db.results(a.id,{all:true}).some(r=>r.runId===run.id&&['executing','uncertain'].includes(r.status));
}

export function continueSourceRun(db,id,runId){
 const run=db.run(runId);
 if(!resumable(db,run)||Object.keys(run.scanIssues??{}).length||(db.get(id).questions??[]).some(q=>q.answer==null&&q.taskId===run.taskId))return null;
 return 'The same assigned source task is still open; no restart or new task occurred. Continue from the current page and saved checkpoint. Do not reread unchanged context or documents. If your last finish_automation_run was rejected, inspect its error, correct only the missing report or continue the remaining work. For an actual browser failure use recheck_scan_page and report the returned technical issue. Do not repeat an unchanged failed action or submit anything.';
}

export function unreportedSourceRun(db,id,runId,reason,now){
 const run=db.run(runId);if(!resumable(db,run))return null;
 const issues=Object.values(run.scanIssues??{}).filter(issue=>issue.verified||issue.kind==='browser_error');
 if(issues.length){
  const pendingUrls=[...new Set([...(run.scan?.pendingUrls??[]),...issues.map(issue=>issue.url)])];
  const summary=`Sayfa yüklenemedi; yeniden denenecek: ${issues[0].url}`;
  db.persistScan(id,{...run,scan:{...run.scan,complete:false,pendingUrls,reason:summary,evidenceUrl:run.scan?.evidenceUrl??issues[0].url}});
  return retryTechnicalSource(db,id,runId,summary,now);
 }
 const task=db.store.workspaces.tasks.get(id,run.taskId),attempt=(task.recovery?.attempt??0)+1;
 // This delay only prevents a failing provider from spinning in a launch loop.
 // A running source task still has no duration, step or retry-count budget.
 const delay=[5000,15000,30000,60000][Math.min(attempt-1,3)],recovery={reason,attempt,readyAt:now+delay};
 const summary=`Agent oturumu kesildi. Kaydedilen noktadan ${delay/1000} saniye sonra otomatik devam edilecek.`;
 db.putRun({...run,recovery});return {status:'interrupted',summary};
}

export const technicalRetryDelay=attempt=>[30000,120000,600000,1800000][Math.min(Math.max(attempt-1,0),3)];

export function retryTechnicalSource(db,id,runId,summary,now){
 const run=db.run(runId);if(!resumable(db,run))return null;
 const task=db.store.workspaces.tasks.get(id,run.taskId),attempt=(task.technicalRecovery?.attempt??0)+1;
 if(attempt>=TECHNICAL_RETRY_LIMIT)return exhaustTechnicalRetries(db,run,attempt,summary);
 const delay=technicalRetryDelay(attempt),urls=[...new Set(Object.values(run.scanIssues??{}).filter(issue=>issue.verified||issue.kind==='browser_error').map(issue=>issue.url))];
 const recovery={reason:'technical_page',attempt,urls,readyAt:now+delay};
 db.putRun({...run,recovery});
 db.store.workspaces.tasks.put({...task,technicalRecovery:recovery});
 return {status:'interrupted',summary:`Geçici tarama sorunu; kaydedilen adresler ${delay/60000<1?'30 saniye':delay/60000+' dakika'} sonra otomatik yeniden denenecek. ${summary}`.slice(0,6000)};
}

export function requeueSourceRun(db,run){return db.store.workspaces.tasks.atomic(()=>{
 const q=db.store.workspaces.tasks,task=q.get(run.automationId,run.taskId),a=db.get(run.automationId),state=a.sourceState?.[run.sourceUrl]??{};
 if(run.stopRequested||task.stopRequested)return q.finish(run.automationId,task.id,'cancelled','Tarama kullanıcı tarafından durduruldu.');
 q.put({...task,state:'pending',workerId:null,scan:run.scan??task.scan,scanPlan:run.scanPlan??task.scanPlan,completionState:null,summary:run.summary,retryAt:run.recovery?.readyAt??null,...(run.recovery?{recovery:run.recovery}:{})});
 if(run.recovery)db.put({...a,sourceState:{...a.sourceState,[run.sourceUrl]:{...state,batchId:task.batchId,blocked:false,blocker:null,lastStatus:'interrupted',lastResult:run.summary,lastRunId:run.id,nextRunAt:run.recovery.readyAt,recovery:run.recovery}}});
});}

export function recoverUnreportedSources(db,now){
 // Upgrade only the specific app-generated failure. CAPTCHA, explicit failures
 // and a user's paused workspace remain untouched.
 for(const a of db.list().filter(a=>a.status==='enabled'))for(const state of Object.values(a.sourceState??{})){
  if(!state.blocked||!state.lastRunId||!legacyMessages.has(state.lastResult))continue;
  const run=db.run(state.lastRunId);if(run.status!=='failed')continue;
  if(a.retryPlan?.[run.sourceUrl]||db.runs(a.id).some(r=>r.sourceUrl===run.sourceUrl&&r.status==='running'))continue;
  const outcome=unreportedSourceRun(db,a.id,run.id,'legacy_unreported',now);if(!outcome)continue;
  const recovered={...db.run(run.id),...outcome};db.putRun(recovered);if(outcome.status==='blocked')db.store.workspaces.tasks.finish(a.id,run.taskId,'blocked',outcome.summary);else requeueSourceRun(db,recovered);
 }
}

export function unreportedInterviewRun(db,id,runId){
 const run=db.run(runId);if(run.kind!=='interview')return null;
 const pending=(db.get(id).questions??[]).filter(q=>q.answer==null&&q.createdAt>=run.startedAt);
 if(!pending.length)return null;
 return {status:'completed',summary:'Kurulum soruları kaydedildi; form yanıtların bekleniyor.'};
}
