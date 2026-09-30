const parse=row=>row?JSON.parse(row.data):null;
export function migrateApplicationConversations(workspaces){
   if(workspaces.exists('agent_conversations'))for(const row of workspaces.db.prepare('SELECT * FROM agent_conversations').all())if(workspaces.has(row.candidate_id)){
    const settings=workspaces.exists('conversation_launch_settings')?parse(workspaces.db.prepare('SELECT data FROM conversation_launch_settings WHERE candidate_id=? AND provider=? AND native_id=?').get(row.candidate_id,row.provider,row.native_id)):null;
    workspaces.history(row.candidate_id).saveConversation(row.candidate_id,row.provider,row.native_id,settings);
   }
   if(workspaces.exists('worker_state'))for(const row of workspaces.db.prepare("SELECT * FROM worker_state WHERE kind LIKE 'conversation:%'").all()){const saved=parse(row);if(saved?.nativeId&&workspaces.has(row.candidate_id))workspaces.history(row.candidate_id,row.worker_id).saveConversation(row.candidate_id,row.kind.slice(13),saved.nativeId,saved.settings);}
   for(const table of ['agent_conversations','conversation_launch_settings'])if(workspaces.exists(table))workspaces.db.exec(`DROP TABLE ${table}`);
   if(workspaces.exists('worker_state'))workspaces.db.exec("DELETE FROM worker_state WHERE kind LIKE 'conversation:%'");
}
