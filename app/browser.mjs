import {BrowserConnections,browserWaitResult} from './browser-connection.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createRequire} from 'node:module';
import path from 'node:path';
import {mkdir,readFile,realpath,stat} from 'node:fs/promises';
import {JevBrowser,jevTools} from './jev-browser.mjs';
import {pressBrowserTarget} from './browser-target.mjs';
const require=createRequire(import.meta.url);

export function browserArguments(mode,directory){
  if(mode==='existing')throw Error('Mevcut Chrome, Codex’in kendi tarayıcı araçlarıyla kullanılır.');
  if(mode==='separate')return ['--browser','chrome','--user-data-dir',path.join(directory,'profile')];
  throw Error('Unknown browser mode');
}
export class BrowserTools {
  constructor(directory,modeForCandidate=()=> 'existing',jevOptionsForCandidate=()=>({})){this.directory=directory;this.modeForCandidate=modeForCandidate;this.jevOptionsForCandidate=jevOptionsForCandidate;this.clients=new Map();this.operations=new Map();this.connectionKeys=new Map();this.connections=new BrowserConnections({connect:async id=>{const {client}=await this.connect(id);await client.context();},changed:(id,state)=>this.onStatus?.(id,state)});}
  forWorker(workerId='main',isActive=()=>true){const scoped=Object.create(this);scoped.workerId=workerId;scoped.isActive=isActive;return scoped;}
  clientKey(id){return this.modeForCandidate(id)==='separate'&&this.workerId&&this.workerId!=='main'?`${id}/workers/${this.workerId}`:id;}
  options(id){return this.jevOptionsForCandidate(id,this.workerId??'main');}
  status(id){
    if(this.modeForCandidate(id)!=='jev')return {state:'unmanaged',ready:true};
    const options=this.options(id),key=JSON.stringify([options.profile?.directory,options.connection]);
    if(this.connectionKeys.get(id)!==key){this.connectionKeys.set(id,key);this.connections.reset(id);}
    return this.connections.status(id);
  }
  prepare(id,options){if(this.status(id).state==='unmanaged')return this.status(id);return this.connections.prepare(id,options);}
  waiting(id){const state=this.status(id);return !state.ready&&state.state!=='idle';}
  async resetCandidate(id){
    this.connections.reset(id);
    const keys=[...this.clients.keys()].filter(key=>key===id||key.startsWith(id+'/workers/'));
    const previous=keys.map(key=>this.clients.get(key));for(const key of keys)this.clients.delete(key);
    this.connectionKeys.delete(id);
    for(const connection of previous){const connected=await connection.pending.catch(()=>null);if(connected)await connected.client.close();}
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
    const mode=this.modeForCandidate(candidateId)??'existing';
    const options=this.options(candidateId),key=JSON.stringify({mode,profile:options.profile?.directory,connection:options.connection});
    const clientKey=this.clientKey(candidateId),previous=this.clients.get(clientKey);
    if(previous?.key===key)return previous.pending;
    if(previous)try{await(await previous.pending).client.close();}catch{}
    const connection={mode,key};
    const pending=this.open(candidateId,mode,options).then(value=>{connection.client=value.client;return value;}).catch(error=>{if(this.clients.get(clientKey)===connection)this.clients.delete(clientKey);throw error;});
    connection.pending=pending;this.clients.set(clientKey,connection);return pending;
  }
  async open(candidateId,mode,options={}){
    const base=this.directoryFor?.(candidateId)??this.directory;
    const directory=path.join(base,'browsers',this.clientKey(candidateId));
    const workspace=path.join(base,'candidates',candidateId);
    await mkdir(workspace,{recursive:true,mode:0o700});
    await mkdir(directory,{recursive:true,mode:0o700});
    if(mode==='jev')return {client:new JevBrowser(path.join(directory,'jev-profile'),{...options,workspace,onDisconnect:()=>this.connections.disconnected(candidateId),onTabsClosed:ids=>{if(!this.closed)return this.onTabsClosed?.(candidateId,ids);},onProgress:(jobId,progress,owner)=>this.onProgress?.(candidateId,jobId,progress,owner),beforeSubmit:(jobId,url,owner,verificationContinuation)=>this.beforeSubmit?.(candidateId,jobId,url,owner,{verificationContinuation})}),tools:jevTools,directory,workspace};
    const cli=path.join(path.dirname(require.resolve('@playwright/mcp/package.json')),'cli.js').replace(/([/\\])(app(?:-(?:x64|arm64))?\.asar)([/\\])/,'$1$2.unpacked$3');
    const transport=new StdioClientTransport({command:process.execPath,args:[cli,...browserArguments(mode,directory),'--output-dir',path.join(directory,'artifacts')],cwd:workspace,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stderr:'pipe'});
    const client=new Client({name:'jobloop-browser',version:'0.1.0'});
    try{await client.connect(transport);const {tools}=await client.listTools();return{client,tools,directory,workspace};}
    catch(error){await transport.close();throw error;}
  }
  async tools(candidateId){const mode=this.modeForCandidate(candidateId)??'existing';if(mode==='existing')return [];if(mode==='jev')return jevTools;return(await this.connect(candidateId)).tools;}
  call(candidateId,name,args,sessionId,options){return this.enqueue(candidateId,()=>this.performCall(candidateId,name,args,sessionId,options));}
  async enqueue(candidateId,run,{checkActive=true}={}){
    const key=this.clientKey(candidateId),previous=this.operations.get(key)??Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>{if(checkActive&&this.isActive&&!this.isActive())throw Error('Worker oturumu kapandı.');return run();});
    this.operations.set(key,operation);
    try{return await operation;}finally{if(this.operations.get(key)===operation)this.operations.delete(key);}
  }
  async waitForOperations(candidateId){await this.operations.get(this.clientKey(candidateId))?.catch(()=>{});}
  async performCall(candidateId,name,args,sessionId,{completeSnapshot=false,automationTabKey,automationWorkspaceId,automationSourceUrl,automationSourceUrls,automationPreferredTabId}={}){
    if(this.modeForCandidate(candidateId)==='jev'&&!this.prepare(candidateId).ready)return {content:[{type:'text',text:JSON.stringify(browserWaitResult())}]};
    const {client,tools,directory,workspace}=await this.connect(candidateId);
    if(this.isActive&&!this.isActive())throw Error('Worker oturumu kapandı.');
    if(name==='browser_target_press')return pressBrowserTarget(client,client instanceof JevBrowser,args,sessionId);
    if(!tools.some(t=>t.name===name))throw Error('Unknown browser tool');
    let result;try{result=await (client instanceof JevBrowser?client.callTool({name,arguments:args},sessionId,{...this.options(candidateId).lifecycle,...(automationTabKey?{automationTabKey}:{}),...(automationWorkspaceId?{automationWorkspaceId:candidateId}:{}),...(automationSourceUrl?{automationSourceUrl,automationSourceUrls}:{}),...(automationPreferredTabId?{automationPreferredTabId}:{})}):client.callTool({name,arguments:args}));}catch(error){if(client instanceof JevBrowser&&(!client.browser&&client.connection==='existing'||error.code==='BROWSER_DISCONNECTED')){this.connections.disconnected(candidateId);return {content:[{type:'text',text:JSON.stringify(browserWaitResult())}]};}throw error;}
    // Newer Playwright versions return snapshot files. Inline only this candidate's
    // bounded browser artifacts, so the agent can act without filesystem access.
    for(const part of [...(result.content??[])]){
      if(part.type!=='text')continue;
      for(const match of part.text.matchAll(/\[Snapshot\]\(([^)]+\.yml)\)/g)){
        try{
          const file=await realpath(path.resolve(workspace,match[1]));
          const artifacts=await realpath(path.join(directory,'artifacts'));
          if(!file.startsWith(artifacts+path.sep)||(await stat(file)).size>512000)continue;
          const snapshot=await readFile(file,'utf8');
          // The automation workflow pages the complete snapshot itself. Keep
          // the existing limit for callers without that reader.
          result.content.push({type:'text',text:completeSnapshot?snapshot:snapshot.slice(0,100000)});
        }catch{/* Keep the original artifact reference if it was removed. */}
      }
    }
    return result;
  }
  cleanupSearch(candidateId,taskId){return this.enqueue(candidateId,()=>this.performCleanupSearch(candidateId,taskId),{checkActive:false});}
  async performCleanupSearch(candidateId,taskId){
    if(this.modeForCandidate(candidateId)!=='jev')return {deferred:true};
    const connection=this.clients.get(candidateId);
    if(connection?.mode!=='jev')return {deferred:true};
    const options=this.options(candidateId),{client}=await connection.pending;
    if(client.profile?.directory!==options.profile?.directory)return {deferred:true};
    return client.cleanupSearch(taskId,options.lifecycle??{});
  }
  cleanup(candidateId){return this.enqueue(candidateId,()=>this.performCleanup(candidateId),{checkActive:false});}
  async performCleanup(candidateId){
    const connection=this.clients.get(candidateId),options=this.options(candidateId);
    if(connection?.mode!=='jev'||this.modeForCandidate(candidateId)!=='jev')return {deferred:true};
    const {client}=await connection.pending;
    if(client.profile?.directory!==options.profile?.directory)return {deferred:true};
    return client.cleanupCompleted(options.lifecycle??{});
  }
  maintain(candidateId){
    const connection=this.clients.get(candidateId),client=connection?.client;
    // Maintenance never starts Chrome, requests permission or queues behind a
    // running agent operation. The next tick retries disconnected/busy clients.
    if(this.closed||this.modeForCandidate(candidateId)!=='jev'||connection?.mode!=='jev'||!client||client.closed||client.busy||!client.opening||client.connection==='existing'&&!client.browser?.isConnected()||this.operations.has(candidateId))return Promise.resolve({deferred:true});
    return this.enqueue(candidateId,async()=>{
      if(this.clients.get(candidateId)!==connection)return {deferred:true};
      const options=this.options(candidateId);
      if(client.profile?.directory!==options.profile?.directory)return {deferred:true};
      return client.cleanupCompleted(options.lifecycle??{});
    });
  }
  async focus(candidateId,context){
    if(this.modeForCandidate(candidateId)!=='jev')throw Object.assign(Error('Bu aday için Jev tarayıcı modu seçili değil.'),{code:'BROWSER_MODE_CHANGED'});
    return (await this.connect(candidateId)).client.focus(context.tabId);
  }
  async workspaceTabs(id){
    if(this.modeForCandidate(id)!=='jev')return [];
    // Reading the Sources page must not connect to Chrome or show a permission prompt.
    const connection=this.clients.get(id);
    if(connection?.mode!=='jev')return [];
    const connected=await connection.pending.catch(()=>null),client=connected?.client,options=this.options(id);
    if(!client||client.closed||this.clients.get(id)!==connection||client.profile?.directory!==options.profile?.directory||client.connection==='existing'&&!client.browser?.isConnected())return [];
    const jobs=Array.isArray(options.lifecycle?.jobs),checkpoints=new Set((options.checkpoints??[]).filter(c=>c?.browser==='Jev Chrome').map(c=>c.tabId));
    const webTab=slot=>{
      const owner=client.automationWorkspaces.get(slot.id);
      if(owner)return owner===id;
      // Tabs created before workspace labels were added remain in this browser's
      // exact owned-target set. Never infer ownership from URL or profile alone.
      return !client.tabJobs.has(slot.id)&&!client.tabSearches.has(slot.id)&&(client.connection==='existing'?client.transport?.owned.has(slot.id):true);
    };
    return [...client.tabs.values()].filter(slot=>slot.id!==client.homeId&&!slot.page.isClosed()&&(jobs?(client.tabJobs.has(slot.id)||client.tabSearches.has(slot.id)||checkpoints.has(slot.id)):webTab(slot))).map(slot=>({tabId:slot.id,url:slot.page.url(),browser:'Jev Chrome',kind:client.tabJobs.has(slot.id)?'application':client.tabSearches.has(slot.id)?'search':'workspace',...(client.tabJobs.has(slot.id)?{jobId:client.tabJobs.get(slot.id)}:{}),...(client.tabSearches.has(slot.id)?{searchTaskId:client.tabSearches.get(slot.id)}:{}),...(client.automationSources.has(slot.id)?{sourceUrl:client.automationSources.get(slot.id)}:{})}));
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
  async sourceTabs(candidateId,sources,task){
    const mode=this.modeForCandidate(candidateId),result={};
    if(mode!=='jev')return Object.fromEntries(sources.filter(s=>s.resumeContext&&s.resumeContext.browser!=='Jev Chrome').map(s=>[s.id,s.resumeContext]));
    // UI reads must never start a connection or create a Chrome permission prompt.
    const connection=this.clients.get(candidateId);
    if(connection?.mode!=='jev')return result;
    const connected=await connection.pending.catch(()=>null),client=connected?.client;
    if(!client||client.closed||this.modeForCandidate(candidateId)!==mode||this.clients.get(candidateId)!==connection||client.profile?.directory!==this.options(candidateId).profile?.directory||client.connection==='existing'&&!client.browser?.isConnected())return result;
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
    if(!context||this.modeForCandidate(candidateId)!=='jev'||this.clients.get(candidateId)!==connection)throw Object.assign(Error('Bu kaynağın açık arama sekmesi bulunamadı.'),{code:'TAB_MISSING'});
    const connected=await connection?.pending;
    if(!connected||connected.client.closed)throw Object.assign(Error('Chrome bağlantısı kapandı.'),{code:'TAB_MISSING'});
    // Focus the live page directly; never reconnect or open a replacement here.
    await connected.client.tab(context.tabId).page.bringToFront();return {focused:true};
  }
  async close(){this.closed=true;this.connections.close();for(const {pending} of this.clients.values()){try{await(await pending).client.close();}catch{}}this.clients.clear();}
}
