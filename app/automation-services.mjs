import {workspaceSourceInstructions,sourceIntegrations,runSourceTool} from './source-integrations.mjs';
import {workspaceDirectory} from './workspace-paths.mjs';
import {withAgentDefaults} from './agent-settings.mjs';
import path from 'node:path';
import {readFile,rm,writeFile,stat} from 'node:fs/promises';
import {WebTasks} from './web-template.mjs';
import {reusableTemplate,webUrl} from './automation-templates.mjs';
import {sourceInput} from './automation-sources.mjs';
import {launchAutomationWorker} from './automation-worker.mjs';
import {automationBrowser} from './automation-browser.mjs';
import {webWorkspaceView} from './workspace-view.mjs';
import {listDocuments} from './artifacts.mjs';

export function registerAutomationServices({root,data,handle,emit,validateSettings,dialog,shell,window,db,browsers,agents,mcp,notify=()=>{},launch=launchAutomationWorker}){
 const outputs=new Map();
 browsers.siteAccess=db.siteAccess;
 browsers.workspaceFor=id=>workspaceDirectory(data,db.store.workspaces.get(id));
 db.siteAccess.changed=()=>{for(const a of db.list())emit('automation-changed',{automationId:a.id});};
 const changed=id=>emit('automation-changed',{automationId:id});
 const runtime=new WebTasks(db,{changed,probeSource:(id,task)=>browsers.probeAutomationSource(id,task),onRunFinished:(id,run,options)=>browsers.finishAutomationRun(id,run,options),browserReady:id=>{if(browsers.status(id).ready)return true;const a=db.get(id);if(a.status==='enabled'||db.store.workspaces.tasks.list(id,{states:['pending']}).some(t=>t.request?.manual))browsers.prepare(id);return browsers.status(id).ready;},launch:(run,automation,onEvent,signal)=>launch({root,data,db,run,automation,onEvent,signal,agents,mcp,
  browser:automationBrowser(browsers.forWorker(run.workerId??'main',()=>!signal.aborted&&db.run(run.id).status==='running'),{mode:automation.browserMode,resumeContext:run.continuation?.browserContext??run.resumeContext,recordId:run.recordOperation?run.recordId:undefined,sourceUrl:run.recordOperation?undefined:run.sourceUrl,sourceUrls:automation.sources,readTabKey:run.recordOperation?`record:${run.recordId}`:run.sourceUrl&&!run.recordId?`source:${run.sourceUrl}`:run.kind!=='run'?`read:${run.sourceUrl??run.workerId??'main'}`:undefined}),
  report:(id,runId,status,summary,goalReached)=>{const result=runtime.report(id,runId,status,summary,goalReached);if(run.kind!=='interview')notify(automation.title,db.run(runId).summary);return result;},changed,
  onOutput:bytes=>{outputs.set(run.id,Buffer.concat([outputs.get(run.id)??Buffer.alloc(0),Buffer.from(bytes)]).subarray(-150000));while(outputs.size>30)outputs.delete(outputs.keys().next().value);emit('automation-output',{automationId:run.automationId,runId:run.id,bytes});}
 })});
 const workspace=id=>{db.get(id);return workspaceDirectory(data,db.store.workspaces.get(id));};
 handle('automation-templates',()=>db.catalog());
 handle('automation-template-save',(id,input)=>{const a=db.get(id),base=db.template(a.templateId),template=db.saveTemplate({...base,title:input.title,description:input.description,guidance:input.guidance,table:a.table});changed(null);return template;});
 handle('automation-template-export',async id=>{const t=db.template(id);const template=reusableTemplate(t,value=>db.store.workspaces.registry.normalize(value)),result=await dialog.showSaveDialog(window(),{defaultPath:t.title.replace(/[^\p{L}\p{N} _-]/gu,'')+'.loop-template.json',filters:[{name:'Loop template',extensions:['json']}]});if(result.canceled)return;await writeFile(result.filePath,JSON.stringify({format:'loop-template',version:2,template},null,2)+'\n',{mode:0o600});return result.filePath;});
 handle('automation-template-import',async()=>{const picked=await dialog.showOpenDialog(window(),{properties:['openFile'],filters:[{name:'Loop template',extensions:['json']}]});if(picked.canceled)return null;const file=picked.filePaths[0];if((await stat(file)).size>100000)throw Error('Template dosyası çok büyük');const input=JSON.parse(await readFile(file,'utf8'));if(input.format!=='loop-template'||![1,2].includes(input.version))throw Error('Desteklenmeyen template dosyası');const template=db.saveTemplate(input.template);changed(null);return template;});
 const snapshot=async id=>{const activeRuns=runtime.slots(id).map(s=>s.run);return webWorkspaceView({...db.snapshot(id),activeRun:activeRuns[0]??null,activeRuns,documents:await listDocuments(workspace(id)),browserStatus:browsers.status(id)},agents);};
 const save=async(id,input)=>{
  if(input.agentSettings){input={...input,agentSettings:withAgentDefaults(input.agentSettings)};await validateSettings(input.agentSettings);}
  const before=db.get(id),browserChanged=input.browserMode!==undefined&&input.browserMode!==before.browserMode||input.chromeProfile!==undefined&&JSON.stringify(input.chromeProfile)!==JSON.stringify(before.chromeProfile);
  if(browserChanged){if(!['separate','jev'].includes(input.browserMode??before.browserMode))throw Error('Geçersiz tarayıcı seçimi');await runtime.pause(id);}
  else if(!(Object.keys(input).length===1&&input.agentSettings))db.assertIdle(id);
  const a=db.save(id,input);if(browserChanged)await browsers.resetCandidate(id);changed(id);return a;
 };
 handle('automation-save',save);
 handle('workspace-answer',(id,question,value)=>runtime.answer(id,question,value));
 handle('automation-setup',id=>runtime.setup(id));
 handle('workspace-source-integrations',()=>sourceIntegrations);
 handle('workspace-source-instructions',async(id,url)=>{const source=db.sources(id).find(s=>s.url===url);if(!source)throw Error('Kaynak bulunamadı');return workspaceSourceInstructions(root,source);});
 handle('workspace-source-test',async(id,url)=>{const source=db.sources(id).find(s=>s.url===url);if(!source)throw Error('Kaynak bulunamadı');return runSourceTool(root,source,['search','--help'],{test:true});});
 handle('automation-source-save',(id,url,input)=>runtime.saveSource(id,url,input));
 handle('automation-sources-interval',(id,intervalMinutes)=>runtime.saveSourcesInterval(id,intervalMinutes));
 handle('automation-source-modes',(id,mode)=>{db.assertIdle(id);const a=db.get(id);for(const url of a.sources)sourceInput(a,url,{mode});db.store.workspaces.tasks.atomic(()=>{for(const url of a.sources)db.saveSource(id,url,{mode});});changed(id);});
 handle('automation-source-run',(id,url)=>runtime.runSource(id,url));
 handle('automation-source-stop',(id,url)=>runtime.stopSource(id,url));
 handle('automation-retry-later',(id,key,cancel)=>runtime.retryLater(id,key,cancel===true));
 handle('automation-source-add',(id,input)=>{
  const a=db.get(id),url=webUrl(input.url);if(a.sources.includes(url))throw Error('Bu kaynak zaten kayıtlı');
  sourceInput({...a,sources:[...a.sources,url]},url,input);
  db.store.workspaces.tasks.atomic(()=>{db.save(id,{sources:[...a.sources,url]});db.saveSource(id,url,input);});changed(id);return db.sources(id).find(s=>s.url===url);
 });
 handle('automation-source-remove',(id,url)=>{const a=db.get(id);if(!a.sources.includes(url))throw Error('Kaynak bu çalışma alanına ait değil');db.save(id,{sources:a.sources.filter(s=>s!==url)});changed(id);});
 handle('automation-review',id=>{const a=db.review(id);changed(id);return a;});
 handle('automation-skip-trial',id=>{if(runtime.slots(id).length)throw Error('Önce çalışan otomasyonu durdur');const a=db.skipTrial(id);changed(id);return a;});
 handle('automation-message',(id,text)=>runtime.message(id,text));
 handle('automation-run',async(id,kind)=>{if(!['trial','run'].includes(kind))throw Error('Geçersiz çalışma');return kind==='run'?runtime.runOnce(id):runtime.start(id,kind);});
 handle('automation-record-run',(id,itemId,kind,input)=>runtime.runRecord(id,itemId,kind,input));
 handle('automation-approve',(id,itemId)=>{const item=db.approve(id,itemId);changed(id);return item;});
 handle('automation-dismiss',(id,itemId)=>runtime.dismissRecord(id,itemId));
 handle('automation-star',(id,itemId,starred)=>{const item=db.star(id,itemId,starred);changed(id);return item;});
 const remove=async id=>{const files=workspace(id);await runtime.pause(id);await browsers.resetCandidate(id);const runs=db.db.prepare('SELECT id FROM automation_runs WHERE automation_id=?').all(id);db.remove(id);for(const run of runs){outputs.delete(run.id);await rm(path.join(data,'automations','runs',run.id),{recursive:true,force:true});}await rm(files,{recursive:true,force:true});for(const directory of ['workspaces','browsers','candidates'])await rm(path.join(data,'automations',directory,id),{recursive:true,force:true});changed(id);};
 handle('automation-browser',async id=>{
  const a=db.get(id);if(a.browserMode==='jev'){browsers.prepare(id,{force:true});await browsers.connections.pending.get(id);const status=browsers.status(id);changed(id);if(!status.ready)throw Error(status.message||'Chrome bağlantısı bekleniyor');if(runtime.slots(id).length>0)return status;}
  db.assertIdle(id);if(!a.sources.length)throw Error('Önce en az bir kaynak adresi kaydet');return automationBrowser(browsers,{mode:a.browserMode}).call(id,'browser_navigate',{url:a.sources[0]},'user');
 });
 handle('automation-terminal',async(id,runId)=>{if(db.run(runId).automationId!==id)throw Error('Çalışma bu otomasyona ait değil');return [...(outputs.get(runId)??await readFile(path.join(data,'automations','runs',runId,'terminal.log')).catch(()=>Buffer.alloc(0)))];});
 handle('automation-export-results',async id=>{const a=db.get(id),result=await dialog.showSaveDialog(window(),{defaultPath:a.title.replace(/[^\p{L}\p{N} _-]/gu,'')+'.json',filters:[{name:'Sonuçlar',extensions:['json']}]});if(result.canceled)return;await writeFile(result.filePath,JSON.stringify({title:a.title,templateId:a.templateId,table:a.table,exportedAt:new Date().toISOString(),results:db.results(id,{all:true})},null,2)+'\n',{mode:0o600});return result.filePath;});
 return {db,runtime,browsers,outputs,save,snapshot,remove,workspace,async close(){await runtime.close();},clearOutputs(){outputs.clear();}};
}
