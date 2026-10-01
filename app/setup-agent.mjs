import {withAgentDefaults} from './agent-settings.mjs';
import {CONVERSATION_WORKER} from './workspace-conversation.mjs';

const providers=['codex','claude','opencode'];
const profile='builtin.agent-profile.loop-web-interview';
const lastInterview=(db,id)=>{
 const row=db.db.prepare("SELECT data FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.kind')='interview' AND json_extract(data,'$.conversation.nativeId') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(id);
 return row?JSON.parse(row.data).conversation:null;
};
export function setupAgentSettings(db,id){
 const a=db.get(id);
 let saved=a.setupAgentSettings;
 if(!saved&&!a.setupAgentHistoryInitialized){
  saved=lastInterview(db,id)?.settings;
  for(const worker of [CONVERSATION_WORKER,'main']){
   if(saved)break;
   const history=db.store.workspaces.history(id,worker).forProfile(profile);
   for(const provider of [...new Set([a.agentSettings.provider,...providers])]){
    const nativeId=history.conversation(id,provider);if(nativeId)saved=history.conversationSettings(id,provider,nativeId);
    if(saved)break;
   }
  }
 }
 saved??=a.agentSettings;
 const {agentProfileDigest,...settings}=withAgentDefaults(saved);
 return {...settings,contextRestartPercent:0};
}
export const setupAgentSettingsKey=settings=>JSON.stringify(['provider','model','reasoning','permission','network'].map(key=>settings[key]??null));

// The setup conversation owns its provider identity from the first message.
// Import only an exact interview identity; Worker 1 may now be scanning sources.
export function setupAgentHistory(db,id){
 const history=db.store.workspaces.history(id,CONVERSATION_WORKER),a=db.get(id);
 if(!a.setupAgentHistoryInitialized){
  const previous=lastInterview(db,id);
  for(const provider of providers){
   const scoped=history.forProfile(profile);if(scoped.conversation(id,provider))continue;
   const legacy=db.store.workspaces.history(id,'main').forProfile(profile);
   const nativeId=previous?.provider===provider?previous.nativeId:legacy.conversation(id,provider);
   const settings=previous?.provider===provider?previous.settings:legacy.conversationSettings(id,provider,nativeId);
   if(nativeId)scoped.saveConversation(id,provider,nativeId,settings);
  }
  db.put({...a,setupAgentSettings:setupAgentSettings(db,id),setupAgentHistoryInitialized:true});
 }
 return history;
}
export function resetSetupAgentHistory(db,id){
 const history=setupAgentHistory(db,id);
 for(const provider of providers)history.forgetConversation(id,provider,history.conversation(id,provider));
 db.db.prepare("UPDATE automation_runs SET data=json_set(data,'$.conversation',NULL) WHERE automation_id=? AND json_extract(data,'$.kind')='interview'").run(id);
}
export function setupAgentOnboarding(db,id){
 const a=db.get(id);
 return a.reviewedRevision==null&&!db.db.prepare("SELECT 1 FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.kind')!='interview' LIMIT 1").get(id);
}
