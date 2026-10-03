import {batchScoring} from './record-task-scope.mjs';
import {workspaceDirectory} from './workspace-paths.mjs';
import {withAgentDefaults} from './agent-settings.mjs';
import path from 'node:path';
import {readFile,rm,writeFile,stat} from 'node:fs/promises';
import {WebTasks} from './web-template.mjs';
import {reusableTemplate,webUrl} from './automation-templates.mjs';
import {sourceInput} from './automation-sources.mjs';
import {loadSourceLibrary,importSourceLibrary,catalogSources} from './source-library.mjs';
import {launchAutomationWorker} from './automation-worker.mjs';
import {automationBrowser} from './automation-browser.mjs';
import {webWorkspaceView} from './workspace-view.mjs';
import {isConversation} from './workspace-conversation.mjs';
import {setupAgentSettings} from './setup-agent.mjs';
import {listDocuments} from './artifacts.mjs';
import {runSnapshot} from './automation-snapshot.mjs';

export function registerAutomationServices({root,data,handle,emit,validateSettings,dialog,shell,window,db,browsers,agents,mcp,notify=()=>{},launch=launchAutomationWorker}){
 const outputs=new Map();
 browsers.siteAccess=db.siteAccess;
 browsers.workspaceFor=id=>workspaceDirectory(data,db.store.workspaces.get(id));
 db.siteAccess.changed=()=>{for(const a of db.list())emit('automation-changed',{automationId:a.id});};
 const changed=id=>emit('automation-changed',{automationId:id});
 const runtime=new WebTasks(db,{changed,probeSource:(id,task)=>browsers.probeAutomationSource(id,task),onRunFinished:(id,run,options)=>browsers.finishAutomationRun(id,run,options),browserReady:id=>{if(browsers.status(id).ready)return true;const a=db.get(id);if(a.status==='enabled'||db.store.workspaces.tasks.list(id,{states:['pending']}).some(t=>t.request?.manual))browsers.prepare(id);return browsers.status(id).ready;},launch:(run,automation,onEvent,signal)=>launch({data,db,run,automation,onEvent,signal,agents,mcp,
  browser:automationBrowser(browsers.forWorker(run.workerId??'main',()=>!signal.aborted&&db.run(run.id).status==='running',{signal,captchaMaySubmit:()=>{const current=db.run(run.id);if(current.recordOperation!=='execute'||!current.recordId||current.actionId!==current.recordId)return false;const item=db.result(run.automationId,current.recordId);return item.status==='executing'&&item.attemptRunId===run.id;}}),{isolatedResearch:isConversation(run)||batchScoring(run),resumeContext:batchScoring(run)?undefined:run.continuation?.browserContext??run.resumeContext,resumeSource:['site_access_response','site_access_retry'].includes(run.continuation?.reason),recordId:run.recordOperation&&!batchScoring(run)?run.recordId:undefined,sourceUrl:run.recordOperation?undefined:run.sourceUrl,sourceUrls:automation.sources,readTabKey:batchScoring(run)?`score-batch:${run.taskId}`:run.recordOperation?`record:${run.recordId}`:run.sourceUrl&&!run.recordId?`source:${run.sourceUrl}`:run.kind!=='run'?`read:${run.sourceUrl??run.workerId??'main'}`:undefined}),
  report:(id,runId,status,summary,goalReached)=>{const result=runtime.report(id,runId,status,summary,goalReached);if(run.kind!=='interview')notify(automation.title,db.run(runId).summary);return result;},changed,
  onOutput:bytes=>{outputs.set(run.id,Buffer.concat([outputs.get(run.id)??Buffer.alloc(0),Buffer.from(bytes)]).subarray(-150000));while(outputs.size>30)outputs.delete(outputs.keys().next().value);emit('automation-output',{automationId:run.automationId,runId:run.id,bytes});}
 })});
 const workspace=id=>{db.get(id);return workspaceDirectory(data,db.store.workspaces.get(id));};
 handle('automation-templates',()=>db.catalog());
 handle('automation-template-save',(id,input)=>{const a=db.get(id),base=db.template(a.templateId),template=db.saveTemplate({...base,title:input.title,description:input.description,guidance:input.guidance,table:a.table});changed(null);return template;});
 handle('automation-template-export',async id=>{const t=db.template(id);const template=reusableTemplate(t,value=>db.store.workspaces.registry.normalize(value)),result=await dialog.showSaveDialog(window(),{defaultPath:t.title.replace(/[^\p{L}\p{N} _-]/gu,'')+'.loop-template.json',filters:[{name:'Loop template',extensions:['json']}]});if(result.canceled)return;await writeFile(result.filePath,JSON.stringify({format:'loop-template',version:2,template},null,2)+'\n',{mode:0o600});return result.filePath;});
 handle('automation-template-import',async()=>{const picked=await dialog.showOpenDialog(window(),{properties:['openFile'],filters:[{name:'Loop template',extensions:['json']}]});if(picked.canceled)return null;const file=picked.filePaths[0];if((await stat(file)).size>2*1024*1024)throw Error('Template dosyası çok büyük');const input=JSON.parse(await readFile(file,'utf8'));if(input.format!=='loop-template'||![1,2].includes(input.version))throw Error('Desteklenmeyen template dosyası');const template=db.saveTemplate(input.template);changed(null);return template;});
 const snapshot=async id=>{const activeRuns=runtime.slots(id).map(s=>runSnapshot(s.run));return webWorkspaceView({...db.snapshot(id),setupAgent:{settings:setupAgentSettings(db,id)},activeRun:activeRuns[0]??null,activeRuns,documents:await listDocuments(workspace(id)),browserStatus:browsers.status(id)},agents);};
 const save=async(id,input)=>{
  if(input.agentSettings){input={...input,agentSettings:withAgentDefaults(input.agentSettings)};await validateSettings(input.agentSettings);}
  const before=db.get(id),browserChanged=input.chromeProfile!==undefined&&JSON.stringify(input.chromeProfile)!==JSON.stringify(before.chromeProfile);
  if(browserChanged)await runtime.pause(id);
  else if(!(Object.keys(input).length===1&&input.agentSettings))db.assertIdle(id,{allowWaitingConversation:true});
  const a=db.save(id,input);if(browserChanged)await browsers.resetCandidate(id);changed(id);return a;
 };
 handle('automation-save',save);
 handle('automation-profile-save',(id,input,options)=>runtime.saveProfile(id,input,options));
 handle('workspace-answer',(id,question,value)=>runtime.answer(id,question,value));
 handle('automation-setup',id=>runtime.setup(id));
 handle('setup-agent-settings',async(id,input)=>{const settings={...withAgentDefaults(input),contextRestartTokens:0};await validateSettings(settings);return runtime.configureConversation(id,settings);});
 handle('setup-agent-restart',id=>runtime.configureConversation(id,null,{restart:true}));
 handle('automation-source-save',(id,url,input)=>runtime.saveSource(id,url,input));
 handle('automation-source-library',url=>loadSourceLibrary(url));
 handle('automation-source-library-file',async()=>{
  const picked=await dialog.showOpenDialog(window(),{properties:['openFile'],filters:[{name:'Kaynak listesi',extensions:['json']}]});if(picked.canceled)return null;
  const file=picked.filePaths[0];if((await stat(file)).size>1024*1024)throw Error('Kaynak listesi 1 MB sınırını aşıyor');
  return catalogSources(JSON.parse(await readFile(file,'utf8')));
 });
 handle('automation-source-export',async id=>{
  const sources=db.sources(id).map(({url,name,instructions,skill,recipe,intervalMinutes,enabled})=>({url,name,instructions,skill,...(recipe?{recipe}:{}),intervalMinutes,enabled}));
  const picked=await dialog.showSaveDialog(window(),{defaultPath:'sources.json',filters:[{name:'Kaynak listesi',extensions:['json']}]});if(picked.canceled)return null;
  await writeFile(picked.filePath,JSON.stringify(catalogSources(sources),null,2)+'\n',{mode:0o600});return picked.filePath;
 });
 handle('automation-source-import',async(id,sources)=>{const result=importSourceLibrary(db,id,sources);changed(id);await runtime.tick();return result;});
 handle('automation-sources-interval',(id,intervalMinutes)=>runtime.saveSourcesInterval(id,intervalMinutes));
 handle('automation-source-modes',(id,mode)=>{db.assertIdle(id);const a=db.get(id);for(const url of a.sources)sourceInput(a,url,{mode});db.store.workspaces.tasks.atomic(()=>{for(const url of a.sources)db.saveSource(id,url,{mode});});changed(id);});
 handle('automation-source-run',(id,url)=>runtime.runSource(id,url));
 handle('automation-source-relearn',(id,url)=>runtime.relearnSource(id,url));
 handle('automation-source-resume',(id,url,runId,response)=>runtime.sourceAccess.resume(id,url,runId,response));
 handle('automation-source-stop',(id,url)=>runtime.stopSource(id,url));
 handle('automation-retry-later',(id,key,cancel)=>runtime.retryLater(id,key,cancel===true));
 handle('automation-attention-dismiss',(id,key,dismissKey)=>runtime.dismissAttention(id,key,dismissKey));
 handle('automation-source-add',async(id,input)=>{db.addSource(id,input);changed(id);await runtime.tick();return db.sources(id).find(source=>source.url===webUrl(input.url));});
 handle('automation-source-remove',async(id,url)=>{db.removeSource(id,url);changed(id);await runtime.tick();});
 handle('automation-source-draft',async(id,draftId,accept)=>{if(typeof accept!=='boolean')throw Error('Geçersiz kaynak işlemi');db.resolveSourceDraft(id,draftId,accept);changed(id);await runtime.tick();});
 handle('automation-review',id=>{const a=db.review(id);changed(id);return a;});
 handle('automation-skip-trial',id=>{if(runtime.slots(id).length)throw Error('Önce çalışan otomasyonu durdur');const a=db.skipTrial(id);changed(id);return a;});
 handle('automation-message',(id,text)=>runtime.message(id,text));
 handle('automation-run',async(id,kind)=>{if(!['trial','run'].includes(kind))throw Error('Geçersiz çalışma');return runtime.runOnce(id);});
 handle('automation-records-score',(id,itemIds)=>runtime.runRecords(id,itemIds));
 handle('automation-record-run',(id,itemId,kind,input)=>runtime.runRecord(id,itemId,kind,input));
 handle('automation-approve',(id,itemId)=>{const item=db.approve(id,itemId);changed(id);return item;});
 handle('automation-dismiss',(id,itemId)=>runtime.dismissRecord(id,itemId));
 handle('automation-star',(id,itemId,starred)=>{const item=db.star(id,itemId,starred);changed(id);return item;});
 const remove=async id=>{const files=workspace(id);await runtime.pause(id);await browsers.resetCandidate(id);const runs=db.db.prepare('SELECT id FROM automation_runs WHERE automation_id=?').all(id);db.remove(id);for(const run of runs){outputs.delete(run.id);await rm(path.join(data,'automations','runs',run.id),{recursive:true,force:true});}await rm(files,{recursive:true,force:true});for(const directory of ['workspaces','browsers','candidates'])await rm(path.join(data,'automations',directory,id),{recursive:true,force:true});changed(id);};
 handle('automation-browser',async id=>{
  const a=db.get(id);browsers.prepare(id,{force:true});await browsers.connections.pending.get(id);const status=browsers.status(id);changed(id);if(!status.ready)throw Error(status.message||'Chrome bağlantısı bekleniyor');if(runtime.slots(id).length>0)return status;
  db.assertIdle(id);if(!a.sources.length)throw Error('Önce en az bir kaynak adresi kaydet');return automationBrowser(browsers).call(id,'browser_navigate',{url:a.sources[0]},'user');
 });
 handle('automation-terminal',async(id,runId)=>{if(db.run(runId).automationId!==id)throw Error('Çalışma bu otomasyona ait değil');return [...(outputs.get(runId)??await readFile(path.join(data,'automations','runs',runId,'terminal.log')).catch(()=>Buffer.alloc(0)))];});
 handle('automation-export-results',async id=>{const a=db.get(id),result=await dialog.showSaveDialog(window(),{defaultPath:a.title.replace(/[^\p{L}\p{N} _-]/gu,'')+'.json',filters:[{name:'Sonuçlar',extensions:['json']}]});if(result.canceled)return;await writeFile(result.filePath,JSON.stringify({title:a.title,templateId:a.templateId,table:a.table,exportedAt:new Date().toISOString(),results:db.results(id,{all:true})},null,2)+'\n',{mode:0o600});return result.filePath;});
 return {db,runtime,browsers,outputs,save,snapshot,remove,workspace,async close(){await runtime.close();},clearOutputs(){outputs.clear();}};
}
