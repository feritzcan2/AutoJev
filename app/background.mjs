export class BackgroundJobs {
 constructor(db,{launch,changed=()=>{},now=()=>Date.now()}){Object.assign(this,{db,launch,changed,now});this.active=new Map();this.closed=false;db.recover();}
 async tick(){if(this.closed)return;for(const p of this.db.store.candidates()){const task=this.db.task(p.id);if(task.enabled&&task.nextRunAt<=this.now()&&!this.active.has(p.id)&&(task.skillPath||!task.connection||task.connection.status==='ready')){void this.start(p.id).catch(()=>{});}}}
 async start(id,{interactive=false,message=null,previousRunId=null}={}){
  if(this.closed)throw Error('Uygulama kapanıyor');if(this.active.has(id))throw Error('Bu görev zaten çalışıyor');
  const run=this.db.begin(id);Object.assign(run,{interactive,message,previousRunId});this.db.putRun(run);const task=this.db.task(id),slot={run,worker:null,controller:new AbortController(),finishing:false,ready:null};this.active.set(id,slot);this.changed(id);
  if(!interactive)slot.timer=setTimeout(()=>{void this.finish(id,'timeout','Süre sınırı aşıldı.');},task.timeoutMinutes*60000);
  slot.ready=Promise.resolve().then(()=>this.launch(run,task,event=>this.event(id,event),slot.controller.signal));
  try{slot.worker=await slot.ready;return run;}catch(error){if(!slot.finishing)await this.finish(id,'failed',error.message);throw error;}
 }
 event(id,event){const slot=this.active.get(id);if(!slot||slot.finishing)return;
  if(event.event==='state'){const state=event.state.replace(/^Some\((.*)\)$/,'$1');slot.run.state=state;if(['Working','Compacting'].includes(state))slot.seenWorking=true;if(state==='Idle'&&slot.seenWorking&&!slot.completionRequested&&!slot.run.interactive){clearTimeout(slot.idleTimer);slot.idleTimer=setTimeout(()=>{if(!slot.completionRequested)void this.finish(id,'failed','Agent turu sonuç bildirmeden bitti; terminal kaydını kontrol et.');},1500);}this.db.putRun(slot.run);this.changed(id);}
  if(['eof','engine_exit'].includes(event.event))void this.finish(id,'failed','Agent sonuç bildirmeden kapandı.');
 }
 async message(id,text,runId){
  if(typeof text!=='string'||!text.trim()||text.length>12000)throw Error('1–12000 karakter arasında mesaj yaz');
  if(runId&&this.db.run(runId)?.candidateId!==id)throw Error('Çalışma bu adaya ait değil');
  let slot=this.active.get(id);
  if(slot){if(slot.finishing)throw Error('Oturum kapanıyor; birazdan yeniden gönder');if(runId&&slot.run.id!==runId)throw Error('Mesaj göndermek için çalışan oturumu seç');slot.run.interactive=true;clearTimeout(slot.timer);clearTimeout(slot.idleTimer);this.db.putRun(slot.run);this.changed(id);const worker=slot.worker??await slot.ready;if(slot.finishing)throw Error('Oturum kapandı; yeniden gönder');await worker.message(text.trim());return slot.run;}
  return this.start(id,{interactive:true,message:text.trim(),previousRunId:runId??null});
 }
 complete(id,runId,summary,status='completed'){const slot=this.active.get(id);if(!slot||slot.run.id!==runId||slot.finishing)throw Error('Etkin görev bulunamadı');if(slot.run.interactive){slot.run.summary=summary;slot.run.lastResult=status;slot.completionRequested=false;clearTimeout(slot.idleTimer);this.db.putRun(slot.run);this.changed(id);return{saved:true,conversationOpen:true};}slot.completionRequested=true;clearTimeout(slot.idleTimer);slot.run.summary=summary;this.db.putRun(slot.run);setTimeout(()=>{if(!slot.run.interactive)void this.finish(id,status,summary);},100);return{saved:true};}
 finish(id,status,summary){const slot=this.active.get(id);if(!slot)return Promise.resolve();if(slot.finishing)return slot.finishPromise;slot.finishing=true;clearTimeout(slot.timer);clearTimeout(slot.idleTimer);slot.controller.abort();slot.finishPromise=(async()=>{
  try{const worker=slot.worker??await slot.ready?.catch(()=>null);await worker?.close();}catch(error){status='failed';summary=`Oturum kapatılamadı: ${error.message}`;}
  Object.assign(slot.run,{status,summary:String(summary).slice(0,3000),finishedAt:this.now()});this.db.putRun(slot.run);const task=this.db.task(id);this.db.putTask(id,{...task,nextRunAt:this.now()+task.intervalMinutes*60000});this.active.delete(id);this.changed(id);
 })();return slot.finishPromise;}
 async close(){this.closed=true;await Promise.all([...this.active.keys()].map(id=>this.finish(id,'interrupted','Uygulama kapatıldı.')));}
}
