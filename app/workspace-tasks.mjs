import {randomUUID} from 'node:crypto';
const parse=row=>row?JSON.parse(row.data):null;
const active=['running','reported','paused'];
export class WorkspaceTasks {
 constructor(workspaces){this.workspaces=workspaces;this.db=workspaces.db;this.sequence=0;this.db.exec(`
  CREATE TABLE IF NOT EXISTS workspace_tasks(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,worker_id TEXT,state TEXT NOT NULL,lock_key TEXT,data TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS workspace_task_worker ON workspace_tasks(workspace_id,worker_id) WHERE state IN ('running','reported','paused');
  CREATE UNIQUE INDEX IF NOT EXISTS workspace_task_lock ON workspace_tasks(workspace_id,lock_key) WHERE state IN ('running','reported','paused') AND lock_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS workspace_tasks_owner ON workspace_tasks(workspace_id,state);
  CREATE INDEX IF NOT EXISTS workspace_tasks_batch ON workspace_tasks(workspace_id,json_extract(data,'$.batchId'));
 `);}
 atomic(fn){const name='workspace_task_'+(++this.sequence);this.db.exec(`SAVEPOINT ${name}`);try{this.db.exec('UPDATE workspace_tasks SET state=state WHERE 0');const result=fn();this.db.exec(`RELEASE ${name}`);return result;}catch(error){this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);throw error;}}
 get(id,taskId){const task=parse(this.db.prepare('SELECT data FROM workspace_tasks WHERE workspace_id=? AND id=?').get(id,taskId));if(!task)throw Error('Görev bu çalışma alanına ait değil');return task;}
 list(id,{states,batchId,limit=-1}={}){this.workspaces.get(id);if(states&&!states.length)return [];const params=[id],where=['workspace_id=?'];if(states){where.push('state IN ('+states.map(()=>'?').join(',')+')');params.push(...states);}if(batchId){where.push("json_extract(data,'$.batchId')=?");params.push(batchId);}params.push(limit);return this.db.prepare(`SELECT data FROM workspace_tasks WHERE ${where.join(' AND ')} ORDER BY rowid ${limit>0?'DESC':'ASC'} LIMIT ?`).all(...params).map(parse);}
 put(task){this.db.prepare('INSERT INTO workspace_tasks VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET worker_id=excluded.worker_id,state=excluded.state,lock_key=excluded.lock_key,data=excluded.data').run(task.id,task.workspaceId,task.workerId??null,task.state,task.lockKey??null,JSON.stringify(task));return task;}
 enqueue(id,input){return this.atomic(()=>{this.workspaces.get(id);if(input.id){const existing=this.db.prepare('SELECT workspace_id,data FROM workspace_tasks WHERE id=?').get(input.id);if(existing){if(existing.workspace_id!==id)throw Error('Görev başka çalışma alanına ait');return parse(existing);}}
  const task={...input,id:input.id??randomUUID(),workspaceId:id,workerId:null,state:'pending',attempts:0,dependsOn:input.dependsOn??[],createdAt:Date.now()};for(const dependency of task.dependsOn)this.get(id,dependency);return this.put(task);
 });}
 claim(id,taskId,workerId='main'){return this.atomic(()=>{
  const task=this.get(id,taskId);if(active.includes(task.state)){if(task.workerId!==workerId)throw Error('Görev başka bir worker tarafından işleniyor.');return task;}
  if(task.state!=='pending')throw Error('Görev çalıştırılabilir durumda değil');
  if(task.dependsOn.some(parent=>this.get(id,parent).state!=='completed'))throw Error('Görevin önceki adımları tamamlanmadı');
  if(this.list(id,{states:active}).some(t=>t.workerId===workerId||task.lockKey&&t.lockKey===task.lockKey))throw Error('Görev başka bir worker tarafından işleniyor.');
  return this.put({...task,state:'running',workerId,attempts:task.attempts+1,startedAt:Date.now()});
 });}
 finish(id,taskId,state='completed',summary=''){if(!['completed','partial','blocked','failed','interrupted','cancelled'].includes(state))throw Error('Geçersiz görev sonucu');const task=this.get(id,taskId);return this.put({...task,state,summary,finishedAt:Date.now()});}
 // Capability adapters supply domain payloads; the queue only handles ownership,
 // resource keys, execution state and durable results.
 sync(id,workerId,input){return this.atomic(()=>{
  for(const previous of this.list(id,{states:active}).filter(t=>t.workerId===workerId&&t.id!==input?.id))this.finish(id,previous.id,previous.result?.state??'interrupted',previous.result?.summary??'Görev sona erdi');
  if(!input)return;
  let current=this.enqueue(id,input);
  if(!active.includes(current.state)&&current.state!=='pending')current=this.put({...current,state:'pending'});
  current=this.claim(id,input.id,workerId);
  return this.put({...current,...input,workspaceId:id,workerId});
 });}
}
