import path from 'node:path';
import {launchInstructionParts,instructionPart} from './instruction-log.mjs';
import {Engine} from './engine.mjs';
import {engineBinaryPath} from './runtime-paths.mjs';
import {workerKey,MAIN_WORKER} from './worker-key.mjs';
import {startWithResumeRepair,rejectedResumeOnExit,selectResume} from './resume.mjs';
import {ContextUsage} from './context-usage.mjs';
import {ContextCompaction,compactionPending} from './context-compaction.mjs';

export const publicSession=active=>active?{candidateId:active.candidateId,workerId:active.workerId??MAIN_WORKER,sessionId:active.sessionId,state:active.state??'Unknown',contextUsage:active.contextUsage??null,compaction:active.compaction??null}:null;

// The original worker session lifecycle, shared by every workspace template.
// Templates supply instructions, tools and task policy; they never own a PTY.
export class AgentSessions {
 constructor({root,data,instructions=null,emit=()=>{},changed=()=>{},createEngine=(...args)=>new Engine(...args)}){
  Object.assign(this,{root,data,instructions,emit,changed,createEngine});
  this.engines=new Map();this.sessions=new Map();this.starting=new Set();this.closing=new Map();this.failedStops=new Set();
  this.outputs=new Map();this.sequences=new Map();this.grids=new Map();
  this.compaction=new ContextCompaction({
   send:s=>this.engineFor(s).request('compact',{sessionId:s.sessionId,nativeId:s.contextReader?.nativeId}),
   changed, event:(id,kind,value)=>this.sessions.get(workerKey(id,value.workerId))?.onRecord?.(kind,value),
   settled:s=>s.onSettled?.()
  });
 }
 audit(s,event){if(!this.instructions)return;try{return this.instructions.record({workspaceId:s.candidateId,workerId:s.workerId,sessionId:s.sessionId,provider:s.provider,...event});}catch(error){this.emit({event:'instruction-log-error',candidateId:s.candidateId,error:error.message});}}
 grid(id,worker=MAIN_WORKER){return this.grids.get(workerKey(id,worker))??{rows:24,cols:80};}
 engineFor(s){if(this.sessions.get(workerKey(s.candidateId,s.workerId))!==s)throw Error('Agent oturumu değişti.');return this.engines.get(workerKey(s.candidateId,s.workerId));}
 ensure(id='catalog',worker=MAIN_WORKER){
  const key=workerKey(id,worker);if(this.closing.has(key)||this.failedStops.has(key))throw Error('Önce önceki agent oturumunun kapanması doğrulanmalı.');
  if(!this.engines.has(key)){
   const instance=this.createEngine(engineBinaryPath({root:this.root}),path.join(this.data,'processes',key),event=>{
    if(this.engines.get(key)!==instance)return;
    const s=this.sessions.get(key);if(event.sessionId&&event.sessionId!==s?.sessionId)return;
    if(event.event==='identity'&&s){s.history?.saveConversation(id,s.provider,event.nativeId,s.launchSettings);
     if(s.contextReader?.nativeId!==event.nativeId){s.contextReader=new ContextUsage({provider:s.provider,nativeId:event.nativeId,cwd:s.cwd,statusFile:path.join(s.runtimeDirectory,`context-${s.sessionId}.jsonl`)});s.compaction=null;s.contextUsage=null;}return;}
    if(event.event==='output'){
     if(s?.resumeId)s.resumeDiagnostic=((s.resumeDiagnostic??'')+Buffer.from(event.bytes).toString()).slice(-8000);
     event={...event,sequence:(this.sequences.get(key)??0)+1};this.sequences.set(key,event.sequence);
     this.outputs.set(key,Buffer.concat([this.outputs.get(key)??Buffer.alloc(0),Buffer.from(event.bytes)]).subarray(-1000000));
    }
    if(event.event==='compaction'&&s)this.compaction.delivery(s,event);
    if(s&&['delivery','compaction'].includes(event.event))this.audit(s,{kind:event.event,title:event.event==='delivery'?'Sağlayıcı teslim durumu':'Context sıkıştırma',status:'observed',detail:String(event.state),parts:[]});
    let compacting=false;
    if(event.event==='state'&&s){s.state=String(event.state).replace(/^Some\((.*)\)$/,'$1');compacting=this.compaction.signal(s,s.state);this.changed(id);}
    if(!compacting)s?.onEvent?.(event,s);
    if(['engine_exit','eof'].includes(event.event)){
     if(rejectedResumeOnExit(s)){s.history?.forgetConversation(id,s.provider,s.resumeId);s.onRecord?.('resume_fallback',{fresh:true,replacedResumeId:s.resumeId,reason:'Resume rejected; next launch starts fresh with saved task context'});}
     this.engines.delete(key);this.retire(id,worker);if(event.event==='eof')instance.close().catch(()=>{});s?.onExit?.(event);
    }
    this.emit({...event,candidateId:id,workerId:worker});
   });this.engines.set(key,instance);
  }return this.engines.get(key);
 }
 async start({id,worker=MAIN_WORKER,sessionId,settings,cwd,runtimeDirectory,endpoint,token,prompt,history,approvedTools,taskType,onEvent,onExit,onRetire,onRecord,onSettled,currentSettings=()=>settings,resume=true,reserved=false,rotateAtBoundary=false}){
  const key=workerKey(id,worker);
  if(this.sessions.has(key)||this.starting.has(key)&&!reserved||this.closing.has(key)||this.failedStops.has(key))throw Error('Bu worker’ın agent oturumu zaten açık veya kapanıyor.');
  this.starting.add(key);
  const resumeId=resume&&history?selectResume(history,id,settings):undefined;
  const s={candidateId:id,workerId:worker,sessionId,token,provider:settings.provider,launchSettings:{...settings},cwd,runtimeDirectory,resumeId,history,onEvent,onExit,onRetire,onRecord,onSettled,currentSettings,rotateAtBoundary};
  this.sessions.set(key,s);this.outputs.delete(key);
  try{
   if(this.instructions){try{this.audit(s,{kind:'files',title:'Oturum talimat dosyaları',status:'available',parts:await launchInstructionParts(cwd)});}catch(error){this.emit({event:'instruction-log-error',candidateId:id,error:error.message});}}
   if(this.sessions.get(key)!==s)throw Error('Agent başlatılırken oturum kapandı.');
   this.audit(s,{kind:'launch',title:'Oturum başlangıç mesajı',status:'requested',resumed:Boolean(resumeId),parts:[instructionPart('launch-prompt','Başlangıç mesajı','system',prompt)]});
   const engine=this.ensure(id,worker);
   await startWithResumeRepair(engine,{sessionId,cwd,runtimeDirectory,endpoint,token,...settings,resumeId,prompt,...this.grid(id,worker),...(approvedTools?{approvedTools}:{}),...(taskType?{taskType}:{})},result=>{
    if(result.fresh){history?.forgetConversation(id,settings.provider,result.replacedResumeId);s.resumeId=null;s.resumeDiagnostic='';}onRecord?.('history_repaired',result);this.changed(id);
   });
   this.audit(s,{kind:'launch_accepted',title:'Başlatma isteği kabul edildi',status:'accepted',parts:[]});
   if(this.sessions.get(key)!==s)throw Error('Agent başlatılırken oturum kapandı.');
   await engine.request('resize',this.grid(id,worker));this.changed(id);return {sessionId};
  }catch(error){this.audit(s,{kind:'launch_failed',title:'Başlatma tamamlanamadı',status:'failed',detail:error.message,parts:[]});await this.stop(id,worker).catch(()=>{});throw error;}finally{this.starting.delete(key);}
 }
 retire(id,worker=MAIN_WORKER){const key=workerKey(id,worker),s=this.sessions.get(key);if(s){const threshold=s.currentSettings().contextRestartPercent??0;if(s.rotateAtBoundary&&threshold>0&&s.contextUsage?.peakPercent>=threshold){const nativeId=s.contextReader?.nativeId??s.resumeId;if(nativeId)s.history?.forgetConversation(id,s.provider,nativeId);s.onRecord?.('agent_context_restart',{workerId:worker,provider:s.provider,peakPercent:s.contextUsage.peakPercent,threshold});}this.sessions.delete(key);s.onRetire?.();this.changed(id);}}
 stop(id,worker=MAIN_WORKER,{settle=async()=>{}}={}){
  const key=workerKey(id,worker);if(this.closing.has(key))return this.closing.get(key);
  const engine=this.engines.get(key);this.engines.delete(key);this.retire(id,worker);
  const pending=(async()=>{try{await engine?.close();await settle();this.failedStops.delete(key);}catch(error){this.failedStops.add(key);if(engine&&!this.engines.has(key))this.engines.set(key,engine);throw error;}finally{this.closing.delete(key);}})();
  this.closing.set(key,pending);return pending;
 }
 output(id,worker=MAIN_WORKER){const key=workerKey(id,worker);return {bytes:[...(this.outputs.get(key)??Buffer.alloc(0))],sequence:this.sequences.get(key)??0,sessionId:this.sessions.get(key)?.sessionId??null};}
 async input(id,text,worker=MAIN_WORKER,sessionId){const s=this.sessions.get(workerKey(id,worker));if(!s||sessionId&&s.sessionId!==sessionId||typeof text!=='string'||text.length>64000)return;await this.engineFor(s).request('input',{text});}
 async resize(id,rows,cols,worker=MAIN_WORKER,sessionId){if(!Number.isInteger(rows)||!Number.isInteger(cols)||rows<4||rows>1024||cols<20||cols>4096)return;const key=workerKey(id,worker),s=this.sessions.get(key),grid={rows,cols};this.grids.set(key,grid);if(s&&(!sessionId||s.sessionId===sessionId)&&!this.starting.has(key))await this.engineFor(s).request('resize',grid);}
 async message(id,text,worker=MAIN_WORKER){const s=this.sessions.get(workerKey(id,worker));if(!s)throw Error('Etkin agent bulunamadı.');this.audit(s,{kind:'message',title:'Devam mesajı',status:'requested',parts:[instructionPart('message','Mesaj','user',text)]});try{const result=await this.engineFor(s).request('message',{text});this.audit(s,{kind:'message_accepted',title:'Mesaj kuyruğa alındı',status:'accepted',parts:[]});return result;}catch(error){this.audit(s,{kind:'message_failed',title:'Mesaj iletilemedi',status:'failed',detail:error.message,parts:[]});throw error;}}
 readContext(id,s){
  if(s.contextRead)return s.contextRead;
  s.contextRead=(async()=>{const settings=s.currentSettings();if(!(settings.contextRestartPercent>0||settings.contextCompactPercent>0))return null;
   const previous=s.contextUsage,reader=s.contextReader,usage=await reader?.read()??null;
   if(this.sessions.get(workerKey(id,s.workerId))!==s||s.contextReader!==reader)return null;
   s.contextUsage=usage;if(previous?.percent!==usage?.percent||previous?.peakPercent!==usage?.peakPercent)this.changed(id);
   await this.compaction.tick(s,usage,settings.contextCompactPercent);return usage;
  })().finally(()=>{s.contextRead=null;});return s.contextRead;
 }
 contextBusy(id,worker=MAIN_WORKER){return compactionPending(this.sessions.get(workerKey(id,worker)));}
 clear(id,worker=MAIN_WORKER){const key=workerKey(id,worker);this.outputs.delete(key);this.sequences.delete(key);this.grids.delete(key);}
 async close(){await Promise.all([...this.engines.keys()].map(key=>{const s=this.sessions.get(key);return s?this.stop(s.candidateId,s.workerId):this.stop(key);}));}
}
