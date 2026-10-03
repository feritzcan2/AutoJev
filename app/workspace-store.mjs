import {withAgentDefaults} from './agent-settings.mjs';
import {WorkspaceTasks} from './workspace-tasks.mjs';
import {WorkspaceWorkers} from './workspace-workers.mjs';
import {TemplateRegistry} from './template-registry.mjs';
import {WorkspaceRecords} from './workspace-records.mjs';
import {contextCompactTokens} from './context-compaction.mjs';
import {contextRestartTokens} from './context-usage.mjs';
import {automationTable,automationCells} from './automation-templates.mjs';

const parse=row=>row?JSON.parse(row.data):null;
const sharedKeys=['agentSettings','chromeProfile','browserMode'];
export const domainData=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!sharedKeys.includes(key)&&key!=='table'));

// Canonical identity, provider/browser settings, table schema and conversations.
// CV/application and web-plan records are template data, linked by the same ID.
export class WorkspaceStore {
 constructor(db,{registry=new TemplateRegistry()}={}){this.db=db;this.registry=registry;db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,template_id TEXT NOT NULL,data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workspace_conversations(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,worker_id TEXT NOT NULL,provider TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workspace_id,worker_id,provider));
 `);this.migrate();this.records=new WorkspaceRecords(this);this.tasks=new WorkspaceTasks(this);this.workers=new WorkspaceWorkers(this);}
 exists(table){return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));}
 has(id){return Boolean(this.db.prepare('SELECT 1 FROM workspaces WHERE id=?').get(id));}
 get(id){const value=parse(this.db.prepare('SELECT data FROM workspaces WHERE id=?').get(id));if(!value)throw Error('Çalışma alanı bulunamadı');return {...value,agentSettings:withAgentDefaults(value.agentSettings)};}
 templateInput(templateId){const saved=this.exists('automation_templates')?parse(this.db.prepare('SELECT data FROM automation_templates WHERE id=?').get(templateId)):null;return saved??this.registry.templates.get(templateId);}
 supports(templateId){const input=this.templateInput(templateId);return Boolean(input&&this.registry.supports(input));}
 template(templateId){const input=this.templateInput(templateId);if(!input)throw Error('Template bulunamadı');return this.registry.normalize(structuredClone(input));}
 definition(id){return this.template(this.get(id).templateId);}
 list(){return this.db.prepare('SELECT data FROM workspaces ORDER BY rowid').all().map(parse);}
 save(id,templateId,value){
  const previous=this.has(id)?this.get(id):{},s=withAgentDefaults(value.agentSettings??previous.agentSettings);
  if(previous.templateId&&previous.templateId!==templateId)throw Error('Çalışma alanı kimliği farklı bir template’e ait');
  const workspace={...previous,id,templateId,title:value.title??value.workspaceName??value.name??previous.title,
   agentSettings:{...s,contextCompactTokens:contextCompactTokens(s.contextCompactTokens),...(s.contextRestartTokens===undefined?{}:{contextRestartTokens:contextRestartTokens(s.contextRestartTokens)})},
   chromeProfile:value.chromeProfile===undefined?previous.chromeProfile??null:value.chromeProfile,
   table:previous.table??value.table??this.template(templateId).table??{title:'İşlem akışı',columns:[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'Başlık',type:'text'}]}};
  this.db.prepare('INSERT INTO workspaces VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET template_id=excluded.template_id,data=excluded.data').run(id,templateId,JSON.stringify(workspace));return workspace;
 }
 transition(id,itemId,actionId){
  const definition=this.definition(id),action=definition.records.actions.find(a=>a.id===actionId);if(!action)throw Error('Template işlemi bulunamadı');
  return this.records.update(id,itemId,item=>{const state=item.workflowState??item.status;if(!action.from.includes(state))throw Error('İşlem bu kayıt durumunda kullanılamaz');return {...item,workflowState:action.to,workflowHistory:[...(item.workflowHistory??[]),{action:action.id,from:state,to:action.to,at:Date.now()}],tableUpdatedAt:Date.now()};});
 }
 fields(id){const w=this.get(id);return Object.fromEntries(sharedKeys.map(key=>[key,w[key]]));}
 table(id){return this.get(id).table;}
 configureTable(id,input){const w=this.get(id);w.table=automationTable(input);this.registry.driver(this.definition(id)).validateTable?.(w.table);this.db.prepare('UPDATE workspaces SET data=? WHERE id=?').run(JSON.stringify(w),id);return w.table;}
 updateCells(id,itemId,input){
  if(this.records.get(id,itemId).assessment&&input.some(cell=>cell.key==='score'))throw Error('Puan değerlendirmeden hesaplanır; değiştirmek için kaydı yeniden puanla.');
  const w=this.get(id);return this.records.update(id,itemId,item=>({...item,cells:{...item.cells,...automationCells(input,w.table)},tableUpdatedAt:Date.now()}));
 }
 history(id,worker='main',profileId=null){
  const read=provider=>{this.get(id);return parse(this.db.prepare('SELECT data FROM workspace_conversations WHERE workspace_id=? AND worker_id=? AND provider=?').get(id,worker,provider));};
  const scoped=provider=>{const data=read(provider);return profileId?data?.profiles?.[profileId]:data;};
  const write=(provider,data)=>this.db.prepare('INSERT INTO workspace_conversations VALUES(?,?,?,?) ON CONFLICT(workspace_id,worker_id,provider) DO UPDATE SET data=excluded.data').run(id,worker,provider,JSON.stringify(data));
  return {
   forProfile:profile=>this.history(id,worker,profile),
   conversation:(_,provider)=>scoped(provider)?.nativeId??null,
   conversationSettings:(_,provider,nativeId)=>{const s=scoped(provider);return s?.nativeId===nativeId?s.settings:null;},
   forgetConversation:(_,provider,nativeId)=>{this.get(id);if(scoped(provider)?.nativeId!==nativeId)return;
    if(!profileId){this.db.prepare('DELETE FROM workspace_conversations WHERE workspace_id=? AND worker_id=? AND provider=?').run(id,worker,provider);return;}
    const data=read(provider);delete data.profiles[profileId];if(data.nativeId===nativeId){data.nativeId=null;data.settings=null;}write(provider,data);
   },
   saveConversation:(_,provider,nativeId,settings)=>{this.get(id);if(!['codex','claude','opencode'].includes(provider)||typeof nativeId!=='string'||!nativeId.trim()||nativeId.length>256)throw Error('Geçersiz sağlayıcı oturumu');
    const saved={nativeId,settings:settings??null},data=read(provider)??{};write(provider,{...data,...saved,...(profileId?{profiles:{...data.profiles,[profileId]:saved}}:{})});}
  };
 }
 remove(id){this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id);}
 migrate(){
  this.db.exec('SAVEPOINT workspace_migration');try{this.db.exec('UPDATE workspaces SET data=data WHERE 0');
   for(const {table,defaultTemplate:kind=null} of [...this.registry.drivers.values()].flatMap(driver=>driver.legacyWorkspaces??[]))if(this.exists(table))for(const row of this.db.prepare(`SELECT id,data FROM ${table}`).all()){
    if(table==='candidates'&&this.exists('workspace_imports')&&this.db.prepare('SELECT 1 FROM workspace_imports WHERE workspace_id=?').get(row.id))continue;
    const value=parse(row),existing=this.has(row.id)?this.get(row.id):null,templateId=value.templateId??existing?.templateId??kind;if(!existing)this.save(row.id,templateId,value);else if(existing.templateId!==templateId)throw Error('Eski kayıtlarda çalışma alanı kimliği çakışması var');
    for(const [provider,saved] of Object.entries(value.conversations??{}))if(saved?.nativeId)this.history(row.id).saveConversation(row.id,provider,saved.nativeId,saved.settings);
    delete value.conversations;
    const cleaned=JSON.stringify(domainData(value));
    if(cleaned!==row.data)this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(cleaned,row.id);
   }
   for(const driver of this.registry.drivers.values())driver.migrate?.(this);
   this.db.exec('RELEASE workspace_migration');
  }catch(error){this.db.exec('ROLLBACK TO workspace_migration; RELEASE workspace_migration');throw error;}
 }
}
