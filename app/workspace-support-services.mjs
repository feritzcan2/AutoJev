import path from 'node:path';
import {fileInstructionParts,contextInstructionParts} from './instruction-log.mjs';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {BackgroundStore} from './background-store.mjs';
import {BackgroundJobs} from './background.mjs';
import {BACKGROUND_AGENT,launchSkillWorker} from './background-worker.mjs';
import {inspectGmailAccess} from './connector-access.mjs';
import {withAgentDefaults} from './agent-settings.mjs';
import {Telegram} from './telegram-accounts.mjs';
import {WorkspaceSupport,rebindWorkspaceOwners} from './workspace-support.mjs';
export async function registerWorkspaceSupport({root,data,db,runtime,agents,profiles,mcp,scheduler,handle,emit,dialog,shell,getWindow,encryptSecret,decryptSecret,isQuitting}){
 rebindWorkspaceOwners(db.db);
 const store=new WorkspaceSupport(db,runtime),ensureEngine=()=>agents.ensure('catalog');profiles.register([BACKGROUND_AGENT]);
const backgroundDb=new BackgroundStore(store);
await rm(path.join(data,'google-oauth.json'),{force:true});
const backgroundOutput=new Map();
const background=new BackgroundJobs(backgroundDb,{changed:candidateId=>emit('background-changed',{candidateId}),launch:(run,task,onEvent,signal)=>launchSkillWorker({root,data,agents,mcp,db:backgroundDb,run,task,onEvent,signal,complete:(...args)=>background.complete(...args),onOutput:bytes=>{
 const output=Buffer.concat([backgroundOutput.get(run.id)??Buffer.alloc(0),Buffer.from(bytes)]).subarray(-150000);backgroundOutput.set(run.id,output);while(backgroundOutput.size>30)backgroundOutput.delete(backgroundOutput.keys().next().value);emit('background-output',{candidateId:run.candidateId,runId:run.id,bytes});
}})});
handle('background-snapshot',async id=>({task:backgroundDb.task(id),mail:backgroundDb.mailContract(id),runs:backgroundDb.runs(id),signals:backgroundDb.signals(id),applications:store.jobs(id).map(({id,company,role,status,updatedAt})=>({id,company,role,status,updatedAt}))}));
handle('background-save',async(id,input)=>{if(input.agentOverride!=null){const settings=withAgentDefaults(input.agentOverride);if(!['codex','claude'].includes(settings.provider)||![true,false,null].includes(settings.network))throw Error('Geçersiz agent ayarları');await ensureEngine().request('validate',settings);input={...input,agentOverride:{provider:settings.provider,model:settings.model,permission:settings.permission,reasoning:settings.reasoning,network:settings.provider==='codex'?settings.network:null}};}if(input.skillPath){if(!path.isAbsolute(input.skillPath)||path.extname(input.skillPath).toLowerCase()!=='.md')throw Error('Bir Markdown skill dosyası seç');if(!(await readFile(input.skillPath,'utf8')).trim())throw Error('Skill dosyası boş');}const result=backgroundDb.save(id,input);emit('background-changed',{candidateId:id});return result;});
handle('background-pick-skill',async()=>{const result=await dialog.showOpenDialog(getWindow(),{properties:['openFile'],filters:[{name:'Skill',extensions:['md']}]});return result.canceled?null:result.filePaths[0];});
handle('background-read-skill',async id=>readFile(backgroundDb.task(id).skillPath||path.join(root,'skills/gmail-sync/SKILL.md'),'utf8'));
const connectorChecks=new Map();
handle('background-check-gmail',async id=>{
 if(connectorChecks.has(id))return connectorChecks.get(id);
 const task=backgroundDb.task(id),workspace=path.join(data,'background','workspaces',id);
 const check=(async()=>{await mkdir(workspace,{recursive:true,mode:0o700});let access;try{access=await inspectGmailAccess(task.agentSettings.provider,workspace);}catch(error){access={status:'error',message:error.message,installUrl:null};}access.checkedAt=Date.now();access.provider=task.agentSettings.provider;if(isQuitting())return access;const current=backgroundDb.task(id);if(current.agentSettings.provider!==access.provider)return access;backgroundDb.putTask(id,{...current,connectorAccess:access});emit('background-changed',{candidateId:id});return access;})();connectorChecks.set(id,check);try{return await check;}finally{connectorChecks.delete(id);}
});
handle('background-connect-gmail',async id=>{const task=backgroundDb.task(id),access=task.connectorAccess;if(!access?.installUrl||access.provider!==task.agentSettings.provider)throw Error('Önce Gmail bağlantısını kontrol et');const url=new URL(access.installUrl);if(url.protocol!=='https:'||url.hostname!=='chatgpt.com')throw Error('Geçersiz bağlantı adresi');await shell.openExternal(url.toString());});
handle('background-run',id=>background.start(id));
handle('background-message',(id,text,runId)=>background.message(id,text,runId));
handle('background-stop',id=>background.finish(id,'cancelled','Kullanıcı durdurdu.'));
handle('background-terminal',async(id,runId)=>{store.profile(id);if(backgroundDb.run(runId)?.candidateId!==id)throw Error('Görev bulunamadı');return [...(backgroundOutput.get(runId)??await readFile(path.join(data,'background',runId,'terminal.log')).catch(()=>Buffer.alloc(0)))];});
handle('background-input',(id,runId,text)=>{const slot=background.active.get(id);if(slot?.run.id!==runId||slot.finishing||typeof text!=='string'||text.length>64000)throw Error('Etkin görev bulunamadı');if(!slot.run.interactive){slot.run.interactive=true;clearTimeout(slot.timer);clearTimeout(slot.idleTimer);backgroundDb.putRun(slot.run);emit('background-changed',{candidateId:id});}if(!slot.worker)throw Error('Agent henüz hazırlanıyor');return slot.worker.input(text);});
handle('background-resize',(id,runId,rows,cols)=>{if(!Number.isInteger(rows)||rows<4||rows>1024||!Number.isInteger(cols)||cols<20||cols>4096)throw Error('Geçersiz terminal boyutu');const slot=background.active.get(id);if(slot?.run.id===runId&&!slot.finishing)return slot.worker?.resize(rows,cols);});
handle('resolve-mail-signal',(id,signalId,jobId,outcome)=>{const result=backgroundDb.resolve(id,signalId,jobId,outcome);emit('background-changed',{candidateId:id});return result;});
handle('dismiss-mail-signal',(id,signalId)=>{backgroundDb.dismiss(id,signalId);emit('background-changed',{candidateId:id});});


 const telegram=new Telegram({store,data,encrypt:encryptSecret,decrypt:decryptSecret,changed:id=>emit('changed',{candidateId:id}),
  answer:async(id,question,text)=>{const result=await runtime.answer(id,question,text);emit('changed',{candidateId:id});return result;},
  queueApplication:(id,itemId,token)=>store.queueRecord(id,itemId,token),
  withdrawApplication:(id,itemId)=>runtime.dismissRecord(id,itemId)});
 handle('telegram-status',id=>telegram.status(id));handle('telegram-configure',(id,input)=>telegram.configure(id,input));
 handle('telegram-pair',id=>telegram.pairing(id));handle('telegram-unlink',id=>telegram.unlink(id));handle('telegram-preferences',(id,input)=>telegram.preferences(id,input));handle('telegram-retry',id=>telegram.retry(id));handle('telegram-send-unsent-jobs',id=>telegram.sendUnsentJobs(id));
 scheduler.register('background-skills',()=>background.tick(),{interval:5000});await telegram.load();
 return {store,background,telegram,async instructions(id){const task=backgroundDb.task(id);return [...fileInstructionParts('AGENTS.md',BACKGROUND_AGENT.instructions),...fileInstructionParts('TASK.md',await readFile(task.skillPath||path.join(root,'skills/gmail-sync/SKILL.md'),'utf8')),...contextInstructionParts('get_background_context',{profile:store.profile(id)})];},async remove(id){await background.finish(id);await telegram.removeCandidate(id);},async close(){await telegram.stop();await background.close();},async stop(){background.closed=true;await telegram.stop();},async resume(){background.closed=false;await telegram.load();},assertIdle(){if(background.active.size)throw Error('Önce arka plan görevlerini durdur.');},activeRunIds:()=>[...background.active.values()].map(s=>s.run.id),clearOutputs:()=>backgroundOutput.clear()};
}
