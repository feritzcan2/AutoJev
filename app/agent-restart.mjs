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
export async function restartAgentFresh({store,campaigns,stop},id,options={}){
 const profile=store.profile(id),setup=store.setup(id),previous=store.campaign(id);
 if(setup&&setup.status!=='complete')throw Error('Önce aday kurulumu tamamlanmalı.');
 if(!profile.cvPath)throw Error('Önce CV seç.');
 const settings=campaigns.startSettings(id,options);
 if(previous)await campaigns.pause(id);else await stop(id);
 const nativeId=store.conversation(id,profile.agentSettings.provider);
 if(nativeId)store.forgetConversation(id,profile.agentSettings.provider,nativeId);
 if(previous){
  const paused=store.campaign(id);
  if(paused?.status!=='paused')throw Error('Yeniden başlatma sırasında kampanya değişti; otomatik başlatılmadı.');
  // A send interrupted by stop is recovered as uncertain by stopAgent. Preserve
  // its task so resumeTurn chooses verification rather than another application.
  store.saveCampaign(id,{...paused,task:previous.task&&!previous.task.report?{...previous.task,seenWorking:false}:null});
 }
 store.event(id,'agent_fresh_restart',{provider:profile.agentSettings.provider,previousConversation:nativeId??null});
 await campaigns.start(id,settings);
 return {fresh:true,campaign:store.campaign(id)};
}
