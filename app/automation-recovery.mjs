import {operationFor} from './template-contract.mjs';
import {sourceMode} from './automation-sources.mjs';

const legacyMessages=new Set(['Agent sonuç bildirmeden durdu. Agent ekranını kontrol et.','Agent oturumu sonuç bildirmeden kapandı.']);
function resumable(db,run){
 const a=db.get(run.automationId);
 if(run.kind!=='run'||!run.sourceUrl||run.recordId||run.actionId||!run.taskId||a.status!=='enabled'||!a.sources.includes(run.sourceUrl)||a.sourceSettings?.[run.sourceUrl]?.enabled===false)return false;
 const template=db.template(a.templateId);if(!template.workflow.some(step=>step.id===run.operation))return false;
 const step=operationFor(template,run.operation);
 return step.scope==='source'&&(step.effect==='read'||sourceMode(a,run.sourceUrl)==='observe')&&!db.results(a.id,{all:true}).some(r=>r.runId===run.id&&['executing','uncertain'].includes(r.status));
}

export function unreportedSourceRun(db,id,runId,reason,now){
 const run=db.run(runId);if(!resumable(db,run))return null;
 const task=db.store.workspaces.tasks.get(id,run.taskId),attempt=(task.recovery?.attempt??0)+1;
 // This delay only prevents a failing provider from spinning in a launch loop.
 // A running source task still has no duration, step or retry-count budget.
 const delay=[5000,15000,30000,60000][Math.min(attempt-1,3)],recovery={reason,attempt,readyAt:now+delay};
 const summary=`Agent oturumu kesildi. Kaydedilen noktadan ${delay/1000} saniye sonra otomatik devam edilecek.`;
 db.putRun({...run,recovery});return {status:'interrupted',summary};
}

export function retryTechnicalSource(db,id,runId,summary,now){
 const run=db.run(runId);if(!resumable(db,run))return null;
 const task=db.store.workspaces.tasks.get(id,run.taskId),attempt=(task.technicalRecovery?.attempt??0)+1;
 const delay=[30000,120000,600000,1800000][Math.min(attempt-1,3)];
 const recovery={reason:'technical_page',attempt,readyAt:now+delay};
 db.putRun({...run,recovery});
 db.store.workspaces.tasks.put({...task,technicalRecovery:recovery});
 return {status:'interrupted',summary:`Geçici tarama sorunu; kaydedilen adresler ${delay/60000<1?'30 saniye':delay/60000+' dakika'} sonra otomatik yeniden denenecek. ${summary}`.slice(0,6000)};
}

export function requeueSourceRun(db,run){return db.store.workspaces.tasks.atomic(()=>{
 const q=db.store.workspaces.tasks,task=q.get(run.automationId,run.taskId),a=db.get(run.automationId),state=a.sourceState?.[run.sourceUrl]??{};
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
  const recovered={...db.run(run.id),...outcome};db.putRun(recovered);requeueSourceRun(db,recovered);
 }
}

export function unreportedInterviewRun(db,id,runId){
 const run=db.run(runId);if(run.kind!=='interview')return null;
 const pending=(db.get(id).questions??[]).filter(q=>q.answer==null&&q.createdAt>=run.startedAt);
 if(!pending.length)return null;
 return {status:'completed',summary:'Kurulum soruları kaydedildi; form yanıtların bekleniyor.'};
}
