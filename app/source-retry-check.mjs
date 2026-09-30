import {technicalRetryDelay} from './automation-recovery.mjs';

// Readiness checks run without an LLM or a worker lease. One in-flight check
// per durable task; a late result cannot revive a stopped or changed workspace.
export class SourceRetryChecks {
 constructor(db,{probe,now=Date.now,changed=()=>{},isClosed=()=>false}={}){Object.assign(this,{db,probe,now,changed,isClosed});this.pending=new Map();}
 ready(id,task){
  if(!this.probe||!task.technicalRecovery)return true;
  const a=this.db.get(id),recovery=task.technicalRecovery;
  if(recovery.probe?.ready&&recovery.probe.revision===a.revision&&this.now()-recovery.probe.at<30000)return true;
  if(this.pending.has(task.id)||task.retryAt>this.now())return false;
  const request=task.retryAt,revision=a.revision;
  const work=Promise.resolve().then(()=>this.probe(id,task)).then(result=>{
   if(this.isClosed())return;
   const current=this.db.get(id),queue=this.db.store.workspaces.tasks,saved=queue.get(id,task.id),source=current.sourceState?.[task.sourceUrl];
   if(current.revision!==revision||current.status!=='enabled'||!current.sources.includes(task.sourceUrl)||current.sourceSettings?.[task.sourceUrl]?.enabled===false||source?.stopping||source?.blocked||saved.state!=='pending'||saved.stopRequested||saved.retryAt!==request)return;
   const checkedAt=this.now(),probeAttempts=(saved.technicalRecovery?.probeAttempts??0)+(result.ready||result.deferred?0:1);
   const retryAt=result.ready?null:checkedAt+(result.deferred?5000:technicalRetryDelay(probeAttempts+1));
   const technicalRecovery={...saved.technicalRecovery,probeAttempts,readyAt:retryAt,probe:{ready:result.ready===true,at:checkedAt,revision,evidence:String(result.evidence??'').slice(0,600)}};
   queue.put({...saved,retryAt,technicalRecovery});
   if(!result.deferred)this.db.put({...current,sourceState:{...current.sourceState,[task.sourceUrl]:{...source,recovery:{...technicalRecovery,reason:'technical_page'},nextRunAt:retryAt??checkedAt,lastResult:result.ready?'Sayfa yeniden erişilebilir; kaydedilen görev devam edecek.':'Sayfa hâlâ yüklenemiyor. Agent açılmadan yeniden kontrol edilecek.'}}});
   this.changed(id);
  }).catch(()=>{
   // A failed readiness service is not permission to start a provider. Retry
   // its check later; do not enqueue a second copy of the source task.
   if(this.isClosed())return;
   try{const queue=this.db.store.workspaces.tasks,saved=queue.get(id,task.id);if(saved.state==='pending'&&saved.retryAt===request&&this.db.get(id).revision===revision)queue.put({...saved,retryAt:this.now()+30000});}catch{}
  }).finally(()=>this.pending.delete(task.id));
  this.pending.set(task.id,work);return false;
 }
}
