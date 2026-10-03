import {createHash} from 'node:crypto';
import {sourceScanScope} from './source-scan.mjs';

const removedSettings=['searchMethod','integrationId','fallback','skillText','customTool','guideOverrides','guideBaseVersion'];
const removedRunFields=['sourceSkillEvidence','sourceSkillVersion','sourceToolAttempts','sourceToolCheck'];
const strip=(value,keys)=>{if(value&&typeof value==='object')for(const key of keys)delete value[key];};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
function oldScope(a,url){
 const settings=a.sourceSettings?.[url]??{};
 return createHash('sha256').update(JSON.stringify(stable({...(settings.skillText?{sourceInstructions:settings.skillText}:{}),...(Object.keys(settings.guideOverrides??{}).length?{guideOverrides:settings.guideOverrides}:{}),url,query:settings.query??a.goal,goal:a.goal,criteria:a.criteria,instructions:a.instructions,facts:a.facts,workflow:a.workflow,templateId:a.templateId,templateVersion:a.templateVersion}))).digest('hex');
}
function cleanSources(value){
 for(const settings of Object.values(value.sourceSettings??{}))strip(settings,removedSettings);
 for(const source of value.defaultSources??[])strip(source,removedSettings);
 // Legacy workspace imports retain source objects rather than URL strings.
 for(const source of value.sources??[])if(typeof source==='object')strip(source,removedSettings);
}
function updateScopes(value,scopes){
 if(!value||typeof value!=='object')return;
 if(scopes.has(value.scopeKey))value.scopeKey=scopes.get(value.scopeKey);
 for(const child of Object.values(value))updateScopes(child,scopes);
}

// Run before normal workspace migrations, including when restoring an old backup.
// Keep pending URLs and scan watermarks valid after removing guide-only scope fields.
export function removeSourceExtensions(db){
 if(db.prepare('PRAGMA user_version').get().user_version>=24)return;
 const exists=table=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
 const scopesByOwner=new Map();
 db.exec('SAVEPOINT remove_source_extensions');
 try{
  db.exec('DROP TABLE IF EXISTS workspace_source_skills');
  for(const table of ['automations','automation_templates','sources','automation_runs','workspaces','workspace_imports']){
   if(!exists(table))continue;
   const key=table==='workspace_imports'?'workspace_id':'id';
   for(const row of db.prepare(`SELECT ${key} AS id,data FROM ${table}`).all()){
    const value=JSON.parse(row.data);
    if(table==='automations')scopesByOwner.set(row.id,new Map((value.sources??[]).map(url=>[oldScope(value,url),sourceScanScope(value,url)])));
    cleanSources(value);
    if(table==='sources')strip(value,removedSettings);
    if(table==='automation_runs')strip(value,removedRunFields);
    const scopes=scopesByOwner.get(table==='automation_runs'?value.automationId:row.id);
    if(scopes)updateScopes(value,scopes);
    const data=JSON.stringify(value);
    if(data!==row.data)db.prepare(`UPDATE ${table} SET data=? WHERE ${key}=?`).run(data,row.id);
   }
  }
  db.exec('RELEASE remove_source_extensions');
 }catch(error){db.exec('ROLLBACK TO remove_source_extensions; RELEASE remove_source_extensions');throw error;}
}

// Convert the former shared guide reference into source-owned text exactly once.
// The guide content is unchanged, so saved scan queues retain their scope.
export function copyExistingSourceSkills(db){
 if(db.prepare('PRAGMA user_version').get().user_version>=26)return;
 const scopesByOwner=new Map();
 db.exec('SAVEPOINT copy_source_skills');
 try{
  for(const table of ['automations','automation_templates','sources','workspaces','workspace_imports','automation_runs']){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
   const key=table==='workspace_imports'?'workspace_id':'id';
   for(const row of db.prepare(`SELECT ${key} AS id,data FROM ${table}`).all()){
    const value=JSON.parse(row.data),before=table==='automations'?new Map((value.sources??[]).map(url=>[url,sourceScanScope(value,url)])):null;
    if(before)scopesByOwner.set(row.id,new Map([...before].map(([url,scope])=>[scope,sourceScanScope(value,url)])));
    const scopes=scopesByOwner.get(table==='automation_runs'?value.automationId:row.id);if(scopes)updateScopes(value,scopes);
    const data=JSON.stringify(value);if(data!==row.data)db.prepare(`UPDATE ${table} SET data=? WHERE ${key}=?`).run(data,row.id);
   }
  }
  db.exec('RELEASE copy_source_skills');
 }catch(error){db.exec('ROLLBACK TO copy_source_skills; RELEASE copy_source_skills');throw error;}
}
