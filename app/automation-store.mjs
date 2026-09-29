import {operationFor} from './template-contract.mjs';
import {domainData} from './workspace-store.mjs';
import {contextCompactPercent} from './context-compaction.mjs';
import {contextRestartPercent} from './context-usage.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {reusableTemplate,planInput,missingPlanFields,defaultAutomationSettings,boundedText,webUrl} from './automation-templates.mjs';
import {automationTable,automationCells,defaultAutomationTable} from './automation-templates.mjs';
import {automationSources,sourceInput,sourceMode} from './automation-sources.mjs';

const json=row=>row?JSON.parse(row.data):null;
const integer=(value,label,min,max)=>{if(!Number.isInteger(value)||value<min||value>max)throw Error(`${label}: ${min}–${max} arasında tam sayı gerekli`);return value;};
const planKey=value=>JSON.stringify([value.title,value.goal,value.criteria,value.sources,value.instructions,value.facts]);
function agentSettings(input){
 if(!['codex','claude'].includes(input?.provider))throw Error('Desteklenmeyen sağlayıcı');
 for(const key of ['model','permission','reasoning'])boundedText(input[key],key,120);
 if(![true,false,null].includes(input.network))throw Error('Geçersiz ağ ayarı');
 return {provider:input.provider,model:input.model,permission:input.permission,reasoning:input.reasoning,network:input.provider==='codex'?input.network:null,contextCompactPercent:contextCompactPercent(input.contextCompactPercent),...(input.contextRestartPercent===undefined?{}:{contextRestartPercent:contextRestartPercent(input.contextRestartPercent)})};
}
export class AutomationStore {
 constructor(store,{now=()=>Date.now()}={}){
  this.store=store;this.db=store.db;this.now=now;
  this.db.exec(`CREATE TABLE IF NOT EXISTS automation_templates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automation_runs(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automation_messages(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS automation_runs_owner ON automation_runs(automation_id);
   CREATE INDEX IF NOT EXISTS automation_messages_owner ON automation_messages(automation_id);`);
 }
 has(id){return Boolean(this.db.prepare('SELECT 1 FROM automations WHERE id=?').get(id));}
 conversation(id,provider){return this.store.workspaces.history(id).conversation(id,provider);}
 conversationSettings(id,provider,nativeId){return this.store.workspaces.history(id).conversationSettings(id,provider,nativeId);}
 saveConversation(id,provider,nativeId,settings){return this.store.workspaces.history(id).saveConversation(id,provider,nativeId,settings);}
 forgetConversation(id,provider,nativeId){return this.store.workspaces.history(id).forgetConversation(id,provider,nativeId);}
 get(id){const a=json(this.db.prepare('SELECT data FROM automations WHERE id=?').get(id));if(!a)throw Error('Otomasyon bulunamadı');return {...a,...this.store.workspaces.fields(id),table:this.store.workspaces.table(id)};}
 catalog(){return [...this.store.workspaces.registry.catalog(),...this.db.prepare('SELECT data FROM automation_templates ORDER BY rowid DESC').all().map(json).filter(input=>this.store.workspaces.registry.supports(input)).map(input=>this.store.workspaces.registry.normalize(input))];}
 template(id){return this.store.workspaces.template(id);}
 saveTemplate(input){const template={...reusableTemplate(input,value=>this.store.workspaces.registry.normalize(value)),id:'template-'+randomUUID(),personal:true};this.db.prepare('INSERT INTO automation_templates VALUES(?,?)').run(template.id,JSON.stringify(template));return template;}
 list(){return this.db.prepare('SELECT id FROM automations ORDER BY rowid DESC').all().map(row=>this.get(row.id));}
 put(a){this.db.exec('SAVEPOINT save_workspace_plan');try{this.store.workspaces.save(a.id,a.templateId,a);this.db.prepare('INSERT INTO automations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(a.id,JSON.stringify(domainData(a)));this.db.exec('RELEASE save_workspace_plan');return this.get(a.id);}catch(error){this.db.exec('ROLLBACK TO save_workspace_plan; RELEASE save_workspace_plan');throw error;}}
 create(templateId,input={}){
  const template=this.template(templateId);if(template.kind!=='web')throw Error('İş arama için aday kurulumunu kullan');
  const a={id:randomUUID(),templateId,templateVersion:template.version,...planInput(template,input),mode:template.defaultMode,browserMode:'separate',chromeProfile:null,intervalMinutes:30,timeoutMinutes:10,maxActionsPerDay:5,maxBrowserSteps:80,endAt:null,agentSettings:agentSettings(input.agentSettings??defaultAutomationSettings),revision:1,reviewedRevision:null,trial:null,status:'draft',nextRunAt:null,createdAt:this.now(),updatedAt:this.now()};
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
   for(const [key,label,min,max]of [['intervalMinutes','Tarama aralığı',1,10080],['timeoutMinutes','Tur süresi',1,60],['maxActionsPerDay','Günlük işlem sınırı',1,1000],['maxBrowserSteps','Tur başına tarayıcı adımı',5,500]])a[key]=integer(input[key]??previous[key],label,min,max);
   if(input.endAt!==undefined){if(input.endAt!==null&&(!Number.isFinite(input.endAt)||input.endAt<=this.now()))throw Error('Bitiş tarihi gelecekte olmalı');a.endAt=input.endAt;}
   if(input.browserMode!==undefined){if(!['separate','jev'].includes(input.browserMode))throw Error('Geçersiz tarayıcı seçimi');a.browserMode=input.browserMode;}
   if(input.chromeProfile!==undefined){const profile=input.chromeProfile;if(profile!==null&&(!profile||typeof profile!=='object'||!/^[-\w ]{1,100}$/.test(profile.directory??'')))throw Error('Geçersiz Chrome profili');a.chromeProfile=profile===null?null:{directory:profile.directory,name:boundedText(profile.name,'Chrome profili',300)};}
   if(input.agentSettings)a.agentSettings=agentSettings(input.agentSettings);
  }
  if(changed){for(const task of this.store.workspaces.tasks.list(id,{states:['pending']}))this.store.workspaces.tasks.finish(id,task.id,'cancelled','Plan değişti');a.batchId=null;a.sourceState={};a.revision++;a.reviewedRevision=null;a.trial=null;a.status='draft';a.nextRunAt=null;this.clearApprovals(id);}
  if(a.browserMode!==previous.browserMode||JSON.stringify(a.chromeProfile)!==JSON.stringify(previous.chromeProfile)){a.trial=null;a.status='paused';a.nextRunAt=null;}
  // Saving settings never resumes a paused automation or grants a trial.
  return this.put(a);
 }
 review(id){this.assertIdle(id);const a=this.get(id),missing=missingPlanFields(a,this.template(a.templateId));if(missing.length)throw Error('Eksik bilgiler: '+missing.join(', '));return this.put({...a,reviewedRevision:a.revision,status:'ready',nextRunAt:null});}
 enable(id){this.assertIdle(id);const a=this.get(id);if(a.reviewedRevision!==a.revision||a.trial?.revision!==a.revision||a.trial.status!=='passed')throw Error('Önce kurulumu kaydet ve başarılı bir deneme çalıştır');if(a.endAt&&a.endAt<=this.now())throw Error('Bitiş tarihini güncelle');return this.put({...a,status:'enabled',batchId:null,once:false,onceSources:null,nextRunAt:this.now()});}
 pause(id,status='paused'){const a=this.get(id);return this.put({...a,status,nextRunAt:null,updatedAt:this.now()});}
 sources(id){
  const a=this.get(id),runs=this.runs(id),records=this.results(id,{all:true});
  return automationSources(a).map(source=>{
   const last=runs.find(r=>r.kind==='run'&&(r.sourceUrl===source.url||!r.sourceUrl&&r.sources?.length===1&&r.sources[0]===source.url));
   const active=runs.find(r=>r.status==='running'&&r.kind==='run'&&(r.sourceUrl===source.url||r.sources?.length===1&&r.sources[0]===source.url));
   const resultCount=records.filter(r=>!r.trial&&(r.sourceUrl?r.sourceUrl===source.url:new URL(r.url).origin===new URL(source.url).origin&&a.sources.filter(url=>new URL(url).origin===new URL(source.url).origin).length===1)).length;
   return {...(last?{lastRunAt:last.finishedAt,lastStatus:last.status,lastResult:last.summary,blocked:['blocked','failed','timeout'].includes(last.status),lastFound:records.filter(r=>!r.trial&&r.runId===last.id).length}:{}),...source,resultCount,scanning:Boolean(active),workerId:active?.workerId??null};
  });
 }
 saveSource(id,url,input){
  const a=this.get(id),settings=sourceInput(a,url,input);
  if(this.runs(id).some(r=>r.status==='running'&&(r.sourceUrl===url||r.kind!=='run')))throw Error('Önce bu kaynağın çalışan görevini durdur');
  const old=a.sourceSettings?.[url]??{};
  a.sourceSettings={...a.sourceSettings,[url]:settings};
  if(old.query!==settings.query||old.mode!==settings.mode)this.clearApprovals(id);
  const state=a.sourceState?.[url]??{};
  a.sourceState={...a.sourceState,[url]:{...state,...(settings.intervalMinutes!==old.intervalMinutes&&!state.blocked?{nextRunAt:state.lastRunAt?state.lastRunAt+(settings.intervalMinutes??a.intervalMinutes)*60000:this.now()}:{})}};
  return this.put(a);
 }
 clearApprovals(id){this.db.prepare("UPDATE workspace_records SET data=json_remove(data,'$.approvedDigest') WHERE workspace_id=?").run(id);}
 message(id,role,text){this.get(id);if(!['user','assistant','system'].includes(role))throw Error('Geçersiz mesaj');const m={id:randomUUID(),automationId:id,role,text:boundedText(text,'Mesaj',12000),at:this.now()};this.db.prepare('INSERT INTO automation_messages VALUES(?,?,?)').run(m.id,id,JSON.stringify(m));return m;}
 messages(id){this.get(id);return this.db.prepare('SELECT data FROM (SELECT rowid,data FROM automation_messages WHERE automation_id=? ORDER BY rowid DESC LIMIT 100) ORDER BY rowid').all(id).map(json);}
 runs(id){this.get(id);return this.db.prepare('SELECT data FROM automation_runs WHERE automation_id=? ORDER BY rowid DESC LIMIT 30').all(id).map(json);}
 run(id){const r=json(this.db.prepare('SELECT data FROM automation_runs WHERE id=?').get(id));if(!r)throw Error('Çalışma bulunamadı');return r;}
 putRun(run){this.db.prepare('INSERT INTO automation_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.automationId,JSON.stringify(run));return run;}
 begin(id,input,workerId='main'){return this.store.workspaces.tasks.atomic(()=>{
  const {kind,taskId}=typeof input==='string'?{kind:input}:input;
  if(!taskId)this.assertIdle(id);const a=this.get(id);this.store.workspaces.workers.get(id,workerId);if(!['interview','trial','run'].includes(kind))throw Error('Geçersiz çalışma');
  if(kind!=='interview'&&a.reviewedRevision!==a.revision)throw Error('Önce kurulum kartını kontrol edip kaydet');
  if(kind==='run'&&(a.trial?.status!=='passed'||a.trial.revision!==a.revision))throw Error('Önce başarılı bir deneme gerekli');
  if(a.endAt&&a.endAt<=this.now()&&kind!=='interview')throw Error('Otomasyonun bitiş tarihi geçti');
  if(['interview','trial'].includes(kind)&&a.status==='enabled')this.pause(id);
  const queue=this.store.workspaces.tasks,task=taskId?queue.get(id,taskId):queue.enqueue(id,{operation:kind,lockKey:'workspace',capability:'browser.observe'});queue.claim(id,task.id,workerId);
  const savedScan=task.scan??a.sourceState?.[task.sourceUrl]?.scan;
  return this.putRun({id:randomUUID(),automationId:id,workerId,taskId:task.id,operation:task.operation,sources:task.sources??a.sources,sourceUrl:task.sourceUrl??null,recordId:task.recordId??null,batchId:task.batchId??null,...(savedScan&&!savedScan.complete?{scan:savedScan}:{}),kind,revision:a.revision,status:'running',state:'Starting',startedAt:this.now(),finishedAt:null,browserSteps:0,observations:[],summary:'Başlatılıyor',actionId:null});
 });}
 activeRun(automationId,runId){const run=this.run(runId);if(run.automationId!==automationId||run.status!=='running')throw Error('Çalışma oturumu geçersiz');return run;}
 spendStep(id,runId,{research=false}={}){const run=this.activeRun(id,runId),a=this.get(id);if(run.kind==='interview'&&!research)throw Error('Kurulum sırasında yalnızca kaynak araştırması yapılabilir');if(research&&run.kind!=='interview')throw Error('Kaynak araştırması yalnızca kurulum sırasında yapılabilir');if(run.browserSteps>=(research?Math.min(a.maxBrowserSteps,12):a.maxBrowserSteps))throw Error('Tarayıcı adım sınırına ulaşıldı');run.browserSteps++;this.putRun(run);}
 observe(id,runId,url,evidence,links=[]){
  const run=this.activeRun(id,runId),observation={url:webUrl(url),evidence:String(evidence).slice(0,2000),at:this.now()};
  run.observations=[...run.observations,observation].slice(-20);
  // Keep the full route separately from the bounded page excerpts.
  run.navigation=[...(run.navigation??[]),{url:observation.url,at:observation.at,step:run.browserSteps}];
  if(links.length)run.observedLinks=[...new Set([...(run.observedLinks??[]),...links])].slice(-10000);
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
 putResult(item){return this.store.workspaces.records.put(item.automationId,item.key,item);}
 configureTable(id,input){this.get(id);this.store.workspaces.configureTable(id,input);return this.get(id);}
 rename(id,title){this.assertIdle(id);return this.put({...this.get(id),title:boundedText(title,'Ad',150)});}
 updateCells(id,itemId,input){return this.store.workspaces.updateCells(id,itemId,input);}
 record(id,runId,input){
  const run=this.activeRun(id,runId),research=run.kind==='interview';
  const url=webUrl(input.url),key=this.template(this.get(id).templateId).records.identity==='url'?url:boundedText(input.key??url,'Sonuç anahtarı',2000),previous=json(this.db.prepare('SELECT data FROM workspace_records WHERE workspace_id=? AND record_key=?').get(id,key));
  if(research){
   if(input.proposal?.trim())throw Error('Kurulumda yalnızca araştırma örneği kaydedilebilir; işlem taslağı oluşturulamaz');
   if(!run.observations.some(o=>o.url===url&&o.evidence.trim()))throw Error('Araştırma örneğinin detay sayfasını önce bu turda gözlemle');
  }
  if(run.recordId&&run.recordId!==previous?.id)throw Error('Kayıt bu göreve ait değil');
  // Neither setup nor trial samples may demote live records or clear approvals.
  if(run.kind!=='run'&&previous&&!previous.trial)return {...previous,duplicate:true};
  if(previous&&['completed','uncertain','executing','dismissed'].includes(previous.status))return {...previous,duplicate:true};
  const title=boundedText(input.title,'Başlık',300),summary=boundedText(input.summary,'Özet',6000),proposal=boundedText(input.proposal??'','İşlem taslağı',12000,{empty:true});
  const digest=createHash('sha256').update(JSON.stringify([url,proposal])).digest('hex');
  if(proposal&&run.operation&&this.template(this.get(id).templateId).workflow.some(s=>s.id===run.operation)&&operationFor(this.template(this.get(id).templateId),run.operation).effect==='read')throw Error('Bu adım yalnızca gözlem ve değerlendirme yapabilir');
  const cells=input.cells===undefined?{}:automationCells(input.cells,this.get(id).table);
  const initial=this.template(this.get(id).templateId).records.initial;
  const item={...previous,...(!previous?.workflowState&&initial&&initial!=='found'?{workflowState:initial}:{}),id:previous?.id??randomUUID(),automationId:id,key,url,title,summary,proposal,digest,status:proposal?'prepared':'found',approvedDigest:previous?.digest===digest?previous.approvedDigest:null,createdAt:previous?.createdAt??this.now(),updatedAt:this.now(),runId,revision:run.revision,trial:run.kind!=='run',sampleKind:research?'interview':null,cells:{...previous?.cells,...cells},starred:previous?.starred??false};
  if(run.sourceUrl)item.sourceUrl=run.sourceUrl;
  return this.putResult(item);
 }
 star(id,itemId,starred){if(typeof starred!=='boolean')throw Error('Geçersiz yıldız durumu');const item=this.result(id,itemId);return this.putResult({...item,starred});}
 approve(id,itemId){this.assertIdle(id);const a=this.get(id),item=this.result(id,itemId);if(!['prepared'].includes(item.status)||!item.proposal||item.trial||item.revision!==a.revision)throw Error('Güncel bir çalışma sonucundaki işlem taslağı gerekli');return this.putResult({...item,approvedDigest:item.digest});}
 dismiss(id,itemId){this.assertIdle(id);const item=this.result(id,itemId);if(['executing','completed','uncertain'].includes(item.status))throw Error('İşlem geçmişi değiştirilemez');return this.putResult({...item,status:'dismissed',approvedDigest:null});}
 reserve(id,runId,itemId){
  const run=this.activeRun(id,runId),a=this.get(id),item=this.result(id,itemId),mode=sourceMode(a,run.sourceUrl??item.sourceUrl);
  if(a.endAt&&a.endAt<=this.now())throw Error('Otomasyonun bitiş tarihi geçti');
  if(run.operation&&this.template(a.templateId).workflow.some(s=>s.id===run.operation)&&operationFor(this.template(a.templateId),run.operation).effect!=='write')throw Error('Bu görev adımı gönderim yapamaz');
  if(run.recordId&&run.recordId!==itemId)throw Error('Kayıt bu göreve ait değil');
  if(run.kind!=='run'||mode==='observe')throw Error('Bu çalışma yalnızca gözlem yapabilir');
  if(item.trial||item.revision!==a.revision||item.status!=='prepared'||!item.proposal)throw Error('Güncel ve gönderilmemiş işlem taslağı gerekli');
  if(run.actionId)throw Error('Önce mevcut işlemin sonucunu doğrula');
  if(mode!=='auto'&&item.approvedDigest!==item.digest)throw Error('İşlem kullanıcı onayı bekliyor');
  const dayStart=new Date(this.now());dayStart.setHours(0,0,0,0);
  const used=this.db.prepare("SELECT count(*) AS n FROM workspace_records WHERE workspace_id=? AND json_extract(data,'$.attemptedAt')>=?").get(id,dayStart.getTime()).n;
  if(used>=a.maxActionsPerDay)throw Error('Günlük işlem sınırına ulaşıldı');
  // Both reservation and attempted state are durable before any browser write.
  this.db.exec('SAVEPOINT automation_reserve');try{this.putResult({...item,status:'executing',attemptedAt:this.now(),attemptRunId:runId,approvedDigest:null});this.putRun({...run,actionId:item.id});this.db.exec('RELEASE automation_reserve');}catch(e){this.db.exec('ROLLBACK TO automation_reserve; RELEASE automation_reserve');throw e;}
  return {reserved:true,itemId:item.id,proposal:item.proposal,url:item.url};
 }
 resolve(id,runId,itemId,{status,evidence,url}){
  const run=this.activeRun(id,runId),item=this.result(id,itemId);if(run.kind!=='run'||!['completed','uncertain'].includes(status)||!['executing','uncertain'].includes(item.status))throw Error('Doğrulanabilecek işlem bulunamadı');
  if(item.status==='executing'&&run.actionId!==item.id)throw Error('İşlem bu çalışmaya ait değil');
  const proofUrl=webUrl(url);if(!run.observations.some(o=>o.url===proofUrl&&o.at>=item.attemptedAt))throw Error('Önce sonuç adresindeki güncel durumu tarayıcıda gözlemle');
  const result=this.putResult({...item,status,evidence:boundedText(evidence,'Sonuç kanıtı',4000),proofUrl,verifiedAt:this.now()});if(run.actionId===itemId)this.putRun({...run,actionId:null});return result;
 }
 finish(id,runId,status,summary,{release=true}={}){
  const run=this.activeRun(id,runId);if(!['completed','partial','failed','blocked','interrupted','timeout'].includes(status))throw Error('Geçersiz çalışma sonucu');
  if(status==='partial'&&(!run.sourceUrl||run.recordId||!run.scan?.pendingUrls.length))throw Error('Kısmi çalışma için kaydedilmiş kaynak devam noktası gerekli');
  if(run.actionId){const item=this.result(id,run.actionId);if(item.status==='executing')this.putResult({...item,status:'uncertain',evidence:'İşlem sonucu doğrulanamadı; tekrar gönderilmeden kontrol edilmeli.'});if(['completed','partial'].includes(status))status='blocked';}
  const a=this.get(id);if(run.kind==='trial'&&status==='completed'){
   const hosts=new Set(run.observations.filter(o=>o.evidence.trim()).map(o=>new URL(o.url).origin));
   if(!(run.sources??a.sources).every(url=>hosts.has(new URL(url).origin))||!a.sources.length||a.revision!==run.revision){status='failed';summary='Deneme tamamlanamadı: her kaynakta gerçek sayfa gözlemi gerekli.';}
  }
  this.putRun({...run,status,summary:boundedText(summary,'Çalışma özeti',6000),finishedAt:this.now(),actionId:null});
  if(run.kind==='trial')a.trial={revision:run.revision,status:status==='completed'?'passed':'failed',runId,at:this.now()};
  if(run.kind==='run'&&a.status==='enabled'){
   if(run.sourceUrl){
    const blocked=['blocked','timeout','failed','interrupted'].includes(status),state=a.sourceState?.[run.sourceUrl]??{};
    a.sourceState={...a.sourceState,[run.sourceUrl]:{...state,lastRunAt:this.now(),lastStatus:status,lastResult:summary,lastRunId:run.id,...(run.scan?{scan:run.scan}:{}),...(blocked?{blocked:true,nextRunAt:null}:{})}};
   }else a.nextRunAt=this.now()+a.intervalMinutes*60000;
   // Access failures belong to the assigned source. An uncertain write still
   // suspends the workspace until its outcome has been checked.
   if(run.actionId||!run.sourceUrl&&['blocked','timeout','failed'].includes(status)){a.status='blocked';a.nextRunAt=null;}
  }
  if(run.taskId){const queue=this.store.workspaces.tasks;if(release)queue.finish(id,run.taskId,status==='timeout'?'failed':status,summary);else queue.put({...queue.get(id,run.taskId),state:'reported',completionState:status==='timeout'?'failed':status,summary});}
  this.put(a);return this.run(runId);
 }
 recover(){for(const row of this.db.prepare("SELECT data FROM automation_runs WHERE json_extract(data,'$.status')='running'").all()){const run=json(row);this.finish(run.automationId,run.id,'interrupted','Uygulama kapandı. Kaydedilen sonuçlar korunuyor.');const a=this.get(run.automationId);if(run.actionId)this.pause(a.id,'blocked');}}
 remove(id){this.assertIdle(id);this.get(id);this.db.exec('SAVEPOINT automation_delete');try{for(const t of ['automation_messages','automation_runs'])this.db.prepare(`DELETE FROM ${t} WHERE automation_id=?`).run(id);this.db.prepare('DELETE FROM automations WHERE id=?').run(id);this.store.workspaces.remove(id);this.db.exec('RELEASE automation_delete');}catch(e){this.db.exec('ROLLBACK TO automation_delete; RELEASE automation_delete');throw e;}}
 snapshot(id){const a=this.get(id),definition=this.template(a.templateId);return {automation:a,definition,sources:this.sources(id),workers:this.store.workspaces.workers.list(id),tasks:this.store.workspaces.tasks.list(id,{limit:100}),messages:this.messages(id),runs:this.runs(id),results:this.results(id),resultCounts:this.resultCounts(id),missing:missingPlanFields(a,definition)};}
}
