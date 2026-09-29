// Called only at a validated task boundary. Keep browser connections/forms and
// campaign scheduling intact; the scheduler launches the next task normally.
export async function rotateAgentContext({store,stop},id,session,usage,threshold){
 await stop(id);
 for(const provider of new Set([session.provider,store.profile(id).agentSettings.provider])){
  const nativeId=store.conversation(id,provider);
  if(nativeId)store.forgetConversation(id,provider,nativeId);
 }
 store.event(id,'agent_context_restart',{provider:session.provider,percent:usage.percent,peakPercent:usage.peakPercent,thresholdPercent:threshold});
}

// Fresh conversation, durable application state. Stop first so a late provider
// identity cannot re-register the conversation being replaced. The browser is
// app-owned: keep its live connection or pending Chrome approval across restarts.
export function prepareAgentRestart({store,campaigns},id,options={}){
 const profile=store.profile(id),setup=store.setup(id);
 if(setup&&setup.status!=='complete')throw Error('Önce aday kurulumu tamamlanmalı.');
 if(!profile.cvPath)throw Error('Önce CV seç.');
 return {previous:store.campaign(id),settings:campaigns.startSettings(id,options),provider:profile.agentSettings.provider,conversation:store.conversation(id,profile.agentSettings.provider)};
}

export async function resumeAgentRestart({store,campaigns},id,state,stoppedStatus='paused'){
 if(state.previous){
  const paused=store.campaign(id);
  if(paused?.status!==stoppedStatus)throw Error('Yeniden başlatma sırasında kampanya değişti; otomatik başlatılmadı.');
  // Interrupted sends must resume as verification, not a duplicate application.
  store.saveCampaign(id,{...paused,task:state.previous.task&&!state.previous.task.report?{...state.previous.task,seenWorking:false}:null});
 }
 store.event(id,'agent_fresh_restart',{provider:state.provider,previousConversation:state.conversation??null});
 await campaigns.start(id,state.settings);
 return {fresh:true,campaign:store.campaign(id)};
}

export async function restartAgentFresh({store,campaigns,stop},id,options={}){
 const state=prepareAgentRestart({store,campaigns},id,options);
 if(state.previous)await campaigns.pause(id);else await stop(id);
 const nativeId=store.conversation(id,state.provider);
 if(nativeId)store.forgetConversation(id,state.provider,nativeId);
 return resumeAgentRestart({store,campaigns},id,state);
}
