import {TerminalScreen} from './terminal-screen.mjs';
import {profileDigest} from './agent-profiles.mjs';
import {withAgentDefaults} from './agent-settings.mjs';
import path from 'node:path';
import {launchInstructionParts,instructionPart} from './instruction-log.mjs';
import {Engine} from './engine.mjs';
import {engineBinaryPath} from './runtime-paths.mjs';
import {workerKey,MAIN_WORKER} from './worker-key.mjs';
import {startWithResumeRepair,rejectedResumeOnExit,selectResume} from './resume.mjs';
import {ContextUsage} from './context-usage.mjs';
import {TranscriptReader} from './agent-transcript.mjs';
import {ContextCompaction,compactionPending} from './context-compaction.mjs';
import {providerLimit} from './provider-limit.mjs';
import {opencodeCompaction} from './opencode-context.mjs';
import {readOpenCodeFailure} from './opencode-failure.mjs';
import {readRunTokenUsage} from './run-token-usage.mjs';

export const publicSession=active=>active?{candidateId:active.candidateId,workerId:active.workerId??MAIN_WORKER,sessionId:active.sessionId,agentProfile:active.agentProfile?{id:active.agentProfile.id,name:active.agentProfile.name,version:active.agentProfile.version}:null,state:active.state??'Unknown',contextUsage:active.contextUsage??null,compaction:active.compaction??null,usageLimit:active.usageLimit??null}:null;

// The original worker session lifecycle, shared by every workspace template.
// Templates supply instructions, tools and task policy; they never own a PTY.
export class AgentSessions {
 constructor({root,data,instructions=null,profiles=null,emit=()=>{},changed=()=>{},createEngine=(...args)=>new Engine(...args),readProviderFailure=readOpenCodeFailure}){
  Object.assign(this,{root,data,instructions,profiles,emit,changed,createEngine,readProviderFailure});
  this.engines=new Map();this.sessions=new Map();this.starting=new Set();this.closing=new Map();this.failedStops=new Set();
  this.screens=new Map();this.outputs=new Map();this.sequences=new Map();this.grids=new Map();this.transcripts=new Map();
  this.compaction=new ContextCompaction({
   send:s=>this.engineFor(s).request('compact',{sessionId:s.sessionId,nativeId:s.contextReader?.nativeId}),
   changed, event:(id,kind,value)=>this.sessions.get(workerKey(id,value.workerId))?.onRecord?.(kind,value),
   settled:s=>s.onSettled?.()
  });
 }
 audit(s,event){if(!this.instructions)return;try{return this.instructions.record({workspaceId:s.candidateId,workerId:s.workerId,sessionId:s.sessionId,provider:s.provider,agentProfileId:s.agentProfile?.id,agentProfileVersion:s.agentProfile?.version,...event});}catch(error){this.emit({event:'instruction-log-error',candidateId:s.candidateId,error:error.message});}}
 grid(id,worker=MAIN_WORKER){return this.grids.get(workerKey(id,worker))??{rows:24,cols:80};}
 engineFor(s){if(this.sessions.get(workerKey(s.candidateId,s.workerId))!==s)throw Error('Agent oturumu değişti.');return this.engines.get(workerKey(s.candidateId,s.workerId));}
 ensure(id='catalog',worker=MAIN_WORKER){
  const key=workerKey(id,worker);if(this.closing.has(key)||this.failedStops.has(key))throw Error('Önce önceki agent oturumunun kapanması doğrulanmalı.');
  if(!this.engines.has(key)){
   const instance=this.createEngine(engineBinaryPath({root:this.root}),path.join(this.data,'processes',key),async event=>{
    if(this.engines.get(key)!==instance)return;
    const s=this.sessions.get(key);if(event.sessionId&&event.sessionId!==s?.sessionId)return;
    if(event.event==='identity'&&s){s.history?.saveConversation(id,s.provider,event.nativeId,s.launchSettings);
     if(this.transcripts.get(key)?.nativeId!==event.nativeId)this.transcripts.set(key,new TranscriptReader({provider:s.provider,nativeId:event.nativeId,cwd:s.cwd,appSent:[s.launchPrompt]}));
     if(s.contextReader?.nativeId!==event.nativeId){s.contextReader=new ContextUsage({provider:s.provider,nativeId:event.nativeId,cwd:s.cwd,statusFile:path.join(s.runtimeDirectory,`context-${s.sessionId}.jsonl`)});s.compaction=null;s.contextUsage=null;}this.queueFailureCheck(s);return;}
    if(event.event==='output'){
     if(s?.resumeId)s.resumeDiagnostic=((s.resumeDiagnostic??'')+Buffer.from(event.bytes).toString()).slice(-8000);
     event={...event,sequence:(this.sequences.get(key)??0)+1};this.sequences.set(key,event.sequence);
     if(!this.screens.has(key))this.screens.set(key,new TerminalScreen(this.grid(id,worker)));
     this.screens.get(key).write(event.bytes,event.sequence);
     this.outputs.set(key,Buffer.concat([this.outputs.get(key)??Buffer.alloc(0),Buffer.from(event.bytes)]).subarray(-1000000));
     if(s)this.queueLimitCheck(s);
    }
    // A provider can print its limit and exit in the same burst. Drain the
    // rendered screen before publishing the exit, so recovery does not relaunch
    // the same exhausted provider without noticing the cause.
    if(s?.provider==='claude'&&['engine_exit','eof'].includes(event.event)){
     await this.checkUsageLimit(s).catch(()=>{});
     if(this.engines.get(key)!==instance||this.sessions.get(key)!==s)return;
    }
    if(s?.provider==='opencode'&&['engine_exit','eof'].includes(event.event)){
     await this.checkProviderFailure(s).catch(()=>{});
     if(this.engines.get(key)!==instance||this.sessions.get(key)!==s)return;
    }
    if(event.event==='compaction'&&s)this.compaction.delivery(s,event);
    if(s&&['delivery','compaction'].includes(event.event))this.audit(s,{kind:event.event,title:event.event==='delivery'?'Sağlayıcı teslim durumu':'Context sıkıştırma',status:'observed',detail:String(event.state),parts:[]});
    let compacting=false;
    if(event.event==='state'&&s){s.state=String(event.state).replace(/^Some\((.*)\)$/,'$1');compacting=this.compaction.signal(s,s.state);this.changed(id);}
    if(!compacting)s?.onEvent?.(event,s);
    if(['engine_exit','eof'].includes(event.event)){
     if(rejectedResumeOnExit(s)&&!s.persistent){s.history?.forgetConversation(id,s.provider,s.resumeId);s.onRecord?.('resume_fallback',{fresh:true,replacedResumeId:s.resumeId,reason:'Resume rejected; next launch starts fresh with saved task context'});}
     this.engines.delete(key);this.retire(id,worker);if(event.event==='eof')instance.close().catch(()=>{});s?.onExit?.(event);
    }
    this.emit({...event,candidateId:id,workerId:worker});
   });this.engines.set(key,instance);
  }return this.engines.get(key);
 }
 queueLimitCheck(s,delay=200){
  if(s.provider!=='claude'||s.limitTimer)return;
  s.limitTimer=setTimeout(()=>{s.limitTimer=null;void this.checkUsageLimit(s).catch(()=>{});},delay);
 }
 async checkUsageLimit(s){
  const key=workerKey(s.candidateId,s.workerId),screen=this.screens.get(key);if(!screen||this.sessions.get(key)!==s)return;
  const found=providerLimit(await screen.text(),s.provider);if(this.sessions.get(key)!==s)return;
  if(found)s.limitMissingAt=null;
  else if(s.usageLimit){s.limitMissingAt??=Date.now();if(Date.now()-s.limitMissingAt<600){this.queueLimitCheck(s,650);return;}}
  if(JSON.stringify(found)===JSON.stringify(s.usageLimit??null))return;
  s.usageLimit=found;s.onEvent?.({event:'usage_limit',sessionId:s.sessionId,usageLimit:found},s);this.changed(s.candidateId);
 }
 queueFailureCheck(s,delay=2000){
  if(s.provider!=='opencode'||s.failureTimer||s.providerFailure||this.sessions.get(workerKey(s.candidateId,s.workerId))!==s)return;
  s.failureTimer=setTimeout(()=>{s.failureTimer=null;void this.checkProviderFailure(s).catch(()=>{}).finally(()=>this.queueFailureCheck(s));},delay);s.failureTimer.unref?.();
 }
 async checkProviderFailure(s){
  const key=workerKey(s.candidateId,s.workerId),nativeId=this.transcripts.get(key)?.nativeId;
  if(s.provider!=='opencode'||!nativeId||s.providerFailure||this.sessions.get(key)!==s)return;
  const failure=await this.readProviderFailure({nativeId,cwd:s.cwd,since:s.startedAt});
  if(!failure||this.sessions.get(key)!==s||this.transcripts.get(key)?.nativeId!==nativeId||s.providerFailure)return;
  s.providerFailure=failure;s.state='Error';
  if(!s.persistent)s.history?.forgetConversation(s.candidateId,s.provider,nativeId);
  s.onEvent?.({event:'provider_error',sessionId:s.sessionId,summary:failure.summary},s);this.changed(s.candidateId);
 }
 async start({id,worker=MAIN_WORKER,sessionId,settings,cwd,runtimeDirectory,endpoint,token,prompt,history,approvedTools,taskType,agentProfile,onEvent,onExit,onRetire,onRecord,onSettled,currentSettings=()=>settings,resume=true,reserved=false,rotateAtBoundary=false,persistent=false}){
  settings=withAgentDefaults(settings);
  if(agentProfile){
   if(this.profiles)agentProfile=this.profiles.get(id,agentProfile.id.replace('builtin.agent-profile.loop-',''),settings);
   agentProfile=structuredClone(agentProfile);settings={...settings,agentProfileDigest:profileDigest(agentProfile)};
   history=history?.forProfile?.(agentProfile.id)??history;
  }
  const key=workerKey(id,worker);
  if(this.sessions.has(key)||this.starting.has(key)&&!reserved||this.closing.has(key)||this.failedStops.has(key))throw Error('Bu worker’ın agent oturumu zaten açık veya kapanıyor.');
  this.starting.add(key);
  const resumeId=resume&&history?selectResume(history,id,settings,{persistent}):undefined;
  const s={startedAt:Date.now(),candidateId:id,workerId:worker,sessionId,token,agentProfile,provider:settings.provider,launchSettings:{...settings},cwd,runtimeDirectory,resumeId,history,onEvent,onExit,onRetire,onRecord,onSettled,currentSettings,rotateAtBoundary:rotateAtBoundary&&!persistent,persistent,launchPrompt:typeof prompt==='string'?prompt:''};
  this.sessions.set(key,s);this.clearOutput(key);
  try{
   if(this.instructions){try{this.audit(s,{kind:'files',title:'Oturum talimat dosyaları',status:'available',parts:await launchInstructionParts(cwd)});}catch(error){this.emit({event:'instruction-log-error',candidateId:id,error:error.message});}}
   if(this.sessions.get(key)!==s)throw Error('Agent başlatılırken oturum kapandı.');
   this.audit(s,{kind:'launch',title:'Oturum başlangıç mesajı',status:'requested',resumed:Boolean(resumeId),parts:[...(agentProfile?[instructionPart('agent-profile:'+agentProfile.id,agentProfile.name+' · v'+agentProfile.version,'system',agentProfile.instructions,{when:'Oturum açılırken sağlayıcının sistem/geliştirici talimatı olarak verilir.'}),instructionPart('session-agent-profile','Agent oturum kaydı','system',{session_id:sessionId,agent:agentProfile})]:[]),instructionPart('launch-prompt','Başlangıç mesajı','system',prompt)]});
   const engine=this.ensure(id,worker);
   const compaction=await opencodeCompaction(settings);
   const launch=await startWithResumeRepair(engine,{sessionId,cwd,runtimeDirectory,endpoint,token,...settings,...(compaction?{opencodeCompaction:compaction}:{}),...(settings.provider==='opencode'&&approvedTools?.includes('read_scoring_profile')?{opencodeDocumentGuard:true}:{}),...(agentProfile?{agentProfile}:{}),resumeId,prompt,...this.grid(id,worker),...(approvedTools?{approvedTools}:{}),...(taskType?{taskType}:{})},result=>{
    if(result.fresh){history?.forgetConversation(id,settings.provider,result.replacedResumeId);s.resumeId=null;s.resumeDiagnostic='';}onRecord?.('history_repaired',result);this.changed(id);
   },{allowFreshFallback:!persistent});
   this.audit(s,{kind:'launch_accepted',title:'Başlatma isteği kabul edildi',status:'accepted',parts:launch?.providerInstructions?[instructionPart('provider-agent-instructions','Sağlayıcıya verilen agent talimatı','system',launch.providerInstructions)]:[]});
   if(this.sessions.get(key)!==s)throw Error('Agent başlatılırken oturum kapandı.');
   await engine.request('resize',this.grid(id,worker));this.changed(id);return {sessionId};
  }catch(error){this.audit(s,{kind:'launch_failed',title:'Başlatma tamamlanamadı',status:'failed',detail:error.message,parts:[]});await this.stop(id,worker).catch(()=>{});throw error;}finally{this.starting.delete(key);}
 }
 retire(id,worker=MAIN_WORKER){const key=workerKey(id,worker),s=this.sessions.get(key);if(s){const threshold=s.currentSettings().contextRestartTokens??0;if(s.rotateAtBoundary&&threshold>0&&s.contextUsage?.peakTokens>=threshold){const nativeId=s.contextReader?.nativeId??s.resumeId;if(nativeId)s.history?.forgetConversation(id,s.provider,nativeId);s.onRecord?.('agent_context_restart',{workerId:worker,provider:s.provider,peakTokens:s.contextUsage.peakTokens,thresholdTokens:threshold});}clearTimeout(s.limitTimer);clearTimeout(s.failureTimer);this.sessions.delete(key);s.onRetire?.();this.changed(id);}}
 stop(id,worker=MAIN_WORKER,{settle=async()=>{}}={}){
  const key=workerKey(id,worker);if(this.closing.has(key))return this.closing.get(key);
  const engine=this.engines.get(key);this.engines.delete(key);this.retire(id,worker);
  const pending=(async()=>{try{await engine?.close();await settle();this.failedStops.delete(key);}catch(error){this.failedStops.add(key);if(engine&&!this.engines.has(key))this.engines.set(key,engine);throw error;}finally{this.closing.delete(key);}})();
  this.closing.set(key,pending);return pending;
 }
 // The latest native conversation for a worker, kept after the session closes until a new one starts.
 async transcript(id,worker=MAIN_WORKER){const reader=this.transcripts.get(workerKey(id,worker));return reader?{nativeId:reader.nativeId,messages:await reader.read(),activity:reader.activity??null}:{nativeId:null,messages:[]};}
 async tokenUsage(id,worker,{since,until}){const reader=this.transcripts.get(workerKey(id,worker));return reader?readRunTokenUsage({...reader,appSent:[],since,until}):null;}
 output(id,worker=MAIN_WORKER){const key=workerKey(id,worker);return {bytes:[...(this.outputs.get(key)??Buffer.alloc(0))],sequence:this.sequences.get(key)??0,sessionId:this.sessions.get(key)?.sessionId??null};}
 snapshot(id,worker=MAIN_WORKER){const key=workerKey(id,worker),sessionId=this.sessions.get(key)?.sessionId??null;return this.screens.get(key)?.snapshot(sessionId)??Promise.resolve({...this.output(id,worker),...this.grid(id,worker)});}
 clearOutput(key){this.screens.get(key)?.dispose();this.screens.delete(key);this.outputs.delete(key);}
 clearOutputs(){for(const key of this.screens.keys())this.clearOutput(key);this.outputs.clear();}
 async input(id,text,worker=MAIN_WORKER,sessionId){const s=this.sessions.get(workerKey(id,worker));if(!s||sessionId&&s.sessionId!==sessionId||typeof text!=='string'||text.length>64000)return;await this.engineFor(s).request('input',{text});}
 async resize(id,rows,cols,worker=MAIN_WORKER,sessionId){if(!Number.isInteger(rows)||!Number.isInteger(cols)||rows<4||rows>1024||cols<20||cols>4096)return;const key=workerKey(id,worker),s=this.sessions.get(key),grid={rows,cols};if(sessionId&&s?.sessionId!==sessionId)return;this.grids.set(key,grid);this.screens.get(key)?.resize(grid);if(s&&(!sessionId||s.sessionId===sessionId)&&!this.starting.has(key))await this.engineFor(s).request('resize',grid);}
 async message(id,text,worker=MAIN_WORKER){const s=this.sessions.get(workerKey(id,worker));if(!s)throw Error('Etkin agent bulunamadı.');this.transcripts.get(workerKey(id,worker))?.appSent.add(String(text).trim());this.audit(s,{kind:'message',title:'Devam mesajı',status:'requested',parts:[instructionPart('message','Mesaj','user',text)]});try{const result=await this.engineFor(s).request('message',{text});this.audit(s,{kind:'message_accepted',title:'Mesaj kuyruğa alındı',status:'accepted',parts:[]});return result;}catch(error){this.audit(s,{kind:'message_failed',title:'Mesaj iletilemedi',status:'failed',detail:error.message,parts:[]});throw error;}}
 readContext(id,s){
  if(s.contextRead)return s.contextRead;
  s.contextRead=(async()=>{const settings=s.currentSettings();if(!(settings.contextRestartTokens>0||settings.contextCompactTokens>0))return null;
   const previous=s.contextUsage,reader=s.contextReader,usage=await reader?.read()??null;
   if(this.sessions.get(workerKey(id,s.workerId))!==s||s.contextReader!==reader)return null;
   s.contextUsage=usage;if(previous?.tokens!==usage?.tokens||previous?.peakTokens!==usage?.peakTokens)this.changed(id);
   if(!s.usageLimit)await this.compaction.tick(s,usage,settings.contextCompactTokens);return usage;
  })().finally(()=>{s.contextRead=null;});return s.contextRead;
 }
 contextBusy(id,worker=MAIN_WORKER){const s=this.sessions.get(workerKey(id,worker));return Boolean(s?.usageLimit)||compactionPending(s);}
 clear(id,worker=MAIN_WORKER){const key=workerKey(id,worker);this.clearOutput(key);this.sequences.delete(key);this.grids.delete(key);this.transcripts.delete(key);}
 async close(){await Promise.all([...this.engines.keys()].map(key=>{const s=this.sessions.get(key);return s?this.stop(s.candidateId,s.workerId):this.stop(key);}));this.clearOutputs();}
}
