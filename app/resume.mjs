// Retry exactly once after a known, pre-launch Codex resume failure.
export async function startWithResumeRepair(engine,args,onRepair=()=>{}){
 try{return await engine.request('start',args);}catch(error){
  if(args.provider!=='codex'||!args.resumeId)throw error;
  if(error.message.includes('provider history is damaged')){
   const result=await engine.request('repair-history',{sessionId:args.sessionId,cwd:args.cwd,runtimeDirectory:args.runtimeDirectory,resumeId:args.resumeId});
   onRepair(result);
   return engine.request('start',args);
  }
  if(error.message.includes('provider rejected runtime preparation')){
   const fresh={...args,resumeId:undefined};
   onRepair({fresh:true,replacedResumeId:args.resumeId});
   return engine.request('start',fresh);
  }
  throw error;
 }
}
