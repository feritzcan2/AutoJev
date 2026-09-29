import {TaskRuns} from './task-runs.mjs';

export class BackgroundJobs extends TaskRuns {
 constructor(db,options){const now=options.now??(()=>Date.now());super({
  recover:()=>db.recover(),config:id=>db.task(id),run:id=>db.run(id),save:run=>db.putRun(run),
  due:at=>db.store.candidates().filter(p=>{const task=db.task(p.id);return task.enabled&&task.nextRunAt<=at&&(task.skillPath||!task.connection||task.connection.status==='ready');}).map(p=>p.id),
  begin:(id,{interactive=false,message=null,previousRunId=null}={})=>{const run={...db.begin(id),interactive,message,previousRunId};db.putRun(run);return run;},
  finish:(id,runId,status,summary)=>{db.putRun({...db.run(runId),status,summary:String(summary).slice(0,3000),finishedAt:now()});const task=db.task(id);db.putTask(id,{...task,nextRunAt:now()+task.intervalMinutes*60000});},
  closeFailed:(id,runId,error)=>db.putRun({...db.run(runId),status:'failed',summary:'Oturum kapatılamadı: '+error.message,finishedAt:now()})
 },options);this.db=db;}
 async message(id,text,runId){
  if(typeof text!=='string'||!text.trim()||text.length>12000)throw Error('1–12000 karakter arasında mesaj yaz');
  if(runId&&this.db.run(runId)?.candidateId!==id)throw Error('Çalışma bu adaya ait değil');
  let slot=this.active.get(id);
  if(slot){if(slot.finishing)throw Error('Oturum kapanıyor; birazdan yeniden gönder');if(runId&&slot.run.id!==runId)throw Error('Mesaj göndermek için çalışan oturumu seç');slot=this.interactive(id);const worker=slot.worker??await slot.ready;if(slot.finishing)throw Error('Oturum kapandı; yeniden gönder');await worker.message(text.trim());return slot.run;}
  return this.start(id,{interactive:true,message:text.trim(),previousRunId:runId??null});
 }
 complete(id,runId,summary,status='completed'){return super.complete(id,runId,status,summary);}
}
