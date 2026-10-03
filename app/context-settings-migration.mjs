// Percentages cannot be converted without knowing the active model's capacity.
// Retire legacy thresholds as disabled; preserve explicitly saved token values.
export function withoutContextPercentages(settings){
 const result={...settings};
 for(const kind of ['Compact','Restart']){
  const oldKey=`context${kind}Percent`,newKey=`context${kind}Tokens`;
  if(Object.hasOwn(result,oldKey)){
   if(result[newKey]===undefined)result[newKey]=0;
   delete result[oldKey];
  }
 }
 return result;
}

function upgrade(value){
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value))return value.map(upgrade);
 return Object.fromEntries(Object.entries(withoutContextPercentages(value)).map(([key,child])=>[key,upgrade(child)]));
}

export function migrateContextThresholds(db){
 if(db.prepare('PRAGMA user_version').get().user_version>=32)return;
 db.exec('SAVEPOINT context_token_thresholds');
 try{
  for(const table of ['workspaces','automations','candidates','workspace_imports','workspace_conversations','automation_runs']){
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
   for(const row of db.prepare(`SELECT rowid,data FROM ${table}`).all()){
    const data=JSON.stringify(upgrade(JSON.parse(row.data)));
    if(data!==row.data)db.prepare(`UPDATE ${table} SET data=? WHERE rowid=?`).run(data,row.rowid);
   }
  }
  db.exec('RELEASE context_token_thresholds');
 }catch(error){db.exec('ROLLBACK TO context_token_thresholds; RELEASE context_token_thresholds');throw error;}
}
