import {TaskRuns} from './task-runs.mjs';
import {workerKey} from './worker-key.mjs';
import {randomUUID} from 'node:crypto';
import {sourceInput} from './automation-sources.mjs';
// Template definitions select operations; the common queue owns dependencies,
// worker leases and record/source exclusivity. No template-name dispatch here.
export class WebTasks extends TaskRuns {
 constructor(db,options){super({
  recover:()=>{db.recover();for(const a of db.list())for(const task of db.store.workspaces.tasks.list(a.id,{states:['running','reported','paused']})){
   const queue=db.store.workspaces.tasks,scan=a.sourceState?.[task.sourceUrl]?.scan;
   if(task.completionState==='partial'&&scan?.pendingUrls.length&&a.status==='enabled')queue.put({...task,state:'pending',workerId:null,scan,completionState:null});
   else queue.finish(a.id,task.id,task.completionState??'interrupted','Önceki uygulama oturumu kapandı');
  }},config:id=>db.get(id),run:id=>db.run(id),save:run=>db.putRun(run),
  due:now=>db.list().filter(a=>a.status==='enabled'&&a.nextRunAt<=now).map(a=>a.id),
  begin:(id,input='run',worker)=>db.begin(id,input,worker),
  report:(id,runId,status,summary,goalReached)=>{const result=db.finish(id,runId,status,summary,{release:false});if(goalReached&&result.kind==='run'&&result.status==='completed')db.pause(id,'complete');return result;},
  finish:(id,runId,status,summary)=>{
   if(db.run(runId).status==='running')db.finish(id,runId,status,summary);
   const run=db.run(runId);if(!run.taskId)return;
   const queue=db.store.workspaces.tasks,task=queue.get(id,run.taskId);
   if(run.status==='partial'&&db.get(id).status==='enabled')queue.put({...task,state:'pending',workerId:null,scan:run.scan,completionState:null,summary:run.summary,createdAt:Date.now()});
   else queue.finish(id,run.taskId,run.status==='timeout'?'failed':run.status,run.summary);
  },
  closeFailed:(id,runId,error)=>{const run=db.run(runId),summary='Oturum kapatılamadı: '+error.message;if(run.status==='running')db.finish(id,runId,'failed',summary);else db.putRun({...run,status:'failed',summary});if(run.taskId){const q=db.store.workspaces.tasks;q.put({...q.get(id,run.taskId),state:'paused'});}db.pause(id,'blocked');}
 },options);this.db=db;this.queue=db.store.workspaces.tasks;this.workers=db.store.workspaces.workers;this.dispatching=false;}
 plan(id,batchId,source){
  const a=this.db.get(id),template=this.db.template(a.templateId),tasks=this.queue.list(id,{batchId});
  for(const step of template.workflow){
   const subjects=step.scope==='source'?[{key:source.url,sources:[source.url]}]:this.db.results(id,{all:true}).filter(r=>!r.trial&&!['completed','uncertain','executing','dismissed'].includes(r.status)&&(r.sourceUrl?r.sourceUrl===source.url:new URL(r.url).origin===new URL(source.url).origin)).map(r=>({key:r.id,recordId:r.id,sources:[r.url]}));
   for(const subject of subjects){
    const parents=tasks.filter(t=>step.after.includes(t.operation)&&(!t.recordId||!subject.recordId||t.recordId===subject.recordId));
    if(step.after.some(parent=>!parents.some(t=>t.operation===parent))||parents.some(t=>t.state!=='completed'))continue;
    if(subject.recordId){const record=this.db.result(id,subject.recordId);if(step.capability==='browser.prepare'&&source.mode==='observe'||step.capability==='browser.act'&&(source.mode==='observe'||record.status!=='prepared'||source.mode==='prepare'&&record.approvedDigest!==record.digest))continue;}if(tasks.some(t=>t.operation===step.id&&t.subject===subject.key))continue;
    const task=this.queue.enqueue(id,{batchId,sourceUrl:source.url,operation:step.id,capability:step.capability,subject:subject.key,recordId:subject.recordId,sources:subject.sources,lockKey:(subject.recordId?'record:':'source:')+subject.key,dependsOn:parents.map(t=>t.id)});tasks.push(task);
   }
  }return tasks;
 }
 sourceState(id,url,patch){const a=this.db.get(id);return this.db.put({...a,sourceState:{...a.sourceState,[url]:{...a.sourceState?.[url],...patch}}});}
 resetSources(id,urls){
  const a=this.db.get(id);for(const task of this.queue.list(id,{states:['pending']}))if(!task.sourceUrl||urls.includes(task.sourceUrl))this.queue.finish(id,task.id,'cancelled','Yeni kaynak turu');
  for(const url of urls)this.sourceState(id,url,{batchId:null,blocked:false,nextRunAt:this.now()});
  return a;
 }
 async tick(){
  if(this.closed||this.dispatching)return;this.dispatching=true;
  try{for(const a of this.db.list()){
   if(a.status!=='enabled')continue;if(a.endAt&&a.endAt<=this.now()){await this.pause(a.id,'complete');continue;}
   if(this.slots(a.id).some(s=>s.run.kind!=='run'))continue;
   const pending=[];
   for(const source of this.db.sources(a.id)){
    if(!source.enabled||a.onceSources&&!a.onceSources.includes(source.url))continue;
    let batchId=source.batchId;
    if(!batchId){
     if(source.blocked||source.nextRunAt>this.now()||a.once&&source.onceCompleted)continue;
     batchId=randomUUID();this.sourceState(a.id,source.url,{batchId});
    }
    const tasks=source.blocked?this.queue.list(a.id,{batchId}):this.plan(a.id,batchId,source);
    if(source.blocked)for(const task of tasks.filter(t=>t.state==='pending'))this.queue.finish(a.id,task.id,'cancelled','Kaynak engellendi');
    const waiting=source.blocked?[]:tasks.filter(t=>t.state==='pending');
    if(!waiting.length&&!this.slots(a.id).some(s=>s.run.batchId===batchId)){
     const blocked=source.blocked||tasks.some(t=>['blocked','failed','interrupted'].includes(t.state));
     this.sourceState(a.id,source.url,{batchId:null,blocked,nextRunAt:blocked?null:this.now()+source.intervalMinutes*60000,onceCompleted:Boolean(a.once)});
    }else pending.push(...waiting);
   }
   const sources=this.db.sources(a.id),eligible=sources.filter(s=>s.enabled&&(!a.onceSources||a.onceSources.includes(s.url)));
   if(a.once&&!this.slots(a.id).length&&!pending.length&&eligible.every(s=>s.blocked||s.onceCompleted)){
    this.db.put({...this.db.get(a.id),once:false,onceSources:null,status:'paused',nextRunAt:null});this.changed(a.id);continue;
   }
   const next=sources.filter(s=>s.enabled&&!s.blocked).map(s=>s.nextRunAt??this.now());
   this.db.put({...this.db.get(a.id),nextRunAt:next.length?Math.min(...next):null});
   pending.sort((x,y)=>x.createdAt-y.createdAt);
   for(const worker of this.workers.list(a.id)){
    if(worker.enabled===false||this.active.has(workerKey(a.id,worker.id))||this.active.size>=this.concurrency)continue;
    const task=pending.shift();if(!task)break;
    // Reservation occurs synchronously inside start before provider awaits.
    void this.start(a.id,{kind:'run',taskId:task.id},worker.id).catch(()=>{});
   }
  }}finally{this.dispatching=false;}
 }
 async runOnce(id){this.db.enable(id);const urls=this.db.sources(id).filter(s=>s.enabled).map(s=>s.url);this.resetSources(id,urls);for(const url of urls)this.sourceState(id,url,{onceCompleted:false});this.db.put({...this.db.get(id),once:true,onceSources:urls});await this.tick();return this.slots(id)[0]?.run??null;}
 async runSource(id,url){
  const source=this.db.sources(id).find(s=>s.url===url);if(!source)throw Error('Kaynak bu çalışma alanına ait değil');if(!source.enabled)throw Error('Önce kaynağı aç');
  if(this.slots(id).some(s=>s.run.sourceUrl===url))throw Error('Bu kaynak zaten çalışıyor');
  const a=this.db.get(id);if(a.status!=='enabled'){this.db.enable(id);this.db.put({...this.db.get(id),once:true,onceSources:[url]});}
  else if(a.once)this.db.put({...a,onceSources:[...new Set([...(a.onceSources??a.sources),url])]});
  this.resetSources(id,[url]);this.sourceState(id,url,{onceCompleted:false});await this.tick();return this.db.sources(id).find(s=>s.url===url);
 }
 async saveSource(id,url,input){
  // Validate before stopping anything. Turning a source off only stops its workers.
  sourceInput(this.db.get(id),url,input);
  if(input.enabled===false){for(const slot of this.slots(id).filter(s=>s.run.sourceUrl===url))await this.finish(id,'interrupted','Kaynak kapatıldı.',slot.workerId);for(const task of this.queue.list(id,{states:['pending']}))if(task.sourceUrl===url)this.queue.finish(id,task.id,'cancelled','Kaynak kapatıldı');this.sourceState(id,url,{batchId:null});}
  const before=this.db.sources(id).find(s=>s.url===url);this.db.saveSource(id,url,input);
  if(input.enabled===true&&!before.enabled)this.resetSources(id,[url]);
  this.changed(id);await this.tick();return this.db.sources(id).find(s=>s.url===url);
 }
 async message(id,text,workerId='main'){await this.pause(id);this.db.message(id,'user',text);this.changed(id);return this.start(id,'interview',workerId);}
 report(id,runId,status,summary,goalReached=false){return this.complete(id,runId,status,summary,{goalReached});}
 async pause(id,status='paused'){
  this.db.pause(id,status);await Promise.all(this.slots(id).map(slot=>this.finish(id,'interrupted','Kullanıcı durdurdu.',slot.workerId)));
  for(const task of this.queue.list(id,{states:['pending']}))this.queue.finish(id,task.id,'cancelled','Çalışma durduruldu');
  for(const source of this.db.sources(id))this.sourceState(id,source.url,{batchId:null});
  this.db.put({...this.db.get(id),batchId:null,once:false,onceSources:null});this.changed(id);
 }
 async add(id,input){const worker=this.workers.add(id,input);this.changed(id);await this.tick();return worker;}
 async startWorker(id,worker){this.workers.get(id,worker);this.workers.setEnabled(id,worker,true);const a=this.db.get(id);if(a.trial?.status!=='passed')return this.start(id,'trial',worker);if(a.status!=='enabled'){this.db.enable(id);this.resetSources(id,this.db.sources(id).filter(s=>s.enabled&&!s.blocked).map(s=>s.url));}await this.tick();}
 async stopWorker(id,worker){this.workers.get(id,worker);this.workers.setEnabled(id,worker,false);await this.finish(id,'interrupted','Worker durduruldu.',worker);this.changed(id);}
 async remove(id,worker){if(worker==='main')throw Error('İlk worker kaldırılamaz.');await this.stopWorker(id,worker);this.workers.remove(id,worker);this.changed(id);}
}
