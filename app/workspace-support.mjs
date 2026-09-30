// Compatibility projection for mail and Telegram transports. All data and actions
// come from the shared automation runtime; there is no candidate execution path.
export class WorkspaceSupport {
 constructor(automation,runtime){this.automation=automation;this.runtime=runtime;this.db=automation.db;this.workspaces=automation.store.workspaces;this.generic=true;
  this.db.exec('CREATE TABLE IF NOT EXISTS workspace_events(seq INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL)');
  this.workerState={tasks:id=>runtime.slots(id).map(s=>({workerId:s.workerId,task:{id:s.run.taskId,jobId:s.run.recordId,kind:'application'}}))};
 }
 event(id,kind,data){return this.automation.event(id,kind,data);}
 candidates(){return this.automation.list().map(a=>this.profile(a.id));}
 profile(id){const a=this.automation.get(id);return {...a,name:a.title,preferences:a.goal,authorization:{observe:'research',prepare:'prepare',auto:'submit'}[a.mode]};}
 jobs(id){return this.automation.results(id,{all:true}).map(item=>this.project(item));}
 visibleJobs(id){return this.jobs(id).filter(item=>!item.trial&&!item.hidden);}
 project(item){return {...item,role:item.title,company:item.cells?.company??new URL(item.url).hostname,location:item.cells?.location??'',fit:item.summary,note:item.summary,status:{completed:'submitted',executing:'submitting',dismissed:'skipped'}[item.status]??item.status};}
 job(id,item){return this.project(this.automation.result(id,item));}
 sources(id){return this.automation.sources(id).map(s=>({...s,applyMode:s.mode==='observe'?'find_only':s.mode}));}
 campaign(id){const a=this.automation.get(id);return {status:a.status==='enabled'?'running':a.status,task:this.workerState.tasks(id)[0]?.task};}
 questions(id){return (this.automation.get(id).questions??[]).map(q=>({...q,question:q.text,jobId:q.recordId,createdAt:q.createdAt}));}
 queueState(id,item){const active=this.workerState.tasks(id).some(w=>w.task.jobId===item.id);return {state:active?'active':item.status==='prepared'?'available':'unavailable',verificationOnly:item.status==='uncertain',actionLabel:'İşlemi onayla',message:active?'Kayıt işleniyor.':item.status==='prepared'?'Kayıtlı taslağı onayla.':'Önce çalışma alanındaki kaydı ve işlem taslağını kontrol et.'};}
 maxEventSeq(){return this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM workspace_events').get().seq;}
 eventsAfter(id,seq){return this.db.prepare('SELECT seq,kind,data FROM workspace_events WHERE workspace_id=? AND seq>? ORDER BY seq LIMIT 200').all(id,seq);}
}

export function rebindWorkspaceOwners(db){
 const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND (name LIKE 'background_%' OR name LIKE 'telegram_%' OR name='mail_signals') AND sql LIKE '%REFERENCES candidates(%'").all();
 if(!tables.length)return;
 db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 try{
  for(const {name,sql} of tables){
   if(!/^[a-z_]+$/.test(name))throw Error('Geçersiz tablo');
   const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(name);
   db.exec(sql.replace(new RegExp('CREATE TABLE (?:IF NOT EXISTS )?'+name,'i'),'CREATE TABLE '+name+'_workspace_upgrade').replaceAll('REFERENCES candidates(','REFERENCES workspaces('));
   db.exec(`INSERT INTO ${name}_workspace_upgrade SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}_workspace_upgrade RENAME TO ${name};`);
   for(const index of indexes)db.exec(index.sql);
  }
  if(db.prepare('PRAGMA foreign_key_check').get())throw Error('Çalışma alanı ilişkileri taşınamadı');
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys=ON');}
}
