import {JOB_AGENTS,JOB_AGENT_ROLES,jobAgentRole,jobAgentProfile} from './agent-profiles.mjs';
import {BACKGROUND_AGENT,BACKGROUND_AGENTS_MD} from '../../background-worker.mjs';
import {withAgentDefaults} from '../../agent-settings.mjs';
import {fileInstructionParts,contextInstructionParts,instructionPart} from '../../instruction-log.mjs';
import {runtimeResourceRoot} from '../../runtime-paths.mjs';
import {AccountVault} from '../../account-vault.mjs';
import {editPreparation} from '../../preparation.mjs';
import {exportPreparation} from '../../preparation-export.mjs';
import {writeWorkspaceInstructions} from '../../workspace-instructions.mjs';
import {STARTUP_INSTRUCTIONS} from './instructions.mjs';
import {saveProfileWithBrowserChange} from '../../browser-engine-change.mjs';
import {browserResume} from '../../browser-resume.mjs';
import {sourceInstructions,runSourceTool,sourceIntegrations} from '../../source-integrations.mjs';
import {focusApplicationTab} from '../../focus-tab.mjs';
import {inspectGmailAccess} from '../../connector-access.mjs';
import {BackgroundStore} from '../../background-store.mjs';
import {BackgroundJobs} from '../../background.mjs';
import {launchSkillWorker} from '../../background-worker.mjs';
import {Store} from '../../store.mjs';
import {rotateAgentContext} from '../../agent-restart.mjs';
import {AGENTS_MD,promptCatalog,browserProfileInstruction} from '../../prompts.mjs';
import {Setups} from '../../setup.mjs';
import {WorkerCampaigns} from '../../worker-campaigns.mjs';
import {MAIN_WORKER,workerKey} from '../../worker-state.mjs';
import {Telegram} from '../../telegram-accounts.mjs';
import {mkdir,cp,readFile,copyFile,chmod,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {applicationWorkerView} from './view.mjs';
import {publicSession} from '../../agent-sessions.mjs';
import {applicationProtocol} from './mcp.mjs';
export {jobSearchDefinition as definition} from './definition.mjs';
export async function register({root,data,core,handle,emit,agents,profiles,browser,mcp,scheduler,maintenance,documents,dialog,shell,getWindow,encryptSecret,decryptSecret,jevSettings,restartingAgents,isQuitting}){
 profiles.register([...JOB_AGENTS,BACKGROUND_AGENT]);
 const store=new Store(path.join(data,'jobloop.sqlite'),{core});
 const {engines,sessions,starting}=agents,ensureEngine=(id='catalog',worker=MAIN_WORKER)=>agents.ensure(id,worker);
const accountVault=new AccountVault(store.db,{encrypt:encryptSecret,decrypt:decryptSecret});
for(const candidate of store.candidates())for(const sessionId of new Set(store.jobs(candidate.id).map(j=>j.sessionId).filter(Boolean)))store.recoverSession(candidate.id,sessionId);

handle('candidates',()=>store.candidates());
const backgroundDb=new BackgroundStore(store);
await rm(path.join(data,'google-oauth.json'),{force:true});
const backgroundOutput=new Map();
const background=new BackgroundJobs(backgroundDb,{changed:candidateId=>emit('background-changed',{candidateId}),launch:(run,task,onEvent,signal)=>launchSkillWorker({root,data,agents,mcp,db:backgroundDb,run,task,onEvent,signal,complete:(...args)=>background.complete(...args),onOutput:bytes=>{
 const output=Buffer.concat([backgroundOutput.get(run.id)??Buffer.alloc(0),Buffer.from(bytes)]).subarray(-150000);backgroundOutput.set(run.id,output);while(backgroundOutput.size>30)backgroundOutput.delete(backgroundOutput.keys().next().value);emit('background-output',{candidateId:run.candidateId,runId:run.id,bytes});
}})});
handle('background-snapshot',async id=>({task:backgroundDb.task(id),runs:backgroundDb.runs(id),signals:backgroundDb.signals(id),applications:store.jobs(id).map(({id,company,role,status,updatedAt})=>({id,company,role,status,updatedAt}))}));
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

const sourceTabs=async id=>Object.assign({},...await Promise.all(store.workers(id).map(w=>browser.forWorker(w.id).sourceTabs(id,store.sources(id),store.forWorker(w.id).campaign(id)?.task))));
handle('source-tabs',sourceTabs);
const workerSnapshot=id=>store.workers(id).map(w=>({...w,campaign:store.forWorker(w.id).campaign(id),active:publicSession(sessions.get(workerKey(id,w.id)))}));
const jobSnapshot=async id=>{const workers=workerSnapshot(id),campaign=campaigns.summary(id),owner=workers.find(w=>w.campaign?.task?.id===campaign?.task?.id&&w.active)??workers.find(w=>w.active);const snapshot=store.snapshot(id);return {...snapshot,prompts:store.prompts(id,80).filter(p=>p.kind==='message'),definition:store.workspaces.definition(id),capabilities:{maxWorkers:store.workspaces.definition(id).execution.maxWorkers,canStart:Boolean(store.profile(id).cvPath),canRestart:Boolean(store.profile(id).cvPath),browserModes:['existing','separate','jev'],workerRestart:true,terminalConversation:false,workerDescription:'Her worker arama, puanlama ve başvuru işlerini ortak kuyruktan alır.'},campaign,execution:{status:campaign?.status??'idle',task:campaign?.task??null,note:campaign?.note},workers:workers.map(worker=>applicationWorkerView(worker,snapshot)),accountCredentials:accountVault.status(id),sourceTabs:await sourceTabs(id),documents:await documents.list(id),browserStatus:browser.status(id),active:owner?.active??null};};

handle('account-credentials-save',(id,input)=>{store.profile(id);const result=accountVault.save(id,input);emit('changed',{candidateId:id});return result;});
handle('account-credentials-remove',id=>{store.profile(id);accountVault.remove(id);emit('changed',{candidateId:id});return {configured:false};});
handle('save-profile',async p=>{if(p.agentSettings){p={...p,agentSettings:withAgentDefaults(p.agentSettings)};await ensureEngine().request('validate',p.agentSettings);if(p.agentSettings.provider==='gemini')throw Error('Gemini MCP entegrasyonu henüz desteklenmiyor');if(![true,false,null].includes(p.agentSettings.network))throw Error('Geçersiz ağ tercihi');}const profile=await saveProfileWithBrowserChange({store,campaigns,stop:stopAgent,resetBrowser:id=>browser.resetCandidate(id)},p);emit('changed',{});return profile;});

const deletingWorkspaces=new Set();
const deleteJobWorkspace=async id=>{
  store.profile(id);
  if(deletingWorkspaces.has(id)||starting.has(id)||campaigns.launching.has(id))throw Error('Agent başlatılıyor; işlem bitince yeniden dene.');
  deletingWorkspaces.add(id);
  try{
    const setup=store.setup(id);if(setup?.status==='running')store.saveSetup(id,{...setup,status:'cancelled',needsTurn:false});
    await campaigns.pause(id,'stopped');
    if(sessions.has(id)||engines.has(id))await stopAgent(id);
    if(background.active.has(id))await background.finish(id,'interrupted','Çalışma alanı silindi.');
    await connectorChecks.get(id)?.catch(()=>{});
    await browser.resetCandidate(id);
    const runIds=store.db.prepare('SELECT id FROM background_runs WHERE candidate_id=?').all(id).map(row=>row.id);
    accountVault.remove(id);
    await telegram.removeCandidate(id);
    for(const w of store.workers(id)){const key=workerKey(id,w.id);await stopAgent(id,w.id);await rm(path.join(data,'processes',key),{recursive:true,force:true});}
    store.deleteWorkspace(id);
    for(const runId of runIds){backgroundOutput.delete(runId);await rm(path.join(data,'background',runId),{recursive:true,force:true});}
    for(const directory of ['candidates','browsers','processes'])await rm(path.join(data,directory,id),{recursive:true,force:true});
    await rm(path.join(data,'background','workspaces',id),{recursive:true,force:true});
    emit('changed',{});return {deleted:true};
  }finally{deletingWorkspaces.delete(id);}
};
handle('source-integrations',()=>sourceIntegrations);
handle('source-instructions',(id,sourceId)=>sourceInstructions(root,store.source(id,sourceId)));
handle('source-test',async(id,sourceId)=>{const result=await runSourceTool(root,store.source(id,sourceId),['search','--help'],{test:true});store.event(id,'source_tool_tested',{sourceId,ok:result.ok});return result;});
handle('save-source',(candidateId,source)=>{if(restartingAgents.has(candidateId))throw Error('Agent yeniden başlatılıyor.');return campaigns.saveSource(candidateId,source);});
handle('save-sources-apply-mode',async(candidateId,applyMode)=>{if(restartingAgents.has(candidateId))throw Error('Agent yeniden başlatılıyor.');const result=store.saveSourcesApplyMode(candidateId,applyMode);emit('changed',{candidateId});await campaigns.tick();return result;});
handle('save-sources-interval',async(candidateId,intervalMinutes)=>{if(restartingAgents.has(candidateId))throw Error('Agent yeniden başlatılıyor.');const result=store.saveSourcesInterval(candidateId,intervalMinutes);emit('changed',{candidateId});await campaigns.tick();return result;});
handle('delete-source',(candidateId,id)=>{const result=store.deleteSource(candidateId,id);emit('changed',{candidateId});return result;});
handle('save-rank-settings',async(id,input)=>{const result=store.saveRankSettings(id,input);emit('changed',{candidateId:id});await campaigns.tick();return result;});
handle('save-rank-threshold',async(id,value)=>{const result=store.saveRankThreshold(id,value);emit('changed',{candidateId:id});await campaigns.tick();return result;});
const setManualJobStatus=async(id,jobId,outcome)=>{maintenance.assertAvailable();store.job(id,jobId);if(!['manual_submitted','already_submitted','withdrawn'].includes(outcome))throw Error('Geçersiz manuel durum');const owner=campaigns.owner(id,jobId);if(store.forWorker(owner).campaign(id)?.task?.jobId===jobId)await campaigns.forWorker(owner).pause(id);const result=store.setManualJobStatus(id,jobId,outcome);emit('changed',{candidateId:id});return result;};
handle('set-manual-job-status',setManualJobStatus);
handle('set-job-starred',(id,jobId,starred)=>{const result=store.setJobStarred(id,jobId,starred);emit('changed',{candidateId:id});return result;});
handle('set-job-hidden',(id,jobId,hidden)=>{const result=store.setJobHidden(id,jobId,hidden);emit('changed',{candidateId:id});return result;});
handle('retry-job-rank',async(id,jobId)=>{const result=store.retryJobRank(id,jobId);emit('changed',{candidateId:id});await campaigns.tick();return result;});
handle('queue-ranked-job',(id,jobId)=>queueApplication(id,jobId));
handle('save-application-policy',(candidateId,policy)=>{const result=store.saveApplicationPolicy(candidateId,policy);emit('changed',{candidateId});return result;});
function requireBrowserReady(candidateId){
  if(!browser.prepare(candidateId).ready)throw Object.assign(Error('Chrome izni ve bağlantısı bekleniyor. Agent henüz başlatılmadı.'),{code:'BROWSER_WAIT'});
}
const agentDirectory=(id,workerId=MAIN_WORKER)=>workerId===MAIN_WORKER?path.join(data,'candidates',id):path.join(data,'candidates',id,'workers',workerId);
async function startAgent(candidateId,prompt,jobId,workerId=MAIN_WORKER){
  maintenance.assertAvailable();
  const key=workerKey(candidateId,workerId),scoped=store.forWorker(workerId);
  if(deletingWorkspaces.has(candidateId))throw Error('Çalışma alanı siliniyor.');
  if(sessions.has(key)||starting.has(key))throw Error('Bu worker’ın agent oturumu zaten açık');
  requireBrowserReady(candidateId);
  const profile=store.profile(candidateId);if(!profile.cvPath&&store.setup(candidateId)?.status!=='running')throw Error('Önce CV seç');starting.add(key);
  const activeJobId=jobId??scoped.campaign(candidateId)?.task?.jobId;
  const resumeBrowser=browserResume(profile,activeJobId?store.job(candidateId,activeJobId):null);
  prompt=[STARTUP_INSTRUCTIONS,browserProfileInstruction(profile),'This is one JobLoop worker. Other workers may use the same candidate and Chrome account concurrently. Work only on your assigned task. Keep your own browser tab handles, never operate on or close another task’s tabs, and never reuse an unrelated application form. For preparation packages use get_task_context.documentRoot/documents/<job-id>; otherwise save generated documents under this worker workspace with job-specific filenames.',resumeBrowser?.instruction,prompt].filter(Boolean).join('\n\n');
  const sessionId=randomUUID(),token=mcp.grant(candidateId,sessionId,workerId);store.logPrompt(candidateId,{kind:'start',text:prompt,jobId:jobId??null,sessionId});
  try{
    const cwd=agentDirectory(candidateId,workerId);await mkdir(cwd,{recursive:true,mode:0o700});await cp(path.join(runtimeResourceRoot({root}),'skills'),path.join(cwd,'.agents/skills'),{recursive:true});
    await writeWorkspaceInstructions(cwd,AGENTS_MD);
    await mkdir(path.join(cwd,'runtime'),{recursive:true});await mkdir(path.join(cwd,'documents'),{recursive:true});
    requireBrowserReady(candidateId);
    if(jobId){const job=store.job(candidateId,jobId);if(['blocked','uncertain'].includes(job.status)&&job.sessionId!==sessionId)store.reclaim(candidateId,jobId,sessionId);}
    await agents.start({agentProfile:jobAgentProfile(jobAgentRole(store,candidateId,workerId),profile.agentSettings),id:candidateId,worker:workerId,reserved:true,sessionId,settings:profile.agentSettings,cwd,runtimeDirectory:path.join(cwd,'runtime'),endpoint:mcp.endpoint,token,prompt,history:store.workspaces.history(candidateId,workerId),
      currentSettings:()=>store.profile(candidateId).agentSettings,
      onRecord:(kind,value)=>store.event(candidateId,kind,value),
      onRetire:()=>{store.recoverSession(candidateId,sessionId);mcp.revoke(token);},
      onSettled:()=>campaigns.forWorker(workerId).afterCompaction(candidateId),
      onEvent:event=>{const controller=campaigns.forWorker(workerId);if(event.event==='delivery')controller.delivery(candidateId,event.state.replace(/^Some\((.*)\)$/,'$1'));if(event.event==='state')controller.signal(candidateId,event.state.replace(/^Some\((.*)\)$/,'$1'));},
      onExit:()=>{campaigns.forWorker(workerId).exited(candidateId);if(workerId===MAIN_WORKER)setups.exited(candidateId);}
    });
    emit('changed',{});return{sessionId};
  }catch(error){mcp.revoke(token);await agents.stop(candidateId,workerId).catch(()=>{});throw error;}finally{starting.delete(key);}
}
const stopAgent=(id,workerId=MAIN_WORKER)=>agents.stop(id,workerId,{settle:()=>browser.forWorker(workerId).waitForOperations(id)});
const sendPrompt=async(text,id,workerId=MAIN_WORKER)=>{
 const role=jobAgentRole(store,id,workerId),active=sessions.get(workerKey(id,workerId));
 if(active?.agentProfile?.id!==jobAgentProfile(role,store.profile(id).agentSettings).id){await stopAgent(id,workerId);return startAgent(id,text,null,workerId);}
store.logPrompt(id,{kind:'message',text,sessionId:sessions.get(workerKey(id,workerId))?.sessionId??null});return agents.message(id,text,workerId);};
const readContext=(id,session)=>agents.readContext(id,session);
const campaigns=new WorkerCampaigns(store,{browserReady:id=>browser.prepare(id),launch:startAgent,send:sendPrompt,stop:stopAgent,active:(id,workerId)=>sessions.get(workerKey(id,workerId)),changed:id=>emit('changed',{candidateId:id}),readContext,contextBusy:(id,workerId)=>agents.contextBusy(id,workerId),rotateContext:(id,session,usage,threshold,workerId)=>rotateAgentContext({store:store.forWorker(workerId),stop:id=>stopAgent(id,workerId)},id,session,usage,threshold)});
for(const candidate of store.candidates()){campaigns.recheckLegacyFormQuestions(candidate.id);campaigns.recheckPendingVerifications(candidate.id);}
for(const p of store.candidates())for(const w of store.workers(p.id)){const scoped=store.forWorker(w.id),c=scoped.campaign(p.id);if(c?.status==='running')scoped.saveCampaign(p.id,{...c,task:c.task?{...c.task,report:null,seenWorking:false,recovery:{readyAt:Date.now()+2000,reason:'App restarted; resume the unfinished task after checking saved outcomes'}}:null,wakeAt:Date.now()+2000});}
const setups=new Setups(store,{browserReady:id=>browser.prepare(id),launch:startAgent,send:sendPrompt,active:id=>sessions.get(id),changed:id=>emit('changed',{candidateId:id})});
for(const p of store.candidates()){const s=store.setup(p.id);if(s?.status==='running')store.saveSetup(p.id,{...s,needsTurn:true});}
handle('create-setup',async settings=>{settings=withAgentDefaults(settings);await ensureEngine().request('validate',settings);if(!['codex','claude'].includes(settings.provider))throw Error('Desteklenmeyen sağlayıcı');const p=store.createSetup(settings);emit('changed',{});return p;});
handle('begin-setup',async(id,source)=>{const s=store.setup(id);if(!s||s.status==='complete')throw Error('Setup bulunamadı');if(source){const url=new URL(source);if(url.protocol!=='https:'||!['linkedin.com','www.linkedin.com'].includes(url.hostname)||!url.pathname.startsWith('/in/'))throw Error('Geçerli bir LinkedIn profil bağlantısı gir');store.saveSetup(id,{...s,source:url.toString()});}await setups.begin(id);});
handle('complete-setup',async(id,fields)=>{if(sessions.has(id))await stopAgent(id);const p=store.completeSetup(id,fields);emit('changed',{});return p;});
handle('import-setup-cv',async(id,file)=>{if(store.setup(id)?.status!=='intake')throw Error('CV yüklemek için setup başlangıcında olmalısın');if(typeof file!=='string'||!path.isAbsolute(file)||!['.pdf','.docx','.txt'].includes(path.extname(file).toLowerCase()))throw Error('PDF, Word veya TXT CV seç');const dir=path.join(data,'candidates',id);await mkdir(dir,{recursive:true,mode:0o700});const target=path.join(dir,'CV'+path.extname(file).toLowerCase());await copyFile(file,target);await chmod(target,0o600);store.setCv(id,target);emit('changed',{});return target;});
handle('improve-profile',async id=>{
 if(restartingAgents.has(id)||starting.has(id)||campaigns.launching.has(id))throw Error('Agent başlatılıyor; mevcut işlemi bekle.');
 restartingAgents.add(id);
 try{
  store.beginProfileImprovement(id);
  if(store.campaign(id))await campaigns.pause(id);else await stopAgent(id);
  await setups.begin(id);
 }finally{restartingAgents.delete(id);emit('changed',{candidateId:id});}
});
handle('finish-profile-improvement',async id=>{
 if(restartingAgents.has(id)||starting.has(id))throw Error('Agent başlatılıyor; mevcut işlemi bekle.');
 const setup=store.setup(id);if(setup?.mode!=='improve'||setup.status==='complete')throw Error('Etkin profil geliştirme bulunamadı');
 restartingAgents.add(id);
 try{store.saveSetup(id,{...setup,needsTurn:false});await stopAgent(id);return store.finishProfileImprovement(id);}
 finally{restartingAgents.delete(id);emit('changed',{candidateId:id});}
});
const restartWorkspaceAgent=async(id,options)=>{
 if(restartingAgents.has(id)||campaigns.launching.has(id))throw Error('Agent başlatılıyor; mevcut işlemi bekle.');
 const settings=campaigns.startSettings(id,options),previous=workerSnapshot(id);
 restartingAgents.add(id);
 try{
  await campaigns.pause(id);
  for(const w of previous){const scoped=store.forWorker(w.id);for(const provider of ['codex','claude']){const native=scoped.conversation(id,provider);if(native)scoped.forgetConversation(id,provider,native);}
   if(w.campaign)scoped.saveCampaign(id,{...scoped.campaign(id),task:w.campaign.task&&!w.campaign.task.report?{...w.campaign.task,seenWorking:false}:null});
  }
  await campaigns.start(id,settings);return {fresh:true,campaign:campaigns.summary(id)};
 }finally{restartingAgents.delete(id);emit('changed',{candidateId:id});}
};

handle('prompt-catalog',()=>promptCatalog(root));
handle('prompts',id=>{store.profile(id);return store.prompts(id);});

const answerCandidate=async(candidateId,id,answer)=>{maintenance.assertAvailable();const result=store.answer(candidateId,id,answer);setups.answered(candidateId);emit('changed',{});const delivery=await campaigns.continueAfterAnswer(candidateId,id);await setups.tick();return{...result,...delivery};};
handle('answer',answerCandidate);
const queueApplication=(candidateId,jobId)=>{maintenance.assertAvailable();if(restartingAgents.has(candidateId))throw Error('Agent yeniden başlatılıyor.');return campaigns.queueAndStartApplication(candidateId,jobId);};
handle('queue-application',queueApplication);
handle('prepare-application',(id,jobId)=>{if(restartingAgents.has(id))throw Error('Agent yeniden başlatılıyor.');return campaigns.queueAndStartPreparation(id,jobId);});
handle('edit-preparation',async(id,jobId,input)=>{const value=await editPreparation(store,id,jobId,input);emit('changed',{candidateId:id});return value;});
handle('export-preparation',(id,jobId)=>exportPreparation(store,id,jobId));
handle('reclaim',(candidateId,id)=>{const reservation=store.workerState.tasks(candidateId).find(w=>w.task.jobId===id);if(reservation)throw Error('Bu ilan bir worker tarafından işleniyor.');const active=sessions.get(candidateId);if(!active)throw Error('Bu adayın agent oturumunu başlat');const result=store.reclaim(candidateId,id,active.sessionId);emit('changed',{});return result;});
const focusTab=(id,context)=>context?.browser==='Jev Chrome'?browser.focus(id,context):focusApplicationTab(context);
handle('open-source-tab',(candidateId,sourceId)=>{const source=store.source(candidateId,sourceId);return store.profile(candidateId).browserMode==='jev'?browser.focusSource(candidateId,source,store.workerState.tasks(candidateId).find(w=>w.task.kind==='search'&&w.task.sourceId===sourceId)?.task):focusTab(candidateId,source.resumeContext);});
handle('open-application-tab',(candidateId,jobId)=>focusTab(candidateId,store.job(candidateId,jobId).resumeContext));
handle('recover-question',(candidateId,questionId)=>{if(restartingAgents.has(candidateId))throw Error('Agent yeniden başlatılıyor.');return campaigns.retryQuestion(candidateId,questionId);});
handle('open-question-tab',async(candidateId,questionId)=>{const q=store.questions(candidateId).find(q=>q.id===questionId);if(!q?.jobId)throw Error('Soruya bağlı ilan bulunamadı');try{return await focusTab(candidateId,store.job(candidateId,q.jobId).resumeContext);}catch(error){if(error.code!=='TAB_MISSING')throw error;return {focused:false,reason:'tab_missing',message:'Kayıtlı sekme artık açık değil.'};}});
const telegram=new Telegram({store,data,answer:answerCandidate,queueApplication,withdrawApplication:(candidateId,jobId)=>setManualJobStatus(candidateId,jobId,'withdrawn'),changed:candidateId=>emit('changed',{candidateId}),
 encrypt:encryptSecret,decrypt:decryptSecret});

handle('telegram-status',candidateId=>telegram.status(candidateId));
handle('telegram-configure',(candidateId,input)=>telegram.configure(candidateId,input));
handle('telegram-pair',candidateId=>telegram.pairing(candidateId));
handle('telegram-unlink',candidateId=>telegram.unlink(candidateId));
handle('telegram-preferences',(candidateId,input)=>telegram.preferences(candidateId,input));
handle('telegram-retry',candidateId=>telegram.retry(candidateId));
handle('telegram-send-unsent-jobs',candidateId=>telegram.sendUnsentJobs(candidateId));
scheduler.register('job-browser-maintenance',async()=>{if(isQuitting())return;await Promise.all(store.candidates().map(p=>browser.maintain(p.id).catch(error=>emit('agent-event',{event:'error',error:`Sekme temizliği yeniden denenecek: ${error.message}`}))));},{interval:30000});
scheduler.register('job-search',()=>campaigns.tick());scheduler.register('job-setup',()=>setups.tick());scheduler.register('background-skills',()=>background.tick(),{interval:5000});
await telegram.load();
return {driver:{
 configuration:()=>promptCatalog(runtimeResourceRoot({root})),
 agentRoles:()=>[...JOB_AGENT_ROLES,'background'],
 agentProfileSettings:(id,role)=>role==='background'?backgroundDb.task(id).agentSettings:store.profile(id).agentSettings,
 instructions:async (id,role)=>{
  if(role==='background'){const task=backgroundDb.task(id);return [...fileInstructionParts('AGENTS.md',BACKGROUND_AGENTS_MD),...fileInstructionParts('TASK.md',await readFile(task.skillPath||path.join(runtimeResourceRoot({root}),'skills/gmail-sync/SKILL.md'),'utf8'))];}
  const profile=store.profile(id),catalog=await promptCatalog(runtimeResourceRoot({root}));
  return [...fileInstructionParts('AGENTS.md',AGENTS_MD),instructionPart('startup-routing','Görev yönlendirme','system',STARTUP_INSTRUCTIONS,{when:'Her başlangıç mesajına eklenir.'}),instructionPart('browser-profile','Tarayıcı talimatı','system',browserProfileInstruction(profile),{when:'Seçilen tarayıcıya göre başlangıç mesajına eklenir.'}),
   ...catalog.skills.filter(skill=>!role||skill.id===(JOB_AGENTS.find(a=>a.role===role)?.skill)||(role==='background'&&skill.id==='gmail-sync')||['candidate-profile','write-cover-letter'].includes(skill.id)).flatMap(skill=>fileInstructionParts('.agents/'+skill.path,skill.text)),
   ...contextInstructionParts('get_task_context',{profile:Object.fromEntries(['preferences','facts','authorization','applicationPolicy'].map(key=>[key,profile[key]])),template:store.workspaces.definition(id)}).map(part=>({...part,when:'Görev bağlamı istendiğinde; dönen alanlar görev kapsamına göre değişebilir.'}))];
 },
  directory:id=>store.candidateDirectory(id),documentPurposes:['attachment','cv'],documentAdded:(id,document)=>{if(document.purpose==='cv')store.setCv(id,document.path);},
  rename:(id,name)=>store.renameWorkspace(id,name),remove:deleteJobWorkspace,
  workers:{add:(id,input)=>campaigns.add(id,input),start:(id,worker,state)=>campaigns.startWorker(id,worker,state),stop:(id,worker)=>campaigns.stopWorker(id,worker),remove:(id,worker)=>campaigns.remove(id,worker),restartState:(id,worker)=>campaigns.restartState(id,worker)},
  beforeInput:(id,text,worker)=>{campaigns.input(id,worker);if(typeof text==='string'&&text.trim())store.logPrompt(id,{kind:'input',text,sessionId:sessions.get(workerKey(id,worker))?.sessionId});},
  message:async(id,text,worker)=>{await campaigns.forWorker(worker).pause(id);return startAgent(id,text,null,worker);},
  snapshot:jobSnapshot,start:(id,options)=>{if(restartingAgents.has(id))throw Error('Agent yeniden başlatılıyor.');return campaigns.start(id,options);},stop:async id=>{await campaigns.pause(id,'stopped');for(const w of store.workers(id))await stopAgent(id,w.id);},restart:restartWorkspaceAgent,
  settings:async(id,input)=>{const p=store.profile(id);const result=await saveProfileWithBrowserChange({store,campaigns,stop:stopAgent,resetBrowser:id=>browser.resetCandidate(id)},{...p,...input,id});emit('changed',{candidateId:id});return result;},
 create:(templateId,input)=>input.intake?store.createSetup(input.agentSettings,templateId):store.saveProfile({...input,templateId}),
 browserDirectory:()=>data,browserOptions(id,workerId=MAIN_WORKER){ const jobs=store.jobs(id),sources=store.sources(id),task=store.forWorker(workerId).campaign(id)?.task;
 const researchTasks=store.workerState.tasks(id).map(w=>w.task).filter(task=>['search','rank'].includes(task.kind)),completed=task=>['done','no_results'].includes(task.report?.outcome),unfinishedResearch=researchTasks.filter(task=>!completed(task));
 return {config:()=>jevSettings.config(),accountVault:{status:()=>accountVault.status(id),secret:()=>accountVault.secret(id),clearRequest:()=>accountVault.clearRequest(id),request:request=>{accountVault.request(id,request);emit('changed',{candidateId:id});}},profile:store.profile(id).chromeProfile,checkpoints:[...jobs,...sources].map(item=>item.resumeContext).filter(Boolean),lifecycle:{jobs,multiWorker:store.workers(id).length>1,activeSourceTabId:task?.kind==='search'?sources.find(s=>s.id===task.sourceId)?.resumeContext?.tabId:null,activeSearchTaskIds:unfinishedResearch.map(task=>task.id),completedSearchTaskIds:researchTasks.filter(completed).map(task=>task.id),activeSourceTabIds:unfinishedResearch.filter(task=>task.kind==='search').map(task=>sources.find(source=>source.id===task.sourceId)?.resumeContext?.tabId).filter(Boolean),taskKind:task?.kind,repeatUncertain:task?.repeatUncertain&&task?.manualRequestId===jobs.find(job=>job.id===task.jobId)?.manualApplication?.requestId,activeSearchTaskId:['search','rank'].includes(task?.kind)?task.id:null,sourceTabIds:sources.filter(s=>s.resumeContext?.browser==='Jev Chrome').map(s=>s.resumeContext.tabId),activeJobId:['application','preparation','verify'].includes(task?.kind)?task.jobId:null}};},
 onBrowserStatus:(id,state)=>{if(!state.ready)campaigns.waitForBrowser(id);else campaigns.recheckBrowserQuestions(id);},
 onTabsClosed:(id,ids)=>store.clearSourceTabs(id,ids),
 onBrowserProgress:(...args)=>store.saveBrowserProgress(...args),beforeSubmit:(...args)=>store.assertSubmissionAllowed(...args),
 protocol(grant){const {workspaceId:id,workerId,sessionId}=grant,key=workerKey(id,workerId),taskId=store.forWorker(workerId).campaign(id)?.task?.id;
  const controller=campaigns.forWorker(workerId),scoped=store.forWorker(workerId),scopedBrowser=browser.forWorker(workerId,()=>sessions.get(key)?.sessionId===sessionId&&scoped.campaign(id)?.task?.id===taskId);
  return applicationProtocol({store:scoped,browser:scopedBrowser,campaigns:{get:id=>scoped.campaign(id),...Object.fromEntries(['waitForBrowser','askApplicationQuestion','report','askCaptcha','stopApplicationFollowup','recordSubmission','recordCandidateReply','recordValidationFailure'].map(name=>[name,controller[name].bind(controller)]))},onChange:id=>emit('changed',{candidateId:id})},grant);
 }},
 assertIdle(){if(background.active.size||connectorChecks.size||campaigns.busy||setups.busy||deletingWorkspaces.size||store.candidates().some(p=>store.setup(p.id)?.status==='running'||store.workers(p.id).some(w=>store.forWorker(w.id).campaign(p.id)?.status==='running')))throw Error('Önce çalışan agent ve arka plan görevlerini durdur.');},
 async stop(){campaigns.closed=true;setups.closed=true;background.closed=true;await telegram.stop();},
 async resume(){campaigns.closed=false;setups.closed=false;background.closed=false;await telegram.load();},
 async close(){campaigns.closed=true;setups.closed=true;await telegram.stop();await background.close();},
 clearOutputs(){backgroundOutput.clear();},activeRunIds:()=>[...background.active.values()].map(slot=>slot.run.id)
};
}
