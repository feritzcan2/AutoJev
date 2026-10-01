import {randomUUID} from 'node:crypto';
import {CONVERSATION_WORKER} from './workspace-conversation.mjs';
export class WorkspaceWorkers {
 constructor(workspaces){this.workspaces=workspaces;this.db=workspaces.db;this.db.exec('CREATE TABLE IF NOT EXISTS workspace_workers(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workspace_id,id))');
  this.db.exec("UPDATE workspace_workers SET data=json_remove(data,'$.role') WHERE json_type(data,'$.role') IS NOT NULL");
  for(const {table,owner} of [...workspaces.registry.drivers.values()].flatMap(driver=>driver.legacyWorkers??[]))if(workspaces.exists(table)){
   this.db.exec('SAVEPOINT migrate_workers');
   try{this.db.exec(`INSERT OR IGNORE INTO workspace_workers SELECT ${owner},id,json_remove(data,'$.role') FROM ${table}; DROP TABLE ${table}; RELEASE migrate_workers`);}
   catch(error){this.db.exec('ROLLBACK TO migrate_workers; RELEASE migrate_workers');throw error;}
  }
 }
 list(id){const workspace=this.workspaces.get(id);return [{id:'main',name:'Worker 1'},...this.db.prepare('SELECT data FROM workspace_workers WHERE workspace_id=? ORDER BY rowid').all(id).map(r=>JSON.parse(r.data))].map(w=>({...w,...(workspace.workerSettings?.[w.id]??{})}));}
 get(id,worker='main'){if(worker===CONVERSATION_WORKER&&this.workspaces.definition(id).execution.driver==='browser')return {id:worker,name:'Sohbet',conversation:true};const found=this.list(id).find(w=>w.id===worker);if(!found)throw Error('Worker bu çalışma alanına ait değil veya kaldırıldı.');return found;}
 add(id,{name}={}){const workers=this.list(id),max=this.workspaces.definition(id).execution.maxWorkers;if(workers.length>=max)throw Error(`En fazla ${max} worker eklenebilir.`);const label=name??`Worker ${Math.max(...workers.map(w=>Number(w.name.match(/^Worker (\d+)$/)?.[1])||1))+1}`;if(typeof label!=='string'||!label.trim()||label.length>80)throw Error('Worker adı 1–80 karakter olmalı.');const worker={id:randomUUID(),name:label.trim()};this.db.prepare('INSERT INTO workspace_workers VALUES(?,?,?)').run(id,worker.id,JSON.stringify(worker));return worker;}
 setEnabled(id,worker,enabled){this.get(id,worker);const w=this.workspaces.get(id);if(w.workerSettings?.[worker]?.enabled===enabled)return;const states={...w.workerSettings,[worker]:{enabled}};this.db.prepare('UPDATE workspaces SET data=? WHERE id=?').run(JSON.stringify({...w,workerSettings:states}),id);}
 remove(id,worker){this.get(id,worker);if(worker==='main'||worker===CONVERSATION_WORKER)throw Error('Bu worker kaldırılamaz.');if(this.workspaces.tasks.list(id,{states:['running','reported','paused']}).some(t=>t.workerId===worker))throw Error('Önce worker görevini durdur');this.db.prepare('DELETE FROM workspace_workers WHERE workspace_id=? AND id=?').run(id,worker);this.db.prepare('DELETE FROM workspace_conversations WHERE workspace_id=? AND worker_id=?').run(id,worker);}
}
