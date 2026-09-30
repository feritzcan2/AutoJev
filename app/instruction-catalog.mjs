import {fileInstructionParts,contextInstructionParts,instructionPart} from './instruction-log.mjs';
import {AUTOMATION_INSTRUCTIONS} from './automation-agent-profiles.mjs';

export function webInstructionCatalog(db,id,role='web-interview'){
 const plan=db.get(id),template=db.template(plan.templateId);
 const values=contextInstructionParts('get_automation_context',{automation:Object.fromEntries(['title','goal','criteria','instructions','facts','mode','sources'].map(key=>[key,plan[key]])),template,...(role==='web-interview'?{messages:db.messages(id).slice(-20)}:{})});
 return [...fileInstructionParts('AGENTS.md',AUTOMATION_INSTRUCTIONS),...values.map(part=>({...part,when:'Agent get_automation_context çağırdığında döner. Kaynak ve görev kapsamı sonucu daraltabilir.'}))];
}
export async function instructionSnapshot({id,options={},log,agents,workspaces,profiles}){
 const roles=workspaces.template(id).agentRoles?.(id)??[],library=profiles?.list(id,roles,role=>workspaces.template(id).agentProfileSettings?.(id,role))??{revision:0,agents:[]};
 const selected=options.profile==='all'?null:library.agents.find(a=>a.id===options.profile)??library.agents[0];
 const scope={...options,profile:selected?.id??''},history=log.history(id,scope),sessions=log.sessions(id,scope);
 const parts=await workspaces.template(id).instructions?.(id,selected?.role)??[];
 if(selected)parts.unshift(instructionPart('agent-profile:'+selected.id,selected.name+' agent talimatı','system',selected.instructions,{when:'Oturum açılırken doğrudan sistem/geliştirici talimatı olarak verilir.',agentProfile:true}));
 return {workspace:workspaces.store.get(id),profiles:library.agents,profileRevision:library.revision,selectedProfileId:selected?.id??null,sessions,workers:workspaces.store.workers.list(id),activeSessions:[...agents.sessions.values()].filter(s=>s.candidateId===id&&(!selected||s.agentProfile?.id===selected.id)).map(s=>({id:s.sessionId,workerId:s.workerId,provider:s.provider})),
  parts:log.status(id,parts,scope),...history};
}
export {fileInstructionParts,contextInstructionParts,instructionPart};
