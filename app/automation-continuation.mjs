// A worker may handle many records. Answers belong to the conversation that
// asked the question, never to whichever conversation that worker used last.
export function answerContinuation(db,id,task,kind){
 const a=db.get(id),matches=[];
 const sameTask=origin=>origin&&origin.automationId===id&&origin.status!=='running'&&origin.kind===kind&&origin.revision===a.revision&&(origin.recordId??null)===(task.recordId??null)&&(origin.recordOperation??null)===(task.recordOperation??null)&&(!task.sourceUrl||origin.sourceUrl===task.sourceUrl);
 for(const question of a.questions??[]){
  if(question.answer==null||question.resolution||question.continuationRunId)continue;
  if((question.recordId??null)!==(task.recordId??null))continue;
  const scoped=db.questionScope(id,question);
  if(!task.recordId&&(scoped.sourceUrl??null)!==(kind==='run'?task.sourceUrl??null:null))continue;
  let origin;
  const runId=question.runId??question.browserContext?.runId;
  if(runId){try{origin=db.run(runId);}catch{continue;}}
  else if(question.taskId){
   const rows=db.db.prepare(`SELECT data FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.startedAt')<=? AND (json_extract(data,'$.finishedAt') IS NULL OR json_extract(data,'$.finishedAt')>=?) LIMIT 2`).all(id,question.taskId,question.createdAt,question.createdAt);
   if(rows.length===1)origin=JSON.parse(rows[0].data);
  }
  if(!sameTask(origin))continue;
  matches.push({question,origin});
 }
 matches.sort((x,y)=>y.question.createdAt-x.question.createdAt);
 const latest=matches[0];
 if(!latest){
  // A retry is the same durable task, not the worker's most recent unrelated
  // conversation. New batches, changed scope and execution→verification stay fresh.
  const row=db.db.prepare(`SELECT data FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.taskId')=? ORDER BY json_extract(data,'$.startedAt') DESC,rowid DESC LIMIT 1`).get(id,task.id);
  const previous=row?JSON.parse(row.data):null;
  if(sameTask(previous)&&previous.operation===task.operation&&['interrupted','partial'].includes(previous.status)&&previous.conversation&&!previous.stopRequested&&!previous.actionId&&!/Kullanıcı|Worker durduruldu/.test(previous.summary??''))return {reason:'task_retry',runId:previous.id,questionIds:[],browserContext:previous.resumeContext??previous.continuation?.browserContext??null};
  // A launch interrupted by shutdown can retry the same durable queue task.
  // Changing it to verification must not revive an execution conversation.
  if(task.continuation){try{if(sameTask(db.run(task.continuation.runId)))return task.continuation;}catch{}}
  return null;
 }
 return {runId:latest.origin.id,questionIds:matches.map(m=>m.question.id),browserContext:latest.question.browserContext??latest.origin.resumeContext??null};
}

export function automationRunHistory(db,run,base,profileId=null){
 const scoped=profileId?base.forProfile(profileId):base;
 const read=()=>{
  if(!run.continuation)return null;
  const origin=db.run(run.continuation.runId);
  return origin.automationId===run.automationId&&origin.conversation?.profileId===profileId?origin.conversation:null;
 };
 return {
  forProfile:profile=>automationRunHistory(db,run,base,profile),
  conversation:(id,provider)=>run.continuation?(read()?.provider===provider?read().nativeId:null):scoped.conversation(id,provider),
  conversationSettings:(id,provider,nativeId)=>run.continuation?(read()?.provider===provider&&read()?.nativeId===nativeId?read().settings:null):scoped.conversationSettings(id,provider,nativeId),
  saveConversation:(id,provider,nativeId,settings)=>{
   scoped.saveConversation(id,provider,nativeId,settings);
   db.putRun({...db.run(run.id),conversation:{provider,nativeId,settings,profileId}});
  },
  forgetConversation:(id,provider,nativeId)=>{
   scoped.forgetConversation(id,provider,nativeId);
   for(const runId of new Set([run.id,run.continuation?.runId].filter(Boolean))){
    const saved=db.run(runId);
    if(saved.conversation?.provider===provider&&saved.conversation.nativeId===nativeId)db.putRun({...saved,conversation:null});
   }
  }
 };
}
