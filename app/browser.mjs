import {checkSourceBrowser} from './source-browser-check.mjs';
import {BrowserConnections,browserWaitResult} from './browser-connection.mjs';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {JevBrowser,jevTools} from './jev-browser.mjs';
import {pressBrowserTarget} from './browser-target.mjs';
import {resolveBrowserCaptcha} from './captcha-automation.mjs';

// Every workspace uses one Jev-managed Chrome connection shared by its workers.
export class BrowserTools {
  constructor(directory,jevOptionsForCandidate=()=>({})){this.directory=directory;this.jevOptionsForCandidate=jevOptionsForCandidate;this.clients=new Map();this.operations=new Map();this.connectionKeys=new Map();this.connections=new BrowserConnections({connect:async id=>{const {client}=await this.connect(id);await client.context();},changed:(id,state)=>this.onStatus?.(id,state)});}
  forWorker(workerId='main',isActive=()=>true,{signal,captchaMaySubmit}={}){const scoped=Object.create(this);scoped.workerId=workerId;scoped.isActive=isActive;scoped.signal=signal;scoped.captchaMaySubmit=captchaMaySubmit;return scoped;}
  options(id){return this.jevOptionsForCandidate(id,this.workerId??'main');}
  status(id){
    const options=this.options(id),key=JSON.stringify([options.profile?.directory,options.connection]);
    if(this.connectionKeys.get(id)!==key){this.connectionKeys.set(id,key);this.connections.reset(id);}
    return this.connections.status(id);
  }
  prepare(id,options){this.status(id);return this.connections.prepare(id,options);}
  waiting(id){const state=this.status(id);return !state.ready&&state.state!=='idle';}
  async resetCandidate(id){
    this.connections.reset(id);
    const previous=this.clients.get(id);this.clients.delete(id);
    this.connectionKeys.delete(id);
    if(previous){const connected=await previous.pending.catch(()=>null);if(connected)await connected.client.close();}
  }
  async resumeApplication(id,jobId,sessionId){
    const options=this.options(id),state=options.lifecycle??{};
    if(state.activeJobId!==jobId)throw Error('Yalnızca etkin başvuru sürdürülebilir.');
    const job=state.jobs?.find(job=>job.id===jobId);if(!job)throw Error('İlan bulunamadı.');
    if(job.followupStopped)return {content:[{type:'text',text:JSON.stringify({status:'followup_stopped',jobId,submissionState:job.status,message:'Kullanıcı takibi bıraktı; önceki gönderim sonucu değiştirilmedi. Yeni işlem yapma.'})}]};
    if(['submitted','already_submitted','skipped'].includes(job.status))return {content:[{type:'text',text:JSON.stringify({status:'complete',jobId,message:'Kayıtlı sonuç kesin; yeni başvuru açma.'})}]};
    if(job.sessionId&&job.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait.');
    if(job.resumeContext&&job.resumeContext.browser!=='Jev Chrome')throw Error('Taslağı kayıtlı orijinal tarayıcı aracıyla sürdür; Jev ile yeni başvuru açma.');
    const result=await this.call(id,'browser_jev_open',{url:job.applicationUrl??job.url},sessionId);
    for(const part of result.content??[])if(part.type==='text'){
      const value=JSON.parse(part.text);if(value.tabId){value.resume={jobId,reopened:!value.reused,previousProgress:job.browserProgress??null,message:'Bu sonuç taze gözlemdir. Önceki ilerleme geçmiş kanıttır; güncel alanlarla karşılaştır, yalnızca eksikleri doldur. Eski fieldId/controlId kullanma.'};part.text=JSON.stringify(value);}
    }
    return result;
  }
  async connect(candidateId){
    const options=this.options(candidateId),key=JSON.stringify({profile:options.profile?.directory,connection:options.connection});
    const previous=this.clients.get(candidateId);
    if(previous?.key===key)return previous.pending;
    if(previous)try{await(await previous.pending).client.close();}catch{}
    const connection={key};
    const pending=this.open(candidateId,options).then(value=>{connection.client=value.client;return value;}).catch(error=>{if(this.clients.get(candidateId)===connection)this.clients.delete(candidateId);throw error;});
    connection.pending=pending;this.clients.set(candidateId,connection);return pending;
  }
  async open(candidateId,options={}){
    const base=this.directoryFor?.(candidateId)??this.directory;
    const directory=path.join(base,'browsers',candidateId);
    const workspace=this.workspaceFor?.(candidateId)??path.join(base,'candidates',candidateId);
    await mkdir(workspace,{recursive:true,mode:0o700});
    await mkdir(directory,{recursive:true,mode:0o700});
    return {client:new JevBrowser(path.join(directory,'jev-profile'),{...options,siteAccess:this.siteAccess,autoVerify:()=>this.captcha?.settings.status().enabled===true,workspace,onDisconnect:()=>this.connections.disconnected(candidateId),onTabsClosed:ids=>{if(!this.closed)return this.onTabsClosed?.(candidateId,ids);},onProgress:(jobId,progress,owner)=>this.onProgress?.(candidateId,jobId,progress,owner),beforeSubmit:(jobId,url,owner,verificationContinuation)=>this.beforeSubmit?.(candidateId,jobId,url,owner,{verificationContinuation})}),tools:jevTools,directory,workspace};
  }
  async tools(){return jevTools;}
  async call(candidateId,name,args,sessionId,options){
    const slot=this.clients.get(candidateId)?.client?.tabs.get(args.tabId);
    if(slot&&slot.owner===sessionId)await this.captcha?.wait(slot);
    const result=await this.enqueue(candidateId,()=>this.performCall(candidateId,name,args,sessionId,options));
    return resolveBrowserCaptcha(this,candidateId,result,sessionId,options);
  }
  async enqueue(candidateId,run,{checkActive=true}={}){
    const previous=this.operations.get(candidateId)??Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>{if(checkActive&&this.isActive&&!this.isActive())throw Error('Worker oturumu kapandı.');return run();});
    this.operations.set(candidateId,operation);
    try{return await operation;}finally{if(this.operations.get(candidateId)===operation)this.operations.delete(candidateId);}
  }
  async waitForOperations(candidateId){await this.operations.get(candidateId)?.catch(()=>{});}
  async performCall(candidateId,name,args,sessionId,{automationTabKey,automationWorkspaceId,automationSourceUrl,automationSourceUrls,automationPreferredTabId,automationFreshTab,automationResumeRecord}={}){
    if(!this.prepare(candidateId).ready)return {content:[{type:'text',text:JSON.stringify(browserWaitResult())}]};
    const {client}=await this.connect(candidateId);
    if(this.isActive&&!this.isActive())throw Error('Worker oturumu kapandı.');
    if(name==='browser_target_press'){
      const url=client.tab(args.tabId).page.url();
      try{if(/^https?:/.test(url))this.siteAccess?.assertAction(url);}
      catch(error){if(error.code!=='SITE_WAIT')throw error;return {content:[{type:'text',text:JSON.stringify({status:'site_wait',url,tabId:args.tabId,siteWait:error.wait,text:error.message,message:error.message,executed:false})}]};}
      return pressBrowserTarget(client,true,args,sessionId);
    }
    if(!jevTools.some(t=>t.name===name))throw Error('Unknown browser tool');
    let result;try{result=await client.callTool({name,arguments:args},sessionId,{...this.options(candidateId).lifecycle,signal:this.signal,...(automationTabKey?{automationTabKey}:{}),...(automationWorkspaceId?{automationWorkspaceId:candidateId}:{}),...(automationSourceUrl?{automationSourceUrl,automationSourceUrls}:{}),...(automationPreferredTabId?{automationPreferredTabId}:{}),...(automationFreshTab?{automationFreshTab:true}:{}),...(automationResumeRecord?{automationResumeRecord:true}:{})});}catch(error){if(!client.browser&&client.connection==='existing'||error.code==='BROWSER_DISCONNECTED'){this.connections.disconnected(candidateId);return {content:[{type:'text',text:JSON.stringify(browserWaitResult())}]};}throw error;}
    if(!result.isError)for(const part of result.content??[]){
      if(part.type!=='text')continue;
      try{const slot=client.tabs.get(JSON.parse(part.text).tabId);if(slot)slot.previewAt=Date.now();}catch{}
    }
    return result;
  }
  // The connected client for a workspace, or null when nothing is connected or
  // the profile changed. UI reads must never start Chrome or prompt for permission.
  async connectedClient(candidateId){
    const connection=this.clients.get(candidateId);if(!connection)return null;
    const connected=await connection.pending.catch(()=>null),client=connected?.client;
    if(!client||client.closed||this.clients.get(candidateId)!==connection||client.profile?.directory!==this.options(candidateId).profile?.directory)return null;
    return client;
  }
  cleanupSearch(candidateId,taskId){return this.enqueue(candidateId,()=>this.performCleanupSearch(candidateId,taskId),{checkActive:false});}
  async performCleanupSearch(candidateId,taskId){
    const connection=this.clients.get(candidateId);
    if(!connection)return {deferred:true};
    const options=this.options(candidateId),{client}=await connection.pending;
    if(client.profile?.directory!==options.profile?.directory)return {deferred:true};
    return client.cleanupSearch(taskId,options.lifecycle??{});
  }
  cleanup(candidateId){return this.enqueue(candidateId,()=>this.performCleanup(candidateId),{checkActive:false});}
  async performCleanup(candidateId){
    const connection=this.clients.get(candidateId),options=this.options(candidateId);
    if(!connection)return {deferred:true};
    const {client}=await connection.pending;
    if(client.profile?.directory!==options.profile?.directory)return {deferred:true};
    return client.cleanupCompleted(options.lifecycle??{});
  }
  maintain(candidateId){
    const connection=this.clients.get(candidateId),client=connection?.client;
    // Maintenance never starts Chrome, requests permission or queues behind a
    // running agent operation. The next tick retries disconnected/busy clients.
    if(this.closed||!client||client.closed||client.busy||!client.opening||client.connection==='existing'&&!client.browser?.isConnected()||this.operations.has(candidateId))return Promise.resolve({deferred:true});
    return this.enqueue(candidateId,async()=>{
      if(this.clients.get(candidateId)!==connection)return {deferred:true};
      const options=this.options(candidateId);
      if(client.profile?.directory!==options.profile?.directory)return {deferred:true};
      return client.cleanupCompleted(options.lifecycle??{});
    });
  }
  async focus(candidateId,context){
    return (await this.connect(candidateId)).client.focus(context.tabId);
  }
  probeAutomationSource(id,task){
    const connection=this.clients.get(id),client=connection?.client;
    if(this.closed||!client||client.closed||client.busy||this.operations.has(id)||!this.status(id).ready)return Promise.resolve({ready:false,deferred:true});
    return this.enqueue(id,()=>{
      if(this.clients.get(id)!==connection||client.profile?.directory!==this.options(id).profile?.directory)return {ready:false,deferred:true};
      return checkSourceBrowser(client,id,task);
    },{checkActive:false});
  }
  async workspaceTabs(id){
    const client=await this.connectedClient(id),options=this.options(id);
    if(!client||client.connection==='existing'&&!client.browser?.isConnected())return [];
    const jobs=Array.isArray(options.lifecycle?.jobs),checkpoints=new Set((options.checkpoints??[]).filter(c=>c?.browser==='Jev Chrome').map(c=>c.tabId));
    const webTab=slot=>{
      const owner=client.automationWorkspaces.get(slot.id);
      if(owner)return owner===id;
      // Tabs created before workspace labels were added remain in this browser's
      // exact owned-target set. Never infer ownership from URL or profile alone.
      return !client.tabJobs.has(slot.id)&&!client.tabSearches.has(slot.id)&&(client.connection==='existing'?client.transport?.owned.has(slot.id):true);
    };
    return [...client.tabs.values()].filter(slot=>slot.id!==client.homeId&&!slot.page.isClosed()&&(jobs?(client.tabJobs.has(slot.id)||client.tabSearches.has(slot.id)||checkpoints.has(slot.id)):webTab(slot))).map(slot=>({tabId:slot.id,url:slot.page.url(),title:slot.observed?.title??'',browser:'Jev Chrome',...(client.automationRuns.has(slot.id)?{runId:client.automationRuns.get(slot.id)}:{}),...(client.automationTabs.get(slot.id)?.startsWith('record:')?{recordId:client.automationTabs.get(slot.id).slice(7)}:{}),kind:client.tabJobs.has(slot.id)?'application':client.tabSearches.has(slot.id)?'search':'workspace',...(client.tabJobs.has(slot.id)?{jobId:client.tabJobs.get(slot.id)}:{}),...(client.tabSearches.has(slot.id)?{searchTaskId:client.tabSearches.get(slot.id)}:{}),...(client.automationSources.has(slot.id)?{sourceUrl:client.automationSources.get(slot.id)}:{})}));
  }
  async focusWorkspaceTab(id,tabId){
    if(typeof tabId!=='string'||!(await this.workspaceTabs(id)).some(tab=>tab.tabId===tabId))throw Object.assign(Error('Bu çalışma alanının açık sekmesi bulunamadı.'),{code:'TAB_MISSING'});
    const connection=this.clients.get(id),client=(await connection?.pending)?.client,slot=client?.tabs.get(tabId);
    if(this.clients.get(id)!==connection||!slot||slot.page.isClosed())throw Object.assign(Error('Sekme kapandı.'),{code:'TAB_MISSING'});
    await slot.page.bringToFront();return {focused:true};
  }
  async closeWorkspaceTabs(id,selection){
    if(!Array.isArray(selection)||!selection.length||selection.some(tab=>!tab||typeof tab.tabId!=='string'||typeof tab.url!=='string')||new Set(selection.map(tab=>tab.tabId)).size!==selection.length)throw Error('Kapatılacak sekmeler geçersiz.');
    return this.enqueue(id,async()=>{
      const available=new Map((await this.workspaceTabs(id)).map(tab=>[tab.tabId,tab]));
      if(selection.some(tab=>{const live=available.get(tab.tabId);return !live||live.url!==tab.url||live.sourceUrl!==tab.sourceUrl;}))throw Object.assign(Error('Sekmeler değişti. Listeyi yenileyip tekrar dene.'),{code:'TAB_CHANGED'});
      const connection=this.clients.get(id),client=(await connection?.pending)?.client;
      if(this.clients.get(id)!==connection||!client)throw Object.assign(Error('Chrome bağlantısı kapandı.'),{code:'TAB_MISSING'});
      const closed=[],failed=[];
      for(const tab of selection){
        const slot=client.tabs.get(tab.tabId);
        if(!slot||slot.page.isClosed()||slot.page.url()!==tab.url){failed.push(tab.tabId);continue;}
        try{await slot.page.close({runBeforeUnload:false});client.forgetTab(tab.tabId);closed.push(tab.tabId);}catch{failed.push(tab.tabId);}
      }
      if(closed.length)await client.onTabsClosed(closed);
      await client.persistTabs();
      return {closed,failed};
    },{checkActive:false});
  }
  async finishAutomationRun(id,run,{closeTabs=false,sourceAccessReset=false,sourceRunIds=[],pendingTabIds=[]}={}){
    if(!closeTabs)return {closed:[]};
    const connection=this.clients.get(id);
    if(!connection)return {deferred:true};
    return this.forWorker(run.workerId??'main').enqueue(id,async()=>{
      const client=await this.connectedClient(id);
      if(!client||this.clients.get(id)!==connection)return {deferred:true};
      return client.closeFinishedAutomationRunTabs(run.id,id,{sourceScan:!run.recordId,pendingTabIds,...(sourceAccessReset?{resetSource:run.sourceUrl,sourceRunIds}:{})});
    },{checkActive:false});
  }
  async sourceTabs(candidateId,sources,task){
    const result={},connection=this.clients.get(candidateId),client=await this.connectedClient(candidateId);
    if(!client||this.clients.get(candidateId)!==connection||client.connection==='existing'&&!client.browser?.isConnected())return result;
    const usable=slot=>slot&&slot.id!==client.homeId&&!slot.page.isClosed()&&!client.tabJobs.has(slot.id);
    for(const source of sources){
      const checkpoint=source.resumeContext?.browser==='Jev Chrome'?client.tabs.get(source.resumeContext.tabId):null;
      const slot=usable(checkpoint)?checkpoint:task?.kind==='search'&&task.sourceId===source.id?[...client.tabs.values()].find(slot=>usable(slot)&&client.tabSearches.get(slot.id)===task.id):null;
      if(slot)result[source.id]={browser:'Jev Chrome',tabId:slot.id,url:slot.page.url()};
    }
    return result;
  }
  async focusSource(candidateId,source,task){
    const connection=this.clients.get(candidateId),context=(await this.sourceTabs(candidateId,[source],task))[source.id];
    if(!context||this.clients.get(candidateId)!==connection)throw Object.assign(Error('Bu kaynağın açık arama sekmesi bulunamadı.'),{code:'TAB_MISSING'});
    const connected=await connection?.pending;
    if(!connected||connected.client.closed)throw Object.assign(Error('Chrome bağlantısı kapandı.'),{code:'TAB_MISSING'});
    // Focus the live page directly; never reconnect or open a replacement here.
    await connected.client.tab(context.tabId).page.bringToFront();return {focused:true};
  }
  async close({closeTabs=false}={}){
    this.closed=true;this.connections.close();
    // Cancel all queued connections before an active one releases its turn.
    await Promise.all([...this.clients].map(async([key,{pending}])=>{
      try{
        const {client}=await pending;
        const result=await client.close({closeTabs});
        if(closeTabs&&result?.closed?.length)this.onTabsClosed?.(key,result.closed);
        if(result?.failed?.length)console.warn(`Chrome sekmeleri kapatılamadı: ${result.failed.join(', ')}`);
      }catch(error){console.warn('Tarayıcı bağlantısı kapatılamadı:',error);}
    }));
    this.clients.clear();
  }
}
