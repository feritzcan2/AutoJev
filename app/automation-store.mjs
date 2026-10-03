import {automaticAssessmentError} from '../src/scoring-state.js';
import {taskRecordIds,taskHasRecord,batchScoring,recordScoredInTask} from './record-task-scope.mjs';
import {profilePlan,profileChanged,splitPlanDraft} from './profile-updates.mjs';
import {taskSnapshot} from './automation-snapshot.mjs';
import {JevTaskStore} from './jev-task-store.mjs';
import {BrowserEvidenceStore} from './browser-evidence-store.mjs';
import {CONVERSATION_WORKER,isConversation,conversationWaiting} from './workspace-conversation.mjs';
import {setupAgentOnboarding} from './setup-agent.mjs';
import {validateNotSubmitted} from './record-outcome.mjs';
import {scanWork,activeSearch,withScanWork,scanQueue,scanWorkSummary,reportWorkPage,updateScanQueue,completeScanSearch,validateWorkCompletion,scanPlanView,scanProgressView} from './scan-work.mjs';
import {answerContinuation} from './automation-continuation.mjs';
import {validateRecordTask,recordOperationState,pendingRecordQuestion,recordSource} from './record-operations.mjs';
import {recordAssessment,assessmentCells} from './record-scoring.mjs';
import {SiteAccess,sameSite} from './site-access.mjs';
import {automationTrialReady,migrateSourceTrials} from './automation-trial.mjs';
import {normalizeFields,validateAnswers,OUTCOME_FIELD} from './question-forms.mjs';
import {removeImportedWorkspace} from './workspace-upgrade.mjs';
import {withAgentDefaults} from './agent-settings.mjs';
import {recipeValues,recipeReplay,replayUrls,replayMatches,recipeRunOutcome,advanceRecipeState,recipeStatus} from './source-recipe.mjs';
import {findOperation,operationFor} from './template-contract.mjs';
import {domainData} from './workspace-store.mjs';
import {contextCompactTokens} from './context-compaction.mjs';
import {contextRestartTokens} from './context-usage.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {reusableTemplate,planInput,normalizeSourceUrls,missingPlanFields,missingProfileFields,defaultAutomationSettings,boundedText,webUrl} from './automation-templates.mjs';
import {automationTable,automationCells,defaultAutomationTable} from './automation-templates.mjs';
import {automationSources,sourceInput,sourceMode} from './automation-sources.mjs';
import {beginSourceScan,sourceScanScope,advanceSourceScan,completeSourceScan} from './source-scan.mjs';

const json=row=>row?JSON.parse(row.data):null;
const integer=(value,label,min,max)=>{if(!Number.isInteger(value)||value<min||value>max)throw Error(`${label}: ${min}–${max} arasında tam sayı gerekli`);return value;};
const planKey=value=>JSON.stringify([value.title,value.goal,value.criteria,value.sources,value.instructions,value.facts]);
function agentSettings(input){
 if(!['codex','claude','opencode'].includes(input?.provider))throw Error('Desteklenmeyen sağlayıcı');
 input=withAgentDefaults(input);
 for(const key of ['model','permission','reasoning'])boundedText(input[key],key,120);
 if(![true,false,null].includes(input.network))throw Error('Geçersiz ağ ayarı');
 const trialModel=input.trialModel?boundedText(input.trialModel,'trialModel',120):null;
 return {provider:input.provider,model:input.model,permission:input.permission,reasoning:input.reasoning,network:input.provider==='codex'?input.network:null,...(trialModel?{trialModel}:{}),contextCompactTokens:contextCompactTokens(input.contextCompactTokens),...(input.contextRestartTokens===undefined?{}:{contextRestartTokens:contextRestartTokens(input.contextRestartTokens)})};
}
export class AutomationStore {
 constructor(store,{now=()=>Date.now()}={}){
  this.store=store;this.db=store.db;this.now=now;this.siteAccess=new SiteAccess(this.db,{now});
  this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_events(seq INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS automation_templates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automation_runs(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automation_messages(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS automation_runs_owner ON automation_runs(automation_id);
   CREATE INDEX IF NOT EXISTS automation_runs_record ON automation_runs(automation_id,json_extract(data,'$.recordId'));
   CREATE INDEX IF NOT EXISTS automation_messages_owner ON automation_messages(automation_id);`);
  this.jevTasks=new JevTaskStore(this.db,now);
  this.browserEvidence=new BrowserEvidenceStore(now);
  migrateSourceTrials(this);
 }
 has(id){return Boolean(this.db.prepare('SELECT 1 FROM automations WHERE id=?').get(id));}
 conversation(id,provider){return this.store.workspaces.history(id).conversation(id,provider);}
 conversationSettings(id,provider,nativeId){return this.store.workspaces.history(id).conversationSettings(id,provider,nativeId);}
 saveConversation(id,provider,nativeId,settings){return this.store.workspaces.history(id).saveConversation(id,provider,nativeId,settings);}
 forgetConversation(id,provider,nativeId){return this.store.workspaces.history(id).forgetConversation(id,provider,nativeId);}
 get(id){const a=json(this.db.prepare('SELECT data FROM automations WHERE id=?').get(id));if(!a)throw Error('Otomasyon bulunamadı');delete a.maxActionsTotal;delete a.maxActionsPerDay;delete a.endAt;delete a.timeoutMinutes;delete a.maxBrowserSteps;if(a.questions)a.questions=a.questions.map(q=>this.questionScope(id,q));return splitPlanDraft({...a,...this.store.workspaces.fields(id),table:this.store.workspaces.table(id)});}
 catalog(){return [...this.store.workspaces.registry.catalog(),...this.db.prepare('SELECT data FROM automation_templates ORDER BY rowid DESC').all().map(json).filter(input=>this.store.workspaces.registry.supports(input)).map(input=>this.store.workspaces.registry.normalize(input))];}
 template(id){return this.store.workspaces.template(id);}
 saveTemplate(input){const template={...reusableTemplate(input,value=>this.store.workspaces.registry.normalize(value)),id:'template-'+randomUUID(),personal:true};this.db.prepare('INSERT INTO automation_templates VALUES(?,?)').run(template.id,JSON.stringify(template));return template;}
 list(){return this.db.prepare('SELECT id FROM automations ORDER BY rowid DESC').all().map(row=>this.get(row.id));}
 put(a){a={...a};delete a.maxActionsTotal;delete a.maxActionsPerDay;delete a.endAt;this.db.exec('SAVEPOINT save_workspace_plan');try{this.store.workspaces.save(a.id,a.templateId,a);this.db.prepare('INSERT INTO automations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(a.id,JSON.stringify(domainData(a)));this.db.exec('RELEASE save_workspace_plan');return this.get(a.id);}catch(error){this.db.exec('ROLLBACK TO save_workspace_plan; RELEASE save_workspace_plan');throw error;}}
 create(templateId,input={}){
  const template=this.template(templateId);if(template.kind!=='web')throw Error('İş arama için aday kurulumunu kullan');
  const defaults=template.defaultSources??[],plan=planInput(template,{...input,sources:input.sources??defaults.map(source=>source.url)});
  const sourceSettings=Object.fromEntries(defaults.filter(source=>plan.sources.includes(source.url)).map(({url,...settings})=>[url,settings]));
  const a={id:randomUUID(),templateId,templateVersion:template.version,...plan,sourceSettings,mode:template.defaultMode,chromeProfile:null,intervalMinutes:30,agentSettings:agentSettings(input.agentSettings??defaultAutomationSettings),revision:1,reviewedRevision:null,trial:null,sourceTrialsVersion:1,status:'draft',nextRunAt:null,createdAt:this.now(),updatedAt:this.now()};
  a.table=template.table?automationTable(template.table):defaultAutomationTable(templateId);this.put(a);this.message(a.id,'assistant',`Ne yapmak istediğini anlat. ${template.fields[0].question}`,{conversation:true});return a;
 }
 assertIdle(id,{allowConversation=false,allowWaitingConversation=false}={}){if(this.runs(id).some(run=>run.status==='running'&&!(allowConversation&&isConversation(run))&&!(allowWaitingConversation&&conversationWaiting(run))))throw Error('Önce çalışan otomasyonu durdur');}
 save(id,input,{agent=false,allowConversation=false}={}){
  const previous=this.get(id),template=this.template(previous.templateId),plan=planInput(template,input,previous);
  // Provider settings apply on the next launch, like the original Agent page.
  // All plan and authority changes still require an idle workspace.
  if(!agent&&!(Object.keys(input).length===1&&input.agentSettings))this.assertIdle(id,{allowWaitingConversation:true,allowConversation});
  const changed=planKey(previous)!==planKey({...previous,...plan}),a={...previous,...plan,updatedAt:this.now()};
  if(agent){if(previous.status==='enabled')throw Error('Etkin otomasyon kurulum sırasında değiştirilemez');}
  else{
   const mode=input.mode??previous.mode;if(!['observe','prepare','auto'].includes(mode))throw Error('Geçersiz işlem yetkisi');a.mode=mode;
   for(const [key,label,min,max]of [['intervalMinutes','Tarama aralığı',1,10080]])a[key]=integer(input[key]??previous[key],label,min,max);
   if(input.chromeProfile!==undefined){const profile=input.chromeProfile;if(profile!==null&&(!profile||typeof profile!=='object'||!/^[-\w ]{1,100}$/.test(profile.directory??'')))throw Error('Geçersiz Chrome profili');a.chromeProfile=profile===null?null:{directory:profile.directory,name:boundedText(profile.name,'Chrome profili',300)};}
   if(input.agentSettings)a.agentSettings=agentSettings(input.agentSettings);
  }
  if(changed){
   for(const task of this.store.workspaces.tasks.list(id,{states:['pending']}))this.store.workspaces.tasks.finish(id,task.id,'cancelled','Plan değişti');
   a.batchId=null;a.sourceState=Object.fromEntries(a.sources.filter(url=>previous.sources.includes(url)&&previous.sourceState?.[url]?.trial).map(url=>[url,{trial:previous.sourceState[url].trial}]));a.revision++;a.reviewedRevision=null;
   // Profile edits retain the existing trial decision; its original run stays unchanged.
   a.trial=automationTrialReady(previous)?{...previous.trial,revision:a.revision}:null;
   a.status='draft';a.nextRunAt=null;this.clearApprovals(id);
  }
  if(JSON.stringify(a.chromeProfile)!==JSON.stringify(previous.chromeProfile)){a.status='paused';a.nextRunAt=null;}
  // Saving settings never resumes a paused automation or grants a trial.
  if(!agent&&['title','goal','criteria','sources','instructions','facts','mode'].some(key=>Object.hasOwn(input,key))){delete a.planDraft;delete a.profileUpdate;}
  return this.put(a);
 }
 saveConversationPlan(id,runId,input){
  const run=this.activeRun(id,runId);if(run.kind!=='interview'||!isConversation(run))throw Error('Sohbet oturumu gerekli');
  const onboarding=setupAgentOnboarding(this,id);
  let a=this.get(id);const base=a.profileUpdate?{...a,...a.profileUpdate.plan}:a,previous=a.planDraft?.baseRevision===a.revision?{...base,...a.planDraft.plan}:base;
  const plan=planInput(this.template(a.templateId),input,{...previous,sources:a.sourceDraft?.sources??a.sources}),profile=profilePlan(plan),updatedAt=this.now();
  if(onboarding)a=this.save(id,profile,{agent:true});
  else if(profileChanged(profile,base))a.planDraft={plan:profile,baseRevision:a.revision,runId,updatedAt};else delete a.planDraft;
  if(JSON.stringify(plan.sources)!==JSON.stringify(a.sources))a.sourceDraft={id:randomUUID(),sources:plan.sources,runId,updatedAt};else delete a.sourceDraft;
  this.put(a);
  return {saved:true,draft:true,plan,applied:false,message:'Taslak kaydedildi. Profil değişiklikleri Çalışma alanı profili, kaynak önerileri Kaynaklar ekranından ayrı ayrı incelenip kaydedilir. Çalışan işler mevcut ayarlarla devam ediyor.'};
 }
 normalizeSetupAgentSettings(input){return {...agentSettings(input),contextRestartTokens:0};}
 saveSetupAgentSettings(id,input){return this.put({...this.get(id),setupAgentSettings:this.normalizeSetupAgentSettings(input)});}
 review(id,{allowConversation=false}={}){this.assertIdle(id,{allowWaitingConversation:true,allowConversation});const a=this.get(id),missing=missingProfileFields(a,this.template(a.templateId));if(missing.length)throw Error('Eksik bilgiler: '+missing.join(', '));return this.put({...a,reviewedRevision:a.revision,status:'ready',nextRunAt:null});}
 enable(id,{sourceUrl=null}={}){
  // A source request joins the worker queue while unrelated record work continues.
  // Enabling the whole workspace still requires idle workers.
  if(!sourceUrl)this.assertIdle(id,{allowConversation:true});
  const a=this.get(id);if(a.reviewedRevision!==a.revision)throw Error('Önce kurulumu kaydet');
  if(sourceUrl&&!a.sources.includes(sourceUrl))throw Error('Kaynak bu çalışma alanına ait değil');
  if(sourceUrl&&a.sourceSettings?.[sourceUrl]?.enabled===false)throw Error('Önce kaynağı aç');
  return this.put({...a,status:'enabled',batchId:null,once:Boolean(sourceUrl),onceSources:sourceUrl?[sourceUrl]:null,nextRunAt:this.now()});
 }
 skipTrial(id){
  this.assertIdle(id);const a=this.get(id);
  if(a.reviewedRevision!==a.revision)throw Error('Önce kurulum kartını kontrol edip kaydet');
  if((a.questions??[]).some(q=>q.answer==null))throw Error('Önce kurulum sorularını yanıtla');
  if(automationTrialReady(a))return a;
  return this.put({...a,trial:{revision:a.revision,status:'skipped',at:this.now()},status:'ready',nextRunAt:null,retryPlan:{},updatedAt:this.now()});
 }
 pause(id,status='paused'){const a=this.get(id);return this.put({...a,status,nextRunAt:null,retryPlan:{},updatedAt:this.now()});}
 schedulingSources(id,a=this.get(id)){
  return automationSources(a).map(source=>({...source,siteWait:this.sourceWait(id,source,a)}));
 }
 sourceWait(id,source,a=this.get(id)){
  const direct=this.siteAccess.status(source.url);
  const state=a.sourceState?.[source.url];
  if(!state?.siteBlocked&&!state?.lastRunId)return direct;
  // A source can lead to another host (for example www -> de.linkedin.com).
  // Bind its observed wait to this source without blocking unrelated sources.
  const row=state.siteBlocked?this.db.prepare("SELECT json_extract(data,'$.siteWait.site') AS site FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.sourceUrl')=? AND json_extract(data,'$.siteWait.site') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(id,source.url):this.db.prepare("SELECT json_extract(data,'$.siteWait.site') AS site FROM automation_runs WHERE id=? AND automation_id=? AND json_extract(data,'$.sourceUrl')=?").get(state.lastRunId,id,source.url);
  let observed=row?.site?this.siteAccess.status('https://'+row.site):null;
  if(!state.siteBlocked&&!observed?.waiting)observed=null;
  return [direct,observed].filter(Boolean).sort((a,b)=>Number(b.exhausted)-Number(a.exhausted)||b.retryAt-a.retryAt)[0]??null;
 }
 sources(id){
  const a=this.get(id),runs=this.runs(id,{summary:true});
  const records=this.db.prepare("SELECT json_extract(data,'$.url') AS url,json_extract(data,'$.sourceUrl') AS sourceUrl,json_extract(data,'$.trial') AS trial,json_extract(data,'$.runId') AS runId,json_extract(data,'$.discoveredRunId') AS discoveredRunId FROM workspace_records WHERE workspace_id=?").all(id);
  // A new active run or unrelated record work must not hide the last source outcome.
  const lastRuns=new Map(this.db.prepare(`SELECT json_object('id',id,'kind',json_extract(data,'$.kind'),'status',json_extract(data,'$.status'),'summary',json_extract(data,'$.summary'),'finishedAt',json_extract(data,'$.finishedAt'),'sourceUrl',json_extract(data,'$.sourceUrl'),'sources',json_extract(data,'$.sources')) AS data FROM automation_runs WHERE rowid IN (
   SELECT max(rowid) FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.kind') IN ('run','trial')
    AND json_extract(data,'$.status')<>'running' AND json_extract(data,'$.recordId') IS NULL AND json_extract(data,'$.recordOperation') IS NULL
   GROUP BY coalesce(json_extract(data,'$.sourceUrl'),CASE WHEN json_array_length(data,'$.sources')=1 THEN json_extract(data,'$.sources[0]') END)
  )`).all(id).map(json).map(run=>[run.sourceUrl??(run.sources?.length===1?run.sources[0]:null),{id:run.id,kind:run.kind,status:run.status,summary:run.summary,finishedAt:run.finishedAt}]));
  return automationSources(a).map(source=>{
   const last=runs.find(r=>!r.recordId&&!r.recordOperation&&['run','trial'].includes(r.kind)&&(r.sourceUrl===source.url||!r.sourceUrl&&r.sources?.length===1&&r.sources[0]===source.url));
   const active=runs.find(r=>!r.recordId&&!r.recordOperation&&r.status==='running'&&['run','trial'].includes(r.kind)&&(r.sourceUrl===source.url||r.sources?.length===1&&r.sources[0]===source.url));
   const resultCount=records.filter(r=>!r.trial&&(r.sourceUrl?r.sourceUrl===source.url:new URL(r.url).origin===new URL(source.url).origin&&a.sources.filter(url=>new URL(url).origin===new URL(source.url).origin).length===1)).length;
   return {...(last?{lastRunAt:last.finishedAt,lastStatus:last.status,lastResult:last.summary,blocked:['blocked','failed','timeout'].includes(last.status),lastFound:records.filter(r=>!r.trial&&(r.discoveredRunId??r.runId)===last.id).length}:{}),...source,lastRun:lastRuns.get(source.url)??null,siteWait:this.sourceWait(id,source,a),pageProgress:active&&!active.recordId?active.pageProgress??null:source.pageProgress??null,observedPage:active?.observedPage??source.observedPage??null,resultCount,scanning:Boolean(active),trialRunning:active?.kind==='trial',scanIssue:active?Object.values(active.scanIssues??{}).sort((a,b)=>b.at-a.at)[0]??null:null,workerId:active?.workerId??null};
  });
 }
 saveSources(id,sources,{acceptDraft=false}={}){
  const a=this.get(id),urls=normalizeSourceUrls(sources);
  const removed=a.sources.filter(url=>!urls.includes(url)),added=urls.filter(url=>!a.sources.includes(url));
  const usesRemoved=work=>work.sourceUrl?removed.includes(work.sourceUrl):(work.sources??a.sources).some(url=>removed.includes(url));
  if(this.runs(id).some(run=>run.status==='running'&&!isConversation(run)&&usesRemoved(run))||this.store.workspaces.tasks.list(id,{states:['running','reported']}).some(task=>task.operation!=='interview'&&usesRemoved(task)))throw Error('Kaldırılacak kaynağın çalışan görevini önce durdur.');
  return this.store.workspaces.tasks.atomic(()=>{
   for(const task of this.store.workspaces.tasks.list(id,{states:['pending','paused']}))if(removed.includes(task.sourceUrl))this.store.workspaces.tasks.finish(id,task.id,'cancelled','Kaynak kaldırıldı');
   const keep=values=>Object.fromEntries(Object.entries(values??{}).filter(([url])=>urls.includes(url)));
   const next={...a,sources:urls,sourceSettings:keep(a.sourceSettings),sourceState:keep(a.sourceState),updatedAt:this.now()};
   if(a.onceSources)next.onceSources=a.onceSources.filter(url=>urls.includes(url));
   if(a.status==='enabled'&&added.length)next.nextRunAt=this.now();
   if(acceptDraft)delete next.sourceDraft;
   else if(a.sourceDraft){
    const proposed=[...new Set([...a.sourceDraft.sources.filter(url=>!removed.includes(url)),...added])];
    if(JSON.stringify(proposed)===JSON.stringify(urls))delete next.sourceDraft;
    else next.sourceDraft={...a.sourceDraft,id:randomUUID(),sources:proposed};
   }
   return this.put(next);
  });
 }
 addSource(id,input){
  const a=this.get(id),url=webUrl(input.url);if(a.sources.includes(url))throw Error('Bu kaynak zaten kayıtlı');
  const settings=sourceInput({...a,sources:[...a.sources,url]},url,input);
  return this.store.workspaces.tasks.atomic(()=>{const next=this.saveSources(id,[...a.sources,url]);return this.put({...next,sourceSettings:{...next.sourceSettings,[url]:settings}});});
 }
 removeSource(id,url){const a=this.get(id);if(!a.sources.includes(url))throw Error('Kaynak bu çalışma alanına ait değil');return this.saveSources(id,a.sources.filter(source=>source!==url));}
 resolveSourceDraft(id,draftId,accept){
  const a=this.get(id);if(!a.sourceDraft||a.sourceDraft.id!==draftId)throw Error('Kaynak önerileri değişti. Güncel önerileri inceleyip tekrar dene.');
  if(accept)return this.saveSources(id,a.sourceDraft.sources,{acceptDraft:true});
  delete a.sourceDraft;return this.put(a);
 }
 saveSourcesInterval(id,intervalMinutes){
  if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>10080)throw Error('Tarama aralığı: 1–10080 arasında tam sayı gerekli');
  return this.store.workspaces.tasks.atomic(()=>{
   const a=this.get(id);
   for(const url of a.sources)this.saveSource(id,url,{intervalMinutes});
   return this.sources(id);
  });
 }
 saveSource(id,url,input){
  const a=this.get(id),settings=sourceInput(a,url,input);
  const intervalOnly=Object.keys(input).length===1&&input.intervalMinutes!==undefined;
  if(!intervalOnly&&this.runs(id).some(r=>!isConversation(r)&&r.status==='running'&&(r.sourceUrl===url||r.kind==='interview'||!r.sourceUrl)))throw Error('Önce bu kaynağın çalışan görevini durdur');
  const old=a.sourceSettings?.[url]??{};
  a.sourceSettings={...a.sourceSettings,[url]:settings};
  const methodChanged=(old.instructions??'')!==(settings.instructions??'')||(old.tool??'')!==(settings.tool??'')||(old.skill??'')!==(settings.skill??'');
  if(old.query!==settings.query||old.mode!==settings.mode||methodChanged)this.clearApprovals(id);
  const scopeChanged=sourceScanScope({...a,sourceSettings:{...a.sourceSettings,[url]:old}},url)!==sourceScanScope(a,url);
  const state=scopeChanged?{trial:methodChanged?null:a.sourceState?.[url]?.trial??null,nextRunAt:this.now(),blocked:false,lastRunAt:null,lastStatus:null,lastFound:0,lastResult:methodChanged?'Kaynak yöntemi değişti. Yeniden denenecek.':'Arama kapsamı değişti. Yeni tam tarama bekleniyor.'}:a.sourceState?.[url]??{};
  if(scopeChanged)for(const task of this.store.workspaces.tasks.list(id,{states:['pending']}))if(task.sourceUrl===url)this.store.workspaces.tasks.finish(id,task.id,'cancelled','Kaynak arama kapsamı değişti');
  // An edited recipe is a new candidate; the next scan verifies it.
  // Only a different search method invalidates verification; notes, the
  // pagination hint and login flag are advisory.
  const recipeKey=r=>r?JSON.stringify({entry:r.entry,terms:r.terms??null}):null,recipeChanged=recipeKey(old.recipe)!==recipeKey(settings.recipe);
  a.sourceState={...a.sourceState,[url]:{...state,...(recipeChanged?{recipeState:settings.recipe?{status:'candidate',successCount:0,failCount:0}:null}:{}),...(settings.intervalMinutes!==old.intervalMinutes&&!state.blocked?{nextRunAt:state.lastRunAt?state.lastRunAt+(settings.intervalMinutes??a.intervalMinutes)*60000:this.now()}:{})}};
  return this.put(a);
 }
 // Called from a running source task: the agent proposed a recipe and the app
 // already checked it. Never resets the trial or the scan scope.
 learnSourceRecipe(id,url,recipe,{runId,verified,listings=0,pages=0}){
  const a=this.get(id);if(!a.sources.includes(url))throw Error('Kaynak bu çalışma alanına ait değil');
  const settings=sourceInput(a,url,{recipe});
  const previous=a.sourceState?.[url]?.recipeState??{};
  const recipeState=recipe.entry.kind==='discovery'?{status:'discovery',successCount:0,failCount:0,learnedRunId:runId,learnedAt:this.now()}:verified?{status:'verified',successCount:(previous.successCount??0)+1,failCount:0,verifiedAt:this.now(),learnedRunId:runId,lastRunId:runId,lastFailure:null,evidence:{listings,pages}}:{status:'candidate',successCount:0,failCount:0,learnedRunId:runId};
  return this.put({...a,sourceSettings:{...a.sourceSettings,[url]:settings},sourceState:{...a.sourceState,[url]:{...a.sourceState?.[url],recipeState}}});
 }
 // Forget that the source was ever checked so its next turn is a trial with
 // the trial agent. The saved recipe stays as a candidate for comparison.
 relearnSource(id,url){
  const a=this.get(id);if(!a.sources.includes(url))throw Error('Kaynak bu çalışma alanına ait değil');
  if(this.runs(id).some(r=>!isConversation(r)&&r.status==='running'&&r.sourceUrl===url))throw Error('Önce bu kaynağın çalışan görevini durdur');
  const state=a.sourceState?.[url]??{},recipe=a.sourceSettings?.[url]?.recipe;
  return this.put({...a,sourceState:{...a.sourceState,[url]:{...state,trial:null,blocked:false,nextRunAt:this.now(),recipeState:recipe?{...state.recipeState,status:'candidate',failCount:0}:null,lastResult:'Kaynak yeniden öğrenilecek. Sıradaki tur deneme olacak.'}}});
 }
 sourceRecipe(id,url){
  const a=this.get(id),recipe=a.sourceSettings?.[url]?.recipe??null,state=a.sourceState?.[url]?.recipeState??null;
  return {recipe,state,status:recipeStatus(recipe,state),replay:recipeStatus(recipe,state)==='stale'?null:recipeReplay(recipe,recipeValues(a,url))};
 }
 event(id,kind,data){this.get(id);this.db.prepare('INSERT INTO workspace_events(workspace_id,kind,data,at) VALUES(?,?,?,?)').run(id,kind,JSON.stringify(data),this.now());}
 questionScope(id,question){
  if(question.recordId||Object.hasOwn(question,'sourceUrl'))return question;
  // Recover the scope of older questions from their durable task, never from
  // the currently assigned worker or a guessed URL host.
  const task=question.taskId?json(this.db.prepare('SELECT data FROM workspace_tasks WHERE workspace_id=? AND id=?').get(id,question.taskId)):null;
  return {...question,sourceUrl:task&&!task.recordId?task.sourceUrl??null:null};
 }
 askQuestion(id,{text,recordId=null,fields=null,accessCheck=null,outcome=false},{runId}={}){
  text=boundedText(text,'Soru',6000);fields=normalizeFields(fields);if(recordId&&this.result(id,recordId).status==='dismissed')throw Error('Elenen kayıt için soru sorulamaz');
  const run=runId?this.activeRun(id,runId):null,sourceUrl=!recordId&&['run','trial'].includes(run?.kind)?run.sourceUrl??null:null;
  const a=this.get(id),previous=(a.questions??[]).find(q=>Boolean(q.conversation)===isConversation(run)&&q.answer==null&&q.text===text&&q.recordId===recordId&&(q.sourceUrl??null)===sourceUrl&&JSON.stringify(q.fields??null)===JSON.stringify(fields));if(previous)return previous;
  const question={id:randomUUID(),text,recordId,sourceUrl,fields,...(isConversation(run)?{conversation:true}:{}),...(accessCheck?{accessCheck}:{}),...(outcome?{outcome:true}:{}),answer:null,createdAt:this.now(),...(run?{runId:run.id}:{}),...(run?.taskId?{taskId:run.taskId}:{}),...(run?.resumeContext?{browserContext:{...run.resumeContext,runId:run.id,workerId:run.workerId,sourceUrl:run.sourceUrl}}:{})};
  this.store.workspaces.tasks.atomic(()=>{this.put({...a,questions:[...(a.questions??[]),question]});this.event(id,'question_asked',{id:question.id});});return question;
 }
 answerQuestion(id,questionId,value){
  const a=this.get(id),question=(a.questions??[]).find(q=>q.id===questionId);
  if(!question)throw Error('Soru bu çalışma alanına ait değil');if(question.answer!==null)throw Error('Bu soru zaten yanıtlandı');
  const result=question.fields&&typeof value!=='string'?validateAnswers(question.fields,value):{summary:boundedText(value,'Yanıt',10000),values:null},answer=result.summary;
  const updated={...question,answer,answerValues:result.values,answeredAt:this.now()};
  const runId=question.runId??question.browserContext?.runId,origin=runId?json(this.db.prepare('SELECT data FROM automation_runs WHERE automation_id=? AND id=?').get(id,runId)):null;
  const conversation=!question.recordId&&!question.sourceUrl&&!question.browserContext?.sourceUrl&&(question.conversation===true||origin?.kind==='interview');
  // The applicant's answer to the app's outcome question resolves the held
  // record: submitted completes it, not submitted makes it sendable again.
  let resolved=null;
  if(question.outcome&&question.recordId){
   const item=this.result(id,question.recordId),choice=result.values?.[OUTCOME_FIELD.id],at=this.now();
   if(item.status==='uncertain'&&choice===OUTCOME_FIELD.options[0])resolved={...item,status:'completed',evidence:'Kullanıcı başvurunun gönderildiğini onayladı.',verifiedAt:at,updatedAt:at};
   if(item.status==='uncertain'&&choice===OUTCOME_FIELD.options[1])resolved={...item,status:item.proposal?'prepared':'found',approvedDigest:null,requiresReview:true,evidence:'Kullanıcı başvurunun gönderilmediğini bildirdi; yeniden gönderilebilir.',verifiedAt:at,updatedAt:at,notSubmitted:{kind:'user',at,digest:item.digest,attemptRunId:item.attemptRunId}};
  }
  this.store.workspaces.tasks.atomic(()=>{this.put({...a,questions:a.questions.map(q=>q.id===questionId?updated:q)});if(resolved)this.putResult(resolved);this.message(id,'user',question.text+'\nYanıt: '+answer,{questionId,conversation,...(runId?{runId}:{})});this.event(id,'question_answered',{id:questionId});});return updated;
 }
 questionContext(id,question){
  if(question.answer==null&&question.recordId)question={...question,canDismissRecord:['found','prepared'].includes(this.result(id,question.recordId).status)};
  if(question.answer!=null||question.browserContext)return question;
  // Older questions predate saved tab context. Match their owning run even
  // after it leaves the short recent-history list; never guess across workers.
  const matches=this.db.prepare(`SELECT data FROM automation_runs WHERE automation_id=?
   AND json_extract(data,'$.recordId') IS ? AND json_extract(data,'$.startedAt')<=?
   AND (json_extract(data,'$.finishedAt') IS NULL OR json_extract(data,'$.finishedAt')>=?) LIMIT 2`).all(id,question.recordId??null,question.createdAt,question.createdAt).map(json);
  if(matches.length!==1||!matches[0].resumeContext)return question;
  const run=matches[0];return {...question,browserContext:{...run.resumeContext,runId:run.id,workerId:run.workerId,sourceUrl:run.sourceUrl}};
 }
 clearApprovals(id){this.db.prepare("UPDATE workspace_records SET data=json_remove(data,'$.approvedDigest') WHERE workspace_id=?").run(id);}
 message(id,role,text,context={}){this.get(id);if(!['user','assistant','system'].includes(role))throw Error('Geçersiz mesaj');const m={id:randomUUID(),automationId:id,role,text:boundedText(text,'Mesaj',12000),at:this.now(),...context};this.db.prepare('INSERT INTO automation_messages VALUES(?,?,?)').run(m.id,id,JSON.stringify(m));return m;}
 messages(id){
  this.get(id);
  return this.db.prepare(`SELECT m.data,json_extract(r.data,'$.kind') AS run_kind FROM
   (SELECT rowid,automation_id,data FROM automation_messages WHERE automation_id=? ORDER BY rowid DESC LIMIT 100) m
   LEFT JOIN automation_runs r ON r.automation_id=m.automation_id AND r.id=json_extract(m.data,'$.runId') ORDER BY m.rowid`).all(id).map(row=>{
   const message=json(row);return typeof message.conversation==='boolean'||!row.run_kind?message:{...message,conversation:row.run_kind==='interview'};
  });
 }
 runs(id,{summary=false}={}){
  this.get(id);
  const select=summary?"json_remove(data,'$.scan','$.scanPlan','$.navigation','$.observedLinks','$.observations','$.jevTask') AS data,json_extract(data,'$.observations[#-1].url') AS observedUrl":"data";
  return this.db.prepare(`SELECT ${select} FROM automation_runs WHERE automation_id=? AND (json_extract(data,'$.status')='running' OR rowid IN (SELECT rowid FROM automation_runs WHERE automation_id=? ORDER BY rowid DESC LIMIT 30)) ORDER BY rowid DESC`).all(id,id).map(row=>summary?{...json(row),observations:row.observedUrl?[{url:row.observedUrl}]:[]}:json(row));
 }
 run(id){const r=json(this.db.prepare('SELECT data FROM automation_runs WHERE id=?').get(id));if(!r)throw Error('Çalışma bulunamadı');return r;}
 putRun(run){this.db.prepare('INSERT INTO automation_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.automationId,JSON.stringify(run));return run;}
 begin(id,input,workerId='main'){return this.store.workspaces.tasks.atomic(()=>{
  const {kind,taskId,messageId,inputQuestionIds}=typeof input==='string'?{kind:input}:input;
  const conversation=workerId===CONVERSATION_WORKER;
  if(conversation&&kind!=='interview')throw Error('Sohbet worker’ı yalnızca konuşma görevini çalıştırabilir');
  if(!taskId&&!conversation)this.assertIdle(id);const a=this.get(id);this.store.workspaces.workers.get(id,workerId);if(!['interview','trial','run'].includes(kind))throw Error('Geçersiz çalışma');
  if(kind!=='interview'&&a.profileUpdate)throw Error('Profil güncellemesi tamamlanmadan yeni görev başlatılamaz.');
  if(kind!=='interview'&&!(taskId&&this.store.workspaces.tasks.get(id,taskId).recordOperation==='verify')&&a.reviewedRevision!==a.revision)throw Error('Önce kurulum kartını kontrol edip kaydet');
  if(!taskId&&!conversation&&['interview','trial'].includes(kind)&&a.status==='enabled')this.pause(id);
  const queue=this.store.workspaces.tasks,task=taskId?queue.get(id,taskId):queue.enqueue(id,{operation:kind,lockKey:conversation?'conversation':'workspace',capability:'browser.observe'});
  validateRecordTask(this,id,task,this.now());queue.claim(id,task.id,workerId);
  if(!taskId&&!conversation&&['interview','trial'].includes(kind)&&Object.keys(a.retryPlan??{}).length)this.put({...this.get(id),retryPlan:{}});
  const state=a.sourceState?.[task.sourceUrl]??{},scopeKey=task.sourceUrl?sourceScanScope(a,task.sourceUrl):null;
  const scopeMatches=!state.scanState||state.scanState.scopeKey===scopeKey;
  const savedScan=!task.recordId&&scopeMatches&&(task.scan??state.scan),pageProgress=scopeMatches?state.pageProgress:null;
  const scanState=kind==='run'&&task.sourceUrl&&!task.recordId?beginSourceScan(state.scanState,scopeKey,this.now()):null;
  if(scanState){this.put({...a,sourceState:{...a.sourceState,[task.sourceUrl]:{...state,scanState}}});queue.put({...queue.get(id,task.id),scanPlan:scanState.active});}
  const continuation=answerContinuation(this,id,task,kind),runId=randomUUID();
  if(continuation){queue.put({...queue.get(id,task.id),continuation});const current=this.get(id);this.put({...current,questions:(current.questions??[]).map(q=>continuation.questionIds.includes(q.id)?{...q,continuationRunId:runId}:q)});}
  return this.putRun({id:runId,...(!task.recordId&&state.accessRecovery?.state==='fresh'?{freshSource:true}:{}),...(conversation?{interactive:true,awaitingMessage:false,...(messageId?{messageId}:{}),...(inputQuestionIds?{inputQuestionIds}:{})}:{}),...(continuation?{continuation}:{}),automationId:id,workerId,taskId:task.id,operation:task.operation,...(task.recordOperation?{recordOperation:task.recordOperation,request:task.request}:{}),sources:task.sources??a.sources,sourceUrl:task.sourceUrl??null,recordId:task.recordId??null,...(task.recordIds?{recordIds:task.recordIds}:{}),batchId:task.batchId??null,...(scanState?{scanPlan:scanState.active}:{}),...(kind==='run'&&savedScan&&!savedScan.complete?{scan:savedScan,...(pageProgress?{pageProgress}:{})}:{}),kind,revision:a.revision,status:'running',state:'Starting',startedAt:this.now(),finishedAt:null,browserSteps:0,observations:[],summary:'Başlatılıyor',actionId:null});
 });}
 activeRun(automationId,runId){const run=this.run(runId);if(run.automationId!==automationId||run.status!=='running')throw Error('Çalışma oturumu geçersiz');return run;}
 spendStep(id,runId,{research=false}={}){const run=this.activeRun(id,runId);if(run.kind==='interview'&&!research)throw Error('Kurulum sırasında yalnızca kaynak araştırması yapılabilir');if(research&&run.kind!=='interview')throw Error('Kaynak araştırması yalnızca kurulum sırasında yapılabilir');run.browserSteps++;this.putRun(run);}
 reportPage(id,runId,pageProgress){return this.store.workspaces.tasks.atomic(()=>{
  const run=this.activeRun(id,runId);if(run.kind!=='run'||!run.sourceUrl||run.recordId)throw Error('Sayfa bildirimi yalnızca kaynak taramasında kullanılabilir.');
  pageProgress={...pageProgress,url:webUrl(pageProgress.url)};
  if(!(run.navigation??[]).some(n=>n.url===pageProgress.url))throw Error('Bildirilen sayfa bu görevde gözlenmedi.');
  const reported=reportWorkPage(run,pageProgress),scan=withScanWork(run,reported.work,{reason:run.scan?.reason??`Son bildirilen sonuç sayfası ${pageProgress.currentPage}.`,evidenceUrl:run.scan?.evidenceUrl??pageProgress.url});
  // Observation and resumable work are separate: even a successful recovery
  // visit to page one must not replace the saved page eight or pending details.
  const scanPlan=run.scanPlan?{...run.scanPlan,boundary:null}:null;
  this.persistScan(id,{...run,observedPage:pageProgress,pageProgress:reported.pageProgress,scan,...(scanPlan?{scanPlan}:{})});
  return {pageProgress:reported.pageProgress,observedPage:pageProgress,revisiting:reported.revisiting,scanProgress:this.scanProgressView(this.run(runId)),queue:scanQueue(this.run(runId)),...(reported.revisiting?{guidance:'Recovery page observed. Saved progress is unchanged. Resume the pending queue; do not scan earlier pages again.'}:{})};
 });}
 persistScan(id,run){
  if(run.scan?.work){
   const work=scanWork(run),known=new Set(work.searches.flatMap(s=>s.pendingUrls));
   const extra=(run.scan.pendingUrls??[]).filter(url=>!known.has(url));
   activeSearch(work).pendingUrls.push(...extra);run={...run,scan:withScanWork(run,work)};
  }
  this.putRun(run);const a=this.get(id),state=a.sourceState?.[run.sourceUrl]??{};
  this.put({...a,sourceState:{...a.sourceState,[run.sourceUrl]:{...state,pageProgress:run.pageProgress??null,observedPage:run.observedPage??null,scan:run.scan,...(run.scanPlan?{scanState:{...state.scanState,active:run.scanPlan}}:{})}}});
  if(run.taskId){const queue=this.store.workspaces.tasks;queue.put({...queue.get(id,run.taskId),scan:run.scan,scanPlan:run.scanPlan});}
 }
 scanProgressView(run){return scanProgressView(run);}
 scanWorkRun(id,runId){const run=this.activeRun(id,runId);if(run.kind!=='run'||!run.sourceUrl||run.recordId)throw Error('Tarama kuyruğu yalnızca kaynak görevine aittir.');return run;}
 scanQueue(id,runId,input){return scanQueue(this.scanWorkRun(id,runId),input);}
 completeScanSearch(id,runId,completion,snapshot){return this.store.workspaces.tasks.atomic(()=>{
  const run=this.scanWorkRun(id,runId),work=completeScanSearch(run,completion,snapshot.url);
  this.persistScan(id,{...run,scan:withScanWork(run,work)});return scanWorkSummary(this.run(runId));
 });}
 saveScanProgress(id,runId,input,snapshot){return this.store.workspaces.tasks.atomic(()=>{
  const run=this.scanWorkRun(id,runId);
  if(!Array.isArray(input.pendingUrls)||input.pendingUrls.length>100)throw Error('Bir seferde en fazla 100 bekleyen adres ekle; kalanları sonraki çağrıda ekleyebilirsin.');
  const reason=boundedText(input.reason,'Kapsam açıklaması',2000),work=updateScanQueue(run,input),search=activeSearch(work);
  // Queue updates accept the agent's report. A page is optional and only
  // supplies context for chronological early stopping, never permission to save.
  const page=snapshot??{url:run.scanPlan?.checkpoint?.url??run.sourceUrl,text:''};
  const chronology=snapshot&&!(input.chronology?.fromStart&&run.observedPage?.url===page.url&&run.observedPage.currentPage!==1)?input.chronology:undefined;
  const scanPlan=advanceSourceScan(run.scanPlan,{...input,chronology,pendingUrls:search.pendingUrls,reason},page,runId,this.now());search.plan=scanPlan;
  const scan=withScanWork(run,work,{reason,evidenceUrl:page.url});
  this.persistScan(id,{...run,scan,scanPlan});return {scanProgress:this.scanProgressView(this.run(runId)),scanPlan:scanPlanView(scanPlan),queue:scanQueue(this.run(runId))};
 });}
 knownResults(id,runId,keys){
  const run=this.activeRun(id,runId);if(!run.sourceUrl||run.recordId||!Array.isArray(keys)||keys.length>100)throw Error('Kaynak taraması için en fazla 100 ilan anahtarı gerekli.');
  const lookup=this.db.prepare("SELECT data FROM workspace_records WHERE workspace_id=? AND record_key=? AND NOT coalesce(json_extract(data,'$.trial'),0)"),byUrl=this.db.prepare("SELECT data FROM workspace_records WHERE workspace_id=? AND json_extract(data,'$.url')=? AND NOT coalesce(json_extract(data,'$.trial'),0) LIMIT 1");
  return keys.map(key=>{boundedText(key,'İlan anahtarı',3000);const item=json(lookup.get(id,key)??byUrl.get(id,key));return {key,known:Boolean(item),...(item?{id:item.id,status:item.status,updatedAt:item.updatedAt,revision:item.revision}:{})};});
 }
 observe(id,runId,url,evidence,links=[],pageContext={}){
  const run=this.activeRun(id,runId),observation={url:webUrl(url),evidence:String(evidence).slice(0,2000),at:this.now()};
  run.observations=[...run.observations,observation].slice(-20);
  // A cutoff proof belongs to the last observed page version. Recheck it after
  // any fresh browser observation rather than completing from stale content.
  const invalidated=Boolean(run.scanPlan?.boundary);if(invalidated)run.scanPlan={...run.scanPlan,boundary:null};
  run.resumeContext={url:observation.url,...(typeof pageContext?.tabId==='string'?{tabId:pageContext.tabId}:{})};
  // Keep the full route separately from the bounded page excerpts.
  run.navigation=[...(run.navigation??[]),{url:observation.url,at:observation.at,step:run.browserSteps}];
  if(links.length)run.observedLinks=[...new Set([...(run.observedLinks??[]),...links])].slice(-10000);
  if(invalidated){this.store.workspaces.tasks.atomic(()=>this.persistScan(id,run));return run;}
  return this.putRun(run);
 }
 results(id,{all=false}={}){this.get(id);return this.db.prepare('SELECT data FROM workspace_records WHERE workspace_id=? ORDER BY rowid DESC LIMIT ?').all(id,all?-1:500).map(json);}
 runFoundCounts(id){
  this.get(id);
  // Count the full table, including records outside the recent-results window.
  return new Map(this.db.prepare(`SELECT coalesce(json_extract(data,'$.discoveredRunId'),json_extract(data,'$.runId')) AS runId,count(*) AS foundCount
   FROM workspace_records WHERE workspace_id=? AND NOT coalesce(json_extract(data,'$.trial'),0) GROUP BY runId`).all(id).map(row=>[row.runId,row.foundCount]));
 }
 resultCounts(id){this.get(id);return this.db.prepare(`SELECT count(*) AS storedCount,
  count(CASE WHEN NOT json_extract(data,'$.trial') THEN 1 END) AS resultCount,
  count(CASE WHEN NOT json_extract(data,'$.trial') AND json_extract(data,'$.status')='prepared' AND NOT coalesce(json_extract(data,'$.approvedDigest')=json_extract(data,'$.digest'),0) THEN 1 END) AS pendingCount,
  count(CASE WHEN NOT json_extract(data,'$.trial') AND json_extract(data,'$.status')='completed' THEN 1 END) AS completedCount,
  count(CASE WHEN NOT json_extract(data,'$.trial') AND json_extract(data,'$.status')='uncertain' THEN 1 END) AS uncertainCount
  FROM workspace_records WHERE workspace_id=?`).get(id);}
 result(id,itemId){this.get(id);const item=json(this.db.prepare('SELECT data FROM workspace_records WHERE id=? AND workspace_id=?').get(itemId,id));if(!item)throw Error('Sonuç bu otomasyona ait değil');return item;}
 putResult(item,{run}={}){return this.store.workspaces.tasks.atomic(()=>{
  const previous=this.store.workspaces.records.find(item.automationId,item.key),saved=this.store.workspaces.records.put(item.automationId,item.key,item);
  if(run){if(run.automationId!==item.automationId)throw Error('Çalışma bu otomasyona ait değil');this.putRun(run);}
  if(!previous)this.event(item.automationId,'job_found',{id:saved.id});else if(JSON.stringify(previous)!==JSON.stringify(saved))this.event(item.automationId,previous.status!==item.status&&item.status==='completed'?'submission_recorded':'record_updated',{id:saved.id});
  return saved;
 });}
 configureTable(id,input){this.get(id);this.store.workspaces.configureTable(id,input);return this.get(id);}
 rename(id,title){this.assertIdle(id);return this.put({...this.get(id),title:boundedText(title,'Ad',150)});}
 updateCells(id,itemId,input){return this.store.workspaces.updateCells(id,itemId,input);}
 record(id,runId,input){
  const run=this.activeRun(id,runId),research=run.kind==='interview';
  if(run.recordOperation==='score')throw Error('Puanlama sonucunu record_automation_score ile kaydet');
  const observedUrl=webUrl(input.url),inputKey=boundedText(input.key??observedUrl,'Sonuç anahtarı',2000);
  let url=observedUrl,key=this.template(this.get(id).templateId).records.identity==='url'?url:inputKey;
  let previous=this.store.workspaces.records.find(id,key),actionUrl=previous?.actionUrl;
  // The same listing observed with extra tracking/ad parameters is one record.
  if(!previous&&!run.recordId&&!research){const variant=this.parameterVariant(id,url);if(variant){previous=variant;key=variant.key;url=variant.url;actionUrl=variant.actionUrl;}}
  if(run.recordId){
   // A redirect to an application/booking form does not create a new record.
   // The durable assignment owns identity; URLs only describe its destination.
   const assigned=this.result(id,run.recordId),keyRecord=this.store.workspaces.records.find(id,inputKey);
   if(input.recordId&&input.recordId!==assigned.id||previous&&previous.id!==assigned.id||keyRecord&&keyRecord.id!==assigned.id)throw Error('Kayıt bu göreve ait değil');
   if(inputKey!==assigned.key&&inputKey!==observedUrl)throw Error('Atanmış kaydın mevcut key değerini kullan');
   previous=assigned;key=assigned.key;url=assigned.url;actionUrl=assigned.actionUrl;
   const destination=input.actionUrl?webUrl(input.actionUrl):observedUrl!==url?observedUrl:actionUrl;
   const destinationRecord=destination&&this.store.workspaces.records.find(id,destination);
   if(destinationRecord&&destinationRecord.id!==assigned.id)throw Error('Kayıt bu göreve ait değil');
   if(destination&&destination!==url&&destination!==actionUrl&&!run.observations.some(o=>o.url===destination&&o.evidence?.trim()))throw Error('İşlem adresini önce bu görevde tarayıcıda gözlemle');
   actionUrl=destination===url?undefined:destination;
  }else if(input.recordId||input.actionUrl)throw Error('Kayıt ID ve işlem adresi yalnızca atanmış kayıt görevinde kullanılabilir');
  if(research){
   if(input.proposal?.trim())throw Error('Kurulumda yalnızca araştırma örneği kaydedilebilir; işlem taslağı oluşturulamaz');
   if(!run.observations.some(o=>o.url===url&&o.evidence.trim()))throw Error('Araştırma örneğinin detay sayfasını önce bu turda gözlemle');
  }
  if(run.recordId&&run.recordId!==previous?.id)throw Error('Kayıt bu göreve ait değil');
  // Neither setup nor trial samples may demote live records or clear approvals.
  if(run.kind!=='run'&&previous&&!previous.trial)return {...previous,duplicate:true};
  if(previous&&['completed','uncertain','executing','dismissed'].includes(previous.status))return {...previous,duplicate:true};
  if(previous&&!run.recordId&&this.store.workspaces.tasks.list(id,{states:['running','reported','paused']}).some(t=>taskHasRecord(t,previous.id)))return {...previous,duplicate:true};
  const title=boundedText(input.title,'Başlık',300),summary=boundedText(input.summary,'Özet',6000),proposal=boundedText(input.proposal??previous?.proposal??'','İşlem taslağı',12000,{empty:true});
  const digest=createHash('sha256').update(JSON.stringify(actionUrl?[url,proposal,actionUrl]:[url,proposal])).digest('hex');
  if(input.proposal!==undefined&&(input.proposal.trim()||previous?.proposal)&&run.operation&&findOperation(this.template(this.get(id).templateId),run.operation)&&operationFor(this.template(this.get(id).templateId),run.operation).effect==='read')throw Error('Bu adım yalnızca gözlem ve değerlendirme yapabilir');
  const cells=input.cells===undefined?{}:automationCells(input.cells,this.get(id).table);
  const scoring=this.template(this.get(id).templateId).recordOperations?.score;
  if(scoring&&run.kind==='run'&&run.sourceUrl&&!run.recordId&&(!previous||previous.trial)&&!input.assessment)throw Error('Yeni ilanı kaydetmeden önce puanla ve kayıt çağrısında score alanını gönder');
  if(input.assessment&&(run.kind!=='run'||!scoring))throw Error('Bu görevde uygunluk puanı kaydedilemez');
  const assessment=input.assessment?recordAssessment(this,id,run,input.assessment,url):previous?.assessment;
  const initial=this.template(this.get(id).templateId).records.initial;
  const item={...previous,...(!previous?.workflowState&&initial&&initial!=='found'?{workflowState:initial}:{}),id:previous?.id??randomUUID(),automationId:id,key,url,...(actionUrl||previous?.actionUrl?{actionUrl}:{}),title,summary,proposal,digest,status:proposal?'prepared':'found',approvedDigest:previous?.digest===digest?previous.approvedDigest:null,createdAt:previous?.createdAt??this.now(),updatedAt:this.now(),runId,revision:proposal&&input.proposal===undefined&&previous?previous.revision:run.revision,trial:run.kind!=='run',sampleKind:research?'interview':null,cells:{...previous?.cells,...cells},starred:previous?.starred??false};
  if(run.recordOperation==='execute'&&run.request?.manual&&run.request.direct!==true&&digest!==run.request.digest)item.requiresReview=true;
  // Rediscovery and later record operations must retain the original scan's credit.
  if(run.kind==='run')item.discoveredRunId=previous&&!previous.trial?(previous.discoveredRunId??previous.runId??runId):runId;
  if(run.sourceUrl)item.sourceUrl=run.sourceUrl;
  if(assessment){item.assessment=assessment;item.cells=assessmentCells(this.get(id).table,item.cells,assessment);}
  return this.putResult(item);
 }
 // Two addresses on the same origin and path whose shared query parameters
 // agree, one carrying only extra parameters, describe the same page. Routes
 // and differing values stay distinct; the rule names no site or parameter.
 parameterVariant(id,url){
  let target;try{target=new URL(url);}catch{return null;}
  const base=target.origin+target.pathname,params=[...target.searchParams];
  const rows=this.db.prepare("SELECT data FROM workspace_records WHERE workspace_id=? AND NOT coalesce(json_extract(data,'$.trial'),0) AND substr(json_extract(data,'$.url'),1,?)=?").all(id,base.length+1,base+'?');
  for(const row of rows){
   const item=json(row);let other;try{other=new URL(item.url);}catch{continue;}
   if(other.origin+other.pathname!==base)continue;
   const otherParams=[...other.searchParams],[small,large]=params.length<=otherParams.length?[params,otherParams]:[otherParams,params];
   if(small.length&&small.every(([k,v])=>large.some(([ok,ov])=>ok===k&&ov===v)))return item;
  }
  return null;
 }
 assertRecordIdle(id,itemId){if(this.store.workspaces.tasks.list(id,{states:['pending','running','reported','paused']}).some(t=>taskHasRecord(t,itemId)))throw Error('Bu kayıt için işlem sırada veya çalışıyor');}
 star(id,itemId,starred){if(typeof starred!=='boolean')throw Error('Geçersiz yıldız durumu');const item=this.result(id,itemId);return this.putResult({...item,starred});}
 approve(id,itemId){this.assertRecordIdle(id,itemId);const a=this.get(id),item=this.result(id,itemId);if(!['prepared'].includes(item.status)||!item.proposal||item.trial||item.revision!==a.revision)throw Error('Güncel bir çalışma sonucundaki işlem taslağı gerekli');return this.putResult({...item,approvedDigest:item.digest});}
 dismiss(id,itemId,{stopActive=false}={}){return this.store.workspaces.tasks.atomic(()=>{
  const item=this.result(id,itemId);if(['executing','completed','uncertain'].includes(item.status))throw Error('İşlem geçmişi değiştirilemez');
  if(!stopActive)this.assertRecordIdle(id,itemId);
  const summary='Kullanıcı bu kaydı eledi. Bu kayıt için işleme devam etme.',a=this.get(id),at=this.now(),queue=this.store.workspaces.tasks;
  // Persist exclusion before closing a worker; late proposals and reservations
  // cannot revive the record, and other records keep their own tasks/questions.
  const saved=this.putResult({...item,status:'dismissed',approvedDigest:null,updatedAt:at});
  this.put({...a,questions:(a.questions??[]).map(q=>q.recordId===itemId&&q.answer==null?{...q,answer:summary,answerValues:null,answeredAt:at,resolution:'record_dismissed'}:q)});
  for(const task of queue.list(id).filter(t=>taskHasRecord(t,itemId))){
   if(task.resumeRecordAfterAnswer)queue.put({...task,resumeRecordAfterAnswer:false});
   if(task.state==='pending')queue.finish(id,task.id,'cancelled',summary);
  }
  this.event(id,'record_dismissed',{itemId});return saved;
 });}
 reserve(id,runId,itemId){
  const run=this.activeRun(id,runId),a=this.get(id),item=this.result(id,itemId),source=run.sourceUrl??recordSource(a,item),mode=source?sourceMode(a,source):'observe';
  if(run.operation&&findOperation(this.template(a.templateId),run.operation)&&operationFor(this.template(a.templateId),run.operation).effect!=='write')throw Error('Bu görev adımı gönderim yapamaz');
  if(run.recordId&&run.recordId!==itemId)throw Error('Kayıt bu göreve ait değil');
  const explicit=run.recordOperation==='execute'&&run.request?.manual&&run.request.revision===a.revision&&(run.request.direct===true||run.request.digest===item.digest);
  if(run.recordOperation==='execute'&&run.request?.manual&&!explicit)throw Error('Taslak veya kurulum değişti; yeniden onay gerekli');
  if(!explicit){const error=automaticAssessmentError(item.assessment,a.revision);if(error)throw Error(error);}
  if(!explicit&&item.requiresReview&&item.approvedDigest!==item.digest)throw Error('Değişen taslak yeniden onay bekliyor');
  if(run.kind!=='run'||mode==='observe'&&!explicit)throw Error('Bu çalışma yalnızca gözlem yapabilir');
  if(item.trial||item.revision!==a.revision||item.status!=='prepared'||!item.proposal)throw Error('Güncel ve gönderilmemiş işlem taslağı gerekli');
  if(run.actionId)throw Error('Önce mevcut işlemin sonucunu doğrula');
  if(!explicit&&mode!=='auto'&&item.approvedDigest!==item.digest)throw Error('İşlem kullanıcı onayı bekliyor');
  if(pendingRecordQuestion(a,item))throw Error('Önce bu işlem için bekleyen soruları yanıtla');
  // Both reservation and attempted state are durable before any browser write.
  this.putResult({...item,status:'executing',attemptedAt:this.now(),attemptRunId:runId,approvedDigest:null},{run:{...run,actionId:item.id}});
  return {reserved:true,itemId:item.id,proposal:item.proposal,url:item.actionUrl??item.url};
 }
 resolve(id,runId,itemId,{status,evidence,url,notSubmittedProof},page){
  const run=this.activeRun(id,runId),item=this.result(id,itemId);if(run.kind!=='run'||!['completed','uncertain','not_submitted'].includes(status)||!['executing','uncertain'].includes(item.status))throw Error('Doğrulanabilecek işlem bulunamadı');
  if(item.status==='executing'&&run.actionId!==item.id)throw Error('İşlem bu çalışmaya ait değil');
  if(run.recordId&&run.recordId!==itemId)throw Error('Kayıt bu göreve ait değil');
  const proofUrl=webUrl(url);if(!run.observations.some(o=>o.url===proofUrl&&o.at>=(item.attemptedAt??0)))throw Error('Önce sonuç adresindeki güncel durumu tarayıcıda gözlemle');
  if(status==='not_submitted'){
   if(run.recordOperation!=='verify'||run.recordId!==item.id||item.status!=='uncertain'||page?.url!==proofUrl)throw Error('Gönderilmedi sonucu yalnızca atanmış kayıt doğrulamasında bildirilebilir');
   const proof=validateNotSubmitted(item,notSubmittedProof,page),at=this.now();
   return this.putResult({...item,status:item.proposal?'prepared':'found',approvedDigest:null,requiresReview:true,evidence:boundedText(evidence,'Sonuç kanıtı',4000),proofUrl,verifiedAt:at,notSubmitted:{...proof,at,runId,attemptRunId:item.attemptRunId,digest:item.digest}},{run:{...run,verifiedNotSubmitted:item.id}});
  }
  return this.putResult({...item,status,evidence:boundedText(evidence,'Sonuç kanıtı',4000),proofUrl,verifiedAt:this.now()},{run:run.actionId===itemId?{...run,actionId:null}:undefined});
 }
 finish(id,runId,status,summary,{release=true}={}){return this.store.workspaces.tasks.atomic(()=>{
  const run=this.activeRun(id,runId);if(!['completed','partial','failed','blocked','interrupted','timeout'].includes(status))throw Error('Geçersiz çalışma sonucu');
  if(status==='completed'&&run.recordOperation)for(const itemId of taskRecordIds(run)){
   const item=this.result(id,itemId),question=(this.get(id).questions??[]).some(q=>q.recordId===item.id&&(q.answer==null||q.createdAt>=run.startedAt));
   if(run.recordOperation==='score'&&!recordScoredInTask(this,run,item)&&!question)throw Error('Önce bu kayıt için puanlama sonucunu kaydet veya eksik bilgi sorusunu sor');
   if(run.recordOperation==='prepare'&&!(item.status==='prepared'&&item.proposal&&item.runId===run.id)&&!question)throw Error('Önce bu kayıt için taslağı kaydet veya eksik bilgi sorusunu sor');
   if(run.recordOperation==='execute'&&item.status!=='completed'&&!run.actionId&&!(run.request?.direct!==true&&item.status==='prepared'&&item.digest!==run.request?.digest)&&!question)throw Error('Gönderim tamamlanmadı; gerçek sonucu doğrula veya engeli bildir');
   if(run.recordOperation==='verify'&&item.status!=='completed'&&!(run.verifiedNotSubmitted===item.id&&item.notSubmitted?.runId===run.id))throw Error('Sonuç henüz doğrulanmadı; belirsiz durumu koru ve engeli bildir');
  }
  if(status==='partial'&&(!run.sourceUrl||run.recordId||!run.scan?.pendingUrls.length))throw Error('Kısmi çalışma için kaydedilmiş kaynak devam noktası gerekli');
  if(run.actionId){const item=this.result(id,run.actionId);if(item.status==='executing')this.putResult({...item,status:'uncertain',evidence:'İşlem sonucu doğrulanamadı; tekrar gönderilmeden kontrol edilmeli.'});if(['completed','partial'].includes(status))status='blocked';}
  const a=this.get(id);if(run.kind==='trial'&&status==='completed'){
   const observed=run.observations.filter(o=>o.evidence.trim()).map(o=>o.url);
   if(!(run.sources??a.sources).every(url=>observed.some(o=>sameSite(o,url)))||!a.sources.length||a.revision!==run.revision){status='failed';summary='Deneme tamamlanamadı: her kaynakta güncel sayfa gözlemi veya CLI yanıtı gerekli.';}
  }
  let scanCompletion=null;
  if(status==='completed'&&run.kind==='run'&&run.sourceUrl&&!run.recordId&&run.scan?.complete){scanCompletion=validateWorkCompletion(run,run.scan);}
  this.putRun({...run,status,summary:boundedText(summary,'Çalışma özeti',6000),finishedAt:this.now(),actionId:null});
  if(run.kind==='run'&&run.sourceUrl&&!run.recordId&&run.scanPlan){const state=a.sourceState?.[run.sourceUrl]??{};
   a.sourceState={...a.sourceState,[run.sourceUrl]:{...state,scanState:scanCompletion?completeSourceScan(state.scanState,run.scanPlan,scanCompletion,this.now()):state.scanState}};
  }
  if(run.kind==='trial'){
   const trial={status:status==='completed'?'passed':'failed',runId,at:this.now()};
   for(const url of run.sources??[])if(a.sources.includes(url))a.sourceState={...a.sourceState,[url]:{...a.sourceState?.[url],trial}};
   if(!run.sourceUrl)a.trial={...trial,revision:run.revision};
   // A passed trial without a saved recipe leaves the source in discovery mode.
   if(run.sourceUrl&&status==='completed'&&!run.recipeSaved&&!a.sourceSettings?.[run.sourceUrl]?.recipe){
    a.sourceSettings={...a.sourceSettings,[run.sourceUrl]:{...a.sourceSettings?.[run.sourceUrl],recipe:{entry:{kind:'discovery'},pagination:'auto',notes:'Deneme turu reçete kaydetmedi.'}}};
    a.sourceState={...a.sourceState,[run.sourceUrl]:{...a.sourceState?.[run.sourceUrl],recipeState:{status:'discovery',successCount:0,failCount:0,learnedRunId:runId,learnedAt:this.now()}}};
   }
  }
  if(run.kind==='run'&&run.sourceUrl&&!run.recordId&&!run.recordOperation&&['completed','partial','failed'].includes(status)){
   const recipe=a.sourceSettings?.[run.sourceUrl]?.recipe,state=a.sourceState?.[run.sourceUrl]??{};
   if(recipe&&recipe.entry.kind!=='discovery'){
    const replay=recipeReplay(recipe,recipeValues(a,run.sourceUrl)),tasks=this.jevTasks.list(id,run.taskId??run.id);
    const urls=replayUrls(replay),outcome=recipeRunOutcome(replay,tasks),failed=tasks.find(t=>replayMatches(replay,t.input?.url)&&t.issue);
    const recipeState=advanceRecipeState(state.recipeState,outcome,{runId,now:this.now(),reason:failed?.issue?.reason??(outcome==='failure'?'no_listings':null),url:failed?.input?.url??urls[0]??null});
    // A stale recipe sends the source back to a trial so it can be relearned.
    a.sourceState={...a.sourceState,[run.sourceUrl]:{...state,recipeState,...(recipeState.status==='stale'&&state.recipeState?.status!=='stale'?{trial:null}:{})}};
   }
  }
  if(['run','trial'].includes(run.kind)&&a.status==='enabled'){
   if(run.sourceUrl&&!run.recordOperation){
    const blocked=['blocked','timeout','failed'].includes(status),state=a.sourceState?.[run.sourceUrl]??{};
    a.sourceState={...a.sourceState,[run.sourceUrl]:{...state,lastRunAt:this.now(),lastStatus:status,lastResult:summary,lastRunId:run.id,...(run.scan?{scan:run.scan}:{}),...(blocked?{blocked:true,nextRunAt:null,blocker:{...run.resumeContext,...(run.stop?{stop:run.stop}:{}),runId:run.id,workerId:run.workerId,recordId:run.recordId}}:{blocker:null})}};
   }else if(!run.recordOperation)a.nextRunAt=this.now()+a.intervalMinutes*60000;
   // An uncertain write is held on its record; independent sources and records
   // keep their schedules. Only an unscoped workspace failure stops the workspace.
   if(!run.actionId&&!run.sourceUrl&&!run.recordOperation&&['blocked','timeout','failed'].includes(status)){a.status='blocked';a.nextRunAt=null;a.retryPlan={};}
  }
  if(run.taskId){const queue=this.store.workspaces.tasks;if(release)queue.finish(id,run.taskId,status==='timeout'?'failed':status,summary);else queue.put({...queue.get(id,run.taskId),state:'reported',completionState:status==='timeout'?'failed':status,summary});}
  if(status==='completed'&&run.recordOperation==='verify'&&run.verifiedNotSubmitted&&run.taskId){const queue=this.store.workspaces.tasks;queue.put({...queue.get(id,run.taskId),resumeRecordAfterVerification:true});}
  this.put(a);return this.run(runId);
 });}
 recover(){for(const row of this.db.prepare("SELECT data FROM automation_runs WHERE json_extract(data,'$.status')='running'").all()){const run=json(row);this.putRun({...run,recoveredAfterCrash:true});this.finish(run.automationId,run.id,'interrupted','Uygulama kapandı. Kaydedilen sonuçlar korunuyor.');}}
 remove(id){this.assertIdle(id);this.get(id);this.db.exec('SAVEPOINT automation_delete');try{for(const t of ['automation_messages','automation_runs'])this.db.prepare(`DELETE FROM ${t} WHERE automation_id=?`).run(id);this.db.prepare('DELETE FROM automations WHERE id=?').run(id);removeImportedWorkspace(this.db,id);this.store.workspaces.remove(id);this.db.exec('RELEASE automation_delete');this.jevTasks.release(id);this.browserEvidence.release(id);}catch(e){this.db.exec('ROLLBACK TO automation_delete; RELEASE automation_delete');throw e;}}
 snapshot(id){
  const a=this.get(id),definition=this.template(a.templateId),tasks=this.store.workspaces.tasks.list(id),results=this.results(id),included=new Set(results.map(item=>item.id)),foundCounts=this.runFoundCounts(id);
  // A worker may prepare an older record outside the recent-results window.
  for(const task of tasks)if(['running','reported'].includes(task.state))for(const itemId of taskRecordIds(task))if(!included.has(itemId)){results.push(this.result(id,itemId));included.add(itemId);}
  return {automation:{...a,questions:(a.questions??[]).map(q=>this.questionContext(id,q))},definition,sources:this.sources(id),workers:this.store.workspaces.workers.list(id),tasks:tasks.slice(-100).reverse().map(taskSnapshot),messages:this.messages(id),runs:this.runs(id,{summary:true}).map(run=>({...run,foundCount:foundCounts.get(run.id)??0})),results:results.map(item=>({...item,recordAction:recordOperationState(this,id,item,{a,definition,tasks})})),resultCounts:this.resultCounts(id),missing:missingPlanFields(a,definition)};
 }
}
