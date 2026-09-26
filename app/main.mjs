import {sourceInstructions,runSourceTool,sourceIntegrations} from './source-integrations.mjs';
import {focusApplicationTab} from './focus-tab.mjs';
import {inspectGmailAccess} from './connector-access.mjs';
import {app,BrowserWindow,ipcMain,dialog,shell} from 'electron';
import {mkdir,cp,writeFile,readFile,copyFile,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {BackgroundStore} from './background-store.mjs';
import {BackgroundJobs} from './background.mjs';
import {launchSkillWorker} from './background-worker.mjs';
import {Store} from './store.mjs';
import {startMcp} from './mcp.mjs';
import {startWithResumeRepair,rejectedResumeOnExit} from './resume.mjs';
import {AGENTS_MD,promptCatalog,browserProfileInstruction} from './prompts.mjs';
import {listChromeProfiles} from './chrome-profiles.mjs';
import {Engine} from './engine.mjs';
import {Setups} from './setup.mjs';
import {Campaigns} from './campaign.mjs';
import {listDocuments,documentPath,readDocument} from './artifacts.mjs';
import {BrowserTools} from './browser.mjs';
import {MobileAccess} from './mobile.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function boot(){
app.setName('JobLoop');
if(process.env.JOBLOOP_DATA_DIR)app.setPath('userData',process.env.JOBLOOP_DATA_DIR);
if(!app.requestSingleInstanceLock()){app.quit();return;}
await app.whenReady();
const data=app.getPath('userData');await mkdir(data,{recursive:true,mode:0o700});
const store=new Store(path.join(data,'jobloop.sqlite'));
for(const candidate of store.candidates())for(const sessionId of new Set(store.jobs(candidate.id).map(j=>j.sessionId).filter(Boolean)))store.recoverSession(candidate.id,sessionId);
const browser=new BrowserTools(data,id=>store.profile(id).browserMode,id=>({profile:store.profile(id).chromeProfile,checkpoints:[...store.jobs(id),...store.sources(id)].map(item=>item.resumeContext).filter(Boolean)}));
let window,quitting=false;
const engines=new Map(),sessions=new Map(),starting=new Set(),terminalOutputs=new Map(),terminalSequences=new Map();
let terminalGrid={rows:24,cols:80};
let mobile=null;
const emit=(channel,value)=>{if(window&&!window.isDestroyed())window.webContents.send(channel,value);mobile?.broadcast(channel,value);};
const mcp=await startMcp(store,candidateId=>emit('changed',{candidateId}),hook=>{const active=[...sessions.values()].find(a=>a.sessionId===hook.observation?.sessionId);if(!active)throw Error('No agent');return engines.get(active.candidateId).request('hook',{token:hook.token,observation:hook.observation});},browser,{get:id=>store.campaign(id),report:(id,sessionId,args)=>campaigns.report(id,sessionId,args)});
const retire=id=>{const active=sessions.get(id);if(active){store.recoverSession(id,active.sessionId);mcp.revoke(active.token);sessions.delete(id);emit('changed',{candidateId:id});}};
function ensureEngine(id='catalog'){if(!engines.has(id)){const instance=new Engine(path.join(root,'engine/target/debug',process.platform==='win32'?'jobloop-engine.exe':'jobloop-engine'),path.join(data,'processes',id),event=>{
  if(engines.get(id)!==instance)return;
  const active=sessions.get(id);
  if(event.sessionId&&event.sessionId!==active?.sessionId)return;
  if(event.event==='identity'&&active){store.saveConversation(id,active.provider,event.nativeId);return;}
  if(event.event==='output'){if(active?.resumeId&&!active.resumeReady)active.resumeDiagnostic=((active.resumeDiagnostic??'')+Buffer.from(event.bytes).toString()).slice(-8000);event.sequence=(terminalSequences.get(id)??0)+1;terminalSequences.set(id,event.sequence);terminalOutputs.set(id,Buffer.concat([terminalOutputs.get(id)??Buffer.alloc(0),Buffer.from(event.bytes)]).subarray(-1000000));}
  if(event.event==='delivery'&&active)campaigns.delivery(id,event.state.replace(/^Some\((.*)\)$/,'$1'));
  if(event.event==='state'&&active){active.state=event.state.replace(/^Some\((.*)\)$/,'$1');if(active.state==='Working'){active.resumeReady=true;active.resumeDiagnostic='';}campaigns.signal(id,active.state);emit('changed',{candidateId:id});}
  if(['engine_exit','eof'].includes(event.event)){if(rejectedResumeOnExit(active)){store.forgetConversation(id,active.provider,active.resumeId);store.event(id,'resume_fallback',{fresh:true,replacedResumeId:active.resumeId,reason:'Resume rejected; next launch starts fresh with saved task context'});}engines.delete(id);retire(id);if(event.event==='eof')instance.close().catch(()=>{});if(active){campaigns.exited(id);setups.exited(id);}}
  emit('agent-event',{...event,candidateId:id});
});engines.set(id,instance);}return engines.get(id);}
// Handlers are also kept by name so a paired phone can reach the same functions (see mobile.mjs).
const handlers=new Map();
function handle(name,fn){handlers.set(name,fn);ipcMain.handle(name,async(event,...args)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('Untrusted sender');return fn(...args);});}
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
const backgroundTimer=setInterval(()=>{background.tick().catch(error=>emit('agent-event',{event:'error',error:error.message}));},5000);
handle('catalog',()=>ensureEngine().request('catalog'));
handle('candidates',()=>store.candidates());
handle('chrome-profiles',()=>listChromeProfiles());
handle('snapshot',async id=>({...store.snapshot(id),documents:await listDocuments(path.join(data,'candidates',id)),active:sessions.has(id)?{candidateId:id,sessionId:sessions.get(id).sessionId,state:sessions.get(id).state??'Unknown'}:null}));
handle('documents',id=>{store.profile(id);return listDocuments(path.join(data,'candidates',id));});
handle('read-document',(id,file)=>{store.profile(id);return readDocument(path.join(data,'candidates',id),file);});
handle('open-document',async(id,file)=>{store.profile(id);const error=await shell.openPath(await documentPath(path.join(data,'candidates',id),file));if(error)throw Error(error);});
handle('save-profile',async p=>{if(p.agentSettings){await ensureEngine().request('validate',p.agentSettings);if(p.agentSettings.provider==='gemini')throw Error('Gemini MCP entegrasyonu henüz desteklenmiyor');if(![true,false,null].includes(p.agentSettings.network))throw Error('Geçersiz ağ tercihi');}const profile=store.saveProfile(p);emit('changed',{});return profile;});
handle('source-integrations',()=>sourceIntegrations);
handle('source-instructions',(id,sourceId)=>sourceInstructions(root,store.source(id,sourceId)));
handle('source-test',async(id,sourceId)=>{const result=await runSourceTool(root,store.source(id,sourceId),['search','--help'],{test:true});store.event(id,'source_tool_tested',{sourceId,ok:result.ok});return result;});
handle('save-source',async(candidateId,source)=>{const result=store.saveSource(candidateId,source);emit('changed',{candidateId});await campaigns.tick();return result;});
handle('delete-source',(candidateId,id)=>{const result=store.deleteSource(candidateId,id);emit('changed',{candidateId});return result;});
handle('save-application-policy',(candidateId,policy)=>{const result=store.saveApplicationPolicy(candidateId,policy);emit('changed',{candidateId});return result;});
handle('pick-cv',async id=>{store.profile(id);const result=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'CV',extensions:['pdf','docx','txt']}]});if(result.canceled)return null;const dir=path.join(data,'candidates',id);await mkdir(dir,{recursive:true,mode:0o700});const target=path.join(dir,'CV'+path.extname(result.filePaths[0]).toLowerCase());await copyFile(result.filePaths[0],target);await chmod(target,0o600);store.setCv(id,target);emit('changed',{});return target;});
async function startAgent(candidateId,prompt,jobId){
  if(sessions.has(candidateId)||starting.has(candidateId))throw Error('Bu adayın agent oturumu zaten açık');
  const profile=store.profile(candidateId);if(!profile.cvPath&&store.setup(candidateId)?.status!=='running')throw Error('Önce CV seç');starting.add(candidateId);
  prompt=['Session startup: read the current AGENTS.md and run-job-search skill once; their task-routing rules replace earlier blanket instructions to reread every skill. Then execute the assigned task below.',browserProfileInstruction(profile),prompt].filter(Boolean).join('\n\n');
  const sessionId=randomUUID(),token=mcp.grant(candidateId,sessionId);store.logPrompt(candidateId,{kind:'start',text:prompt,jobId:jobId??null,sessionId});
  try{
    const cwd=path.join(data,'candidates',candidateId);await mkdir(cwd,{recursive:true,mode:0o700});await cp(path.join(root,'skills'),path.join(cwd,'.agents/skills'),{recursive:true});
    await writeFile(path.join(cwd,'AGENTS.md'),AGENTS_MD);
    await mkdir(path.join(cwd,'runtime'),{recursive:true});await mkdir(path.join(cwd,'documents'),{recursive:true});
    sessions.set(candidateId,{candidateId,sessionId,token,provider:profile.agentSettings.provider,resumeId:store.conversation(candidateId,profile.agentSettings.provider)});terminalOutputs.delete(candidateId);
    const engine=ensureEngine(candidateId);
    if(jobId){const job=store.job(candidateId,jobId);if(['blocked','uncertain'].includes(job.status)&&job.sessionId!==sessionId)store.reclaim(candidateId,jobId,sessionId);}
    await startWithResumeRepair(engine,{sessionId,cwd,runtimeDirectory:path.join(cwd,'runtime'),endpoint:mcp.endpoint,token,...profile.agentSettings,resumeId:store.conversation(candidateId,profile.agentSettings.provider),prompt,...terminalGrid},result=>{if(result.fresh){store.forgetConversation(candidateId,profile.agentSettings.provider,result.replacedResumeId);const active=sessions.get(candidateId);if(active){active.resumeId=null;active.resumeDiagnostic='';}}store.event(candidateId,'history_repaired',result);emit('changed',{candidateId});});
    await engine.request('resize',terminalGrid);
    emit('changed',{});return{sessionId};
  }catch(error){mcp.revoke(token);sessions.delete(candidateId);const failed=engines.get(candidateId);engines.delete(candidateId);await failed?.close().catch(()=>{});throw error;}finally{starting.delete(candidateId);}
}
async function stopAgent(id){const engine=engines.get(id);engines.delete(id);retire(id);await engine?.close();}
const sendPrompt=(text,id)=>{store.logPrompt(id,{kind:'message',text,sessionId:sessions.get(id)?.sessionId??null});return engines.get(id).request('message',{text});};
const campaigns=new Campaigns(store,{launch:startAgent,send:sendPrompt,stop:stopAgent,active:id=>sessions.get(id),changed:id=>emit('changed',{candidateId:id})});
for(const candidate of store.candidates())campaigns.recheckLegacyFormQuestions(candidate.id);
for(const p of store.candidates()){const c=store.campaign(p.id);if(c?.status==='running')store.saveCampaign(p.id,{...c,task:c.task?{...c.task,report:null,seenWorking:false,recovery:{readyAt:Date.now()+2000,reason:'App restarted; resume the unfinished task after checking saved outcomes'}}:null,wakeAt:Date.now()+2000});}
const setups=new Setups(store,{launch:startAgent,send:sendPrompt,active:id=>sessions.get(id),changed:id=>emit('changed',{candidateId:id})});
for(const p of store.candidates()){const s=store.setup(p.id);if(s?.status==='running')store.saveSetup(p.id,{...s,needsTurn:true});}
const campaignTimer=setInterval(()=>{campaigns.tick().catch(error=>emit('agent-event',{event:'error',error:error.message}));setups.tick().catch(error=>emit('agent-event',{event:'error',error:error.message}));},1000);
handle('create-setup',async settings=>{await ensureEngine().request('validate',settings);if(!['codex','claude'].includes(settings.provider))throw Error('Desteklenmeyen sağlayıcı');const p=store.createSetup(settings);emit('changed',{});return p;});
handle('begin-setup',async(id,source)=>{const s=store.setup(id);if(!s||s.status==='complete')throw Error('Setup bulunamadı');if(source){const url=new URL(source);if(url.protocol!=='https:'||!['linkedin.com','www.linkedin.com'].includes(url.hostname)||!url.pathname.startsWith('/in/'))throw Error('Geçerli bir LinkedIn profil bağlantısı gir');store.saveSetup(id,{...s,source:url.toString()});}await setups.begin(id);});
handle('complete-setup',async(id,fields)=>{if(sessions.has(id))await stopAgent(id);const p=store.completeSetup(id,fields);emit('changed',{});return p;});
handle('import-setup-cv',async(id,file)=>{if(store.setup(id)?.status!=='intake')throw Error('CV yüklemek için setup başlangıcında olmalısın');if(typeof file!=='string'||!path.isAbsolute(file)||!['.pdf','.docx','.txt'].includes(path.extname(file).toLowerCase()))throw Error('PDF, Word veya TXT CV seç');const dir=path.join(data,'candidates',id);await mkdir(dir,{recursive:true,mode:0o700});const target=path.join(dir,'CV'+path.extname(file).toLowerCase());await copyFile(file,target);await chmod(target,0o600);store.setCv(id,target);emit('changed',{});return target;});
handle('start',(id,options)=>campaigns.start(id,options));
handle('pause',id=>campaigns.pause(id));
handle('stop',async id=>{store.profile(id);if(store.campaign(id))await campaigns.pause(id,'stopped');else await stopAgent(id);});
handle('terminal-output',id=>{store.profile(id);return {bytes:[...(terminalOutputs.get(id)??Buffer.alloc(0))],sequence:terminalSequences.get(id)??0};});
handle('terminal-input',async(id,text)=>{if(!sessions.has(id)||typeof text!=='string'||text.length>64000)return;campaigns.input(id);if(text.trim())store.logPrompt(id,{kind:'input',text,sessionId:sessions.get(id).sessionId});await engines.get(id).request('input',{text});});
handle('prompt-catalog',()=>promptCatalog(root));
handle('prompts',id=>{store.profile(id);return store.prompts(id);});
handle('terminal-resize',async(id,rows,cols)=>{if(!Number.isInteger(rows)||!Number.isInteger(cols)||rows<4||rows>1024||cols<20||cols>4096)return;terminalGrid={rows,cols};if(sessions.has(id)&&!starting.has(id))await engines.get(id).request('resize',terminalGrid);});
handle('answer',async(candidateId,id,answer)=>{const result=store.answer(candidateId,id,answer);campaigns.answered(candidateId,id);setups.answered(candidateId);emit('changed',{});await campaigns.tick();await setups.tick();return{...result,delivery:'saved'};});
handle('reclaim',(candidateId,id)=>{const active=sessions.get(candidateId);if(!active)throw Error('Bu adayın agent oturumunu başlat');const result=store.reclaim(candidateId,id,active.sessionId);emit('changed',{});return result;});
const focusTab=(id,context)=>context?.browser==='Jev Chrome'?browser.focus(id,context):focusApplicationTab(context);
handle('open-source-tab',(candidateId,sourceId)=>focusTab(candidateId,store.source(candidateId,sourceId).resumeContext));
handle('open-application-tab',(candidateId,jobId)=>focusTab(candidateId,store.job(candidateId,jobId).resumeContext));
handle('recover-question',(candidateId,questionId)=>campaigns.recoverQuestion(candidateId,questionId));
handle('open-question-tab',async(candidateId,questionId)=>{const q=store.questions(candidateId).find(q=>q.id===questionId);if(!q?.jobId)throw Error('Soruya bağlı ilan bulunamadı');try{return await focusTab(candidateId,store.job(candidateId,q.jobId).resumeContext);}catch(error){if(error.code!=='TAB_MISSING')throw error;return campaigns.recoverQuestion(candidateId,questionId);}});
handle('open-link',async url=>{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))throw Error('Geçersiz bağlantı');await shell.openExternal(u.toString());});
mobile=new MobileAccess({data,dist:path.join(root,'dist'),handlers,log:error=>console.error('[mobile]',error),
  documentFile:(id,file)=>{store.profile(id);return documentPath(path.join(data,'candidates',id),file);},
  uploadCv:async(id,name,bytes)=>{store.profile(id);const ext=path.extname(String(name)).toLowerCase();if(!['.pdf','.docx','.txt'].includes(ext))throw Error('PDF, Word veya TXT CV seç');if(!bytes.length)throw Error('Dosya boş');const dir=path.join(data,'candidates',id);await mkdir(dir,{recursive:true,mode:0o700});const target=path.join(dir,'CV'+ext);await writeFile(target,bytes,{mode:0o600});store.setCv(id,target);emit('changed',{});return target;}});
await mobile.load();
handle('mobile-status',()=>mobile.status());
handle('mobile-enable',on=>mobile.setEnabled(on===true));
handle('mobile-rotate',()=>mobile.rotate());
window=new BrowserWindow({width:1440,height:950,minWidth:1040,minHeight:720,title:'JobLoop',backgroundColor:'#11151b',webPreferences:{preload:path.join(root,'app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
await window.loadFile(path.join(root,'dist/index.html'));
app.on('second-instance',()=>{window?.show();window?.focus();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;mobile?.stop().catch(()=>{});campaigns.closed=true;setups.closed=true;clearInterval(campaignTimer);clearInterval(backgroundTimer);(async()=>{await background.close();await Promise.allSettled([...engines.values()].map(engine=>engine.close()));for(const id of sessions.keys())retire(id);engines.clear();await browser.close();await mcp.close();store.close();app.quit();})();});

}
boot().catch(error=>{console.error(error);app.exit(1);});
