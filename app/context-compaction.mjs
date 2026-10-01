export const DEFAULT_COMPACT_PERCENT=0;
export function contextCompactPercent(value=DEFAULT_COMPACT_PERCENT){
 if(!Number.isInteger(value)||value<0||value>100)throw Error('Compaction eşiği 0 (kapalı) veya %1–100 olmalı.');
 return value;
}
export const compactionPending=session=>['sending','submitted','running_command','compacting'].includes(session?.compaction?.state);

// One native command per crossing. A PTY receipt is delivery, not proof that
// the provider compacted. Only a fresh lower measurement rearms the trigger.
export class ContextCompaction {
 constructor({send,changed=()=>{},event=()=>{},settled=()=>{},now=()=>Date.now()}){Object.assign(this,{send,changed,event,settled,now});}
 update(session,patch){session.compaction={...session.compaction,...patch};this.changed(session.candidateId);}
 signal(session,state){
  const c=session.compaction;
  if(!c)return false;
  if(state==='Compacting'&&compactionPending(session)){
   this.update(session,{state:'compacting',startedAt:this.now(),idleAt:null});return true;
  }
  // Codex reports the manual compaction turn as Working. After the original
  // turn's Idle, this turn belongs to the queued command, not campaign work.
  if(c.state==='submitted'&&c.idleAt!=null&&state==='Working'){
   this.update(session,{state:'running_command',startedAt:this.now()});return true;
  }
  if(['compacting','running_command'].includes(c.state)&&['Idle','Working','Interrupted'].includes(state)){
   this.update(session,{state:'awaiting_usage',finishedAt:this.now()});
   this.event(session.candidateId,'agent_context_compact_finished',{workerId:session.workerId??'main',provider:session.provider,sessionId:session.sessionId});
   if(state==='Idle')this.settled(session);
   return state!=='Working';
  }
  if(c.state==='submitted'&&['Idle','Interrupted'].includes(state))c.idleAt??=this.now();
  return false;
 }
 delivery(session,result){
  if(!compactionPending(session))return;
  if(result.state==='submitted'){
   // PreCompact may have arrived before the transport receipt.
   if(session.compaction.state==='sending')this.update(session,{state:'submitted',sentAt:this.now(),idleAt:['Idle','Interrupted'].includes(session.state)?this.now():null});
  }else if(result.state==='failed'){
   this.update(session,{state:'unconfirmed',error:result.error});
   this.event(session.candidateId,'agent_context_compact_unconfirmed',{workerId:session.workerId??'main',provider:session.provider,error:result.error});
  }
 }
 async tick(session,usage,threshold=DEFAULT_COMPACT_PERCENT){
  let c=session.compaction;
  const fresh=usage?.caughtUp&&!usage.pending&&Number.isFinite(usage.percent)&&usage.updatedAt!=null;
  if(c&&usage?.caughtUp&&usage.compactionId&&usage.compactionId!==c.compactionId&&c.state!=='verified'){
   this.update(session,{state:'verified',finishedAt:this.now(),compactionId:usage.compactionId});
   c=session.compaction;
  }
  // Never immediately recompact a summary that still exceeds a low threshold.
  if(c?.latched&&fresh&&usage.updatedAt>c.sampleAt&&usage.percent<c.threshold){
   c.latched=false;
   if(['submitted','awaiting_usage'].includes(c.state))this.update(session,{state:'completed',finishedAt:this.now()});
  }
  if(c?.state==='submitted'&&c.idleAt!=null&&this.now()-c.idleAt>30000)
   this.update(session,{state:'unconfirmed',error:'Komut gönderildi; compaction başlangıcı doğrulanamadı.'});
  if(!threshold||!fresh||usage.percent<threshold||compactionPending(session)||c?.latched)return;
  if(!['Working','Idle','Interrupted'].includes(session.state))return;
  if(c?.retryAt>this.now())return;
  this.update(session,{state:'sending',threshold,percent:usage.percent,sampleAt:usage.updatedAt,compactionId:usage.compactionId??null,latched:true,error:null,idleAt:null});
  try{
   const result=await this.send(session);
   if(result?.deferred){
    this.update(session,{state:'waiting',latched:false,retryAt:this.now()+2000,error:result.reason});return;
   }
   this.event(session.candidateId,'agent_context_compact_requested',{workerId:session.workerId??'main',provider:session.provider,sessionId:session.sessionId,percent:usage.percent,thresholdPercent:threshold});
  }catch(error){
   // The writer may already have accepted the bytes. Never retry an unknown
   // outcome against the same high sample.
   this.update(session,{state:'unconfirmed',error:error.message});
   this.event(session.candidateId,'agent_context_compact_unconfirmed',{workerId:session.workerId??'main',provider:session.provider,error:error.message});
  }
 }
}
