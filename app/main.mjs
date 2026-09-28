import {Maintenance} from './maintenance.mjs';
import {registerSettingsServices} from './settings-services.mjs';
import {JevSettings} from './jev-settings.mjs';
import {applyPendingRestore,prepareDataUpgrade,completeDataUpgrade} from './data-management.mjs';
import {engineBinaryPath,runtimeResourceRoot} from './runtime-paths.mjs';
import {AccountVault} from './account-vault.mjs';
import {editPreparation} from './preparation.mjs';
import {exportPreparation} from './preparation-export.mjs';
import {writeWorkspaceInstructions,STARTUP_INSTRUCTIONS} from './workspace-instructions.mjs';
import {ContextCompaction,compactionPending} from './context-compaction.mjs';
import {saveProfileWithBrowserChange} from './browser-engine-change.mjs';
import {browserResume} from './browser-resume.mjs';
import {sourceInstructions,runSourceTool,sourceIntegrations} from './source-integrations.mjs';
import {focusApplicationTab} from './focus-tab.mjs';
import {inspectGmailAccess} from './connector-access.mjs';
import {app,BrowserWindow,ipcMain,dialog,shell,safeStorage} from 'electron';
import {mkdir,cp,readFile,copyFile,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {BackgroundStore} from './background-store.mjs';
import {BackgroundJobs} from './background.mjs';
import {launchSkillWorker} from './background-worker.mjs';
import {Store} from './store.mjs';
import {startMcp} from './mcp.mjs';
import {startWithResumeRepair,rejectedResumeOnExit,selectResume} from './resume.mjs';
import {restartAgentFresh,rotateAgentContext} from './agent-restart.mjs';
import {ContextUsage} from './context-usage.mjs';
import {AGENTS_MD,promptCatalog,browserProfileInstruction} from './prompts.mjs';
import {listChromeProfiles} from './chrome-profiles.mjs';
import {Engine} from './engine.mjs';
import {Setups} from './setup.mjs';
import {WorkerCampaigns} from './worker-campaigns.mjs';
import {MAIN_WORKER,workerKey} from './worker-state.mjs';
import {listDocuments,documentPath,readDocument} from './artifacts.mjs';
import {BrowserTools} from './browser.mjs';
import {Telegram} from './telegram-accounts.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function boot(){
app.setName('JobLoop');
if(process.env.JOBLOOP_DATA_DIR)app.setPath('userData',process.env.JOBLOOP_DATA_DIR);
if(!app.requestSingleInstanceLock()){app.quit();return;}
await app.whenReady();
const data=app.getPath('userData');await mkdir(data,{recursive:true,mode:0o700});
// Retire saved pairing credentials from the removed local-network web client.
await rm(path.join(data,'mobile.json'),{force:true});
await applyPendingRestore({dataDirectory:data});
await prepareDataUpgrade({dataDirectory:data,appVersion:app.getVersion()});
const store=new Store(path.join(data,'jobloop.sqlite'));
const encryptSecret=value=>{if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('Güvenli saklama için sistem anahtarlığını aç.');return safeStorage.encryptString(value).toString('base64');};
const decryptSecret=value=>safeStorage.decryptString(Buffer.from(value,'base64'));
const jevSettings=new JevSettings(store.db,{encrypt:encryptSecret,decrypt:decryptSecret});
const accountVault=new AccountVault(store.db,{encrypt:encryptSecret,decrypt:decryptSecret});
for(const candidate of store.candidates())for(const sessionId of new Set(store.jobs(candidate.id).map(j=>j.sessionId).filter(Boolean)))store.recoverSession(candidate.id,sessionId);
const browser=new BrowserTools(data,id=>store.profile(id).browserMode,(id,workerId=MAIN_WORKER)=>{
 const jobs=store.jobs(id),sources=store.sources(id),task=store.forWorker(workerId).campaign(id)?.task;
 return {config:()=>jevSettings.config(),accountVault:{status:()=>accountVault.status(id),secret:()=>accountVault.secret(id),clearRequest:()=>accountVault.clearRequest(id),request:request=>{accountVault.request(id,request);emit('changed',{candidateId:id});}},profile:store.profile(id).chromeProfile,checkpoints:[...jobs,...sources].map(item=>item.resumeContext).filter(Boolean),lifecycle:{jobs,multiWorker:store.workers(id).length>1,activeSourceTabId:task?.kind==='search'?sources.find(s=>s.id===task.sourceId)?.resumeContext?.tabId:null,activeSearchTaskIds:store.workerState.tasks(id).filter(w=>['search','rank'].includes(w.task.kind)).map(w=>w.task.id),taskKind:task?.kind,repeatUncertain:task?.repeatUncertain&&task?.manualRequestId===jobs.find(job=>job.id===task.jobId)?.manualApplication?.requestId,activeSearchTaskId:['search','rank'].includes(task?.kind)?task.id:null,sourceTabIds:sources.filter(s=>s.resumeContext?.browser==='Jev Chrome').map(s=>s.resumeContext.tabId),activeJobId:['application','preparation','verify'].includes(task?.kind)?task.jobId:null}};
});
let window,quitting=false;
const engines=new Map(),sessions=new Map(),starting=new Set(),terminalOutputs=new Map(),terminalSequences=new Map();
const terminalGrids=new Map();const gridFor=(id,workerId=MAIN_WORKER)=>terminalGrids.get(workerKey(id,workerId))??{rows:24,cols:80};
const emit=(channel,value)=>{if(window&&!window.isDestroyed())window.webContents.send(channel,value);};
const mcp=await startMcp(store,candidateId=>emit('changed',{candidateId}),hook=>{const active=[...sessions.values()].find(a=>a.sessionId===hook.observation?.sessionId);if(!active)throw Error('No agent');return engines.get(workerKey(active.candidateId,active.workerId)).request('hook',{token:hook.token,observation:hook.observation});},browser,null,null,({candidateId,sessionId,workerId=MAIN_WORKER})=>{
 const key=workerKey(candidateId,workerId),taskId=store.forWorker(workerId).campaign(candidateId)?.task?.id;if(sessions.get(key)?.sessionId!==sessionId)throw Error('Worker oturumu kapandı.');
 const scoped=store.forWorker(workerId),controller=campaigns.forWorker(workerId),scopedBrowser=browser.forWorker(workerId,()=>sessions.get(key)?.sessionId===sessionId&&store.forWorker(workerId).campaign(candidateId)?.task?.id===taskId);
 return {store:scoped,browser:scopedBrowser,campaigns:{get:id=>scoped.campaign(id),...Object.fromEntries(['waitForBrowser','askApplicationQuestion','report','askCaptcha','stopApplicationFollowup','recordSubmission','recordCandidateReply','recordValidationFailure'].map(name=>[name,controller[name].bind(controller)]))}};
});
const retire=(id,workerId=MAIN_WORKER)=>{const key=workerKey(id,workerId),active=sessions.get(key);if(active){store.recoverSession(id,active.sessionId);mcp.revoke(active.token);sessions.delete(key);emit('changed',{candidateId:id});}};
function ensureEngine(id='catalog',workerId=MAIN_WORKER){const key=workerKey(id,workerId),scoped=store.forWorker(workerId);if(!engines.has(key)){const instance=new Engine(engineBinaryPath({root}),path.join(data,'processes',key),event=>{
  if(engines.get(key)!==instance)return;
  const active=sessions.get(key);
  if(event.sessionId&&event.sessionId!==active?.sessionId)return;
  if(event.event==='identity'&&active){scoped.saveConversation(id,active.provider,event.nativeId,active.launchSettings);if(active.contextReader?.nativeId!==event.nativeId){active.contextReader=new ContextUsage({provider:active.provider,nativeId:event.nativeId,cwd:agentDirectory(id,workerId),statusFile:path.join(agentDirectory(id,workerId),'runtime',`context-${active.sessionId}.jsonl`)});active.compaction=null;active.contextUsage=null;}return;}
  if(event.event==='output'){if(active?.resumeId)active.resumeDiagnostic=((active.resumeDiagnostic??'')+Buffer.from(event.bytes).toString()).slice(-8000);event.sequence=(terminalSequences.get(key)??0)+1;terminalSequences.set(key,event.sequence);terminalOutputs.set(key,Buffer.concat([terminalOutputs.get(key)??Buffer.alloc(0),Buffer.from(event.bytes)]).subarray(-1000000));}
  if(event.event==='compaction'&&active)compaction.delivery(active,event);
  if(event.event==='delivery'&&active)campaigns.forWorker(workerId).delivery(id,event.state.replace(/^Some\((.*)\)$/,'$1'));
  if(event.event==='state'&&active){active.state=event.state.replace(/^Some\((.*)\)$/,'$1');if(!compaction.signal(active,active.state))campaigns.forWorker(workerId).signal(id,active.state);emit('changed',{candidateId:id});}
  if(['engine_exit','eof'].includes(event.event)){if(rejectedResumeOnExit(active)){scoped.forgetConversation(id,active.provider,active.resumeId);store.event(id,'resume_fallback',{fresh:true,replacedResumeId:active.resumeId,reason:'Resume rejected; next launch starts fresh with saved task context'});}engines.delete(key);retire(id,workerId);if(event.event==='eof')instance.close().catch(()=>{});if(active){campaigns.forWorker(workerId).exited(id);if(workerId===MAIN_WORKER)setups.exited(id);}}
  emit('agent-event',{...event,candidateId:id,workerId});
});engines.set(key,instance);}return engines.get(key);}
function handle(name,fn){ipcMain.handle(name,async(event,...args)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('Untrusted sender');return maintenance.invoke(name,()=>fn(...args));});}
const backgroundDb=new BackgroundStore(store);
await rm(path.join(data,'google-oauth.json'),{force:true});
const backgroundOutput=new Map();
const background=new BackgroundJobs(backgroundDb,{changed:candidateId=>emit('background-changed',{candidateId}),launch:(run,task,onEvent,signal)=>launchSkillWorker({root,data,db:backgroundDb,run,task,onEvent,signal,complete:(...args)=>background.complete(...args),onOutput:bytes=>{
 const output=Buffer.concat([backgroundOutput.get(run.id)??Buffer.alloc(0),Buffer.from(bytes)]).subarray(-150000);backgroundOutput.set(run.id,output);while(backgroundOutput.size>30)backgroundOutput.delete(backgroundOutput.keys().next().value);emit('background-output',{candidateId:run.candidateId,runId:run.id,bytes});
}})});
handle('background-snapshot',async id=>({task:backgroundDb.task(id),runs:backgroundDb.runs(id),signals:backgroundDb.signals(id),applications:store.jobs(id).map(({id,company,role,status,updatedAt})=>({id,company,role,status,updatedAt}))}));
handle('background-save',async(id,input)=>{if(input.agentOverride!=null){const settings=input.agentOverride;if(!['codex','claude'].includes(settings.provider)||![true,false,null].includes(settings.network))throw Error('Geçersiz agent ayarları');await ensureEngine().request('validate',settings);input={...input,agentOverride:{provider:settings.provider,model:settings.model,permission:settings.permission,reasoning:settings.reasoning,network:settings.provider==='codex'?settings.network:null}};}if(input.skillPath){if(!path.isAbsolute(input.skillPath)||path.extname(input.skillPath).toLowerCase()!=='.md')throw Error('Bir Markdown skill dosyası seç');if(!(await readFile(input.skillPath,'utf8')).trim())throw Error('Skill dosyası boş');}const result=backgroundDb.save(id,input);emit('background-changed',{candidateId:id});return result;});
handle('background-pick-skill',async()=>{const result=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'Skill',extensions:['md']}]});return result.canceled?null:result.filePaths[0];});
handle('background-read-skill',async id=>readFile(backgroundDb.task(id).skillPath||path.join(root,'skills/gmail-sync/SKILL.md'),'utf8'));
const connectorChecks=new Map();
handle('background-check-gmail',async id=>{
 if(connectorChecks.has(id))return connectorChecks.get(id);
 const task=backgroundDb.task(id),workspace=path.join(data,'background','workspaces',id);
 const check=(async()=>{await mkdir(workspace,{recursive:true,mode:0o700});let access;try{access=await inspectGmailAccess(task.agentSettings.provider,workspace);}catch(error){access={status:'error',message:error.message,installUrl:null};}access.checkedAt=Date.now();access.provider=task.agentSettings.provider;if(quitting)return access;const current=backgroundDb.task(id);if(current.agentSettings.provider!==access.provider)return access;backgroundDb.putTask(id,{...current,connectorAccess:access});emit('background-changed',{candidateId:id});return access;})();connectorChecks.set(id,check);try{return await check;}finally{connectorChecks.delete(id);}
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
const backgroundTimer=setInterval(()=>{if(maintenance.busy)return;background.tick().catch(error=>emit('agent-event',{event:'error',error:error.message}));},5000);
handle('catalog',()=>ensureEngine().request('catalog'));
handle('candidates',()=>store.candidates());
handle('chrome-profiles',()=>listChromeProfiles());
const sourceTabs=async id=>Object.assign({},...await Promise.all(store.workers(id).map(w=>browser.forWorker(w.id).sourceTabs(id,store.sources(id),store.forWorker(w.id).campaign(id)?.task))));
handle('source-tabs',sourceTabs);
const publicSession=active=>active?{candidateId:active.candidateId,workerId:active.workerId??MAIN_WORKER,sessionId:active.sessionId,state:active.state??'Unknown',contextUsage:active.contextUsage??null,compaction:active.compaction??null}:null;
const workerSnapshot=id=>store.workers(id).map(w=>({...w,campaign:store.forWorker(w.id).campaign(id),active:publicSession(sessions.get(workerKey(id,w.id)))}));
handle('snapshot',async id=>{const workers=workerSnapshot(id),campaign=campaigns.summary(id),owner=workers.find(w=>w.campaign?.task?.id===campaign?.task?.id&&w.active)??workers.find(w=>w.active);return {...store.snapshot(id),campaign,workers,accountCredentials:accountVault.status(id),sourceTabs:await sourceTabs(id),documents:await listDocuments(path.join(data,'candidates',id)),browserStatus:browser.status(id),active:owner?.active??null};});
handle('browser-reconnect',id=>{store.profile(id);return browser.prepare(id,{force:true});});
handle('documents',id=>{store.profile(id);return listDocuments(path.join(data,'candidates',id));});
handle('read-document',(id,file)=>{store.profile(id);return readDocument(path.join(data,'candidates',id),file);});
handle('open-document',async(id,file)=>{store.profile(id);const error=await shell.openPath(await documentPath(path.join(data,'candidates',id),file));if(error)throw Error(error);});
handle('account-credentials-save',(id,input)=>{store.profile(id);const result=accountVault.save(id,input);emit('changed',{candidateId:id});return result;});
handle('account-credentials-remove',id=>{store.profile(id);accountVault.remove(id);emit('changed',{candidateId:id});return {configured:false};});
handle('save-profile',async p=>{if(p.agentSettings){await ensureEngine().request('validate',p.agentSettings);if(p.agentSettings.provider==='gemini')throw Error('Gemini MCP entegrasyonu henüz desteklenmiyor');if(![true,false,null].includes(p.agentSettings.network))throw Error('Geçersiz ağ tercihi');}const profile=await saveProfileWithBrowserChange({store,campaigns,stop:stopAgent,resetBrowser:id=>browser.resetCandidate(id)},p);emit('changed',{});return profile;});
handle('rename-workspace',(id,name)=>{const profile=store.renameWorkspace(id,name);emit('changed',{});return profile;});
const deletingWorkspaces=new Set();
handle('delete-workspace',async id=>{
  store.profile(id);
  if(deletingWorkspaces.has(id)||starting.has(id)||restartingAgents.has(id)||campaigns.launching.has(id))throw Error('Agent başlatılıyor; işlem bitince yeniden dene.');
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
    for(const w of store.workers(id)){const key=workerKey(id,w.id);await stopAgent(id,w.id);terminalOutputs.delete(key);terminalSequences.delete(key);terminalGrids.delete(key);await rm(path.join(data,'processes',key),{recursive:true,force:true});}
    store.deleteWorkspace(id);
    for(const runId of runIds){backgroundOutput.delete(runId);await rm(path.join(data,'background',runId),{recursive:true,force:true});}
    for(const directory of ['candidates','browsers','processes'])await rm(path.join(data,directory,id),{recursive:true,force:true});
    await rm(path.join(data,'background','workspaces',id),{recursive:true,force:true});
    emit('changed',{});return {deleted:true};
  }finally{deletingWorkspaces.delete(id);}
});
handle('source-integrations',()=>sourceIntegrations);
handle('source-instructions',(id,sourceId)=>sourceInstructions(root,store.source(id,sourceId)));
handle('source-test',async(id,sourceId)=>{const result=await runSourceTool(root,store.source(id,sourceId),['search','--help'],{test:true});store.event(id,'source_tool_tested',{sourceId,ok:result.ok});return result;});
handle('save-source',(candidateId,source)=>{if(restartingAgents.has(candidateId))throw Error('Agent yeniden başlatılıyor.');return campaigns.saveSource(candidateId,source);});
handle('save-sources-apply-mode',async(candidateId,applyMode)=>{if(restartingAgents.has(candidateId))throw Error('Agent yeniden başlatılıyor.');const result=store.saveSourcesApplyMode(candidateId,applyMode);emit('changed',{candidateId});await campaigns.tick();return result;});
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
handle('pick-cv',async id=>{store.profile(id);const result=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'CV',extensions:['pdf','docx','txt']}]});if(result.canceled)return null;const dir=path.join(data,'candidates',id);await mkdir(dir,{recursive:true,mode:0o700});const target=path.join(dir,'CV'+path.extname(result.filePaths[0]).toLowerCase());await copyFile(result.filePaths[0],target);await chmod(target,0o600);store.setCv(id,target);emit('changed',{});return target;});
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
  const profile=store.profile(candidateId),resumeId=selectResume(scoped,candidateId,store.profile(candidateId).agentSettings);if(!profile.cvPath&&store.setup(candidateId)?.status!=='running')throw Error('Önce CV seç');starting.add(key);
  const activeJobId=jobId??scoped.campaign(candidateId)?.task?.jobId;
  const resumeBrowser=browserResume(profile,activeJobId?store.job(candidateId,activeJobId):null);
  prompt=[STARTUP_INSTRUCTIONS,browserProfileInstruction(profile),'This is one JobLoop worker. Other workers may use the same candidate and Chrome account concurrently. Work only on your assigned task. Keep your own browser tab handles, never operate on or close another task’s tabs, and never reuse an unrelated application form. For preparation packages use get_task_context.documentRoot/documents/<job-id>; otherwise save generated documents under this worker workspace with job-specific filenames.',resumeBrowser?.instruction,prompt].filter(Boolean).join('\n\n');
  const sessionId=randomUUID(),token=mcp.grant(candidateId,sessionId,workerId);store.logPrompt(candidateId,{kind:'start',text:prompt,jobId:jobId??null,sessionId});
  try{
    const cwd=agentDirectory(candidateId,workerId);await mkdir(cwd,{recursive:true,mode:0o700});await cp(path.join(runtimeResourceRoot({root}),'skills'),path.join(cwd,'.agents/skills'),{recursive:true});
    await writeWorkspaceInstructions(cwd,AGENTS_MD);
    await mkdir(path.join(cwd,'runtime'),{recursive:true});await mkdir(path.join(cwd,'documents'),{recursive:true});
    requireBrowserReady(candidateId);
    sessions.set(key,{candidateId,workerId,sessionId,token,provider:profile.agentSettings.provider,resumeId,launchSettings:{...profile.agentSettings}});terminalOutputs.delete(key);
    const engine=ensureEngine(candidateId,workerId);
    if(jobId){const job=store.job(candidateId,jobId);if(['blocked','uncertain'].includes(job.status)&&job.sessionId!==sessionId)store.reclaim(candidateId,jobId,sessionId);}
    await startWithResumeRepair(engine,{sessionId,cwd,runtimeDirectory:path.join(cwd,'runtime'),endpoint:mcp.endpoint,token,...profile.agentSettings,resumeId,prompt,...gridFor(candidateId,workerId)},result=>{if(result.fresh){scoped.forgetConversation(candidateId,profile.agentSettings.provider,result.replacedResumeId);const active=sessions.get(key);if(active){active.resumeId=null;active.resumeDiagnostic='';}}store.event(candidateId,'history_repaired',result);emit('changed',{candidateId});});
    await engine.request('resize',gridFor(candidateId,workerId));
    emit('changed',{});return{sessionId};
  }catch(error){mcp.revoke(token);sessions.delete(key);const failed=engines.get(key);engines.delete(key);await failed?.close().catch(()=>{});throw error;}finally{starting.delete(key);}
}
async function stopAgent(id,workerId=MAIN_WORKER){const key=workerKey(id,workerId),engine=engines.get(key);engines.delete(key);retire(id,workerId);try{await engine?.close();await browser.forWorker(workerId).waitForOperations(id);}catch(error){if(engine&&!engines.has(key))engines.set(key,engine);throw error;}}
const sendPrompt=(text,id,workerId=MAIN_WORKER)=>{const key=workerKey(id,workerId);store.logPrompt(id,{kind:'message',text,sessionId:sessions.get(key)?.sessionId??null});return engines.get(key).request('message',{text});};
const compaction=new ContextCompaction({
 settled:session=>campaigns.forWorker(session.workerId??MAIN_WORKER).afterCompaction(session.candidateId),
 send:session=>{if(sessions.get(workerKey(session.candidateId,session.workerId))!==session)throw Error('Agent oturumu değişti.');return engines.get(workerKey(session.candidateId,session.workerId)).request('compact',{sessionId:session.sessionId,nativeId:session.contextReader?.nativeId});},
 changed:id=>emit('changed',{candidateId:id}),event:(id,kind,value)=>store.event(id,kind,value)
});
const readContext=(id,session)=>{
 if(session.contextRead)return session.contextRead;
 session.contextRead=(async()=>{
  const settings=store.profile(id).agentSettings;
  if(!(settings.contextRestartPercent>0||settings.contextCompactPercent>0))return null;
  const previous=session.contextUsage;
  const reader=session.contextReader;
  const usage=await reader?.read()??null;
  if(sessions.get(workerKey(id,session.workerId))!==session||session.contextReader!==reader)return null;
  session.contextUsage=usage;
  if(previous?.percent!==usage?.percent||previous?.peakPercent!==usage?.peakPercent)emit('changed',{candidateId:id});
  await compaction.tick(session,usage,store.profile(id).agentSettings.contextCompactPercent);
  return usage;
 })().finally(()=>{session.contextRead=null;});
 return session.contextRead;
};
const campaigns=new WorkerCampaigns(store,{browserReady:id=>browser.prepare(id),launch:startAgent,send:sendPrompt,stop:stopAgent,active:(id,workerId)=>sessions.get(workerKey(id,workerId)),changed:id=>emit('changed',{candidateId:id}),readContext,contextBusy:(id,workerId)=>compactionPending(sessions.get(workerKey(id,workerId))),rotateContext:(id,session,usage,threshold,workerId)=>rotateAgentContext({store:store.forWorker(workerId),stop:id=>stopAgent(id,workerId)},id,session,usage,threshold)});
browser.onStatus=(id,state)=>{if(!state.ready)campaigns.waitForBrowser(id);else campaigns.recheckBrowserQuestions(id);emit('changed',{candidateId:id});};
browser.onProgress=(id,jobId,progress,owner)=>store.saveBrowserProgress(id,jobId,progress,owner);
browser.beforeSubmit=(id,jobId,url,owner,options)=>store.assertSubmissionAllowed(id,jobId,url,owner,options);
for(const candidate of store.candidates()){campaigns.recheckLegacyFormQuestions(candidate.id);campaigns.recheckPendingVerifications(candidate.id);}
for(const p of store.candidates())for(const w of store.workers(p.id)){const scoped=store.forWorker(w.id),c=scoped.campaign(p.id);if(c?.status==='running')scoped.saveCampaign(p.id,{...c,task:c.task?{...c.task,report:null,seenWorking:false,recovery:{readyAt:Date.now()+2000,reason:'App restarted; resume the unfinished task after checking saved outcomes'}}:null,wakeAt:Date.now()+2000});}
const setups=new Setups(store,{browserReady:id=>browser.prepare(id),launch:startAgent,send:sendPrompt,active:id=>sessions.get(id),changed:id=>emit('changed',{candidateId:id})});
for(const p of store.candidates()){const s=store.setup(p.id);if(s?.status==='running')store.saveSetup(p.id,{...s,needsTurn:true});}
const campaignTimer=setInterval(()=>{if(maintenance.busy)return;for(const session of sessions.values())readContext(session.candidateId,session).catch(error=>emit('agent-event',{event:'error',error:error.message}));for(const p of store.candidates()){const state=browser.status(p.id);if(state.state==='waiting')browser.prepare(p.id);}campaigns.tick().catch(error=>emit('agent-event',{event:'error',error:error.message}));setups.tick().catch(error=>emit('agent-event',{event:'error',error:error.message}));},1000);
handle('create-setup',async settings=>{await ensureEngine().request('validate',settings);if(!['codex','claude'].includes(settings.provider))throw Error('Desteklenmeyen sağlayıcı');const p=store.createSetup(settings);emit('changed',{});return p;});
handle('begin-setup',async(id,source)=>{const s=store.setup(id);if(!s||s.status==='complete')throw Error('Setup bulunamadı');if(source){const url=new URL(source);if(url.protocol!=='https:'||!['linkedin.com','www.linkedin.com'].includes(url.hostname)||!url.pathname.startsWith('/in/'))throw Error('Geçerli bir LinkedIn profil bağlantısı gir');store.saveSetup(id,{...s,source:url.toString()});}await setups.begin(id);});
handle('complete-setup',async(id,fields)=>{if(sessions.has(id))await stopAgent(id);const p=store.completeSetup(id,fields);emit('changed',{});return p;});
handle('import-setup-cv',async(id,file)=>{if(store.setup(id)?.status!=='intake')throw Error('CV yüklemek için setup başlangıcında olmalısın');if(typeof file!=='string'||!path.isAbsolute(file)||!['.pdf','.docx','.txt'].includes(path.extname(file).toLowerCase()))throw Error('PDF, Word veya TXT CV seç');const dir=path.join(data,'candidates',id);await mkdir(dir,{recursive:true,mode:0o700});const target=path.join(dir,'CV'+path.extname(file).toLowerCase());await copyFile(file,target);await chmod(target,0o600);store.setCv(id,target);emit('changed',{});return target;});
const restartingAgents=new Set();
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
handle('start',(id,options)=>{if(restartingAgents.has(id))throw Error('Agent yeniden başlatılıyor.');return campaigns.start(id,options);});
handle('restart-agent',async(id,options)=>{
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
});
handle('pause',id=>campaigns.pause(id));
handle('stop',async id=>{store.profile(id);await campaigns.pause(id,'stopped');for(const w of store.workers(id))await stopAgent(id,w.id);});
const validateWorker=(id,workerId)=>{store.workerState.get(id,workerId);if(deletingWorkspaces.has(id)||restartingAgents.has(id))throw Error('Çalışma alanı güncelleniyor.');};
handle('worker-add',async(id,input)=>{validateWorker(id,MAIN_WORKER);if(store.setup(id)&&store.setup(id).status!=='complete')throw Error('Önce aday kurulumu tamamlanmalı.');return campaigns.add(id,input);});
handle('worker-start',async(id,workerId)=>{validateWorker(id,workerId);await campaigns.startWorker(id,workerId);emit('changed',{candidateId:id});});
handle('worker-stop',async(id,workerId)=>{validateWorker(id,workerId);await campaigns.stopWorker(id,workerId);});
handle('worker-restart',async(id,workerId)=>{validateWorker(id,workerId);const controller=campaigns.forWorker(workerId);if(controller.launching.has(id))throw Error('Worker başlatılıyor.');restartingAgents.add(id);try{return await restartAgentFresh({store:store.forWorker(workerId),campaigns:controller,stop:id=>stopAgent(id,workerId)},id,{target:store.campaign(id)?.target??100});}finally{restartingAgents.delete(id);emit('changed',{candidateId:id});}});
handle('worker-remove',async(id,workerId)=>{validateWorker(id,workerId);await campaigns.remove(id,workerId);const key=workerKey(id,workerId);terminalOutputs.delete(key);terminalSequences.delete(key);terminalGrids.delete(key);});
handle('terminal-output',(id,workerId=MAIN_WORKER)=>{store.workerState.get(id,workerId);const key=workerKey(id,workerId),active=sessions.get(key);return {bytes:[...(terminalOutputs.get(key)??Buffer.alloc(0))],sequence:terminalSequences.get(key)??0,sessionId:active?.sessionId??null};});
handle('terminal-input',async(id,text,workerId=MAIN_WORKER,sessionId)=>{store.workerState.get(id,workerId);const key=workerKey(id,workerId),active=sessions.get(key);if(!active||sessionId&&active.sessionId!==sessionId||typeof text!=='string'||text.length>64000)return;campaigns.input(id,workerId);if(text.trim())store.logPrompt(id,{kind:'input',text,sessionId:active.sessionId});await engines.get(key).request('input',{text});});
handle('prompt-catalog',()=>promptCatalog(root));
handle('prompts',id=>{store.profile(id);return store.prompts(id);});
handle('terminal-resize',async(id,rows,cols,workerId=MAIN_WORKER,sessionId)=>{store.workerState.get(id,workerId);if(!Number.isInteger(rows)||!Number.isInteger(cols)||rows<4||rows>1024||cols<20||cols>4096)return;const key=workerKey(id,workerId),grid={rows,cols},active=sessions.get(key);terminalGrids.set(key,grid);if(active&&(!sessionId||active.sessionId===sessionId)&&!starting.has(key))await engines.get(key).request('resize',grid);});
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
handle('open-link',async url=>{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))throw Error('Geçersiz bağlantı');await shell.openExternal(u.toString());});
const telegram=new Telegram({store,data,answer:answerCandidate,queueApplication,withdrawApplication:(candidateId,jobId)=>setManualJobStatus(candidateId,jobId,'withdrawn'),changed:candidateId=>emit('changed',{candidateId}),
 encrypt:encryptSecret,decrypt:decryptSecret});
const maintenance=new Maintenance({
 assertIdle(){if(sessions.size||starting.size||background.active.size||connectorChecks.size||browser.operations.size||campaigns.busy||setups.busy||restartingAgents.size||deletingWorkspaces.size||store.candidates().some(p=>store.setup(p.id)?.status==='running'||store.workers(p.id).some(w=>store.forWorker(w.id).campaign(p.id)?.status==='running')))throw Error('Önce çalışan agent, aday kurulumu ve arka plan görevlerini durdur.');},
 stop:async()=>{campaigns.closed=true;setups.closed=true;background.closed=true;await telegram.stop();},
 resume:async()=>{if(quitting)return;campaigns.closed=false;setups.closed=false;background.closed=false;await telegram.load();}
});
await telegram.load();
const settingsServices=await registerSettingsServices({app,root,data,store,jevSettings,handle,window:()=>window,maintenance,emit,clearTerminalOutputs:()=>{terminalOutputs.clear();backgroundOutput.clear();emit('logs-cleared',{});},activeRunIds:()=>[...background.active.values()].map(slot=>slot.run.id)});
handle('telegram-status',candidateId=>telegram.status(candidateId));
handle('telegram-configure',(candidateId,input)=>telegram.configure(candidateId,input));
handle('telegram-pair',candidateId=>telegram.pairing(candidateId));
handle('telegram-unlink',candidateId=>telegram.unlink(candidateId));
handle('telegram-preferences',(candidateId,input)=>telegram.preferences(candidateId,input));
handle('telegram-retry',candidateId=>telegram.retry(candidateId));
handle('telegram-send-unsent-jobs',candidateId=>telegram.sendUnsentJobs(candidateId));
window=new BrowserWindow({width:1440,height:950,minWidth:1040,minHeight:720,title:'JobLoop',backgroundColor:'#11151b',webPreferences:{preload:path.join(root,'app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
await window.loadFile(path.join(root,'dist/index.html'));
await completeDataUpgrade({dataDirectory:data,appVersion:app.getVersion()});
app.on('second-instance',()=>{window?.show();window?.focus();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;settingsServices.dispose();campaigns.closed=true;setups.closed=true;clearInterval(campaignTimer);clearInterval(backgroundTimer);(async()=>{await telegram.stop();await background.close();await Promise.allSettled([...engines.values()].map(engine=>engine.close()));for(const session of sessions.values())retire(session.candidateId,session.workerId);engines.clear();await browser.close();await mcp.close();store.close();app.quit();})();});

}
boot().catch(error=>{console.error(error);dialog.showErrorBox('JobLoop açılamadı',String(error.message??error)+'\n\nVeri klasörünü silme. Yedekleri koru ve hatayı güvenli destek kanalına bildir.');app.exit(1);});
