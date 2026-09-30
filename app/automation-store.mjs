import {SourceSkills,sourceSkillSummary} from './source-skills.mjs';
import {sourceMethodIssue} from './source-method.mjs';
import {validateNotSubmitted} from './record-outcome.mjs';
import {scanWork,activeSearch,withScanWork,scanQueue,scanWorkSummary,declareScanSearches,selectScanSearch,reportWorkPage,updateScanQueue,completeScanSearch,validateWorkCompletion,scanPlanView,scanProgressView} from './scan-work.mjs';
import {answerContinuation} from './automation-continuation.mjs';
import {validateRecordTask,recordOperationState,pendingRecordQuestion} from './record-operations.mjs';
import {SiteAccess} from './site-access.mjs';
import {automationTrialReady,migrateSourceTrials} from './automation-trial.mjs';
import {normalizeFields,validateAnswers} from './question-forms.mjs';
import {removeImportedWorkspace} from './workspace-upgrade.mjs';
import {withAgentDefaults} from './agent-settings.mjs';
import {findOperation,operationFor} from './template-contract.mjs';
import {domainData} from './workspace-store.mjs';
import {contextCompactPercent} from './context-compaction.mjs';
import {contextRestartPercent} from './context-usage.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {reusableTemplate,planInput,missingPlanFields,defaultAutomationSettings,boundedText,webUrl} from './automation-templates.mjs';
import {automationTable,automationCells,defaultAutomationTable} from './automation-templates.mjs';
import {automationSources,sourceInput,sourceMode} from './automation-sources.mjs';
import {beginSourceScan,sourceScanScope,advanceSourceScan,completeSourceScan} from './source-scan.mjs';
import {scanCheckpoint} from './automation-scan.mjs';

const json=row=>row?JSON.parse(row.data):null;
const integer=(value,label,min,max)=>{if(!Number.isInteger(value)||value<min||value>max)throw Error(`${label}: ${min}–${max} arasında tam sayı gerekli`);return value;};
const planKey=value=>JSON.stringify([value.title,value.goal,value.criteria,value.sources,value.instructions,value.facts]);
function agentSettings(input){
 if(!['codex','claude'].includes(input?.provider))throw Error('Desteklenmeyen sağlayıcı');
 input=withAgentDefaults(input);
 for(const key of ['model','permission','reasoning'])boundedText(input[key],key,120);
 if(![true,false,null].includes(input.network))throw Error('Geçersiz ağ ayarı');
 return {provider:input.provider,model:input.model,permission:input.permission,reasoning:input.reasoning,network:input.provider==='codex'?input.network:null,contextCompactPercent:contextCompactPercent(input.contextCompactPercent),...(input.contextRestartPercent===undefined?{}:{contextRestartPercent:contextRestartPercent(input.contextRestartPercent)})};
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
   CREATE INDEX IF NOT EXISTS automation_messages_owner ON automation_messages(automation_id);`);
  this.sourceSkills=new SourceSkills(this);
  migrateSourceTrials(this);
 }
 has(id){return Boolean(this.db.prepare('SELECT 1 FROM automations WHERE id=?').get(id));}
 conversation(id,provider){return this.store.workspaces.history(id).conversation(id,provider);}
 conversationSettings(id,provider,nativeId){return this.store.workspaces.history(id).conversationSettings(id,provider,nativeId);}
 saveConversation(id,provider,nativeId,settings){return this.store.workspaces.history(id).saveConversation(id,provider,nativeId,settings);}
 forgetConversation(id,provider,nativeId){return this.store.workspaces.history(id).forgetConversation(id,provider,nativeId);}
 get(id){const a=json(this.db.prepare('SELECT data FROM automations WHERE id=?').get(id));if(!a)throw Error('Otomasyon bulunamadı');delete a.maxActionsTotal;delete a.maxActionsPerDay;delete a.endAt;delete a.timeoutMinutes;delete a.maxBrowserSteps;if(a.questions)a.questions=a.questions.map(q=>this.questionScope(id,q));return {...a,...this.store.workspaces.fields(id),table:this.store.workspaces.table(id)};}
 catalog(){return [...this.store.workspaces.registry.catalog(),...this.db.prepare('SELECT data FROM automation_templates ORDER BY rowid DESC').all().map(json).filter(input=>this.store.workspaces.registry.supports(input)).map(input=>this.store.workspaces.registry.normalize(input))];}
 template(id){return this.store.workspaces.template(id);}
 saveTemplate(input){const template={...reusableTemplate(input,value=>this.store.workspaces.registry.normalize(value)),id:'template-'+randomUUID(),personal:true};this.db.prepare('INSERT INTO automation_templates VALUES(?,?)').run(template.id,JSON.stringify(template));return template;}
 list(){return this.db.prepare('SELECT id FROM automations ORDER BY rowid DESC').all().map(row=>this.get(row.id));}
 put(a){a={...a};delete a.maxActionsTotal;delete a.maxActionsPerDay;delete a.endAt;this.db.exec('SAVEPOINT save_workspace_plan');try{this.store.workspaces.save(a.id,a.templateId,a);this.db.prepare('INSERT INTO automations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(a.id,JSON.stringify(domainData(a)));this.db.exec('RELEASE save_workspace_plan');return this.get(a.id);}catch(error){this.db.exec('ROLLBACK TO save_workspace_plan; RELEASE save_workspace_plan');throw error;}}
 create(templateId,input={}){
  const template=this.template(templateId);if(template.kind!=='web')throw Error('İş arama için aday kurulumunu kullan');
  const a={id:randomUUID(),templateId,templateVersion:template.version,...planInput(template,input),mode:template.defaultMode,browserMode:'separate',chromeProfile:null,intervalMinutes:30,agentSettings:agentSettings(input.agentSettings??defaultAutomationSettings),revision:1,reviewedRevision:null,trial:null,sourceTrialsVersion:1,status:'draft',nextRunAt:null,createdAt:this.now(),updatedAt:this.now()};
  a.table=template.table?automationTable(template.table):defaultAutomationTable(templateId);this.put(a);this.message(a.id,'assistant',`Ne yapmak istediğini anlat. ${template.fields[0].question}`);return a;
 }
 assertIdle(id){if(this.db.prepare("SELECT 1 FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.status')='running'").get(id))throw Error('Önce çalışan otomasyonu durdur');}
 save(id,input,{agent=false}={}){
  const previous=this.get(id),template=this.template(previous.templateId),plan=planInput(template,input,previous);
  // Provider settings apply on the next launch, like the original Agent page.
  // All plan and authority changes still require an idle workspace.
  if(!agent&&!(Object.keys(input).length===1&&input.agentSettings))this.assertIdle(id);
  const changed=planKey(previous)!==planKey({...previous,...plan}),a={...previous,...plan,updatedAt:this.now()};
  if(agent){if(previous.status==='enabled')throw Error('Etkin otomasyon kurulum sırasında değiştirilemez');}
  else{
   const mode=input.mode??previous.mode;if(!['observe','prepare','auto'].includes(mode))throw Error('Geçersiz işlem yetkisi');a.mode=mode;
   for(const [key,label,min,max]of [['intervalMinutes','Tarama aralığı',1,10080]])a[key]=integer(input[key]??previous[key],label,min,max);
   if(input.browserMode!==undefined){if(!['separate','jev'].includes(input.browserMode))throw Error('Geçersiz tarayıcı seçimi');a.browserMode=input.browserMode;}
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
  if(a.browserMode!==previous.browserMode){a.trial=null;for(const state of Object.values(a.sourceState??{}))state.trial=null;}
  if(a.browserMode!==previous.browserMode||JSON.stringify(a.chromeProfile)!==JSON.stringify(previous.chromeProfile)){a.status='paused';a.nextRunAt=null;}
  // Saving settings never resumes a paused automation or grants a trial.
  return this.put(a);
 }
 review(id){this.assertIdle(id);const a=this.get(id),missing=missingPlanFields(a,this.template(a.templateId));if(missing.length)throw Error('Eksik bilgiler: '+missing.join(', '));return this.put({...a,reviewedRevision:a.revision,status:'ready',nextRunAt:null});}
 enable(id){this.assertIdle(id);const a=this.get(id);if(a.reviewedRevision!==a.revision)throw Error('Önce kurulumu kaydet');return this.put({...a,status:'enabled',batchId:null,once:false,onceSources:null,nextRunAt:this.now()});}
 skipTrial(id){
  this.assertIdle(id);const a=this.get(id);
  if(a.reviewedRevision!==a.revision)throw Error('Önce kurulum kartını kontrol edip kaydet');
  if((a.questions??[]).some(q=>q.answer==null))throw Error('Önce kurulum sorularını yanıtla');
  if(automationTrialReady(a))return a;
  return this.put({...a,trial:{revision:a.revision,status:'skipped',at:this.now()},status:'ready',nextRunAt:null,retryPlan:{},updatedAt:this.now()});
 }
 pause(id,status='paused'){const a=this.get(id);return this.put({...a,status,nextRunAt:null,retryPlan:{},updatedAt:this.now()});}
 sources(id){
  const a=this.get(id),runs=this.runs(id),records=this.results(id,{all:true});
  return automationSources(a).map(source=>{
   const last=runs.find(r=>!r.recordId&&!r.recordOperation&&['run','trial'].includes(r.kind)&&(r.sourceUrl===source.url||!r.sourceUrl&&r.sources?.length===1&&r.sources[0]===source.url));
   const active=runs.find(r=>!r.recordId&&!r.recordOperation&&r.status==='running'&&['run','trial'].includes(r.kind)&&(r.sourceUrl===source.url||r.sources?.length===1&&r.sources[0]===source.url));
   const resultCount=records.filter(r=>!r.trial&&(r.sourceUrl?r.sourceUrl===source.url:new URL(r.url).origin===new URL(source.url).origin&&a.sources.filter(url=>new URL(url).origin===new URL(source.url).origin).length===1)).length;
   return {...(last?{lastRunAt:last.finishedAt,lastStatus:last.status,lastResult:last.summary,blocked:['blocked','failed','timeout'].includes(last.status),lastFound:records.filter(r=>!r.trial&&r.runId===last.id).length}:{}),...source,learnedSkill:sourceSkillSummary(this.sourceSkills.get(id,source.url)),siteWait:this.siteAccess.status(source.url),pageProgress:active&&!active.recordId?active.pageProgress??null:source.pageProgress??null,observedPage:active?.observedPage??source.observedPage??null,resultCount,scanning:Boolean(active),trialRunning:active?.kind==='trial',scanIssue:active?Object.values(active.scanIssues??{}).sort((a,b)=>b.at-a.at)[0]??null:null,workerId:active?.workerId??null};
  });
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
  if(!intervalOnly&&this.runs(id).some(r=>r.status==='running'&&(r.sourceUrl===url||r.kind==='interview'||!r.sourceUrl)))throw Error('Önce bu kaynağın çalışan görevini durdur');
  const old=a.sourceSettings?.[url]??{};
  a.sourceSettings={...a.sourceSettings,[url]:settings};
  if(old.query!==settings.query||old.mode!==settings.mode)this.clearApprovals(id);
  const scopeChanged=sourceScanScope({...a,sourceSettings:{...a.sourceSettings,[url]:old}},url)!==sourceScanScope(a,url);
  const state=scopeChanged?{trial:a.sourceState?.[url]?.trial??null,nextRunAt:this.now(),blocked:false,lastRunAt:null,lastStatus:null,lastFound:0,lastResult:'Arama kapsamı değişti. Yeni tam tarama bekleniyor.'}:a.sourceState?.[url]??{};
  if(scopeChanged)for(const task of this.store.workspaces.tasks.list(id,{states:['pending']}))if(task.sourceUrl===url)this.store.workspaces.tasks.finish(id,task.id,'cancelled','Kaynak arama kapsamı değişti');
  a.sourceState={...a.sourceState,[url]:{...state,...(settings.intervalMinutes!==old.intervalMinutes&&!state.blocked?{nextRunAt:state.lastRunAt?state.lastRunAt+(settings.intervalMinutes??a.intervalMinutes)*60000:this.now()}:{})}};
  return this.put(a);
 }
 event(id,kind,data){this.get(id);this.db.prepare('INSERT INTO workspace_events(workspace_id,kind,data,at) VALUES(?,?,?,?)').run(id,kind,JSON.stringify(data),this.now());}
 questionScope(id,question){
  if(question.recordId||Object.hasOwn(question,'sourceUrl'))return question;
  // Recover the scope of older questions from their durable task, never from
  // the currently assigned worker or a guessed URL host.
  const task=question.taskId?json(this.db.prepare('SELECT data FROM workspace_tasks WHERE workspace_id=? AND id=?').get(id,question.taskId)):null;
  return {...question,sourceUrl:task&&!task.recordId?task.sourceUrl??null:null};
 }
 askQuestion(id,{text,recordId=null,fields=null,accessCheck=null},{runId}={}){
  text=boundedText(text,'Soru',6000);fields=normalizeFields(fields);if(recordId&&this.result(id,recordId).status==='dismissed')throw Error('Elenen kayıt için soru sorulamaz');
  const run=runId?this.activeRun(id,runId):null,sourceUrl=!recordId&&['run','trial'].includes(run?.kind)?run.sourceUrl??null:null;
  const a=this.get(id),previous=(a.questions??[]).find(q=>q.answer==null&&q.text===text&&q.recordId===recordId&&(q.sourceUrl??null)===sourceUrl&&JSON.stringify(q.fields??null)===JSON.stringify(fields));if(previous)return previous;
  const question={id:randomUUID(),text,recordId,sourceUrl,fields,...(accessCheck?{accessCheck}:{}),answer:null,createdAt:this.now(),...(run?{runId:run.id}:{}),...(run?.taskId?{taskId:run.taskId}:{}),...(run?.resumeContext?{browserContext:{...run.resumeContext,runId:run.id,workerId:run.workerId,sourceUrl:run.sourceUrl}}:{})};
  this.store.workspaces.tasks.atomic(()=>{this.put({...a,questions:[...(a.questions??[]),question]});this.event(id,'question_asked',{id:question.id});});return question;
 }
 answerQuestion(id,questionId,value){
  const a=this.get(id),question=(a.questions??[]).find(q=>q.id===questionId);
  if(!question)throw Error('Soru bu çalışma alanına ait değil');if(question.answer!==null)throw Error('Bu soru zaten yanıtlandı');
  const result=question.fields&&typeof value!=='string'?validateAnswers(question.fields,value):{summary:boundedText(value,'Yanıt',10000),values:null},answer=result.summary;
  const updated={...question,answer,answerValues:result.values,answeredAt:this.now()};
  this.store.workspaces.tasks.atomic(()=>{this.put({...a,questions:a.questions.map(q=>q.id===questionId?updated:q)});this.message(id,'user',question.text+'\nYanıt: '+answer);this.event(id,'question_answered',{id:questionId});});return updated;
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
 message(id,role,text){this.get(id);if(!['user','assistant','system'].includes(role))throw Error('Geçersiz mesaj');const m={id:randomUUID(),automationId:id,role,text:boundedText(text,'Mesaj',12000),at:this.now()};this.db.prepare('INSERT INTO automation_messages VALUES(?,?,?)').run(m.id,id,JSON.stringify(m));return m;}
 messages(id){this.get(id);return this.db.prepare('SELECT data FROM (SELECT rowid,data FROM automation_messages WHERE automation_id=? ORDER BY rowid DESC LIMIT 100) ORDER BY rowid').all(id).map(json);}
 runs(id){this.get(id);return this.db.prepare("SELECT data FROM automation_runs WHERE automation_id=? AND (json_extract(data,'$.status')='running' OR rowid IN (SELECT rowid FROM automation_runs WHERE automation_id=? ORDER BY rowid DESC LIMIT 30)) ORDER BY rowid DESC").all(id,id).map(json);}
 run(id){const r=json(this.db.prepare('SELECT data FROM automation_runs WHERE id=?').get(id));if(!r)throw Error('Çalışma bulunamadı');return r;}
 putRun(run){this.db.prepare('INSERT INTO automation_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.automationId,JSON.stringify(run));return run;}
 begin(id,input,workerId='main'){return this.store.workspaces.tasks.atomic(()=>{
  const {kind,taskId}=typeof input==='string'?{kind:input}:input;
  if(!taskId)this.assertIdle(id);const a=this.get(id);this.store.workspaces.workers.get(id,workerId);if(!['interview','trial','run'].includes(kind))throw Error('Geçersiz çalışma');
  if(kind!=='interview'&&!(taskId&&this.store.workspaces.tasks.get(id,taskId).recordOperation==='verify')&&a.reviewedRevision!==a.revision)throw Error('Önce kurulum kartını kontrol edip kaydet');
  if(!taskId&&['interview','trial'].includes(kind)&&a.status==='enabled')this.pause(id);
  const queue=this.store.workspaces.tasks,task=taskId?queue.get(id,taskId):queue.enqueue(id,{operation:kind,lockKey:'workspace',capability:'browser.observe'});validateRecordTask(this,id,task,this.now());queue.claim(id,task.id,workerId);
  if(!taskId&&['interview','trial'].includes(kind)&&Object.keys(a.retryPlan??{}).length)this.put({...this.get(id),retryPlan:{}});
  const state=a.sourceState?.[task.sourceUrl]??{},scopeKey=task.sourceUrl?sourceScanScope(a,task.sourceUrl):null;
  const scopeMatches=!state.scanState||state.scanState.scopeKey===scopeKey;
  const savedScan=!task.recordId&&scopeMatches&&(task.scan??state.scan),pageProgress=scopeMatches?state.pageProgress:null;
  const scanState=kind==='run'&&task.sourceUrl&&!task.recordId?beginSourceScan(state.scanState,scopeKey,this.now()):null;
  if(scanState){this.put({...a,sourceState:{...a.sourceState,[task.sourceUrl]:{...state,scanState}}});queue.put({...queue.get(id,task.id),scanPlan:scanState.active});}
  const continuation=answerContinuation(this,id,task,kind),runId=randomUUID();
  if(continuation){queue.put({...queue.get(id,task.id),continuation});const current=this.get(id);this.put({...current,questions:(current.questions??[]).map(q=>continuation.questionIds.includes(q.id)?{...q,continuationRunId:runId}:q)});}
  return this.putRun({id:runId,...(continuation?{continuation}:{}),automationId:id,workerId,taskId:task.id,operation:task.operation,...(task.recordOperation?{recordOperation:task.recordOperation,request:task.request}:{}),sources:task.sources??a.sources,sourceUrl:task.sourceUrl??null,recordId:task.recordId??null,batchId:task.batchId??null,...(scanState?{scanPlan:scanState.active}:{}),...(kind==='run'&&savedScan&&!savedScan.complete?{scan:savedScan,...(pageProgress?{pageProgress}:{})}:{}),kind,revision:a.revision,status:'running',state:'Starting',startedAt:this.now(),finishedAt:null,browserSteps:0,observations:[],summary:'Başlatılıyor',actionId:null});
 });}
 activeRun(automationId,runId){const run=this.run(runId);if(run.automationId!==automationId||run.status!=='running')throw Error('Çalışma oturumu geçersiz');return run;}
 spendStep(id,runId,{research=false}={}){const run=this.activeRun(id,runId);if(run.kind==='interview'&&!research)throw Error('Kurulum sırasında yalnızca kaynak araştırması yapılabilir');if(research&&run.kind!=='interview')throw Error('Kaynak araştırması yalnızca kurulum sırasında yapılabilir');run.browserSteps++;this.putRun(run);}
 reportPage(id,runId,pageProgress){return this.store.workspaces.tasks.atomic(()=>{
  const run=this.activeRun(id,runId);if(run.kind!=='run'||!run.sourceUrl||run.recordId)throw Error('Sayfa bildirimi yalnızca kaynak taramasında kullanılabilir.');
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
 saveScanSearches(id,runId,searches){return this.store.workspaces.tasks.atomic(()=>{
  const run=this.scanWorkRun(id,runId),work=declareScanSearches(run,searches);
  this.persistScan(id,{...run,scan:withScanWork(run,work)});return scanWorkSummary(this.run(runId));
 });}
 selectScanSearch(id,runId,searchId){return this.store.workspaces.tasks.atomic(()=>{
  const run=this.scanWorkRun(id,runId),selected=selectScanSearch(run,searchId);
  this.persistScan(id,{...run,scan:withScanWork(run,selected.work),scanPlan:selected.plan,pageProgress:selected.pageProgress,observedPage:null});
  return {scanWork:scanWorkSummary(this.run(runId)),scanPlan:scanPlanView(selected.plan)};
 });}
 completeScanSearch(id,runId,completion,snapshot){return this.store.workspaces.tasks.atomic(()=>{
  const run=this.scanWorkRun(id,runId),work=completeScanSearch(run,completion,snapshot.url);
  this.persistScan(id,{...run,scan:withScanWork(run,work)});return scanWorkSummary(this.run(runId));
 });}
 saveScanProgress(id,runId,input,snapshot){return this.store.workspaces.tasks.atomic(()=>{
  const run=this.scanWorkRun(id,runId);
  if(!Array.isArray(input.pendingUrls)||input.pendingUrls.length>100)throw Error('Bir seferde en fazla 100 bekleyen adres ekle; kalanları sonraki çağrıda ekleyebilirsin.');
  scanCheckpoint(run,{complete:false,pendingUrls:input.pendingUrls,reason:input.reason,evidenceUrl:snapshot.url},{checkpoint:true});
  const work=updateScanQueue(run,input,snapshot),search=activeSearch(work);
  if(input.chronology?.fromStart&&run.observedPage?.url===snapshot.url&&run.observedPage.currentPage!==1)throw Error('Başlangıç kanıtı ilk sonuç sayfasından gelmeli.');
  const scanPlan=advanceSourceScan(run.scanPlan,{...input,pendingUrls:search.pendingUrls},snapshot,runId,this.now());search.plan=scanPlan;
  const scan=withScanWork(run,work,{reason:input.reason,evidenceUrl:snapshot.url});
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
  if(!previous)this.event(item.automationId,'job_found',{id:saved.id});else if(previous.status!==item.status)this.event(item.automationId,item.status==='completed'?'submission_recorded':'record_updated',{id:saved.id});
  return saved;
 });}
 configureTable(id,input){this.get(id);this.store.workspaces.configureTable(id,input);return this.get(id);}
 rename(id,title){this.assertIdle(id);return this.put({...this.get(id),title:boundedText(title,'Ad',150)});}
 updateCells(id,itemId,input){return this.store.workspaces.updateCells(id,itemId,input);}
 record(id,runId,input){
  const run=this.activeRun(id,runId),research=run.kind==='interview';
  const observedUrl=webUrl(input.url),inputKey=boundedText(input.key??observedUrl,'Sonuç anahtarı',2000);
  let url=observedUrl,key=this.template(this.get(id).templateId).records.identity==='url'?url:inputKey;
  let previous=this.store.workspaces.records.find(id,key),actionUrl=previous?.actionUrl;
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
  if(previous&&!run.recordId&&this.store.workspaces.tasks.list(id,{states:['running','reported','paused']}).some(t=>t.recordId===previous.id))return {...previous,duplicate:true};
  const title=boundedText(input.title,'Başlık',300),summary=boundedText(input.summary,'Özet',6000),proposal=boundedText(input.proposal??previous?.proposal??'','İşlem taslağı',12000,{empty:true});
  const digest=createHash('sha256').update(JSON.stringify(actionUrl?[url,proposal,actionUrl]:[url,proposal])).digest('hex');
  if(input.proposal!==undefined&&(input.proposal.trim()||previous?.proposal)&&run.operation&&findOperation(this.template(this.get(id).templateId),run.operation)&&operationFor(this.template(this.get(id).templateId),run.operation).effect==='read')throw Error('Bu adım yalnızca gözlem ve değerlendirme yapabilir');
  const cells=input.cells===undefined?{}:automationCells(input.cells,this.get(id).table);
  const initial=this.template(this.get(id).templateId).records.initial;
  const item={...previous,...(!previous?.workflowState&&initial&&initial!=='found'?{workflowState:initial}:{}),id:previous?.id??randomUUID(),automationId:id,key,url,...(actionUrl||previous?.actionUrl?{actionUrl}:{}),title,summary,proposal,digest,status:proposal?'prepared':'found',approvedDigest:previous?.digest===digest?previous.approvedDigest:null,createdAt:previous?.createdAt??this.now(),updatedAt:this.now(),runId,revision:proposal&&input.proposal===undefined&&previous?previous.revision:run.revision,trial:run.kind!=='run',sampleKind:research?'interview':null,cells:{...previous?.cells,...cells},starred:previous?.starred??false};
  if(run.recordOperation==='execute'&&run.request?.manual&&run.request.direct!==true&&digest!==run.request.digest)item.requiresReview=true;
  if(run.sourceUrl)item.sourceUrl=run.sourceUrl;
  return this.putResult(item);
 }
 assertRecordIdle(id,itemId){if(this.store.workspaces.tasks.list(id,{states:['pending','running','reported','paused']}).some(t=>t.recordId===itemId))throw Error('Bu kayıt için işlem sırada veya çalışıyor');}
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
  for(const task of queue.list(id).filter(t=>t.recordId===itemId)){
   if(task.resumeRecordAfterAnswer)queue.put({...task,resumeRecordAfterAnswer:false});
   if(task.state==='pending')queue.finish(id,task.id,'cancelled',summary);
  }
  this.event(id,'record_dismissed',{itemId});return saved;
 });}
 reserve(id,runId,itemId){
  const run=this.activeRun(id,runId),a=this.get(id),item=this.result(id,itemId),mode=sourceMode(a,run.sourceUrl??item.sourceUrl);
  if(run.operation&&findOperation(this.template(a.templateId),run.operation)&&operationFor(this.template(a.templateId),run.operation).effect!=='write')throw Error('Bu görev adımı gönderim yapamaz');
  if(run.recordId&&run.recordId!==itemId)throw Error('Kayıt bu göreve ait değil');
  const explicit=run.recordOperation==='execute'&&run.request?.manual&&run.request.revision===a.revision&&(run.request.direct===true||run.request.digest===item.digest);
  if(run.recordOperation==='execute'&&run.request?.manual&&!explicit)throw Error('Taslak veya kurulum değişti; yeniden onay gerekli');
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
  if(status==='completed'&&run.recordOperation){
   const item=this.result(id,run.recordId),question=(this.get(id).questions??[]).some(q=>q.recordId===item.id&&(q.answer==null||q.createdAt>=run.startedAt));
   if(run.recordOperation==='prepare'&&!(item.status==='prepared'&&item.proposal&&item.runId===run.id)&&!question)throw Error('Önce bu kayıt için taslağı kaydet veya eksik bilgi sorusunu sor');
   if(run.recordOperation==='execute'&&item.status!=='completed'&&!run.actionId&&!(run.request?.direct!==true&&item.status==='prepared'&&item.digest!==run.request?.digest)&&!question)throw Error('Gönderim tamamlanmadı; gerçek sonucu doğrula veya engeli bildir');
   if(run.recordOperation==='verify'&&item.status!=='completed'&&!(run.verifiedNotSubmitted===item.id&&item.notSubmitted?.runId===run.id))throw Error('Sonuç henüz doğrulanmadı; belirsiz durumu koru ve engeli bildir');
  }
  if(status==='partial'&&(!run.sourceUrl||run.recordId||!run.scan?.pendingUrls.length))throw Error('Kısmi çalışma için kaydedilmiş kaynak devam noktası gerekli');
  if(run.actionId){const item=this.result(id,run.actionId);if(item.status==='executing')this.putResult({...item,status:'uncertain',evidence:'İşlem sonucu doğrulanamadı; tekrar gönderilmeden kontrol edilmeli.'});if(['completed','partial'].includes(status))status='blocked';}
  const a=this.get(id);if(run.kind==='trial'&&status==='completed'){
   const hosts=new Set(run.observations.filter(o=>o.evidence.trim()).map(o=>new URL(o.url).origin));
   if(!(run.sources??a.sources).every(url=>hosts.has(new URL(url).origin))||!a.sources.length||a.revision!==run.revision){status='failed';summary='Deneme tamamlanamadı: her kaynakta gerçek sayfa gözlemi gerekli.';}
  }
  if(run.kind==='trial'&&run.sourceUrl&&status==='completed'&&!run.sourceSkillVersion){status='failed';summary='Deneme tamamlanamadı: öğrenilen kaynak yöntemini ve denenmeyen bölümleri skill olarak kaydet.';}
  if(run.kind==='trial'&&status==='completed'){const issue=sourceMethodIssue(run,a.sourceSettings?.[run.sourceUrl]);if(issue){status='failed';summary=issue;}}
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
 recover(){for(const row of this.db.prepare("SELECT data FROM automation_runs WHERE json_extract(data,'$.status')='running'").all()){const run=json(row);this.finish(run.automationId,run.id,'interrupted','Uygulama kapandı. Kaydedilen sonuçlar korunuyor.');}}
 remove(id){this.assertIdle(id);this.get(id);this.db.exec('SAVEPOINT automation_delete');try{for(const t of ['automation_messages','automation_runs'])this.db.prepare(`DELETE FROM ${t} WHERE automation_id=?`).run(id);this.db.prepare('DELETE FROM automations WHERE id=?').run(id);removeImportedWorkspace(this.db,id);this.store.workspaces.remove(id);this.db.exec('RELEASE automation_delete');}catch(e){this.db.exec('ROLLBACK TO automation_delete; RELEASE automation_delete');throw e;}}
 snapshot(id){
  const a=this.get(id),definition=this.template(a.templateId),tasks=this.store.workspaces.tasks.list(id),results=this.results(id),included=new Set(results.map(item=>item.id));
  // A worker may prepare an older record outside the recent-results window.
  for(const task of tasks)if(task.recordId&&['running','reported'].includes(task.state)&&!included.has(task.recordId)){results.push(this.result(id,task.recordId));included.add(task.recordId);}
  return {automation:{...a,questions:(a.questions??[]).map(q=>this.questionContext(id,q))},definition,sources:this.sources(id),workers:this.store.workspaces.workers.list(id),tasks:tasks.slice(-100).reverse(),messages:this.messages(id),runs:this.runs(id),results:results.map(item=>({...item,recordAction:recordOperationState(this,id,item,{a,definition,tasks})})),resultCounts:this.resultCounts(id),missing:missingPlanFields(a,definition)};
 }
}
