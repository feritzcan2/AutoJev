import {workerKey} from './worker-key.mjs';
// Shared provider task lifecycle; policies validate durable domain outcomes.
export class TaskRuns {
 constructor(policy,{launch,changed=()=>{},now=()=>Date.now(),concurrency=Infinity}={}){Object.assign(this,{policy,launch,changed,now,concurrency});this.active=new Map();this.closed=false;policy.recover();}
 slots(id){return [...this.active.values()].filter(s=>s.id===id);}
 slot(id,runId){return runId?this.slots(id).find(s=>s.run.id===runId):this.active.get(id);}
 async tick(){if(this.closed)return;for(const id of this.policy.due(this.now())){if(this.active.size>=this.concurrency)break;if(!this.active.has(id))void this.start(id).catch(()=>{});}}
 async start(id,input,workerId='main'){
  const key=workerKey(id,workerId);if(this.closed)throw Error('Uygulama kapanıyor');if(this.active.has(key))throw Error('Bu worker’ın görevi zaten çalışıyor');
  if(this.active.size>=this.concurrency)throw Error(`Aynı anda en fazla ${this.concurrency} görev çalışabilir`);
  const run=this.policy.begin(id,input,workerId),task=this.policy.config(id),slot={id,key,workerId,run,worker:null,controller:new AbortController(),finishing:false,ready:null};this.active.set(key,slot);this.changed(id);
  if(!run.interactive)slot.timer=setTimeout(()=>{void this.finish(id,'timeout','Tur süresi doldu. Devam etmek için sonucu kontrol et.',workerId).catch(()=>{});},task.timeoutMinutes*60000);
  slot.ready=Promise.resolve().then(()=>this.launch(run,task,event=>this.event(id,event,run.id),slot.controller.signal));
  try{slot.worker=await slot.ready;return run;}catch(error){if(!slot.finishing)await this.finish(id,'failed',error.message,workerId);throw error;}
 }
 event(id,event,runId){const slot=this.slot(id,runId);if(!slot||slot.finishing)return;
  const fail=message=>this.finish(id,'failed',message,slot.workerId).catch(()=>{});
  if(event.event==='state'){
   const state=String(event.state).replace(/^Some\((.*)\)$/,'$1');slot.run={...this.policy.run(slot.run.id),state};if(['Working','Compacting'].includes(state))slot.seenWorking=true;clearTimeout(slot.idleTimer);
   if(state==='Idle'&&slot.seenWorking&&!slot.completionRequested&&!slot.run.interactive)slot.idleTimer=setTimeout(()=>{if(!slot.completionRequested)void fail('Agent sonuç bildirmeden durdu. Agent ekranını kontrol et.');},2000);
   this.policy.save(slot.run);this.changed(id);
  }
  if(['eof','engine_exit'].includes(event.event)&&!slot.completionRequested)void fail('Agent oturumu sonuç bildirmeden kapandı.');
 }
 interactive(id){const slot=this.active.get(id);if(!slot||slot.finishing)throw Error('Etkin görev bulunamadı');slot.run={...this.policy.run(slot.run.id),interactive:true};slot.completionRequested=false;clearTimeout(slot.timer);clearTimeout(slot.idleTimer);clearTimeout(slot.completionTimer);this.policy.save(slot.run);this.changed(id);return slot;}
 complete(id,runId,status,summary,{goalReached=false}={}){
  const slot=this.slot(id,runId);if(!slot||slot.finishing||slot.completionRequested)throw Error('Etkin çalışma bulunamadı');
  if(slot.run.interactive){slot.run.summary=summary;slot.run.lastResult=status;clearTimeout(slot.idleTimer);this.policy.save(slot.run);this.changed(id);return {saved:true,conversationOpen:true};}
  const result=this.policy.report?.(id,runId,status,summary,goalReached);slot.completionRequested=true;clearTimeout(slot.idleTimer);
  if(result)slot.run=result;else{slot.run.summary=summary;this.policy.save(slot.run);}
  this.changed(id);slot.completionTimer=setTimeout(()=>{if(!slot.run.interactive)void this.finish(id,result?.status??status,result?.summary??summary,slot.workerId).catch(()=>{});},150);
  return {saved:true,status:result?.status??status,stop:true};
 }
 finish(id,status='interrupted',summary='Kullanıcı durdurdu.',workerId='main'){
  const slot=this.active.get(workerKey(id,workerId));if(!slot)return Promise.resolve();if(slot.finishing)return slot.finishPromise;
  slot.finishing=true;clearTimeout(slot.timer);clearTimeout(slot.idleTimer);clearTimeout(slot.completionTimer);slot.controller.abort();
  slot.finishPromise=(async()=>{
   try{const worker=slot.worker??await slot.ready?.catch(()=>null);await worker?.close();}catch(error){this.policy.closeFailed?.(id,slot.run.id,error);slot.finishing=false;this.changed(id);throw error;}
   this.policy.finish(id,slot.run.id,status,summary);this.active.delete(slot.key);this.changed(id);
  })();return slot.finishPromise;
 }
 async close(){this.closed=true;await Promise.all([...this.active.values()].map(s=>this.finish(s.id,'interrupted','Uygulama kapatıldı.',s.workerId)));}
}
