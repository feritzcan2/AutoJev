import {applicationQueueState,manualApplicationAuthorized,migrateManualApplications,uncertainRetryPeerAllowed} from './application-queue.mjs';
import {preparationAuthorized,preparationHeld,preparationView,preparationQueueState} from './preparation.mjs';
import {dirname,join} from 'node:path';
import {WorkerState,MAIN_WORKER} from './worker-state.mjs';
import {contextCompactPercent} from './context-compaction.mjs';
import {contextRestartPercent} from './context-usage.mjs';
import {compactTaskContext} from './agent-payloads.mjs';
import {isStopReply} from './application-stop.mjs';
import {candidateReplyActions,missingDocumentReplies,sameDocumentRequirement,latestJobReply} from './application-replies.mjs';
import {browserResume} from './browser-resume.mjs';
import {canonicalJob,uniqueJobCount,vacancyMatch,annotateDuplicates} from './job-identity.mjs';
import {canonicalJobUrl,listingIdentity} from './job-urls.mjs';
import {JobRegistry} from './job-registry.mjs';
import {applicationReadiness,rankDecision,rankProfileKey,rankThreshold,normalizeRank} from './ranking.mjs';
import {normalizeRankWeights,weightedRankScore} from './rank-criteria.mjs';
import {sourceIntegrations,validateSourceSearch} from './source-integrations.mjs';
import {normalizeFields,validateAnswers} from './question-forms.mjs';
import {reusableAnswers,reusableFactKeys} from './candidate-answers.mjs';
export {reusableFactKeys} from './candidate-answers.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {assertDataSchemaVersion,markDataSchemaVersion,prunePromptLogs,LOG_RETENTION} from './data-management-schema.mjs';

export function text(value, name, max=12000) {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${name}: geçerli bir metin gerekli`);
  return value.trim();
}
export const canonicalUrl=canonicalJobUrl;
const normalize=s=>s.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const sourceTemplates=[
  ['LinkedIn','linkedin','LinkedIn Jobs üzerinde aday profiline uygun güncel ilanlar','https://www.linkedin.com/jobs/',15],
  ['StepStone','stepstone','StepStone üzerinde adayın kayıtlı ülke ve çalışma tercihlerine uygun ilanlar','https://www.stepstone.de/',30],
  ['Indeed','indeed','Indeed üzerinde adayın kayıtlı ülke ve çalışma tercihlerine uygun ilanlar','https://www.indeed.com/',30],
  ['JOIN','join','JOIN üzerinde adayın kayıtlı ülke ve çalışma tercihlerine uygun ilanlar','https://join.com/',30],
  ['Personio','personio','Personio kariyer sayfalarında uygun ilanlar','https://www.personio.com/',45],
  ['Greenhouse','greenhouse','Greenhouse iş panolarında uygun ilanlar','https://www.greenhouse.com/',45],
  ['Lever','lever','Lever iş panolarında uygun ilanlar','https://www.lever.co/',45],
  ['Ashby','ashby','Ashby iş panolarında uygun ilanlar','https://www.ashbyhq.com/',45],
  ['Şirket kariyer sayfaları','employer','Hedef role uygun şirketlerin resmî kariyer sayfaları','https://www.google.com/search',60]
];
const defaultPolicy={autoFillKnown:true,acceptPrivacy:false,groupRecruitmentConsent:false,demographic:'prefer_not_to_say',marketing:'decline',unknownImportant:'ask',legalAgreements:'ask'};
export class Store {
  constructor(path) {
    this.directory=dirname(path);
    this.db=new DatabaseSync(path);
    // A second app/test connection may briefly hold the writer lock during startup.
    this.db.exec('PRAGMA busy_timeout=5000');
    try{assertDataSchemaVersion(this.db);}catch(error){this.db.close();throw error;}
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS agent_conversations(candidate_id TEXT NOT NULL REFERENCES candidates(id), provider TEXT NOT NULL, native_id TEXT NOT NULL, PRIMARY KEY(candidate_id,provider));
      CREATE TABLE IF NOT EXISTS conversation_launch_settings(candidate_id TEXT NOT NULL, provider TEXT NOT NULL, native_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(candidate_id,provider));
      CREATE TABLE IF NOT EXISTS setups(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_context_reviews(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS campaigns(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_catalog_versions(candidate_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), url TEXT NOT NULL, identity TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(candidate_id,url));
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), job_id TEXT REFERENCES jobs(id), question TEXT NOT NULL, answer TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompts(seq INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, job_id TEXT, session_id TEXT, at TEXT NOT NULL);`);
    this.jobRegistry=new JobRegistry(this.db);
    this.workerState=new WorkerState(this);
    const columns=this.db.prepare('PRAGMA table_info(questions)').all().map(c=>c.name);
    for(const column of ['fields','answer_values','application_blocker','resolution','answered_at'])if(!columns.includes(column))this.db.exec(`ALTER TABLE questions ADD COLUMN ${column} TEXT`);
    migrateManualApplications(this);
    markDataSchemaVersion(this.db);
    prunePromptLogs(this.db);
    for(const {candidate_id} of this.db.prepare('SELECT DISTINCT candidate_id FROM sources').all())this.restoreSourceSchedule(candidate_id);
  }
  candidateDirectory(id){this.profile(id);return join(this.directory,'candidates',id);}
  forWorker(worker=MAIN_WORKER){return this.workerState.view(worker);}
  workers(id){return this.workerState.list(id);}
  workerTasks(id){return this.workerState.tasks(id,this.workerId??MAIN_WORKER);}
  logPrompt(candidate,{kind,text,jobId=null,sessionId=null}){if(!['start','message','input'].includes(kind))throw Error('Geçersiz prompt türü');this.db.prepare('INSERT INTO prompts(candidate_id,kind,text,job_id,session_id,at) VALUES(?,?,?,?,?,?)').run(candidate,kind,String(text).slice(0,LOG_RETENTION.promptCharacters),jobId,sessionId,new Date().toISOString());prunePromptLogs(this.db);}
  prompts(candidate,limit=200){return this.db.prepare('SELECT seq,kind,text,job_id AS jobId,session_id AS sessionId,at FROM prompts WHERE candidate_id=? ORDER BY seq DESC LIMIT ?').all(candidate,limit);}
  event(candidate,kind,data){this.db.prepare('INSERT INTO events(candidate_id,kind,data,at) VALUES(?,?,?,?)').run(candidate,kind,JSON.stringify({...data,workerId:this.workerId??MAIN_WORKER}),new Date().toISOString());}
  reportActivity(candidate,sessionId,input){
    this.profile(candidate);
    if(input.jobId)this.job(candidate,input.jobId);
    const task=this.campaign(candidate)?.task;
    if(task?.jobId&&input.jobId&&task.jobId!==input.jobId)throw Error('Bildirim etkin işe ait değil');
    const value={sessionId,taskId:task?.id??null,jobId:input.jobId??task?.jobId??null,message:text(input.message,'İşlem bildirimi',600)};
    this.event(candidate,'agent_activity',value);return value;
  }
  conversation(id,provider){if(this.workerId&&this.workerId!==MAIN_WORKER){this.profile(id);return this.workerState.read(id,this.workerId,'conversation:'+provider)?.nativeId??null;}this.profile(id);return this.db.prepare('SELECT native_id FROM agent_conversations WHERE candidate_id=? AND provider=?').get(id,provider)?.native_id??null;}
  forgetConversation(id,provider,nativeId){if(this.workerId&&this.workerId!==MAIN_WORKER){this.profile(id);if(this.conversation(id,provider)===nativeId)this.workerState.write(id,this.workerId,'conversation:'+provider,null);return;}this.profile(id);this.db.prepare('DELETE FROM agent_conversations WHERE candidate_id=? AND provider=? AND native_id=?').run(id,provider,nativeId);}
  conversationSettings(id,provider,nativeId){if(this.workerId&&this.workerId!==MAIN_WORKER){this.profile(id);const saved=this.workerState.read(id,this.workerId,'conversation:'+provider);return saved?.nativeId===nativeId?saved.settings:null;}this.profile(id);const row=this.db.prepare('SELECT data FROM conversation_launch_settings WHERE candidate_id=? AND provider=? AND native_id=?').get(id,provider,nativeId);return row?JSON.parse(row.data):null;}
  saveConversation(id,provider,nativeId,settings){if(this.workerId&&this.workerId!==MAIN_WORKER){this.profile(id);if(!['codex','claude'].includes(provider))throw Error('Geçersiz sağlayıcı');return this.workerState.write(id,this.workerId,'conversation:'+provider,{nativeId:text(nativeId,'Oturum kimliği',256),settings:settings??null});}this.profile(id);if(!['codex','claude'].includes(provider))throw Error('Geçersiz sağlayıcı');const value=text(nativeId,'Oturum kimliği',256);this.db.prepare('INSERT INTO agent_conversations VALUES(?,?,?) ON CONFLICT(candidate_id,provider) DO UPDATE SET native_id=excluded.native_id').run(id,provider,value);if(settings)this.db.prepare('INSERT INTO conversation_launch_settings VALUES(?,?,?,?) ON CONFLICT(candidate_id,provider) DO UPDATE SET native_id=excluded.native_id,data=excluded.data').run(id,provider,value,JSON.stringify(settings));}
  candidates(){return this.db.prepare('SELECT data FROM candidates').all().map(r=>JSON.parse(r.data));}
  profile(id){const row=this.db.prepare('SELECT data FROM candidates WHERE id=?').get(id);if(!row)throw Error('Aday bulunamadı');const profile=JSON.parse(row.data);return{...profile,agentSettings:{...profile.agentSettings,contextCompactPercent:contextCompactPercent(profile.agentSettings?.contextCompactPercent)},rankThreshold:rankThreshold(profile.rankThreshold),rankWeights:normalizeRankWeights(profile.rankWeights),rankingProfileKey:rankProfileKey(profile),applicationPolicy:{...defaultPolicy,...profile.applicationPolicy}};}
  saveProfile(input){
    const id=input.id||randomUUID();
    const previous=input.id?this.profile(id):{};
    const scope=input.authorization??previous.authorization??'prepare';
    if(!['research','prepare','submit'].includes(scope))throw Error('Geçersiz başvuru yetkisi');
    // Token thresholds cannot be interpreted as percentages. Saving the new
    // settings removes the old unit without silently enabling a guessed limit.
    const {contextRestartTokens:legacyTokens,...settings}=input.agentSettings??previous.agentSettings??{provider:'codex',model:'default',permission:'default',reasoning:'default',network:null};
    contextRestartPercent(settings.contextRestartPercent);
    settings.contextCompactPercent=contextCompactPercent(settings.contextCompactPercent);
    if(!['existing','separate','jev'].includes(input.browserMode??previous.browserMode??'existing'))throw Error('Geçersiz tarayıcı seçimi');
    let chromeProfile=input.chromeProfile===undefined?previous.chromeProfile??null:input.chromeProfile;
    if(chromeProfile!==null){
      if(typeof chromeProfile!=='object'||!/^[-\w ]{1,100}$/.test(chromeProfile.directory??''))throw Error('Geçersiz Chrome profili');
      chromeProfile={directory:chromeProfile.directory,name:text(chromeProfile.name,'Chrome profili',300)};
    }
    const profile={id,workspaceName:previous.workspaceName??null,rankThreshold:rankThreshold(input.rankThreshold??previous.rankThreshold),rankWeights:normalizeRankWeights(input.rankWeights===undefined?previous.rankWeights:input.rankWeights),cvRevision:previous.cvRevision??null,chromeProfile,learnedFacts:Object.fromEntries(Object.entries(previous.learnedFacts??{}).filter(([key,fact])=>typeof input.facts!=='string'||input.facts.split('\n').includes(`[${key}] ${fact.value}`))),agentSettings:settings,name:text(input.name,'İsim',150),preferences:text(input.preferences,'Tercihler'),facts:typeof input.facts==='string'?input.facts.slice(0,30000):'',authorization:scope,browserMode:input.browserMode??previous.browserMode??'existing',applicationPolicy:input.applicationPolicy??previous.applicationPolicy??defaultPolicy,cvPath:previous.cvPath??null,updatedAt:new Date().toISOString()};
    this.db.exec('SAVEPOINT save_profile');
    try{
      this.db.prepare('INSERT INTO candidates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(profile));
      if(previous.id&&JSON.stringify(previous.rankWeights)!==JSON.stringify(profile.rankWeights)){
        // Keep the assessment, application state and activity time; only its weighted total changes.
        const update=this.db.prepare('UPDATE jobs SET data=? WHERE id=? AND candidate_id=?');
        for(const row of this.db.prepare('SELECT data FROM jobs WHERE candidate_id=?').all(id)){
          const job=JSON.parse(row.data);if(job.rank?.status!=='scored')continue;
          job.rank={...job.rank,weights:profile.rankWeights,score:weightedRankScore(job.rank.dimensions,profile.rankWeights)};
          update.run(JSON.stringify(job),job.id,id);
        }
      }
      this.event(id,'profile_updated',{});this.db.exec('RELEASE save_profile');return profile;
    }catch(error){this.db.exec('ROLLBACK TO save_profile; RELEASE save_profile');throw error;}
  }
  renameWorkspace(id,name){
    const profile=this.profile(id),workspaceName=text(name,'Çalışma alanı adı',150);
    profile.workspaceName=workspaceName;profile.updatedAt=new Date().toISOString();
    this.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(profile),id);
    this.event(id,'workspace_renamed',{name:workspaceName});return profile;
  }
  deleteWorkspace(id){
    this.profile(id);
    const tables=['questions','job_urls','job_keys','job_members','jobs','sources','source_catalog_versions','agent_conversations','conversation_launch_settings','setups','task_context_reviews','campaigns','events','prompts','background_tasks','background_runs','mail_signals','agent_workers','worker_state'];
    this.db.exec('BEGIN');
    try{
      for(const table of tables)if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))this.db.prepare(`DELETE FROM ${table} WHERE candidate_id=?`).run(id);
      this.db.prepare('DELETE FROM candidates WHERE id=?').run(id);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  rememberFact(candidate,input){
    const p=this.profile(candidate),key=input.key;
    if(!reusableFactKeys.includes(key))throw Error('Yalnızca genel profil bilgileri kaydedilebilir');
    const value=text(input.value,'Profil bilgisi',2000),evidence=text(input.evidence,'Kaynak alıntısı',3000);
    let source;
    if(input.source==='answer'){
      const q=this.questions(candidate).find(q=>q.id===input.sourceId);
      if(!q||q.answer===null)throw Error('Bu adayın yanıtlanmış sorusu gerekli');source=q.answer;
    }else if(input.source==='profile'){if(input.sourceId!==candidate)throw Error('Profil kaynağı bu adaya ait değil');source=p.facts+'\n'+p.preferences;}
    else if(input.source==='cv'){if(!p.cvPath||input.sourceId!==p.cvPath)throw Error('Kaynak adayın mevcut CV dosyası olmalı');}
    else throw Error('Geçersiz bilgi kaynağı');
    const normalize=s=>s.replace(/\s+/g,' ').trim();
    if(source&&!normalize(source).includes(normalize(evidence)))throw Error('Alıntı belirtilen kaynakta bulunamadı');
    const previous=p.learnedFacts?.[key];
    if(previous?.source==='answer'&&input.source!=='answer'&&previous.value!==value)throw Error('Adayın açık yanıtı CV veya çıkarımla değiştirilemez');
    if(previous?.source==='answer'&&input.source==='answer'&&previous.value!==value){const history=this.questions(candidate);if(history.findIndex(q=>q.id===input.sourceId)>history.findIndex(q=>q.id===previous.sourceId))throw Error('Eski yanıt daha yeni aday bilgisini değiştiremez');}
    if(previous?.value===value)return p;
    const prefix=`[${key}] `,lines=p.facts.split('\n').filter(line=>!line.startsWith(prefix));
    const facts=[...lines,`${prefix}${value}`].join('\n').trim();if(facts.length>30000)throw Error('Profil bilgi alanı dolu');
    const fact={value,source:input.source,sourceId:input.sourceId,evidence,updatedAt:new Date().toISOString()};
    p.facts=facts;p.learnedFacts={...p.learnedFacts,[key]:fact};p.updatedAt=fact.updatedAt;
    this.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(p),candidate);this.event(candidate,'profile_fact_learned',{key,...fact});return p;
  }
  setCv(id,path){const p=this.profile(id);p.cvPath=path;p.cvRevision=randomUUID();this.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(p),id);return p;}
  sources(candidate){
    this.profile(candidate);let rows=this.db.prepare('SELECT data FROM sources WHERE candidate_id=? ORDER BY rowid').all(candidate);
    if(!rows.length){const mode='auto';for(const [name,kind,query,url,intervalMinutes] of sourceTemplates)this.saveSource(candidate,{name,kind,query,url,intervalMinutes,applyMode:mode,enabled:true},{silent:true});rows=this.db.prepare('SELECT data FROM sources WHERE candidate_id=? ORDER BY rowid').all(candidate);}
    if(!this.db.prepare('SELECT version FROM source_catalog_versions WHERE candidate_id=?').get(candidate)){
      const existing=rows.map(r=>JSON.parse(r.data)),mode='auto';
      for(const item of sourceIntegrations){const found=existing.find(x=>x.kind===item.id||x.url===canonicalUrl(item.url));
        if(found){this.saveSource(candidate,{...found,integrationId:item.id,searchMethod:found.integrationId?found.searchMethod:'tool'},{silent:true});}
        else this.saveSource(candidate,{name:item.name,kind:item.id,url:item.url,query:'Adayın kayıtlı hedef rollerine, ülke ve çalışma tercihlerine uygun güncel ilanlar',enabled:item.market==='global',intervalMinutes:30,applyMode:mode,integrationId:item.id,searchMethod:'tool'},{silent:true});
      }
      this.db.prepare('INSERT INTO source_catalog_versions VALUES(?,1)').run(candidate);
      rows=this.db.prepare('SELECT data FROM sources WHERE candidate_id=? ORDER BY rowid').all(candidate);
    }
    return rows.map(r=>JSON.parse(r.data));
  }
  source(candidate,id){const row=this.db.prepare('SELECT data FROM sources WHERE id=? AND candidate_id=?').get(id,candidate);if(!row)throw Error('Kaynak bulunamadı');return JSON.parse(row.data);}
  saveSource(candidate,input,{silent=false}={}){
    this.profile(candidate);const previous=input.id?this.source(candidate,input.id):{},id=input.id??randomUUID(),intervalMinutes=Number(input.intervalMinutes);
    if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>10080)throw Error('Tarama aralığı 1–10080 dakika olmalı');
    const applyMode=input.applyMode??previous.applyMode??'auto';
    if(!['find_only','prepare','auto'].includes(applyMode))throw Error('Geçersiz başvuru modu');
    const enabled=Boolean(input.enabled),scheduleChanged=previous.id&&(intervalMinutes!==previous.intervalMinutes||enabled&&!previous.enabled);
    // Settings forms may predate a completed scan. Keep the persisted schedule;
    // interval changes and re-enabling count from the last completed scan.
    const nextRunAt=scheduleChanged?(previous.lastRunAt==null?0:previous.lastRunAt+intervalMinutes*60000):previous.nextRunAt??input.nextRunAt??0;
    const source={...validateSourceSearch(input,previous),modeInherited:silent?previous.modeInherited??true:false,id,candidateId:candidate,name:text(input.name,'Kaynak adı',120),kind:text(input.kind??previous.kind??'custom','Kaynak türü',60),query:text(input.query,'Arama kapsamı',2000),url:canonicalUrl(input.url),enabled,intervalMinutes,applyMode,resumeContext:previous.resumeContext??null,lastRunAt:previous.lastRunAt??null,nextRunAt,lastResult:previous.lastResult??'Henüz taranmadı',lastFound:previous.lastFound??0,updatedAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,candidate,JSON.stringify(source));if(!silent)this.event(candidate,'source_updated',{id,name:source.name,enabled:source.enabled,intervalMinutes,applyMode:source.applyMode});return source;
  }
  saveSourcesApplyMode(candidate,applyMode){
    if(!['find_only','auto'].includes(applyMode))throw Error('Geçersiz başvuru modu');
    const sources=this.sources(candidate);
    this.db.exec('BEGIN');
    try{
      const result=sources.map(source=>this.saveSource(candidate,{...source,applyMode}));
      this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  deleteSource(candidate,id){const source=this.source(candidate,id);if(this.jobs(candidate).some(job=>job.sourceId===id))throw Error('Bu kaynaktan kayıtlı ilanlar var; silmek yerine kapat');this.db.prepare('DELETE FROM sources WHERE id=? AND candidate_id=?').run(id,candidate);this.event(candidate,'source_deleted',{id,name:source.name});return source;}
  saveSourceCheckpoint(candidate,id,input){
    const source=this.source(candidate,id),task=this.campaign(candidate)?.task;
    if(this.campaign(candidate)?.status!=='running'||task?.kind!=='search'||task.sourceId!==id)throw Error('Etkin kaynak taraması bulunamadı');
    const url=new URL(text(input.url,'Sekme bağlantısı',3000));
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz sekme bağlantısı');
    source.resumeContext={...(this.profile(candidate).browserMode==='separate'?{workerId:this.workerId??MAIN_WORKER}:{}),browser:text(input.browser,'Tarayıcı',300),tabId:text(input.tabId,'Sekme kimliği',300),url:url.toString(),savedAt:new Date().toISOString()};
    this.db.prepare('UPDATE sources SET data=? WHERE id=? AND candidate_id=?').run(JSON.stringify(source),id,candidate);
    this.event(candidate,'source_checkpoint_saved',{id});return source;
  }
  clearSourceTabs(candidate,tabIds){
    for(const source of this.sources(candidate))if(source.resumeContext?.browser==='Jev Chrome'&&tabIds.includes(source.resumeContext.tabId)){
      source.resumeContext=null;
      this.db.prepare('UPDATE sources SET data=? WHERE id=? AND candidate_id=?').run(JSON.stringify(source),source.id,candidate);
    }
  }
  markSourceRun(candidate,id,{at,nextRunAt,result,found}){const source=this.source(candidate,id);Object.assign(source,{lastRunAt:at,nextRunAt,lastResult:text(result,'Tarama sonucu',3000),lastFound:found,updatedAt:new Date().toISOString()});this.db.prepare('UPDATE sources SET data=? WHERE id=?').run(JSON.stringify(source),id);this.event(candidate,'source_scanned',{id,name:source.name,found,result:source.lastResult});return source;}
  restoreSourceSchedule(candidate){
    // Older starts cleared nextRunAt. Rebuild it from completed work so a
    // campaign or worker restart cannot bypass the source's waiting interval.
    for(const {data} of this.db.prepare('SELECT data FROM sources WHERE candidate_id=?').all(candidate)){
      const source=JSON.parse(data);
      if(source.lastRunAt==null)continue;
      const nextRunAt=source.lastRunAt+source.intervalMinutes*60000;
      if(source.nextRunAt===nextRunAt)continue;
      source.nextRunAt=nextRunAt;
      this.db.prepare('UPDATE sources SET data=? WHERE id=? AND candidate_id=?').run(JSON.stringify(source),source.id,candidate);
    }
  }
  saveApplicationPolicy(candidate,input){const profile=this.profile(candidate),policy={autoFillKnown:Boolean(input.autoFillKnown),acceptPrivacy:Boolean(input.acceptPrivacy),groupRecruitmentConsent:Boolean(input.groupRecruitmentConsent??profile.applicationPolicy.groupRecruitmentConsent),demographic:['prefer_not_to_say','profile_only'].includes(input.demographic)?input.demographic:'prefer_not_to_say',marketing:['decline','profile_only','auto'].includes(input.marketing)?input.marketing:'decline',unknownImportant:['ask','skip'].includes(input.unknownImportant)?input.unknownImportant:'ask',legalAgreements:['ask','skip','auto'].includes(input.legalAgreements)?input.legalAgreements:'ask'};profile.applicationPolicy=policy;profile.updatedAt=new Date().toISOString();this.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(profile),candidate);this.event(candidate,'application_policy_updated',policy);return policy;}
  jobs(id){this.profile(id);return this.jobRegistry.decorate(this.db.prepare('SELECT data FROM jobs WHERE candidate_id=? ORDER BY rowid DESC').all(id).map(r=>JSON.parse(r.data)));}
  visibleJobs(id,withHistory=false){
    const jobs=this.jobs(id),visible=jobs.filter(canonicalJob);
    if(!withHistory)return visible;
    const groups=new Map();for(const job of jobs){const key=job.canonicalJobId??job.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(job);}
    return visible.map(job=>({...job,relatedApplications:groups.get(job.id).filter(other=>other.id!==job.id).map(({id,company,role,url,location,status,note,proof,resumeContext,updatedAt})=>({id,company,role,url,location,status,note,proof,resumeContext,updatedAt}))}));
  }
  job(candidate,id){this.profile(candidate);return this.jobRegistry.job(candidate,id);}
  canonicalJobId(candidate,id){return this.jobRegistry.canonical(candidate,id);}
  checkJobs(candidate,items){
    this.profile(candidate);
    if(!Array.isArray(items)||!items.length||items.length>50)throw Error('Bir kontrolde 1–50 ilan gerekli');
    return items.map(({url})=>{const id=this.jobRegistry.lookup(candidate,url);return {url:canonicalUrl(url),duplicate:Boolean(id),job:id?this.rankedJob(candidate,id):null};});
  }
  linkJobUrl(candidate,id,{url,evidence},sessionId){
    text(evidence,'İlan bağlantısı kanıtı',2000);
    return this.jobRegistry.atomic(()=>{
      const job=this.job(candidate,id);
      if(job.sessionId&&job.sessionId!==sessionId&&!['submitted','already_submitted','skipped'].includes(job.status))throw Error('İlan başka bir oturuma ait');
      const linked=this.jobRegistry.bind(candidate,id,url,evidence);
      if(linked.linked)this.event(candidate,'job_url_linked',{jobId:id,url:canonicalUrl(url),canonicalJobId:linked.jobId});
      return {...linked,job:this.rankedJob(candidate,linked.jobId)};
    });
  }
  assertSubmissionAllowed(candidate,id,url,sessionId,{verificationContinuation=false}={}){
    const task=this.campaign(candidate)?.task,job=this.job(candidate,id);
    const continuation=verificationContinuation&&task?.jobId===id&&['application','verify'].includes(task.kind)&&job.sessionId===sessionId&&job.status==='uncertain'&&job.verificationContinuation&&job.verificationContinuation.url===url;
    if(task?.jobId===id&&task.verificationOnly&&!continuation)throw Error('Bu görev yalnızca sonucu doğrular; yeniden başvuru gönderilemez.');
    if(preparationHeld(job))throw Error('Hazırlık tamamlandıktan sonra kullanıcı Başvur seçmeli. Gönderim bekletiliyor.');
    this.jobRegistry.atomic(()=>{
      this.job(candidate,id);
      if(url)this.jobRegistry.bind(candidate,id,url,'observed_application_page');
    });
    return this.jobRegistry.atomic(()=>this.jobRegistry.assertAvailable(candidate,id,sessionId,this.workerState.tasks(candidate),{allowUncertainPeers:uncertainRetryPeerAllowed(this.job(candidate,id),task)}));
  }
  addJob(candidate,input){
    return this.jobRegistry.atomic(()=>this.insertJob(candidate,input));
  }
  insertJob(candidate,input){
    this.profile(candidate);
    const url=canonicalUrl(input.url),company=text(input.company,'Şirket',200),role=text(input.role,'Pozisyon',250);
    const identity=[normalize(company),normalize(role),normalize(input.location||'')].join('|');
    const prior=this.jobRegistry.lookup(candidate,url);
    if(prior){this.jobRegistry.bind(candidate,prior,url,'search_result',true);return {duplicate:true,job:this.job(candidate,prior)};}
    if(input.sourceId)this.source(candidate,input.sourceId);
    const job={id:randomUUID(),candidateId:candidate,sourceId:input.sourceId??null,url,company,role,location:text(input.location,'Konum',250),fit:text(input.fit,'Uygunluk',3000),status:'found',discoveryTaskId:this.campaign(candidate)?.task?.kind==='search'?this.campaign(candidate).task.id:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),note:'',proof:null,sessionId:null};
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id,candidate,url,identity,JSON.stringify(job));this.jobRegistry.register(job);this.event(candidate,'job_found',job);return{duplicate:false,job:this.job(candidate,job.id)};
  }
  rankJob(candidate,id,input){
    const job=this.job(candidate,id),profile=this.profile(candidate);
    if(['submitted','already_submitted','skipped'].includes(job.status))throw Error('Tamamlanmış ilan yeniden puanlanamaz');
    const rank=normalizeRank(input,profile);
    if(job.rank?.status==='scored'||job.rank?.status==='unavailable'&&job.rank.browserCheck&&!job.rankRetry)return job; // Scores remain stable; failed retrievals can be retried.
    if(input.profileKey!==rankProfileKey(profile))throw Error('Profil değişti; get_task_context ile güncel profili okuyup yeniden değerlendir');
    if(job.rank)job.previousRank=job.rank;
    job.rank=rank;delete job.rankRetry;delete job.rankOverride;
    return this.saveJob(job,'job_ranked');
  }
  retryJobRank(candidate,id){
    const job=this.job(candidate,id);
    if(!['found','blocked'].includes(job.status)||job.rank?.status!=='unavailable')throw Error('Yalnızca erişilemeyen ilan yeniden incelenebilir');
    job.rankRetry=true;return this.saveJob(job,'job_rank_retry_requested');
  }
  queueRankedJob(candidate,id){
    const job=this.job(candidate,id),profile=this.profile(candidate),decision=rankDecision(profile,job);
    if(!['found','blocked'].includes(job.status)||decision.state!=='below_threshold')throw Error('Yalnızca puanı eşik altında olan açık ilan sıraya alınabilir');
    job.rankOverride={profileKey:job.rank.profileKey,rankedAt:job.rank.rankedAt,at:new Date().toISOString()};
    return this.saveJob(job,'job_rank_override');
  }
  saveRankSettings(candidate,input){
    if(!input||!Object.hasOwn(input,'threshold')||input.threshold===undefined||!Object.hasOwn(input,'weights')||input.weights===undefined)throw Error('Puan eşiği ve kriter oranları gerekli');
    const threshold=rankThreshold(input.threshold),weights=normalizeRankWeights(input.weights);
    const profile=this.saveProfile({...this.profile(candidate),rankThreshold:threshold,rankWeights:weights});
    this.event(candidate,'rank_settings_updated',{threshold,weights});
    return {threshold:profile.rankThreshold,weights:profile.rankWeights};
  }
  saveRankThreshold(candidate,value){
    const p=this.profile(candidate);p.rankThreshold=rankThreshold(value);
    this.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(p),candidate);
    this.event(candidate,'rank_threshold_updated',{threshold:p.rankThreshold});return p.rankThreshold;
  }
  setJobStarred(candidate,id,starred){
    if(typeof starred!=='boolean')throw Error('Geçersiz yıldız durumu');
    const job=this.job(candidate,id);
    if(Boolean(job.starred)===starred)return job;
    job.starred=starred;
    // A bookmark does not change the application's last activity or agent state.
    this.db.prepare('UPDATE jobs SET data=? WHERE id=? AND candidate_id=?').run(JSON.stringify(job),id,candidate);
    this.event(candidate,'job_starred',{id,starred});return job;
  }
  setJobHidden(candidate,id,hidden){
    if(typeof hidden!=='boolean')throw Error('Geçersiz gizleme durumu');
    const job=this.job(candidate,id);
    if(Boolean(job.hidden)===hidden)return job;
    job.hidden=hidden;
    this.db.prepare('UPDATE jobs SET data=? WHERE id=? AND candidate_id=?').run(JSON.stringify(job),id,candidate);
    this.event(candidate,'job_hidden',{id,hidden});return job;
  }
  setManualJobStatus(candidate,id,outcome){
    if(!['manual_submitted','already_submitted','withdrawn'].includes(outcome))throw Error('Geçersiz manuel durum');
    const job=this.job(candidate,id);
    job.status=outcome==='already_submitted'?'already_submitted':outcome==='manual_submitted'?'submitted':'skipped';
    delete job.followupStopped;delete job.missingDocuments;
    job.manualOutcome=outcome;job.manualUpdatedAt=new Date().toISOString();
    job.note=outcome==='already_submitted'?'Kullanıcı daha önce gönderildi olarak işaretledi':outcome==='manual_submitted'?'Kullanıcı başvuruyu manuel gönderdi':'Kullanıcı başvurudan vazgeçti';
    job.sessionId=null;
    this.db.prepare('UPDATE questions SET resolution=? WHERE candidate_id=? AND job_id=? AND resolution IS NULL AND answer IS NULL').run(JSON.stringify({kind:outcome,at:job.manualUpdatedAt}),candidate,id);
    return this.saveJob(job,'job_updated');
  }
  stopApplicationFollowup(candidate,id,questionId,sessionId){
    const job=this.job(candidate,id),q=this.questions(candidate).find(q=>q.id===questionId&&q.jobId===id&&q.answer!==null);
    if(!q||latestJobReply(job,this.questions(candidate))?.id!==q.id||!isStopReply(q.answer,job,q))throw Error('Bu başvuruya bağlı en son açık atla/durdur yanıtı gerekli; alan sorusuna verilen hayır veya CAPTCHA adımını atlama yanıtı başvuruyu iptal etmez.');
    if(job.sessionId&&job.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait');
    if(job.followupStopped)return job;
    const at=new Date().toISOString();
    job.followupStopped={questionId,answer:q.answer,at,previousStatus:job.status};
    if(job.status==='submitting')job.status='uncertain';
    else if(!['uncertain','submitted'].includes(job.status))job.status='skipped';
    job.note=job.status==='uncertain'?'Kullanıcı takibi bıraktı; önceki gönderimin sonucu belirsiz. Yeniden gönderilmeyecek.':'Kullanıcının açık yanıtıyla başvuru takibi bırakıldı.';
    this.db.prepare('UPDATE questions SET resolution=? WHERE candidate_id=? AND job_id=? AND resolution IS NULL AND answer IS NULL').run(JSON.stringify({kind:'followup_stopped',at}),candidate,id);
    return this.saveJob(job,'application_followup_stopped');
  }
  recordCandidateReply(candidate,id,questionId,sessionId,tool){
    const job=this.job(candidate,id),questions=this.questions(candidate);
    if(job.sessionId&&job.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait');
    // Idempotent receipts, including after the task has been marked complete.
    if(tool==='record_candidate_submission'&&job.status==='submitted'&&job.candidateSubmission?.questionId===questionId)return job;
    if(tool==='defer_missing_documents'&&job.missingDocuments?.questionId===questionId&&job.status==='blocked'&&missingDocumentReplies(job,questions).some(q=>q.id===questionId))return job;
    const action=candidateReplyActions(job,questions).find(a=>a.tool===tool&&a.questionId===questionId);
    if(!action)throw Error('Bu işlem için aynı başvurunun en son kayıtlı yanıtı açıkça gönderildiğini veya zorunlu belgelerin bulunmadığını belirtmeli. Genel onay, doğrulama kodunun tamamlanması veya eski bir yanıt yeterli değil.');
    const q=questions.find(q=>q.id===questionId),at=new Date().toISOString();
    if(tool==='record_candidate_submission'){
      job.status='submitted';job.manualOutcome='manual_submitted';job.manualUpdatedAt=at;
      job.candidateSubmission={questionId,answer:q.answer,at};
      job.note='Kullanıcı başvuruyu gönderdiğini bildirdi; işveren teyidi bağımsız doğrulanmadı.';
      delete job.missingDocuments;
      this.db.prepare('UPDATE questions SET resolution=? WHERE candidate_id=? AND job_id=? AND resolution IS NULL AND answer IS NULL').run(JSON.stringify({kind:'candidate_reported_submission',at}),candidate,id);
      return this.saveJob(job,'candidate_submission_recorded');
    }
    job.status='blocked';job.sessionId=sessionId;
    job.missingDocuments={questionId,answer:q.answer,requirement:q.applicationBlocker.evidence,at};
    job.note='Zorunlu belgeler adayda yok. Taslak korundu; belge sağlandığında yeniden sıraya alınabilir.';
    // Close only repeated questions for the same documents, without inventing
    // answers or dismissing other outstanding facts/consents on this form.
    for(const pending of questions.filter(p=>p.jobId===id&&p.answer===null&&sameDocumentRequirement(q,p)))this.db.prepare('UPDATE questions SET resolution=? WHERE candidate_id=? AND id=? AND answer IS NULL').run(JSON.stringify({kind:'known_missing_documents',questionId,at}),candidate,pending.id);
    return this.saveJob(job,'application_documents_deferred');
  }
  updateJob(candidate,id,status,note,sessionId){
    return this.jobRegistry.atomic(()=>this.transitionJob(candidate,id,status,note,sessionId));
  }
  transitionJob(candidate,id,status,note,sessionId){
    if(['working','prepared','submitting'].includes(status)){
      const current=this.job(candidate,id);
      if(current.resumeContext?.url)this.jobRegistry.bind(candidate,id,current.resumeContext.url,'application_checkpoint');
      this.jobRegistry.assertAvailable(candidate,id,sessionId,this.workerState.tasks(candidate),{allowUncertainPeers:uncertainRetryPeerAllowed(current,this.campaign(candidate)?.task)});
    }
    const j=this.job(candidate,id),p=this.profile(candidate),c=this.campaign(candidate),manual=c?.status==='running'&&manualApplicationAuthorized(j,c.task),preparing=c?.status==='running'&&preparationAuthorized(j,c.task);
    if(status==='submitting'&&(preparationHeld(j)||c?.task?.kind==='preparation'))throw Error('Hazırlık görevi gönderemez. Kullanıcı Başvur seçmeli.');
    if(preparationHeld(j)&&['working','prepared'].includes(status)&&!preparing)throw Error('Bu ilan için etkin hazırlık görevi gerekli.');
    if(['working','prepared','submitting'].includes(status)&&candidateReplyActions(j,this.questions(candidate)).some(a=>a.tool==='record_candidate_submission'))throw Error('Kullanıcı bu başvuruyu gönderdiğini açıkça bildirdi. Yeni hazırlık/gönderim durumları oluşturma; record_candidate_submission ile kayıtlı questionId üzerinden tamamla.');
    if(c?.status==='running'&&c.task?.jobId===id&&c.task.verificationOnly&&['working','prepared','submitting'].includes(status))throw Error('Bu görev yalnızca sonucu doğrular; yeniden başvuru hazırlanamaz veya gönderilemez.');
    const transitions={found:['working','skipped'],working:['prepared','blocked','skipped'],prepared:['working','submitting','blocked','skipped'],blocked:['working','skipped'],submitting:['uncertain'],uncertain:['submitted'],submitted:[],already_submitted:[],skipped:[]};
    if(j.followupStopped)throw Error('Bu başvurunun takibi kullanıcı isteğiyle bırakıldı; yeni form işlemi yapma.');
    if(status===j.status){
      if(!['blocked','uncertain'].includes(status))return j;
      if(j.sessionId&&j.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait; kullanıcı devralmalı');
      const currentNote=text(note,'Açıklama',3000);
      if(j.note===currentNote)return j;
      j.note=currentNote;j.sessionId=sessionId;return this.saveJob(j,'job_updated');
    }
    if(!transitions[j.status]?.includes(status))throw Error(`Geçersiz geçiş: ${j.status} → ${status}${j.status==='submitted'?'. Gönderim zaten kanıtıyla kaydedildi; bu başvurunun durumunu tekrar değiştirme.':['submitting','uncertain'].includes(j.status)?'. working/prepared/submitting geçişlerini sırayla deneme. Aynı sekmede onay varsa doğrudan record_submission kullan. Yalnızca gönderimi engelleyen açık alan doğrulama hatası varsa record_validation_failure kullan. continue_verification için aynı ilanın yanıtlanmış erişim sorusu ve açık kalan site talimatı birlikte gereklidir. Zaman aşımı, CAPTCHA veya onay yokluğu yeniden gönderme gerekçesi değildir.':''}`);
    if(status==='submitted')throw Error('Gönderim kanıtı için record_submission kullan');
    if(['working','prepared','submitting'].includes(status)&&j.duplicateApplication&&!uncertainRetryPeerAllowed(j,c?.task))throw Error(j.duplicateApplication.reason+' Önceki ilan: '+j.duplicateApplication.jobId);
    if(!manual&&!preparing&&status==='working'&&p.authorization==='research')throw Error('Profil yalnızca araştırmaya izin veriyor');
    if(!manual&&status==='submitting'&&p.authorization!=='submit')throw Error('Gönderim yetkisi yok; kullanıcı profilden değiştirmeli');
    if(!manual&&status==='submitting'&&j.sourceId&&this.source(candidate,j.sourceId).applyMode!=='auto')throw Error('Bu kaynak otomatik gönderime izin vermiyor');
    if(!manual&&!preparing&&['working','submitting'].includes(status)&&!rankDecision(p,j).eligible)throw Error('Başvuru puanlama koşulu karşılanmıyor: '+rankDecision(p,j).label+'. Önce rank-jobs ile değerlendir.');
    if(j.sessionId&&j.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait; kullanıcı devralmalı');
    if(status==='submitting'){const target=this.campaign(candidate)?.target;if(!manual&&target&&uniqueJobCount(this.jobs(candidate).filter(other=>other.id!==id),['submitted','already_submitted','submitting','uncertain'])>=target)throw Error('Ortak başvuru limiti dolu; devam eden gönderimlerin sonucunu bekle.');delete j.validationFailure;delete j.verificationContinuation;}
    if(status==='working'){delete j.missingDocuments;if(preparing)j.preparation={...j.preparation,status:'inspecting'};if(p.browserMode==='separate')j.browserWorkerId=this.workerId??MAIN_WORKER;}
    if(status==='blocked'&&preparing)j.preparation={...j.preparation,status:'waiting'};
    j.status=status;j.note=text(note,'Açıklama',3000);j.sessionId=sessionId;return this.saveJob(j,'job_updated');
  }
  recordValidationFailure(candidate,id,input,sessionId){
    const j=this.job(candidate,id);
    if(j.followupStopped)throw Error('Başvuru takibi bırakıldı; yeniden başlatma.');
    if(!['submitting','uncertain'].includes(j.status)||j.sessionId!==sessionId)throw Error('Doğrulama hatası bu oturumun başlamış gönderimine ait olmalı');
    if(input.submissionPrevented!==true||!Array.isArray(input.fields)||!input.fields.length||input.fields.length>10)throw Error('Gönderimi engelleyen alan hatalarını ve submissionPrevented=true kanıtını belirt');
    const fields=input.fields.map(f=>({label:text(f.label,'Alan',2000),message:text(f.message,'Doğrulama hatası',2000)}));
    const evidence=text(input.evidence,'Gönderimin engellendiğine ilişkin kanıt',5000),context=input.resumeContext;
    if(j.resumeContext&&(j.resumeContext.browser!==context?.browser||j.resumeContext.tabId!==context?.tabId))throw Error('Doğrulama hatası kayıtlı başvurunun aynı sekmesinden gelmeli');
    this.db.exec('SAVEPOINT validation_failure');
    try{
      const saved=this.saveApplicationCheckpoint(candidate,id,context,sessionId);
      saved.status='blocked';saved.note='Form gönderimi alan doğrulamasında durduruldu: '+fields.map(f=>f.label).join(', ');
      saved.validationFailure={fields,evidence,submissionPrevented:true,observedAt:new Date().toISOString()};
      this.saveJob(saved,'application_validation_failed');
      this.db.exec('RELEASE validation_failure');return saved;
    }catch(error){this.db.exec('ROLLBACK TO validation_failure');this.db.exec('RELEASE validation_failure');throw error;}
  }
  continueVerification(candidate,id,input,sessionId){
    const j=this.job(candidate,id),p=this.profile(candidate),c=this.campaign(candidate);
    if(j.followupStopped)throw Error('Başvuru takibi bırakıldı; doğrulamayı yeniden başlatma.');
    if(c?.status!=='running'||c.task?.jobId!==id||!['application','verify'].includes(c.task.kind)||j.sessionId!==sessionId||!['submitting','uncertain'].includes(j.status))throw Error('Devam adımı etkin görevin aynı gönderim denemesine ait olmalı');
    if(!manualApplicationAuthorized(j,c.task)&&(p.authorization!=='submit'||j.sourceId&&this.source(candidate,j.sourceId).applyMode!=='auto'))throw Error('Mevcut yetki doğrulama sonrası gönderime devam etmeye izin vermiyor');
    if(j.verificationContinuation)throw Error('Bu deneme için devam adımı zaten ayrıldı. Yeniden tıklama; mevcut sonucu doğrula.');
    const q=this.questions(candidate).find(q=>q.id===input.questionId&&q.jobId===id&&q.answer!==null);
    if(q?.applicationBlocker?.kind!=='access'||!['user_only','captcha'].includes(q.applicationBlocker.recovery?.kind))throw Error('Aynı başvurunun yanıtlanmış erişim/doğrulama sorusu gerekli');
    const context=input.resumeContext;
    if(!j.resumeContext||j.resumeContext.browser!==context?.browser||j.resumeContext.tabId!==context?.tabId||j.resumeContext.url!==context?.url)throw Error('Devam adımı aynı kayıtlı doğrulama sekmesinde olmalı');
    if(input.verificationReady!==true||input.noFieldErrors!==true)throw Error('Doğrulama tamamlanmaya hazır olmalı ve çözülmemiş alan/seçim hatası kalmamalı');
    j.verificationContinuation={questionId:q.id,siteInstruction:text(input.siteInstruction,'Sitenin devam talimatı',2000),actionLabel:text(input.actionLabel,'Gözlenen devam düğmesi',500),evidence:text(input.evidence,'Güncel doğrulama kanıtı',5000),tabId:context.tabId,url:context.url,reservedAt:new Date().toISOString()};
    this.saveJob(j,'verification_continuation_reserved');
    return {...j,continuation:{nextAction:'complete_pending_verification_once',actionLabel:j.verificationContinuation.actionLabel,message:'Complete only this observed verification step of the existing attempt once, using the supported browser tool. Do not start a new application or change consent. Then inspect confirmation and record_submission; no automatic retry if the outcome stays unclear.'}};
  }
  saveJob(j,kind){return this.jobRegistry.atomic(()=>{
    j.updatedAt=new Date().toISOString();
    const {canonicalJobId,duplicateCount,listingKeys,duplicateApplication,...saved}=j;
    this.db.prepare('UPDATE jobs SET data=? WHERE id=? AND candidate_id=?').run(JSON.stringify(saved),j.id,j.candidateId);
    this.jobRegistry.register(saved);this.event(j.candidateId,kind,saved);return this.job(j.candidateId,j.id);
  });}
  recordSubmission(candidate,id,input,sessionId){
    const j=this.job(candidate,id);
    // This saves evidence of an already-started submission. Current permissions
    // are enforced when entering submitting, not when recording its outcome.
    if(['submitted','already_submitted'].includes(j.status))return j;
    if(input.kind==='already_submitted'){
      if(j.status==='skipped'||j.followupStopped||j.sessionId&&j.sessionId!==sessionId)throw Error('Başvuru başka oturuma ait veya kullanıcı tarafından kapatıldı');
      const proof={kind:input.kind,text:text(input.text,'Mevcut başvuru onayı',5000),url:canonicalUrl(input.url),documents:text(input.documents,'Gözlenen belge bilgisi',3000),observedAt:new Date().toISOString()};
      j.status='already_submitted';j.proof=proof;j.sessionId=sessionId;j.note='Sitede daha önce gönderilmiş başvuru doğrulandı';
      this.db.prepare('UPDATE questions SET resolution=? WHERE candidate_id=? AND job_id=? AND resolution IS NULL AND answer IS NULL').run(JSON.stringify({kind:'already_submitted',at:proof.observedAt}),candidate,id);
      return this.saveJob(j,'existing_submission_recorded');
    }
    if(!['submitting','uncertain'].includes(j.status)||j.sessionId!==sessionId)throw Error('Gönderim bu oturuma ait değil veya başlatılmadı');
    const kind=input.kind;if(!['success_page','confirmation_email','confirmation_message'].includes(kind))throw Error('Geçersiz kanıt türü');
    const proof={kind,text:text(input.text,'Onay metni',5000),url:canonicalUrl(input.url),documents:text(input.documents,'Gönderilen belgeler',3000),observedAt:new Date().toISOString()};
    j.status='submitted';j.proof=proof;j.note='Gönderim onayı kaydedildi';return this.saveJob(j,'submission_recorded');
  }
  recoverSession(candidate,sessionId){for(const j of this.jobs(candidate))if(j.sessionId===sessionId&&['working','prepared','submitting'].includes(j.status)){j.status=j.status==='submitting'?'uncertain':'blocked';j.note='Oturum kapandı. Devralmadan önce dış sitedeki durumu kontrol et.';this.saveJob(j,'session_interrupted');}}
  reclaim(candidate,id,sessionId){const j=this.job(candidate,id);if(!['blocked','uncertain'].includes(j.status))throw Error('Yalnızca kesilmiş işler devralınabilir');j.sessionId=sessionId;return this.saveJob(j,'job_reclaimed');}
  saveBrowserProgress(candidate,id,input,sessionId){
    return this.jobRegistry.atomic(()=>this.recordBrowserProgress(candidate,id,input,sessionId));
  }
  recordBrowserProgress(candidate,id,input,sessionId){
    const job=this.job(candidate,id);
    if(['submitted','already_submitted','skipped'].includes(job.status))return job;
    if(job.sessionId&&job.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait');
    const url=new URL(input.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz form URL');
    const observedAt=new Date().toISOString();
    const fields=(input.fields??[]).slice(0,150).map(({label,type,value})=>({label,type,value}));
    const controls=(input.controls??[]).slice(0,150).map(({label,role,value,checked,pressed,choice,selectedLabels})=>({label,role,value,checked,pressed,choice,selectedLabels}));
    // A new tab is a new form: never mix its current fields/uploads with the old draft.
    job.browserProgress={observedAt,tabId:input.tabId,url:url.toString(),fields,controls,files:input.files??[],submissionState:job.status};
    job.resumeContext={browser:'Jev Chrome',tabId:input.tabId,url:url.toString(),step:'Son gözlenen form durumu otomatik kaydedildi',nextAction:'Sekmeyi doğrula; kayıtlı ilerlemeyi güncel alanlarla karşılaştır ve yalnızca eksikleri doldur. Gönderim belirsizse tekrar gönderme.',savedAt:observedAt};
    // Avoid one activity/event entry for every browser observation.
    this.db.prepare('UPDATE jobs SET data=? WHERE id=? AND candidate_id=?').run(JSON.stringify(job),id,candidate);
    this.jobRegistry.bind(candidate,id,url.toString(),'observed_application_page');
    return job;
  }
  saveApplicationCheckpoint(candidate,id,input,sessionId){
    return this.jobRegistry.atomic(()=>this.recordApplicationCheckpoint(candidate,id,input,sessionId));
  }
  recordApplicationCheckpoint(candidate,id,input,sessionId){
    const job=this.job(candidate,id);
    if(['submitted','already_submitted','skipped'].includes(job.status))throw Error('Tamamlanmış ilana devam noktası eklenemez');
    if(job.sessionId&&job.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait');
    const url=new URL(text(input.url,'Form URL',3000));
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz form URL');
    job.resumeContext={browser:text(input.browser,'Tarayıcı',300),tabId:text(input.tabId,'Sekme kimliği',300),url:url.toString(),step:text(input.step,'Form adımı',2000),nextAction:text(input.nextAction,'Devam adımı',3000),savedAt:new Date().toISOString()};
    if(this.profile(candidate).browserMode==='separate')job.browserWorkerId=this.workerId??MAIN_WORKER;
    this.jobRegistry.bind(candidate,id,url.toString(),'application_checkpoint');
    return this.saveJob(job,'application_checkpoint_saved');
  }
  ask(candidate,input,sessionId){
    const fields=normalizeFields(input.fields),question=text(input.question,'Soru',3000),jobId=input.jobId||null;
    this.profile(candidate);if(jobId)this.job(candidate,jobId);
    if(jobId){
      const job=this.job(candidate,jobId),reply=missingDocumentReplies(job,this.questions(candidate)).find(q=>sameDocumentRequirement(q,input));
      if(reply)throw Error('Bu zorunlu belgelerin bulunmadığı zaten yanıtlandı. Yeni soru açma; defer_missing_documents(jobId,questionId) ile kayıtlı yanıta dayanarak beklemeye al. Yanıt kimliği: '+reply.id);
    }
    if(input.resumeContext){if(!jobId)throw Error('Devam noktası için ilan gerekli');this.saveApplicationCheckpoint(candidate,jobId,input.resumeContext,sessionId);}
    const signature=value=>JSON.stringify(value?.slice().sort((a,b)=>a.id.localeCompare(b.id))??null);
    const setup=this.setup(candidate),questions=setup?.mode==='improve'&&setup.status!=='complete'?this.setupQuestions(candidate):this.questions(candidate);
    const existing=questions.find(q=>q.answer===null&&q.jobId===jobId&&q.applicationBlocker?.kind===input.applicationBlocker?.kind&&q.applicationBlocker?.consentScope===input.applicationBlocker?.consentScope&&(fields?signature(q.fields)===signature(fields):!q.fields&&q.question===question));
    if(existing)return {...existing,reused:true};
    // A fresh diagnosis of the same technical step updates its open question.
    // Never merge candidate facts, consent questions, or different jobs.
    const recovery=input.applicationBlocker?.recovery?.kind;
    const technical=jobId&&!fields&&input.applicationBlocker?.kind==='access'&&['form_entry','captcha','user_only'].includes(recovery)
      ?questions.find(q=>q.answer===null&&q.jobId===jobId&&!q.fields&&q.applicationBlocker?.kind==='access'&&q.applicationBlocker?.recovery?.kind===recovery):null;
    if(technical){
      this.db.prepare('UPDATE questions SET question=?,application_blocker=? WHERE id=? AND candidate_id=?').run(question,JSON.stringify(input.applicationBlocker),technical.id,candidate);
      const updated={...technical,question,applicationBlocker:input.applicationBlocker,reused:true};this.event(candidate,'question_updated',updated);return updated;
    }
    const q={id:randomUUID(),candidateId:candidate,jobId,question,answer:null,fields,applicationBlocker:input.applicationBlocker??null,createdAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO questions(id,candidate_id,job_id,question,answer,created_at,fields,application_blocker) VALUES(?,?,?,?,?,?,?,?)').run(q.id,candidate,q.jobId,q.question,null,q.createdAt,fields?JSON.stringify(fields):null,q.applicationBlocker?JSON.stringify(q.applicationBlocker):null);
    this.event(candidate,'question_asked',q);return q;
  }
  questions(candidate){return this.db.prepare('SELECT id, question, answer, job_id AS jobId, fields, answer_values AS answerValues, application_blocker AS applicationBlocker, created_at AS createdAt, answered_at AS answeredAt FROM questions WHERE candidate_id=? AND resolution IS NULL ORDER BY rowid DESC').all(candidate).map(q=>({...q,fields:JSON.parse(q.fields??'null'),answerValues:JSON.parse(q.answerValues??'null'),applicationBlocker:JSON.parse(q.applicationBlocker??'null')}));}
  reusableAnswers(candidate){return reusableAnswers(this.questions(candidate).reverse());}
  resolveTechnicalQuestion(candidate,id,evidence){
    const q=this.questions(candidate).find(q=>q.id===id);
    if(!q||q.answer!==null||q.applicationBlocker?.kind!=='access'||!['form_entry','user_only'].includes(q.applicationBlocker?.recovery?.kind))throw Error('Yalnızca yanıtlanmamış ve çözüldüğü doğrulanan teknik erişim sorusu kapatılabilir');
    const resolution={kind:'technical_resolved',evidence:text(evidence,'Çözüm kanıtı',3000),at:new Date().toISOString()};
    this.db.prepare('UPDATE questions SET resolution=? WHERE id=? AND candidate_id=? AND answer IS NULL').run(JSON.stringify(resolution),id,candidate);
    this.event(candidate,'technical_question_resolved',{id,...resolution});return resolution;
  }
  answer(candidate,id,answer){const q=this.questions(candidate).find(q=>q.id===id);if(!q||q.answer!==null)throw Error('Soru bulunamadı veya zaten yanıtlandı');const result=q.fields&&typeof answer!=='string'?validateAnswers(q.fields,answer):{summary:text(answer,'Yanıt',10000),values:null};const r=this.db.prepare('UPDATE questions SET answer=?, answer_values=?, answered_at=? WHERE id=? AND candidate_id=? AND answer IS NULL').run(result.summary,result.values?JSON.stringify(result.values):null,new Date().toISOString(),id,candidate);if(!r.changes)throw Error('Soru zaten yanıtlandı');this.event(candidate,'question_answered',{id,answer:result.summary,answerValues:result.values});return{id,answer:result.summary,answerValues:result.values};}
  setup(id){const row=this.db.prepare('SELECT data FROM setups WHERE candidate_id=?').get(id);return row?JSON.parse(row.data):null;}
  saveSetup(id,value){this.profile(id);this.db.prepare('INSERT INTO setups VALUES(?,?) ON CONFLICT(candidate_id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(value));return value;}
  createSetup(settings){const p=this.saveProfile({name:'Yeni aday',preferences:'Setup sırasında belirlenecek',facts:'',authorization:'research',agentSettings:settings});this.saveSetup(p.id,{status:'intake',stage:'source',source:null,needsTurn:false});return p;}
  beginProfileImprovement(id){
    const setup=this.setup(id);this.profile(id);
    if(setup&&setup.status!=='complete')throw Error('Önce açık profil çalışmasını tamamla');
    return this.saveSetup(id,{...setup,mode:'improve',status:'running',stage:'preferences',needsTurn:false,askForChanges:true,error:null,failures:0,startedAt:new Date().toISOString(),excludedQuestionIds:this.questions(id).map(q=>q.id),message:'Profilinde geliştirmek istediklerini agent ile konuşabilirsin.'});
  }
  setupQuestions(id){const setup=this.setup(id),questions=this.questions(id);return setup?.mode==='improve'?questions.filter(q=>!q.jobId&&!(setup.excludedQuestionIds??[]).includes(q.id)):questions;}
  finishProfileImprovement(id){
    const setup=this.setup(id);if(setup?.mode!=='improve'||setup.status==='complete')throw Error('Etkin profil geliştirme bulunamadı');
    for(const q of this.setupQuestions(id).filter(q=>q.answer===null))this.db.prepare('UPDATE questions SET resolution=? WHERE candidate_id=? AND id=?').run(JSON.stringify({kind:'profile_improvement_closed',at:new Date().toISOString()}),id,q.id);
    this.saveSetup(id,{...setup,status:'complete',needsTurn:false,error:null,completedAt:new Date().toISOString()});return this.profile(id);
  }
  updateSetupProfile(id,input){
    const setup=this.setup(id);if(setup?.status!=='running')throw Error('Etkin setup bulunamadı');
    if(!['reading','preferences','review'].includes(input.stage))throw Error('Geçersiz setup aşaması');
    const p=this.profile(id),fields={...p};for(const key of ['name','preferences','facts'])if(input[key]!==undefined)fields[key]=setup.mode==='improve'&&key==='facts'&&input[key]===''?'':text(input[key],key,key==='facts'?30000:12000);
    if(input.stage==='review'&&(fields.name==='Yeni aday'||fields.preferences==='Setup sırasında belirlenecek'||setup.mode!=='improve'&&!fields.facts.trim()||this.setupQuestions(id).some(q=>q.answer===null)))throw Error('Profil ve bekleyen sorular tamamlanmalı');
    this.saveProfile(fields);this.saveSetup(id,{...setup,status:input.stage==='review'?'review':'running',stage:input.stage,message:text(input.message,'Durum'),error:null});this.event(id,'setup_updated',{stage:input.stage,message:input.message});return this.profile(id);
  }
  completeSetup(id,input){const setup=this.setup(id);if(setup?.status!=='review')throw Error('Profil henüz hazır değil');const p=this.profile(id);const updated=this.saveProfile({...p,name:input.name,preferences:input.preferences,facts:setup.mode==='improve'?input.facts:text(input.facts,'Profil bilgileri',30000),authorization:input.authorization});this.saveSetup(id,{...setup,status:'complete',needsTurn:false,completedAt:new Date().toISOString()});
    if(setup.mode==='improve')return updated;
    for(const source of this.sources(id)){if(source.modeInherited){const dk=['jobindex','jobnet','jobdanmark','jobbank'].includes(source.integrationId);const preferences=updated.preferences.toLowerCase();const denmark=/\b(denmark|danmark|danimarka|copenhagen|kopenhag)\b/.test(preferences)&&!/(outside|hariç|exclude|dışında|not)/.test(preferences);this.saveSource(id,{...source,applyMode:'auto',enabled:dk?denmark:source.enabled},{silent:true});}}
    return updated;}
  campaign(id){return this.workerState.campaign(id,this.workerId??MAIN_WORKER);}
  saveCampaign(id,value){return this.workerState.saveCampaign(id,this.workerId??MAIN_WORKER,value);}
  saveTaskReview(candidate,taskId,knowledge){
    if(this.workerId&&this.workerId!==MAIN_WORKER){this.profile(candidate);this.workerState.write(candidate,this.workerId,'review',{taskId,knowledge});return;}
    this.profile(candidate);
    this.db.prepare('INSERT INTO task_context_reviews VALUES(?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET task_id=excluded.task_id,data=excluded.data').run(candidate,taskId,knowledge);
  }
  taskReview(candidate,taskId){
    if(this.workerId&&this.workerId!==MAIN_WORKER){const review=this.workerState.read(candidate,this.workerId,'review');return review?.taskId===taskId?review.knowledge:undefined;}
    return this.db.prepare('SELECT data FROM task_context_reviews WHERE candidate_id=? AND task_id=?').get(candidate,taskId)?.data;
  }
  taskContext(candidate){
    const campaign=this.campaign(candidate),task=campaign?.task;
    const profile=this.profile(candidate),job=task?.jobId?this.rankedJob(candidate,task.jobId):null,ranking=task?.kind==='rank';
    const unfinishedTabs=this.jobs(candidate).filter(j=>j.resumeContext&&!['submitted','already_submitted','skipped'].includes(j.status)&&(j.resumeContext.browser!=='Jev Chrome'||!ranking&&(!task?.jobId||j.id===task.jobId))).map(j=>({jobId:j.id,status:j.status,resumeContext:j.id===task?.jobId&&!ranking?j.resumeContext:{browser:j.resumeContext.browser,tabId:j.resumeContext.tabId,url:j.resumeContext.url}}));
    if(job?.preparation)job.preparation=preparationView(job,profile);
    const applicationAuthorization=campaign?.status==='running'&&task?.verificationOnly?{mode:'verify',scope:'this_job',requestId:task.manualRequestId,instruction:'Verify the result of the existing submission only. Do not prepare, submit or repeat any sending step. Record observed confirmation; if the result remains unclear preserve uncertain and report the actual blocker. Fresh field validation evidence may establish that submission was prevented, but never grants permission to resubmit in this task.'}:campaign?.status==='running'&&preparationAuthorized(job,task)?{mode:'prepare',scope:'this_job',requestId:task.preparationRequestId,overrides:['profile_authorization','source_mode','ranking','campaign_target'],instruction:'Prepare the application package only. Never submit, including when profile/source allow auto. Save requirements, documents and answers with save_preparation. Preserve user edits.'}:campaign?.status==='running'&&manualApplicationAuthorized(job,task)?{mode:'submit',scope:'this_job',requestId:task.manualRequestId,overrides:['profile_authorization','source_mode','ranking','campaign_target'],instruction:'User explicitly queued this application. Submit using verified candidate facts. Preserve unanswered questions, consent policies and duplicate/submission verification safeguards. Reuse job.preparation documents and user-edited answers, checking freshness and the actual form before sending.'}:null;
    return compactTaskContext({documentRoot:this.candidateDirectory(candidate),applicationAuthorization,setup:this.setup(candidate),campaign:campaign?{status:campaign.status,task}:null,profile,job,candidateReplyActions:ranking?[]:candidateReplyActions(job,this.questions(candidate)),browserResume:ranking?null:browserResume(profile,job),source:task?.sourceId?this.source(candidate,task.sourceId):null,questions:this.questions(candidate).filter(q=>(!q.jobId||q.jobId===task?.jobId)&&(!ranking||q.answer!==null)),reusableAnswers:this.reusableAnswers(candidate),unfinishedTabs});
  }
  applicationHistory(candidate,{jobId,company,status,limit=20,offset=0}={}){
    this.profile(candidate);
    if(jobId){const related=this.jobRegistry.members(candidate,jobId),ids=new Set(related.map(j=>j.id));return {job:this.rankedJob(candidate,jobId),relatedApplications:related.filter(j=>j.id!==jobId),questions:this.questions(candidate).filter(q=>ids.has(q.jobId))};}
    // MCP gets summaries, never the renderer's full snapshot and event payloads.
    const matches=this.visibleJobs(candidate).filter(j=>(!company||j.company.toLocaleLowerCase().includes(company.toLocaleLowerCase()))&&(!status||j.status===status));
    const jobs=matches.slice(offset,offset+limit).map(j=>({id:j.id,company:j.company,role:j.role,url:j.url,location:j.location,status:j.status,updatedAt:j.updatedAt,submitted:Boolean(j.proof),followupStopped:Boolean(j.followupStopped)}));
    return {jobs,total:matches.length,offset,limit,nextOffset:offset+jobs.length<matches.length?offset+jobs.length:null};
  }
  rankedJob(candidate,id){const job=this.job(candidate,id);return {...job,rankDecision:rankDecision(this.profile(candidate),job)};}
  snapshot(candidate){const campaign=this.campaign(candidate),tasks=this.workerState.tasks(candidate),profile=this.profile(candidate),sources=this.sources(candidate),bySource=new Map(sources.map(s=>[s.id,s]));return{setup:this.setup(candidate),campaign:this.campaign(candidate),profile,sources,jobs:this.visibleJobs(candidate,true).map(job=>({...job,preparation:preparationView(job,profile),preparationQueueState:preparationQueueState(this,candidate,job),manualQueueState:applicationQueueState(this,candidate,job,{campaign,tasks}),rankDecision:rankDecision(profile,job),queueState:applicationReadiness(profile,job,bySource.get(job.sourceId))})),questions:this.questions(candidate),events:this.db.prepare('SELECT seq,kind,data,at FROM events WHERE candidate_id=? ORDER BY seq DESC LIMIT 60').all(candidate).map(r=>({...r,data:JSON.parse(r.data)}))};}
  close(){this.db.close();}
}
