import {fileInstructionParts,contextInstructionParts,instructionPart} from './instruction-log.mjs';
import {AUTOMATION_INSTRUCTIONS} from './automation-worker.mjs';

export function webInstructionCatalog(db,id){
 const plan=db.get(id),template=db.template(plan.templateId);
 const values=contextInstructionParts('get_automation_context',{automation:Object.fromEntries(['title','goal','criteria','instructions','facts','mode','sources','maxActionsPerDay','maxBrowserSteps','timeoutMinutes'].map(key=>[key,plan[key]])),template,messages:db.messages(id).slice(-20)});
 return [...fileInstructionParts('AGENTS.md',AUTOMATION_INSTRUCTIONS),...values.map(part=>({...part,when:'Agent get_automation_context çağırdığında döner. Kaynak ve görev kapsamı sonucu daraltabilir.'}))];
}
export async function instructionSnapshot({id,options={},log,agents,workspaces}){
 const {worker='',session=''}=options;
 const history=log.history(id,options),sessions=log.sessions(id);
 const parts=await workspaces.template(id).instructions?.(id)??[];
 return {workspace:workspaces.store.get(id),sessions,workers:workspaces.store.workers.list(id),activeSessions:[...agents.sessions.values()].filter(s=>s.candidateId===id).map(s=>({id:s.sessionId,workerId:s.workerId,provider:s.provider})),
  parts:log.status(id,parts,{worker,session}),...history};
}
export {fileInstructionParts,contextInstructionParts,instructionPart};
