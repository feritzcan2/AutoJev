// Batch scoring keeps a primary recordId for existing record-task routing.
// Ownership and score writes always use the complete assignment.
export const taskRecordIds=task=>task?.recordIds??(task?.recordId?[task.recordId]:[]);
export const taskHasRecord=(task,id)=>taskRecordIds(task).includes(id);
export const batchScoring=task=>task?.recordOperation==='score'&&Array.isArray(task.recordIds);

// Score provenance, not its numeric value, proves completion of this task.
export function recordScoredInTask(db,task,item){
 if(task?.recordOperation!=='score'||!taskHasRecord(task,item.id)||!item.assessment?.runId)return false;
 const revision=task.revision??task.request?.revision;
 if(item.assessment.revision!==revision)return false;
 try{const run=db.run(item.assessment.runId);return run.automationId===(task.automationId??task.workspaceId)&&run.taskId===(task.taskId??task.id);}catch{return false;}
}
