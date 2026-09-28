import {randomUUID} from 'node:crypto';

export const MAIN_WORKER='main';
export const MAX_WORKERS=8;
export const workerKey=(candidate,worker=MAIN_WORKER)=>worker===MAIN_WORKER?candidate:`${candidate}~${worker}`;
const queueKeys=['attempts','pendingRetries','pendingResumes','pendingRecoveries'];
const baseline=Symbol('queue snapshot');

// Candidate data stays shared. Only scheduling, reviews and conversation history
// belong to a worker. The original tables remain the first worker's storage.
export class WorkerState {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_workers(candidate_id TEXT NOT NULL REFERENCES candidates(id),id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(candidate_id,id));
      CREATE TABLE IF NOT EXISTS worker_state(candidate_id TEXT NOT NULL REFERENCES candidates(id),worker_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(candidate_id,worker_id,kind));`);
    // Every worker now takes every kind of task; remove saved role restrictions.
    this.db.exec("UPDATE agent_workers SET data=json_remove(data,'$.role') WHERE json_type(data,'$.role') IS NOT NULL");
  }
  list(id){
    this.store.profile(id);
    return [{id:MAIN_WORKER,name:'Worker 1'},...this.db.prepare('SELECT data FROM agent_workers WHERE candidate_id=? ORDER BY rowid').all(id).map(r=>JSON.parse(r.data))];
  }
  get(id,worker=MAIN_WORKER){const result=this.list(id).find(w=>w.id===worker);if(!result)throw Error('Worker bu adaya ait değil veya kaldırıldı.');return result;}
  add(id,{name}={}){
    const workers=this.list(id);
    if(workers.length>=MAX_WORKERS)throw Error(`En fazla ${MAX_WORKERS} worker eklenebilir.`);
    const label=name??`Worker ${Math.max(...workers.map(w=>Number(w.name.match(/^Worker (\d+)$/)?.[1])||1))+1}`;
    if(typeof label!=='string'||!label.trim()||label.length>80)throw Error('Worker adı 1–80 karakter olmalı.');
    const worker={id:randomUUID(),name:label.trim()};
    this.db.prepare('INSERT INTO agent_workers VALUES(?,?,?)').run(id,worker.id,JSON.stringify(worker));return worker;
  }
  remove(id,worker){
    this.get(id,worker);if(worker===MAIN_WORKER)throw Error('İlk worker kaldırılamaz.');
    this.db.prepare('DELETE FROM worker_state WHERE candidate_id=? AND worker_id=?').run(id,worker);
    this.db.prepare('DELETE FROM agent_workers WHERE candidate_id=? AND id=?').run(id,worker);
  }
  read(id,worker,kind){const r=this.db.prepare('SELECT data FROM worker_state WHERE candidate_id=? AND worker_id=? AND kind=?').get(id,worker,kind);return r?JSON.parse(r.data):null;}
  write(id,worker,kind,value){this.db.prepare('INSERT INTO worker_state VALUES(?,?,?,?) ON CONFLICT(candidate_id,worker_id,kind) DO UPDATE SET data=excluded.data').run(id,worker,kind,JSON.stringify(value));return value;}
  rawCampaign(id,worker){
    if(worker!==MAIN_WORKER)return this.read(id,worker,'campaign');
    const row=this.db.prepare('SELECT data FROM campaigns WHERE candidate_id=?').get(id);return row?JSON.parse(row.data):null;
  }
  campaign(id,worker=MAIN_WORKER){
    const c=this.rawCampaign(id,worker);if(!c)return null;
    const shared=this.read(id,MAIN_WORKER,'queue')??Object.fromEntries(queueKeys.filter(k=>this.rawCampaign(id,MAIN_WORKER)?.[k]!==undefined).map(k=>[k,this.rawCampaign(id,MAIN_WORKER)[k]]));
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
    const task=value.task;
    const previous=this.rawCampaign(id,worker)?.task;
    if(task&&(previous?.id!==task.id||previous?.jobId!==task.jobId||previous?.sourceId!==task.sourceId)){
      for(const other of this.tasks(id,worker))if(task.jobId&&other.task.jobId&&this.store.canonicalJobId(id,other.task.jobId)===this.store.canonicalJobId(id,task.jobId)&&!other.task.report&&!task.report||task.kind==='search'&&other.task.kind==='search'&&task.sourceId===other.task.sourceId)throw Error('Görev başka bir worker tarafından işleniyor.');
    }
    const shared=this.read(id,MAIN_WORKER,'queue')??Object.fromEntries(queueKeys.filter(k=>this.rawCampaign(id,MAIN_WORKER)?.[k]!==undefined).map(k=>[k,this.rawCampaign(id,MAIN_WORKER)[k]]));
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
    const saved={...value,...shared};
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
