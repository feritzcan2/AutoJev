import {Campaigns} from './campaign.mjs';
import {MAIN_WORKER} from './worker-state.mjs';

// One existing campaign state machine per worker. A synchronous task reservation
// in WorkerState prevents controllers from selecting the same job or source.
export class WorkerCampaigns {
  constructor(store,options){this.store=store;this.options=options;this.controllers=new Map();this._closed=false;this.busy=false;this.changing=new Set();this.epochs=new Map();this.pendingStarts=new Map();}
  forWorker(worker=MAIN_WORKER){
    if(!this.controllers.has(worker)){
      const controller=new Campaigns(this.store.forWorker(worker),{
        ...this.options,
        launch:(id,prompt,job)=>this.options.launch(id,prompt,job,worker),
        stop:id=>this.options.stop(id,worker),
        send:(text,id)=>this.options.send(text,id,worker),
        active:id=>this.options.active(id,worker),
        contextBusy:id=>this.options.contextBusy?.(id,worker)??false,
        rotateContext:(id,session,usage,threshold)=>this.options.rotateContext?.(id,session,usage,threshold,worker)
      });
      // Extra workers are registered under one candidate only.
      if(worker!==MAIN_WORKER){const scoped=controller.store;scoped.candidates=()=>this.store.candidates().filter(p=>this.store.workers(p.id).some(w=>w.id===worker));}
      controller.ensureRunning=id=>{const c=controller.store.campaign(id);return c?.status!=='running'&&c?.task?this.startWorker(id,worker):this.ensureRunning(id);};
      controller.closed=this._closed;this.controllers.set(worker,controller);
    }
    return this.controllers.get(worker);
  }
  get launching(){return new Set([...this.controllers.values()].flatMap(c=>[...c.launching]));}
  get closed(){return this._closed;}
  set closed(value){this._closed=value;for(const c of this.controllers.values())c.closed=value;}
  owner(id,jobId){return this.store.workerState.tasks(id).find(w=>w.task.jobId===jobId)?.workerId??MAIN_WORKER;}
  summary(id){
    const rows=this.store.workers(id).map(w=>({...w,campaign:this.store.forWorker(w.id).campaign(id)}));
    const first=rows[0].campaign,working=rows.find(w=>w.campaign?.status==='running'&&w.campaign.task),running=working??rows.find(w=>w.campaign?.status==='running');
    if(!running)return first??rows.find(w=>w.campaign)?.campaign??null;
    return {...running.campaign,target:first?.target??running.campaign.target,tasks:rows.filter(w=>w.campaign?.status==='running'&&w.campaign.task).map(w=>({...w.campaign.task,workerId:w.id})),note:rows.filter(w=>w.campaign?.status==='running').length>1?`${rows.filter(w=>w.campaign?.status==='running').length} worker çalışıyor. ${running.campaign.note}`:running.campaign.note};
  }
  async tick(){
    if(this.busy||this.closed)return;this.busy=true;
    try{for(const p of this.store.candidates())for(const w of this.store.workers(p.id))this.forWorker(w.id);
      // Sequential dispatch keeps source/job reservation before provider awaits.
      // Provider processes themselves run concurrently.
      for(const c of this.controllers.values())await c.tick();
    }finally{this.busy=false;}
  }
  startSettings(id,options){return this.forWorker().startSettings(id,options);}
  async start(id,options={}){
    if(this.changing.has(id))throw Error('Worker işlemi sürüyor; birazdan yeniden dene.');
    const settings=this.startSettings(id,options),epoch=(this.epochs.get(id)??0)+1;this.epochs.set(id,epoch);
    for(const w of this.store.workers(id)){if(this.epochs.get(id)!==epoch)break;await this.forWorker(w.id).start(id,settings);}
    return this.summary(id);
  }
  async ensureRunning(id){
    if(this.pendingStarts.has(id))return this.pendingStarts.get(id);
    if(this.store.workers(id).some(w=>this.store.forWorker(w.id).campaign(id)?.status==='running'))return this.tick();
    const start=Promise.resolve().then(()=>this.start(id));this.pendingStarts.set(id,start);
    try{return await start;}finally{if(this.pendingStarts.get(id)===start)this.pendingStarts.delete(id);}
  }
  async pause(id,status='paused'){
    this.epochs.set(id,(this.epochs.get(id)??0)+1);this.changing.add(id);
    try{await Promise.all(this.store.workers(id).map(w=>this.forWorker(w.id).pause(id,status)));}
    finally{this.changing.delete(id);}
  }
  async startWorker(id,worker){
    this.store.workerState.get(id,worker);
    if(this.changing.has(id))throw Error('Worker işlemi sürüyor.');
    const settings=this.store.campaign(id)??{};
    return this.forWorker(worker).start(id,{target:settings.target??100,intervalMinutes:settings.intervalMinutes??30});
  }
  async add(id,input){
    if(this.changing.has(id))throw Error('Worker işlemi sürüyor.');
    const running=this.summary(id)?.status==='running',worker=this.store.workerState.add(id,input);
    this.options.changed(id);
    if(running)await this.startWorker(id,worker.id);
    return worker;
  }
  async stopWorker(id,worker){
    this.store.workerState.get(id,worker);if(this.changing.has(id))throw Error('Worker işlemi sürüyor.');this.changing.add(id);this.epochs.set(id,(this.epochs.get(id)??0)+1);
    try{await this.forWorker(worker).pause(id,'stopped');await this.options.stop(id,worker);}finally{this.changing.delete(id);this.options.changed(id);}
  }
  async remove(id,worker){
    this.store.workerState.get(id,worker);if(worker===MAIN_WORKER)throw Error('İlk worker kaldırılamaz.');
    if(this.store.jobs(id).some(j=>j.browserWorkerId===worker&&!['submitted','already_submitted','skipped'].includes(j.status)))throw Error('Bu worker’ın ayrı Chrome profilinde yarım kalan başvurular var. Önce bunları tamamla veya worker’ı durdur.');
    const controller=this.forWorker(worker);
    if(controller.launching.has(id))throw Error('Worker başlatılıyor; işlem bitince yeniden dene.');
    await this.stopWorker(id,worker);
    for(const source of this.store.sources(id))if(source.resumeContext?.workerId===worker){source.resumeContext=null;this.store.db.prepare('UPDATE sources SET data=? WHERE candidate_id=? AND id=?').run(JSON.stringify(source),id,source.id);}
    this.store.workerState.remove(id,worker);this.controllers.delete(worker);this.options.changed(id);
  }
  async saveSource(id,source){const previous=source.id?this.store.source(id,source.id):null,result=this.store.saveSource(id,source);this.options.changed(id);if(result.enabled&&!previous?.enabled)await this.ensureRunning(id);else await this.tick();return result;}
  forJob(id,job){return this.forWorker(this.owner(id,job));}
  queueAndStartApplication(id,job){return this.forJob(id,job).queueAndStartApplication(id,job);}
  async queueAndStartPreparation(id,job){
    const browserOwner=this.store.job(id,job).browserWorkerId;
    if(!browserOwner)return this.forJob(id,job).queueAndStartPreparation(id,job);
    const controller=this.forWorker(browserOwner),result=controller.queuePreparation(id,job);
    if(result.active)return result;
    try{await this.startWorker(id,browserOwner);}catch(error){return {...result,message:'Hazırlık sıraya alındı, ancak agent başlatılamadı: '+error.message};}
    return result;
  }
  continueAfterAnswer(id,question){const q=this.store.questions(id).find(q=>q.id===question);return this.forJob(id,q?.jobId).continueAfterAnswer(id,question);}
  retryQuestion(id,question){const q=this.store.questions(id).find(q=>q.id===question);return this.forJob(id,q?.jobId).retryQuestion(id,question);}
  recheckLegacyFormQuestions(id){return this.forWorker().recheckLegacyFormQuestions(id);}
  recheckPendingVerifications(id){return this.forWorker().recheckPendingVerifications(id);}
  recheckBrowserQuestions(id){return this.forWorker().recheckBrowserQuestions(id);}
  waitForBrowser(id,options){for(const w of this.store.workers(id))this.forWorker(w.id).waitForBrowser(id,options);}
  input(id,worker=MAIN_WORKER){return this.forWorker(worker).input(id);}
}
