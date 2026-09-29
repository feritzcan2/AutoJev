import {randomUUID} from 'node:crypto';

import {MAIN_WORKER,MAX_WORKERS,workerKey} from './worker-key.mjs';
export {MAIN_WORKER,MAX_WORKERS,workerKey};
const queueKeys=['attempts','pendingRetries','pendingResumes','pendingRecoveries'];
const baseline=Symbol('queue snapshot');

// Candidate data stays shared. Only scheduling, reviews and conversation history
// belong to a worker. The original tables remain the first worker's storage.
export class WorkerState {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_state(candidate_id TEXT NOT NULL REFERENCES candidates(id),worker_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(candidate_id,worker_id,kind));`);
    const legacy=this.db.prepare("SELECT candidate_id, 'main' AS worker_id,data FROM campaigns WHERE json_type(data,'$.task')='object' UNION ALL SELECT candidate_id,worker_id,data FROM worker_state WHERE kind='campaign' AND json_type(data,'$.task')='object'").all();
    for(const row of legacy)this.persistCampaign(row.candidate_id,row.worker_id,JSON.parse(row.data));
  }
  list(id){return this.store.workspaces.workers.list(id);}
  get(id,worker=MAIN_WORKER){return this.store.workspaces.workers.get(id,worker);}
  add(id,input){return this.store.workspaces.workers.add(id,input);}
  remove(id,worker){this.store.workspaces.workers.remove(id,worker);this.db.prepare('DELETE FROM worker_state WHERE candidate_id=? AND worker_id=?').run(id,worker);}
  read(id,worker,kind){const r=this.db.prepare('SELECT data FROM worker_state WHERE candidate_id=? AND worker_id=? AND kind=?').get(id,worker,kind);return r?JSON.parse(r.data):null;}
  write(id,worker,kind,value){this.db.prepare('INSERT INTO worker_state VALUES(?,?,?,?) ON CONFLICT(candidate_id,worker_id,kind) DO UPDATE SET data=excluded.data').run(id,worker,kind,JSON.stringify(value));return value;}
  rawCampaign(id,worker){
    const row=worker===MAIN_WORKER?this.db.prepare('SELECT data FROM campaigns WHERE candidate_id=?').get(id):null;
    const campaign=worker===MAIN_WORKER?(row?JSON.parse(row.data):null):this.read(id,worker,'campaign');
    if(campaign&&Object.hasOwn(campaign,'taskId')){campaign.task=campaign.taskId?this.store.workspaces.tasks.get(id,campaign.taskId).payload??null:null;delete campaign.taskId;}
    return campaign;
  }
  sharedQueue(id){
    const saved=this.read(id,MAIN_WORKER,'queue');if(saved)return saved;
    const main=this.rawCampaign(id,MAIN_WORKER);return Object.fromEntries(queueKeys.filter(key=>main?.[key]!==undefined).map(key=>[key,main[key]]));
  }
  campaign(id,worker=MAIN_WORKER){
    const c=this.rawCampaign(id,worker);if(!c)return null;
    const shared=this.sharedQueue(id);
    for(const key of queueKeys)if(shared[key]!==undefined)c[key]=structuredClone(shared[key]);
    c[baseline]=structuredClone(shared);return c;
  }
  saveCampaign(id,worker=MAIN_WORKER,value){
    return this.store.jobRegistry.atomic(()=>this.persistCampaign(id,worker,value));
  }
  persistCampaign(id,worker,value){
    this.store.profile(id);
    this.db.exec('SAVEPOINT worker_campaign');
    try{
    const task=value.task;if(task&&!task.id)task.id=randomUUID();
    this.store.workspaces.tasks.sync(id,worker,task?{
      id:task.id,operation:task.kind,capability:this.store.workspaces.definition(id).workflow.find(step=>step.id===task.kind)?.capability??'jobs.verify',
      recordId:task.jobId,sourceId:task.sourceId,payload:structuredClone(task),checkpoint:task.recovery??null,
      lockKey:task.report?null:task.jobId?'record:'+this.store.canonicalJobId(id,task.jobId):task.sourceId?'source:'+task.sourceId:null,
      result:task.report?{state:task.report.outcome==='blocked'?'blocked':'completed',summary:task.report.note}:null,
      state:task.report?'reported':value.status==='running'?'running':'paused'
    }:null);
    const previous=this.rawCampaign(id,worker)?.task;
    if(task&&(previous?.id!==task.id||previous?.jobId!==task.jobId||previous?.sourceId!==task.sourceId)){
      for(const other of this.tasks(id,worker))if(task.jobId&&other.task.jobId&&this.store.canonicalJobId(id,other.task.jobId)===this.store.canonicalJobId(id,task.jobId)&&!other.task.report&&!task.report||task.kind==='search'&&other.task.kind==='search'&&task.sourceId===other.task.sourceId)throw Error('Görev başka bir worker tarafından işleniyor.');
    }
    const shared=this.sharedQueue(id);
    // Apply only this read's edits. Another worker may have saved a retry or a
    // completed attempt while this worker awaited its provider.
    for(const key of queueKeys){
      if(value[key]===undefined)continue;
      const before=value[baseline]?.[key]??{},after=value[key];shared[key]??={};
      for(const id of new Set([...Object.keys(before),...Object.keys(after)])){
        if(JSON.stringify(before[id])===JSON.stringify(after[id]))continue;
        if(Object.hasOwn(after,id))shared[key][id]=after[id];else if(JSON.stringify(shared[key][id])===JSON.stringify(before[id]))delete shared[key][id];
      }
    }
    this.write(id,MAIN_WORKER,'queue',shared);
    const saved={...value,...(Object.hasOwn(value,'task')?{taskId:task?.id??null}:{})};delete saved.task;for(const key of queueKeys)delete saved[key];
    if(worker===MAIN_WORKER)this.db.prepare('INSERT INTO campaigns VALUES(?,?) ON CONFLICT(candidate_id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(saved));
    else this.write(id,worker,'campaign',saved);
    this.db.exec('RELEASE worker_campaign');
    Object.assign(value,structuredClone(shared));value[baseline]=structuredClone(shared);
    return this.campaign(id,worker);
    }catch(error){this.db.exec('ROLLBACK TO worker_campaign');this.db.exec('RELEASE worker_campaign');throw error;}
  }
  tasks(id,exclude){return this.list(id).filter(w=>w.id!==exclude).map(w=>({workerId:w.id,task:this.rawCampaign(id,w.id)?.task})).filter(w=>w.task);}
  view(worker=MAIN_WORKER){const view=Object.create(this.store);view.workerId=worker;return view;}
}
