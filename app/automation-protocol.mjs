import {createHash} from 'node:crypto';
// Change the revision when workflow semantics change without a schema change.
export const AUTOMATION_PROTOCOL_VERSION=5;
export const automationProtocol=(tools,instructions)=>createHash('sha256').update(JSON.stringify([AUTOMATION_PROTOCOL_VERSION,tools,instructions])).digest('hex');
export function prepareAutomationProtocol(db,run,protocol){
 const origin=run.continuation?db.run(run.continuation.runId):null;
 const changed=Boolean(origin?.conversation&&origin.conversation.protocol!==protocol);
 const evidenceEpoch=db.jevTasks.epoch,expired=Boolean(origin?.conversation&&origin.evidenceEpoch!==evidenceEpoch);
 const next={...db.run(run.id),protocol,evidenceEpoch,...(changed||expired?{continuation:{...run.continuation,resumeConversation:false},protocolReset:{reason:changed?'tool_contract_changed':'temporary_evidence_expired',at:db.now()}}:{})};
 if(changed&&run.taskId){const queue=db.store.workspaces.tasks,task=queue.get(run.automationId,run.taskId);queue.put({...task,toolFailures:{},toolFailure:null});}
 return db.putRun(next);
}
