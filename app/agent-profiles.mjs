import {createHash} from 'node:crypto';
import {withAgentDefaults} from './agent-settings.mjs';

export const agentProfileId=role=>'builtin.agent-profile.loop-'+role;
export function personalAgent(definition,settings){
 const s=withAgentDefaults(settings);
 return {id:agentProfileId(definition.role),version:1,name:definition.name,description:definition.description,category:definition.category??'Loop',instructions:definition.instructions,agent_id:s.provider,selection:{model:s.model,permission:s.permission,reasoning:s.reasoning}};
}
export const profileDigest=profile=>createHash('sha256').update(JSON.stringify(profile)).digest('hex');

// Workspace overrides use TermLoop's AgentLibrary / PersonalAgent wire format.
// Rust validates both the library and the provider's supported launch selection.
export class AgentProfiles {
 constructor(workspaces,{validate,changed=()=>{}}){Object.assign(this,{workspaces,validate,changed});this.definitions=new Map();}
 register(definitions){for(const definition of definitions){const id=agentProfileId(definition.role);if(this.definitions.has(id))throw Error('Agent zaten kayıtlı: '+id);this.definitions.set(id,Object.freeze({...definition}));}}
 library(id){return structuredClone(this.workspaces.get(id).agentLibrary??{revision:0,agents:[],favorites:[]});}
 get(id,role,settings){const definition=this.definitions.get(agentProfileId(role));if(!definition)throw Error('Agent tanımı bulunamadı: '+role);const base=personalAgent(definition,settings??this.workspaces.get(id).agentSettings),saved=this.library(id).agents.find(p=>p.id===base.id);return saved?{...base,version:saved.version,instructions:saved.instructions}:base;}
 list(id,roles,settingsForRole){const library=this.library(id);return {revision:library.revision,agents:roles.map(role=>({...this.get(id,role,settingsForRole?.(role)),role,when:this.definitions.get(agentProfileId(role)).when}))};}
 async update(id,role,{instructions,expectedRevision}){
  const previous=this.library(id);if(previous.revision!==expectedRevision)throw Error('Agent talimatları değişti. Yenileyip tekrar kaydet.');
  if(typeof instructions!=='string')throw Error('Agent talimatı gerekli');
  const profile={...this.get(id,role),instructions,version:this.get(id,role).version+1};
  const library={...previous,revision:previous.revision+1,agents:[...previous.agents.filter(p=>p.id!==profile.id),profile]};
  await this.validate(library);
  // Validation crosses an async boundary. Never overwrite a newer editor's save.
  if(this.library(id).revision!==expectedRevision)throw Error('Agent talimatları değişti. Yenileyip tekrar kaydet.');
  const workspace=this.workspaces.get(id);workspace.agentLibrary=library;
  this.workspaces.db.prepare('UPDATE workspaces SET data=? WHERE id=?').run(JSON.stringify(workspace),id);
  this.changed(id);return profile;
 }
}
