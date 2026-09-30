// These errors prove resume was rejected, unlike timeouts with an unknown outcome.
export function isResumeRejection(message=''){
 return /permission overrides are not supported when resuming a remote task|provider rejected runtime preparation|provider history is damaged|(?:session|conversation|thread).{0,80}(?:not found|does not exist)|(?:failed|unable) to resume/i.test(message);
}
export function rejectedResumeOnExit(active){
 return Boolean(active?.resumeId&&active.provider==='codex'&&/Error:\s*Permission overrides are not supported when resuming a remote task\./i.test((active.resumeDiagnostic??'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')));
}
export async function startWithResumeRepair(engine,args,onRepair=()=>{}){
 try{return await engine.request('start',args);}catch(error){
  if(!args.resumeId||!isResumeRejection(error.message))throw error;
  if(args.provider==='codex'&&error.message.includes('provider history is damaged')){
   try{
    const result=await engine.request('repair-history',{sessionId:args.sessionId,cwd:args.cwd,runtimeDirectory:args.runtimeDirectory,resumeId:args.resumeId});
    onRepair(result);
    return await engine.request('start',args);
   }catch(repairError){
    // An unknown start outcome must not create a second working agent.
    if(!isResumeRejection(repairError.message)&&!repairError.message.includes('unrecognized damage'))throw repairError;
   }
  }
  onRepair({fresh:true,replacedResumeId:args.resumeId});
  return engine.request('start',{...args,resumeId:undefined});
 }
}

export function selectResume(store,candidateId,settings){
 const nativeId=store.conversation(candidateId,settings.provider);if(!nativeId)return undefined;
 const previous=store.conversationSettings(candidateId,settings.provider,nativeId);
 // Legacy sessions without launch settings cannot prove permission continuity.
 if(!previous||(previous.model??'default')!==(settings.model??'default')||(previous.agentProfileDigest??null)!==(settings.agentProfileDigest??null)||previous.permission!==settings.permission||(previous.network??null)!==(settings.network??null))return undefined;
 return nativeId;
}
