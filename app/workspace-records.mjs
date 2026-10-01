import {randomUUID} from 'node:crypto';

const parse=row=>row?JSON.parse(row.data):null;
// One durable record table. Domain extensions keep their own fields in data;
// bindings in the template expose those fields through the same record contract.
export class WorkspaceRecords {
 constructor(workspaces){this.workspaces=workspaces;this.db=workspaces.db;this.migrate();}
 migrate(){
  const db=this.db,legacy=[...this.workspaces.registry.drivers.values()].flatMap(driver=>driver.legacyRecords??[]).filter(({table})=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try{
   db.exec(`CREATE TABLE IF NOT EXISTS workspace_records(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,record_key TEXT NOT NULL,identity TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,UNIQUE(workspace_id,record_key));
    CREATE INDEX IF NOT EXISTS workspace_records_owner ON workspace_records(workspace_id);`);
   for(const {table,owner,key,identity="''"} of legacy){
    db.exec(`INSERT INTO workspace_records SELECT id,${owner},${key},${identity},data FROM ${table} ORDER BY rowid`);
   }
   // Keep foreign keys when an extension migrates its former record table.
   for(const {table} of legacy)for(const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql LIKE ?").all(`%REFERENCES ${table}(%`)){
    if(row.name===table)continue;
    const name=row.name;if(!/^[a-z_]+$/.test(name))throw Error('Geçersiz eski tablo');
    const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(name);
    const create=row.sql.replace(new RegExp('CREATE TABLE (?:IF NOT EXISTS )?'+name,'i'),'CREATE TABLE '+name+'_records_migration').replaceAll(`REFERENCES ${table}(`,'REFERENCES workspace_records(');
    db.exec(`${create}; INSERT INTO ${name}_records_migration SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}_records_migration RENAME TO ${name};`);
    for(const index of indexes)db.exec(index.sql);
   }
   for(const {table} of legacy)db.exec(`DROP TABLE ${table}`);
   if(db.prepare('PRAGMA foreign_key_check').get())throw Error('Kayıtlar taşınırken ilişki doğrulaması başarısız');
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys=ON');}
 }
 get(id,recordId){this.workspaces.get(id);const record=parse(this.db.prepare('SELECT data FROM workspace_records WHERE workspace_id=? AND id=?').get(id,recordId));if(!record)throw Error('Kayıt bu çalışma alanına ait değil');return record;}
 find(id,key){this.workspaces.get(id);return parse(this.db.prepare('SELECT data FROM workspace_records WHERE workspace_id=? AND record_key=?').get(id,key));}
 list(id,{offset=0,limit=500,descending=true}={}){this.workspaces.get(id);return this.db.prepare(`SELECT data FROM workspace_records WHERE workspace_id=? ORDER BY rowid ${descending?'DESC':'ASC'} LIMIT ? OFFSET ?`).all(id,limit,offset).map(parse);}
 count(id){this.workspaces.get(id);return this.db.prepare('SELECT count(*) AS n FROM workspace_records WHERE workspace_id=?').get(id).n;}
 search(id,{query,offset=0,limit=25}){
  this.workspaces.get(id);
  const fold=value=>value.normalize('NFKC').toLowerCase(),needle=fold(query),records=[];let total=0;
  // Search locally so agents need not load every record to find one listing.
  // JS case folding also covers non-ASCII company names, unlike SQLite lower.
  for(const row of this.db.prepare('SELECT data FROM workspace_records WHERE workspace_id=? ORDER BY rowid ASC').iterate(id)){
   const record=parse(row),text=JSON.stringify([record.title,record.role,record.company,record.location,record.url,record.key,record.sourceUrl,record.summary,record.cells]);
   if(!fold(text).includes(needle))continue;
   if(total>=offset&&records.length<limit)records.push(record);total++;
  }
  return {records,total};
 }
 put(id,key,value){
  this.workspaces.get(id);const record={...value,id:value.id??randomUUID()},existing=this.db.prepare('SELECT workspace_id FROM workspace_records WHERE id=?').get(record.id);
  if(existing&&existing.workspace_id!==id)throw Error('Kayıt bu çalışma alanına ait değil');
  this.db.prepare('INSERT INTO workspace_records(id,workspace_id,record_key,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.id,id,key,JSON.stringify(record));return record;
 }
 update(id,recordId,change){const value=change(this.get(id,recordId));if(value.id!==recordId)throw Error('Kayıt kimliği değiştirilemez');this.db.prepare('UPDATE workspace_records SET data=? WHERE workspace_id=? AND id=?').run(JSON.stringify(value),id,recordId);return value;}
 project(id,record,definition){
  const fields={...record.cells};for(const [key,source]of Object.entries(definition.records.bindings))if(record[source]!==undefined)fields[key]=record[source];
  if(!fields.source&&record.url)try{fields.source=new URL(record.url).hostname;}catch{}
  return {...record,id:record.id,workspaceId:id,url:record.url,fields,state:record.workflowState??record.status,operationState:record.status,documents:record.documents??[],evidence:record.evidence??null,updatedAt:record.updatedAt,...this.workspaces.registry.driver(definition).projectRecord?.(record)};
 }
}
