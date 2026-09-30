import {automationTrialReady} from './automation-trial.mjs';
import {publicSession} from './agent-sessions.mjs';
import {workerKey} from './worker-key.mjs';
import {automationProgress,runKindLabel,runOperationLabel} from './automation-progress.mjs';

// Web execution state uses the shared workspace and worker presentation contract.
export function webWorkspaceView(snapshot,agents){
 const {automation:a,runs,activeRun:run}=snapshot;
 const progress=automationProgress(snapshot),title=progress.title;
 const execution={status:run||a.status==='enabled'?'running':a.status,note:run?a.goal:runs[0]?.summary??'Agent’a ne yapmak istediğini anlat.',intervalMinutes:a.intervalMinutes,task:run?{id:run.id,kind:run.kind,createdAt:run.startedAt}:null};
 const workers=(snapshot.workers??[{id:'main',name:'Worker 1'}]).map(worker=>{
   const slotRun=(snapshot.activeRuns??[run]).find(r=>r&&(r.workerId??'main')===worker.id),ownRun=runs.find(r=>r.id===slotRun?.id)??slotRun,ownSession=agents.sessions.get(workerKey(a.id,worker.id));
   const ownActive=publicSession(ownSession);
   const waiting=!ownRun&&!ownActive&&worker.enabled!==false&&execution.status==='running';
   return {...worker,active:ownActive,execution:{...execution,...(worker.enabled===false?{status:'paused'}:{}),task:ownRun?{id:ownRun.id,kind:ownRun.kind,operation:ownRun.operation,createdAt:ownRun.startedAt}:null},presentation:{pageProgress:ownRun?.pageProgress??null,title:waiting?'Sıradaki görev bekleniyor':ownRun?runOperationLabel(ownRun.operation,ownRun.kind):title,status:ownActive?'Çalışıyor':waiting?'Görev bekliyor':progress.label,startLabel:worker.id==='main'?progress.primary?.label:'Worker’ı başlat',detail:waiting?'Worker açık; çalışan agent oturumu yok. Uygun görev geldiğinde otomatik başlayacak.':ownRun?(ownRun.sources??[]).join(' · '):progress.next,outcome:!waiting&&!ownRun&&progress.finishedRun?{id:progress.finishedRun.id,title:progress.title,detail:progress.next,tone:progress.tone}:null}};
  });
 return {...snapshot,progress,template:{id:a.templateId,kind:'web'},
  capabilities:{maxWorkers:snapshot.definition?.execution.maxWorkers??8,canStart:true,canRestart:automationTrialReady(a),browserModes:snapshot.definition?.execution.browserModes??['separate','jev'],documents:true,terminalConversation:true,workerRestart:false,workerDescription:'Agent, çalışma alanının kaynaklarını ve kayıtlarını takip eder.'},
  active:workers.find(w=>w.active?.sessionId===run?.id)?.active??workers.find(w=>w.active)?.active??null,execution,workers,
  activity:{title,detail:progress.detail,state:progress.label,tone:progress.tone,running:Boolean(run?.startedAt),at:(run?.startedAt??progress.finishedRun?.finishedAt)?new Date(run?.startedAt??progress.finishedRun.finishedAt).toISOString():null,url:null,history:runs.slice(0,10).map(r=>({at:r.startedAt,kind:'agent_activity',data:{message:`${runKindLabel(r.kind)} · ${r.summary}`}}))}
 };
}
