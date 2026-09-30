import {createHash} from 'node:crypto';
import {recordOperationState} from './record-operations.mjs';
// Compatibility projection for mail and Telegram transports. All data and actions
// come from the shared automation runtime; there is no candidate execution path.
export class WorkspaceSupport {
 constructor(automation,runtime){this.automation=automation;this.runtime=runtime;this.db=automation.db;this.workspaces=automation.store.workspaces;this.generic=true;
  this.db.exec('CREATE TABLE IF NOT EXISTS workspace_events(seq INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL)');
  this.workerState={tasks:id=>this.workspaces.tasks.list(id,{states:['pending','running','reported','paused']}).map(t=>({workerId:t.workerId,task:{id:t.id,jobId:t.recordId,kind:t.recordOperation??t.operation,state:t.state}}))};
 }
 event(id,kind,data){return this.automation.event(id,kind,data);}
 candidates(){return this.automation.list().map(a=>this.profile(a.id));}
 profile(id){const a=this.automation.get(id);return {...a,name:a.title,preferences:a.goal,authorization:{observe:'research',prepare:'prepare',auto:'submit'}[a.mode]};}
 jobs(id){return this.automation.results(id,{all:true}).map(item=>this.project(item));}
 visibleJobs(id){return this.jobs(id).filter(item=>!item.trial&&!item.hidden);}
 project(item){return {...item,role:item.title,company:item.cells?.company??new URL(item.url).hostname,location:item.cells?.location??'',fit:item.summary,note:item.summary,status:{completed:'submitted',executing:'submitting',dismissed:'skipped'}[item.status]??item.status};}
 job(id,item){return this.project(this.automation.result(id,item));}
 recordNotification(id,itemId){
  const definition=this.workspaces.definition(id),item=this.automation.result(id,itemId),record=this.workspaces.records.project(id,item,definition);
  const label=state=>definition.records.states.find(s=>s.id===state)?.label??state;
  return {title:definition.title,status:label(item.status),completed:label('completed'),heading:this.workspaces.table(id).columns.map(column=>({label:column.label,value:record.fields[column.key]})).filter(field=>field.value!==undefined&&field.value!==''),summary:item.summary};
 }
 sources(id){return this.automation.sources(id).map(s=>({...s,applyMode:s.mode==='observe'?'find_only':s.mode}));}
 mailContract(id){return this.workspaces.definition(id).mail;}
 mailRecords(id){const definition=this.workspaces.definition(id);return this.automation.results(id,{all:true}).filter(item=>!item.trial).map(item=>this.workspaces.records.project(id,item,definition));}
 campaign(id){const a=this.automation.get(id);return {status:a.status==='enabled'?'running':a.status,task:this.workerState.tasks(id)[0]?.task};}
 questions(id){return (this.automation.get(id).questions??[]).map(q=>({...q,question:q.text,jobId:q.recordId,createdAt:q.createdAt}));}
 queueState(id,item){
  const record=this.automation.result(id,item.id),a=this.automation.get(id),state=recordOperationState(this.automation,id,record,{a});
  const operation=state.directOperation??state.operation,direct=Boolean(state.directOperation),verificationOnly=operation?.kind==='verify';
  const request=operation?{kind:operation.kind,...(direct?{direct:true}:operation.kind==='execute'?{digest:record.digest}:{})}:null;
  const token=request?createHash('sha256').update(JSON.stringify([request,a.revision,record.digest,record.status])).digest('hex').slice(0,24):null;
  return {state:state.task?(state.task.state==='pending'?'queued':'active'):operation&&!operation.disabled?'available':'unavailable',verificationOnly,actionLabel:operation?.label??'İşlem kullanılamıyor',request,token,
   message:state.task?(state.task.state==='pending'?'Kayıt için görev zaten sırada.':'Agent bu kaydı zaten işliyor.'):operation?.reason??(operation?'Bu kayıt için '+operation.label.toLocaleLowerCase('tr')+'.':'Önce çalışma alanındaki kaydı kontrol et.')};
 }
 async queueRecord(id,itemId,token){
  const state=this.queueState(id,{id:itemId});
  if(state.state!=='available')throw Error(state.message);
  if(!token||token!==state.token)throw Error('Kayıt değişti. Güncellenen karttaki işlemi yeniden seç.');
  const {kind,...input}=state.request,task=await this.runtime.runRecord(id,itemId,kind,input);
  return {queued:true,taskId:task.id,message:state.verificationOnly?'Kayıt doğrulama sırasına alındı.':'Kayıt işlem sırasına alındı.'};
 }
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
