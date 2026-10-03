import {workerPreviews} from './worker-preview.mjs';
import {registerWorkspaceSupport} from './workspace-support-services.mjs';
import {upgradeWorkspaces} from './workspace-upgrade.mjs';
import {workspaceBrowserDirectory} from './workspace-paths.mjs';
import {AgentProfiles} from './agent-profiles.mjs';
import {WEB_AGENTS,WEB_AGENT_ROLES} from './automation-agent-profiles.mjs';
import {InstructionLog} from './instruction-log.mjs';
import {webInstructionCatalog,instructionSnapshot} from './instruction-catalog.mjs';
import {configurationCatalog,webPromptCatalog} from './configuration-catalog.mjs';
import {app,BrowserWindow,Menu,ipcMain,dialog,shell,safeStorage,Notification} from 'electron';
import {mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Maintenance} from './maintenance.mjs';
import {registerAutomationServices} from './automation-services.mjs';
import {AutomationStore} from './automation-store.mjs';
import {registerSettingsServices} from './settings-services.mjs';
import {JevSettings} from './jev-settings.mjs';
import {CaptchaSettings} from './captcha-settings.mjs';
import {CaptchaCoordinator} from './captcha-coordinator.mjs';
import {applyPendingRestore,prepareDataUpgrade,completeDataUpgrade} from './data-management.mjs';
import {currentDataDirectory,resolveDataDirectory,cancelDataLocation} from './data-location.mjs';
import {AgentSessions} from './agent-sessions.mjs';
import {WorkspaceScheduler} from './workspace-scheduler.mjs';
import {Workspaces} from './workspaces.mjs';
import {WorkspaceDocuments} from './workspace-documents.mjs';
import {WorkspaceDatabase} from './workspace-database.mjs';
import {TemplateRegistry} from './template-registry.mjs';
import {loadExtensions} from './extensions.mjs';
import {startToolServer} from './tool-server.mjs';
import {workerKey} from './worker-key.mjs';
import {BrowserTools} from './browser.mjs';
import {listChromeProfiles} from './chrome-profiles.mjs';
import {browserDefinition} from './browser-definition.mjs';
import {resolveLaunchEnvironment} from './launch-environment.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function boot(){
 // The internal name keeps the JobLoop data folder and keychain entry; users see AutoJev.
 app.setName('JobLoop');
 if(process.env.JOBLOOP_DATA_DIR)app.setPath('userData',process.env.JOBLOOP_DATA_DIR);
 if(!app.requestSingleInstanceLock()){app.quit();return;}
 await app.whenReady();
 if(process.platform!=='win32')process.env.PATH=(await resolveLaunchEnvironment()).PATH;
 if(process.platform==='darwin'){app.setAboutPanelOptions({applicationName:'AutoJev'});if(!app.isPackaged)app.dock.setIcon(path.join(root,'build/icon.png'));Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'AutoJev',submenu:[{role:'about',label:'About AutoJev'},{type:'separator'},{role:'services'},{type:'separator'},{role:'hide',label:'Hide AutoJev'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit',label:'Quit AutoJev'}]},{role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}]));}
 const bootstrapDirectory=app.getPath('userData');await mkdir(bootstrapDirectory,{recursive:true,mode:0o700});
 let data=await currentDataDirectory(bootstrapDirectory);
 try{data=await resolveDataDirectory({bootstrapDirectory});}catch(error){await cancelDataLocation(bootstrapDirectory);dialog.showErrorBox('Veri klasörü değiştirilemedi',`${error.message}\n\nÖnceki veri konumuyla devam ediliyor: ${data}`);}
 await mkdir(data,{recursive:true,mode:0o700});await rm(path.join(data,'mobile.json'),{force:true});
 await applyPendingRestore({dataDirectory:data});await prepareDataUpgrade({dataDirectory:data,appVersion:app.getVersion()});
 const extensions=await loadExtensions(),registry=new TemplateRegistry(extensions.map(extension=>extension.definition));
 const core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite'),{registry});
 const encryptSecret=value=>{if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('Güvenli saklama için sistem anahtarlığını aç.');return safeStorage.encryptString(value).toString('base64');};
 const decryptSecret=value=>safeStorage.decryptString(Buffer.from(value,'base64'));
 const jevSettings=new JevSettings(core.db,{encrypt:encryptSecret,decrypt:decryptSecret});
 const captchaSettings=new CaptchaSettings(core.db,{encrypt:encryptSecret,decrypt:decryptSecret});
 let window,quitting=false;
 const emit=(channel,value)=>{if(window&&!window.isDestroyed())window.webContents.send(channel,value);};
 const changed=id=>{emit('changed',{candidateId:id});emit('automation-changed',{automationId:id});};
 const instructionLog=new InstructionLog(core.workspaces,{changed:id=>emit('instructions-changed',{workspaceId:id})});
 const agents=new AgentSessions({root,data,instructions:instructionLog,emit:event=>emit('agent-event',event),changed}),changing=new Set(),services=[];
 const ensureEngine=()=>agents.ensure('catalog');
 const profiles=new AgentProfiles(core.workspaces,{validate:library=>ensureEngine().request('validate-profile',{library}),changed:id=>emit('instructions-changed',{workspaceId:id})});profiles.register(WEB_AGENTS);agents.profiles=profiles;
 const workspaces=new Workspaces(core.workspaces,{templates:{},changing,changed,validateSettings:settings=>ensureEngine().request('validate',settings),workerRemoved:(id,worker)=>agents.clear(id,worker)});
 const documents=new WorkspaceDocuments(workspaces,{dialog,shell,window:()=>window});
 const browser=new BrowserTools(data,(id,worker)=>workspaces.template(id).browserOptions(id,worker));
 browser.captcha=new CaptchaCoordinator(captchaSettings);
 browser.onCaptchaProgress=changed;
 browser.directoryFor=id=>workspaces.template(id).browserDirectory(id);
 browser.onStatus=(id,state)=>{workspaces.template(id).onBrowserStatus?.(id,state);changed(id);};
 browser.onTabsClosed=(id,ids)=>{workspaces.template(id).onTabsClosed?.(id,ids);changed(id);};
 browser.onProgress=(id,...args)=>workspaces.template(id).onBrowserProgress?.(id,...args);
 browser.beforeSubmit=(id,...args)=>workspaces.template(id).beforeSubmit?.(id,...args);
 const mcp=await startToolServer({onExchange:(grant,event)=>instructionLog.tool({...grant,agentProfileId:agents.sessions.get(workerKey(grant.workspaceId,grant.workerId))?.agentProfile?.id},event),assertOwner:id=>core.workspaces.get(id),resolve(grant){
  if(agents.sessions.get(workerKey(grant.workspaceId,grant.workerId))?.sessionId!==grant.sessionId)throw Error('Worker oturumu kapandı.');
  return grant.workflow??workspaces.template(grant.workspaceId).protocol(grant);
 },onHook:hook=>{const active=[...agents.sessions.values()].find(a=>a.sessionId===hook.observation?.sessionId);if(!active)throw Error('No agent');return agents.engines.get(workerKey(active.candidateId,active.workerId)).request('hook',{token:hook.token,observation:hook.observation});}});
 const scheduler=new WorkspaceScheduler({available:()=>!maintenance.busy,onError:error=>emit('agent-event',{event:'error',error:error.message})});
 const maintenance=new Maintenance({
  assertIdle(){if(agents.sessions.size||agents.starting.size||browser.operations.size||changing.size)throw Error('Önce çalışan agent ve tarayıcı işlemlerini durdur.');for(const service of services)service.assertIdle?.();},
  stop:async()=>{for(const service of services)await service.stop?.();},resume:async()=>{if(!quitting)for(const service of services)await service.resume?.();}
 });
 function handle(name,fn){ipcMain.handle(name,async(event,...args)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('Untrusted sender');return maintenance.invoke(name,()=>fn(...args));});}
 const automationDb=new AutomationStore(core);upgradeWorkspaces(automationDb);
 const web=registerAutomationServices({root,data,db:automationDb,browsers:browser,mcp,agents,handle,emit,validateSettings:settings=>ensureEngine().request('validate',settings),dialog,shell,window:()=>window,notify:(title,body)=>{if(Notification.isSupported()&&!window?.isFocused()){const notification=new Notification({title,body:body.slice(0,300)});notification.on('click',()=>{window?.show();window?.focus();});notification.show();}}});
 workspaces.templates[browserDefinition.id]={
  agentRoles:()=>WEB_AGENT_ROLES,
  instructions:(id,role)=>webInstructionCatalog(automationDb,id,role),
  configuration:id=>webPromptCatalog(automationDb.get(id)),
  create:(templateId,input)=>automationDb.create(templateId,input),directory:web.workspace,documentPurposes:['attachment'],beforeDocument:id=>automationDb.assertIdle(id),documentAdded:(id,document)=>automationDb.message(id,'system',`Kullanıcı bir belge ekledi: ${document.relative} (${document.name}). Yalnızca bu otomasyon kapsamında kullan.`),
  rename:(id,name)=>automationDb.rename(id,name),remove:web.remove,browserDirectory:id=>workspaceBrowserDirectory(data,core.workspaces.get(id)),browserOptions:id=>({config:()=>jevSettings.config(),profile:core.workspaces.get(id).chromeProfile,lifecycle:{multiWorker:true}}),
  workers:{add:(id,input)=>web.runtime.add(id,input),start:(id,worker,state)=>web.runtime.startWorker(id,worker,state),restartState:(id,worker)=>web.runtime.restartState(id,worker),stop:(id,worker)=>web.runtime.stopWorker(id,worker),remove:(id,worker)=>web.runtime.remove(id,worker)},
  message:(id,text,worker)=>web.runtime.message(id,text,worker),snapshot:id=>web.snapshot(id),
  start:async id=>{automationDb.enable(id);await web.runtime.tick();},stop:id=>web.runtime.pause(id),restart:id=>web.runtime.restart(id),settings:(id,input)=>web.save(id,input)
 };
 services.push({...web,assertIdle(){if(web.runtime.active.size)throw Error('Önce çalışan otomasyonları durdur.');},stop:()=>{web.runtime.closed=true;},resume:()=>{web.runtime.closed=false;},activeRunIds:()=>[...web.runtime.active.values()].map(slot=>slot.run.id)});
 const support=await registerWorkspaceSupport({data,db:automationDb,runtime:web.runtime,handle,emit,encryptSecret,decryptSecret});services.push(support);
 const removeWorkspace=workspaces.templates.browser.remove;workspaces.templates.browser.remove=async id=>{await support.remove(id);return removeWorkspace(id);};
 for(const extension of extensions){const service=await extension.register({root,data,core,handle,emit,agents,profiles,browser,mcp,scheduler,maintenance,documents,dialog,shell,getWindow:()=>window,encryptSecret,decryptSecret,jevSettings,restartingAgents:changing,isQuitting:()=>quitting});workspaces.templates[extension.definition.id]=service.driver;services.push(service);}
 handle('configuration-catalog',id=>configurationCatalog({id,workspaces,profiles}));
 handle('instruction-snapshot',(id,options)=>instructionSnapshot({id,options,log:instructionLog,agents,workspaces,profiles}));
 handle('agent-profile-save',async(id,role,input)=>{if(!workspaces.template(id).agentRoles?.(id).includes(role))throw Error('Bu çalışma alanında agent bulunamadı');return profiles.update(id,role,input);});
 handle('instruction-event',(id,seq)=>instructionLog.detail(id,seq));
 handle('workspace-create',(templateId,input)=>workspaces.create(templateId,input));
 handle('workspaces',()=>workspaces.list());handle('workspace-snapshot',id=>workspaces.snapshot(id));
 handle('workspace-tabs',id=>{core.workspaces.get(id);return browser.workspaceTabs(id);});
 handle('browser-reconnect',id=>{core.workspaces.get(id);return browser.prepare(id,{force:true});});
 handle('focus-workspace-tab',(id,tabId)=>{core.workspaces.get(id);return browser.focusWorkspaceTab(id,tabId);});
 handle('close-workspace-tabs',(id,tabs)=>{core.workspaces.get(id);return browser.closeWorkspaceTabs(id,tabs);});
 handle('workspace-start',(id,options)=>workspaces.start(id,options));handle('workspace-stop',id=>workspaces.stop(id));handle('workspace-restart',(id,options)=>workspaces.restart(id,options));handle('workspace-settings',(id,input)=>workspaces.settings(id,input));
 handle('workspace-transition',(id,itemId,action)=>{const result=core.workspaces.transition(id,itemId,action);changed(id);return result;});
 handle('rename-workspace',(id,name)=>workspaces.rename(id,name));handle('delete-workspace',id=>workspaces.remove(id));
 handle('documents',id=>documents.list(id));handle('pick-document',(id,options)=>documents.pick(id,options));handle('read-document',(id,file)=>documents.read(id,file));handle('open-document',(id,file)=>documents.open(id,file));
 handle('worker-add',(id,input)=>workspaces.addWorker(id,input));handle('worker-start',(id,worker)=>workspaces.startWorker(id,worker));handle('worker-stop',(id,worker)=>workspaces.stopWorker(id,worker));handle('worker-restart',(id,worker)=>workspaces.restartWorker(id,worker));handle('worker-remove',(id,worker)=>workspaces.removeWorker(id,worker));
 handle('terminal-output',(id,worker='main')=>{workspaces.validateWorker(id,worker);return agents.snapshot(id,worker);});
 handle('worker-transcript',(id,worker='main')=>{workspaces.validateWorker(id,worker);return agents.transcript(id,worker);});
 const preview=workerPreviews({browsers:browser,sessionFor:(id,worker)=>agents.sessions.get(workerKey(id,worker))});
 handle('worker-preview',(id,worker='main')=>{workspaces.validateWorker(id,worker);return preview(id,worker);});
 handle('terminal-input',(id,text,worker='main',session)=>{workspaces.beforeInput(id,text,worker);return agents.input(id,text,worker,session);});
 handle('terminal-message',(id,text,worker='main')=>workspaces.message(id,text,worker));handle('terminal-resize',(id,rows,cols,worker='main',session)=>{workspaces.validateWorker(id,worker);return agents.resize(id,rows,cols,worker,session);});
 handle('catalog',()=>ensureEngine().request('catalog'));handle('chrome-profiles',()=>listChromeProfiles());
 handle('open-link',async url=>{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))throw Error('Geçersiz bağlantı');await shell.openExternal(u.toString());});
 scheduler.register('agents',async()=>{for(const session of agents.sessions.values())await agents.readContext(session.candidateId,session);});
 scheduler.register('browsers',()=>{for(const workspace of workspaces.list())if(browser.status(workspace.id).state==='waiting')browser.prepare(workspace.id);});scheduler.register('web-templates',()=>web.runtime.tick());scheduler.start();
 const settingsServices=await registerSettingsServices({app,root,data,bootstrapDirectory,store:core,jevSettings,captchaSettings,handle,window:()=>window,maintenance,emit,clearTerminalOutputs:()=>{agents.clearOutputs();for(const service of services)service.clearOutputs?.();emit('logs-cleared',{});},activeRunIds:()=>services.flatMap(service=>service.activeRunIds?.()??[])});
 window=new BrowserWindow({width:1440,height:950,minWidth:1040,minHeight:720,title:'AutoJev · Web otomasyonları',backgroundColor:'#11151b',webPreferences:{preload:path.join(root,'app/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());await window.loadFile(path.join(root,'dist/index.html'));
 await completeDataUpgrade({dataDirectory:data,appVersion:app.getVersion()});app.on('second-instance',()=>{window?.show();window?.focus();});app.on('window-all-closed',()=>app.quit());
 app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;settingsServices.dispose();scheduler.close();(async()=>{for(const service of services)await service.close?.();await agents.close();await browser.close({closeTabs:true});await mcp.close();core.close();app.quit();})();});
}
boot().catch(error=>{console.error(error);dialog.showErrorBox('Loop açılamadı',String(error.message??error)+'\n\nVeri klasörünü silme. Yedekleri koru ve hatayı güvenli destek kanalına bildir.');app.exit(1);});
