import {browserResume} from './browser-resume.mjs';
import {applicationReadiness,rankDecision,rankProfileKey,rankThreshold,normalizeRank} from './ranking.mjs';
import {sourceIntegrations,validateSourceSearch} from './source-integrations.mjs';
import {normalizeFields,validateAnswers} from './question-forms.mjs';
import {reusableAnswers,reusableFactKeys} from './candidate-answers.mjs';
export {reusableFactKeys} from './candidate-answers.mjs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

export function text(value, name, max=12000) {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${name}: geçerli bir metin gerekli`);
  return value.trim();
}
export function canonicalUrl(raw) {
  const url=new URL(text(raw,'URL',3000));
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz ilan bağlantısı');
  url.hash='';
  for(const key of [...url.searchParams.keys()])if(/^(utm_|trk$|trackingId$|ref$|source$|gh_src$)/i.test(key))url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString().replace(/\/$/,'');
}
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
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS agent_conversations(candidate_id TEXT NOT NULL REFERENCES candidates(id), provider TEXT NOT NULL, native_id TEXT NOT NULL, PRIMARY KEY(candidate_id,provider));
      CREATE TABLE IF NOT EXISTS conversation_launch_settings(candidate_id TEXT NOT NULL, provider TEXT NOT NULL, native_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(candidate_id,provider));
      CREATE TABLE IF NOT EXISTS setups(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_context_reviews(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS campaigns(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_catalog_versions(candidate_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), url TEXT NOT NULL, identity TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(candidate_id,url), UNIQUE(candidate_id,identity));
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id), job_id TEXT REFERENCES jobs(id), question TEXT NOT NULL, answer TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompts(seq INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, job_id TEXT, session_id TEXT, at TEXT NOT NULL);`);
    const columns=this.db.prepare('PRAGMA table_info(questions)').all().map(c=>c.name);
    for(const column of ['fields','answer_values','application_blocker','resolution','answered_at'])if(!columns.includes(column))this.db.exec(`ALTER TABLE questions ADD COLUMN ${column} TEXT`);
  }
  logPrompt(candidate,{kind,text,jobId=null,sessionId=null}){if(!['start','message','input'].includes(kind))throw Error('Geçersiz prompt türü');this.db.prepare('INSERT INTO prompts(candidate_id,kind,text,job_id,session_id,at) VALUES(?,?,?,?,?,?)').run(candidate,kind,String(text),jobId,sessionId,new Date().toISOString());}
  prompts(candidate,limit=200){return this.db.prepare('SELECT seq,kind,text,job_id AS jobId,session_id AS sessionId,at FROM prompts WHERE candidate_id=? ORDER BY seq DESC LIMIT ?').all(candidate,limit);}
  event(candidate,kind,data){this.db.prepare('INSERT INTO events(candidate_id,kind,data,at) VALUES(?,?,?,?)').run(candidate,kind,JSON.stringify(data),new Date().toISOString());}
  reportActivity(candidate,sessionId,input){
    this.profile(candidate);
    if(input.jobId)this.job(candidate,input.jobId);
    const task=this.campaign(candidate)?.task;
    if(task?.jobId&&input.jobId&&task.jobId!==input.jobId)throw Error('Bildirim etkin işe ait değil');
    const value={sessionId,taskId:task?.id??null,jobId:input.jobId??task?.jobId??null,message:text(input.message,'İşlem bildirimi',600)};
    this.event(candidate,'agent_activity',value);return value;
  }
  conversation(id,provider){this.profile(id);return this.db.prepare('SELECT native_id FROM agent_conversations WHERE candidate_id=? AND provider=?').get(id,provider)?.native_id??null;}
  forgetConversation(id,provider,nativeId){this.profile(id);this.db.prepare('DELETE FROM agent_conversations WHERE candidate_id=? AND provider=? AND native_id=?').run(id,provider,nativeId);}
  conversationSettings(id,provider,nativeId){this.profile(id);const row=this.db.prepare('SELECT data FROM conversation_launch_settings WHERE candidate_id=? AND provider=? AND native_id=?').get(id,provider,nativeId);return row?JSON.parse(row.data):null;}
  saveConversation(id,provider,nativeId,settings){this.profile(id);if(!['codex','claude'].includes(provider))throw Error('Geçersiz sağlayıcı');const value=text(nativeId,'Oturum kimliği',256);this.db.prepare('INSERT INTO agent_conversations VALUES(?,?,?) ON CONFLICT(candidate_id,provider) DO UPDATE SET native_id=excluded.native_id').run(id,provider,value);if(settings)this.db.prepare('INSERT INTO conversation_launch_settings VALUES(?,?,?,?) ON CONFLICT(candidate_id,provider) DO UPDATE SET native_id=excluded.native_id,data=excluded.data').run(id,provider,value,JSON.stringify(settings));}
  candidates(){return this.db.prepare('SELECT data FROM candidates').all().map(r=>JSON.parse(r.data));}
  profile(id){const row=this.db.prepare('SELECT data FROM candidates WHERE id=?').get(id);if(!row)throw Error('Aday bulunamadı');const profile=JSON.parse(row.data);return{...profile,rankThreshold:rankThreshold(profile.rankThreshold),rankingProfileKey:rankProfileKey(profile),applicationPolicy:{...defaultPolicy,...profile.applicationPolicy}};}
  saveProfile(input){
    const id=input.id||randomUUID();
    const previous=input.id?this.profile(id):{};
    const scope=input.authorization??previous.authorization??'prepare';
    if(!['research','prepare','submit'].includes(scope))throw Error('Geçersiz başvuru yetkisi');
    const settings=input.agentSettings??previous.agentSettings??{provider:'codex',model:'default',permission:'default',reasoning:'default',network:null};
    if(!['existing','separate','jev'].includes(input.browserMode??previous.browserMode??'existing'))throw Error('Geçersiz tarayıcı seçimi');
    let chromeProfile=input.chromeProfile===undefined?previous.chromeProfile??null:input.chromeProfile;
    if(chromeProfile!==null){
      if(typeof chromeProfile!=='object'||!/^[-\w ]{1,100}$/.test(chromeProfile.directory??''))throw Error('Geçersiz Chrome profili');
      chromeProfile={directory:chromeProfile.directory,name:text(chromeProfile.name,'Chrome profili',300)};
    }
    const profile={id,rankThreshold:rankThreshold(input.rankThreshold??previous.rankThreshold),cvRevision:previous.cvRevision??null,chromeProfile,learnedFacts:Object.fromEntries(Object.entries(previous.learnedFacts??{}).filter(([key,fact])=>typeof input.facts!=='string'||input.facts.split('\n').includes(`[${key}] ${fact.value}`))),agentSettings:settings,name:text(input.name,'İsim',150),preferences:text(input.preferences,'Tercihler'),facts:typeof input.facts==='string'?input.facts.slice(0,30000):'',authorization:scope,browserMode:input.browserMode??previous.browserMode??'existing',applicationPolicy:input.applicationPolicy??previous.applicationPolicy??defaultPolicy,cvPath:previous.cvPath??null,updatedAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO candidates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(profile));
    this.event(id,'profile_updated',{});return profile;
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
    const enabled=Boolean(input.enabled),scheduleChanged=previous.id&&(intervalMinutes!==previous.intervalMinutes||enabled&&!previous.enabled),source={...validateSourceSearch(input,previous),modeInherited:silent?previous.modeInherited??true:false,id,candidateId:candidate,name:text(input.name,'Kaynak adı',120),kind:text(input.kind??previous.kind??'custom','Kaynak türü',60),query:text(input.query,'Arama kapsamı',2000),url:canonicalUrl(input.url),enabled,intervalMinutes,applyMode,resumeContext:previous.resumeContext??null,lastRunAt:previous.lastRunAt??null,nextRunAt:scheduleChanged?0:input.nextRunAt??previous.nextRunAt??0,lastResult:previous.lastResult??'Henüz taranmadı',lastFound:previous.lastFound??0,updatedAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO sources VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,candidate,JSON.stringify(source));if(!silent)this.event(candidate,'source_updated',{id,name:source.name,enabled:source.enabled,intervalMinutes,applyMode:source.applyMode});return source;
  }
  deleteSource(candidate,id){const source=this.source(candidate,id);if(this.jobs(candidate).some(job=>job.sourceId===id))throw Error('Bu kaynaktan kayıtlı ilanlar var; silmek yerine kapat');this.db.prepare('DELETE FROM sources WHERE id=? AND candidate_id=?').run(id,candidate);this.event(candidate,'source_deleted',{id,name:source.name});return source;}
  saveSourceCheckpoint(candidate,id,input){
    const source=this.source(candidate,id),task=this.campaign(candidate)?.task;
    if(this.campaign(candidate)?.status!=='running'||task?.kind!=='search'||task.sourceId!==id)throw Error('Etkin kaynak taraması bulunamadı');
    const url=new URL(text(input.url,'Sekme bağlantısı',3000));
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz sekme bağlantısı');
    source.resumeContext={browser:text(input.browser,'Tarayıcı',300),tabId:text(input.tabId,'Sekme kimliği',300),url:url.toString(),savedAt:new Date().toISOString()};
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
  resetSourceSchedule(candidate){for(const source of this.sources(candidate)){source.nextRunAt=0;this.db.prepare('UPDATE sources SET data=? WHERE id=?').run(JSON.stringify(source),source.id);}}
  saveApplicationPolicy(candidate,input){const profile=this.profile(candidate),policy={autoFillKnown:Boolean(input.autoFillKnown),acceptPrivacy:Boolean(input.acceptPrivacy),groupRecruitmentConsent:Boolean(input.groupRecruitmentConsent??profile.applicationPolicy.groupRecruitmentConsent),demographic:['prefer_not_to_say','profile_only'].includes(input.demographic)?input.demographic:'prefer_not_to_say',marketing:['decline','profile_only','auto'].includes(input.marketing)?input.marketing:'decline',unknownImportant:['ask','skip'].includes(input.unknownImportant)?input.unknownImportant:'ask',legalAgreements:['ask','skip','auto'].includes(input.legalAgreements)?input.legalAgreements:'ask'};profile.applicationPolicy=policy;profile.updatedAt=new Date().toISOString();this.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(profile),candidate);this.event(candidate,'application_policy_updated',policy);return policy;}
  jobs(id){this.profile(id);return this.db.prepare('SELECT data FROM jobs WHERE candidate_id=? ORDER BY rowid DESC').all(id).map(r=>JSON.parse(r.data));}
  job(candidate,id){const r=this.db.prepare('SELECT data FROM jobs WHERE id=? AND candidate_id=?').get(id,candidate);if(!r)throw Error('İlan bulunamadı');return JSON.parse(r.data);}
  addJob(candidate,input){
    this.profile(candidate);
    const url=canonicalUrl(input.url),company=text(input.company,'Şirket',200),role=text(input.role,'Pozisyon',250);
    const identity=[normalize(company),normalize(role),normalize(input.location||'')].join('|');
    const prior=this.db.prepare('SELECT data FROM jobs WHERE candidate_id=? AND (url=? OR identity=?)').get(candidate,url,identity);
    if(prior)return {duplicate:true,job:JSON.parse(prior.data)};
    if(input.sourceId)this.source(candidate,input.sourceId);
    const job={id:randomUUID(),candidateId:candidate,sourceId:input.sourceId??null,url,company,role,location:text(input.location,'Konum',250),fit:text(input.fit,'Uygunluk',3000),status:'found',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),note:'',proof:null,sessionId:null};
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id,candidate,url,identity,JSON.stringify(job));this.event(candidate,'job_found',job);return{duplicate:false,job};
  }
  rankJob(candidate,id,input){
    const job=this.job(candidate,id),profile=this.profile(candidate);
    if(['submitted','skipped'].includes(job.status))throw Error('Tamamlanmış ilan yeniden puanlanamaz');
    const rank=normalizeRank(input,profile);
    if(job.rank)return job; // First recorded assessment is final; retries cannot overwrite it.
    if(input.profileKey!==rankProfileKey(profile))throw Error('Profil değişti; get_task_context ile güncel profili okuyup yeniden değerlendir');
    job.rank=rank;delete job.rankOverride;
    return this.saveJob(job,'job_ranked');
  }
  queueRankedJob(candidate,id){
    const job=this.job(candidate,id),profile=this.profile(candidate),decision=rankDecision(profile,job);
    if(!['found','blocked'].includes(job.status)||decision.state!=='below_threshold')throw Error('Yalnızca puanı eşik altında olan açık ilan sıraya alınabilir');
    job.rankOverride={profileKey:job.rank.profileKey,rankedAt:job.rank.rankedAt,at:new Date().toISOString()};
    return this.saveJob(job,'job_rank_override');
  }
  saveRankThreshold(candidate,value){
    const p=this.profile(candidate);p.rankThreshold=rankThreshold(value);
    this.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(p),candidate);
    this.event(candidate,'rank_threshold_updated',{threshold:p.rankThreshold});return p.rankThreshold;
  }
  setManualJobStatus(candidate,id,outcome){
    if(!['manual_submitted','withdrawn'].includes(outcome))throw Error('Geçersiz manuel durum');
    const job=this.job(candidate,id);
    if(job.status==='submitted'&&!job.manualOutcome)throw Error('Kanıtıyla kaydedilmiş gönderim değiştirilemez');
    job.status=outcome==='manual_submitted'?'submitted':'skipped';
    job.manualOutcome=outcome;job.manualUpdatedAt=new Date().toISOString();
    job.note=outcome==='manual_submitted'?'Kullanıcı başvuruyu manuel gönderdi':'Kullanıcı başvurudan vazgeçti';
    job.sessionId=null;
    this.db.prepare('UPDATE questions SET resolution=? WHERE candidate_id=? AND job_id=? AND resolution IS NULL AND answer IS NULL').run(JSON.stringify({kind:outcome,at:job.manualUpdatedAt}),candidate,id);
    return this.saveJob(job,'job_updated');
  }
  updateJob(candidate,id,status,note,sessionId){
    const j=this.job(candidate,id),p=this.profile(candidate);
    const transitions={found:['working','skipped'],working:['prepared','blocked','skipped'],prepared:['working','submitting','blocked','skipped'],blocked:['working','skipped'],submitting:['uncertain'],uncertain:['submitted'],submitted:[],skipped:[]};
    if(status===j.status)return j;
    if(!transitions[j.status]?.includes(status))throw Error(`Geçersiz geçiş: ${j.status} → ${status}${j.status==='submitted'?'. Gönderim zaten kanıtıyla kaydedildi; bu başvurunun durumunu tekrar değiştirme.':['submitting','uncertain'].includes(j.status)?'. Yalnızca gönderimi engelleyen açık alan doğrulama hatası varsa record_validation_failure kullan. Zaman aşımı, CAPTCHA veya onay yokluğu yeterli kanıt değildir.':''}`);
    if(status==='submitted')throw Error('Gönderim kanıtı için record_submission kullan');
    if(status==='working'&&p.authorization==='research')throw Error('Profil yalnızca araştırmaya izin veriyor');
    if(status==='submitting'&&p.authorization!=='submit')throw Error('Gönderim yetkisi yok; kullanıcı profilden değiştirmeli');
    if(status==='submitting'&&j.sourceId&&this.source(candidate,j.sourceId).applyMode!=='auto')throw Error('Bu kaynak otomatik gönderime izin vermiyor');
    if(['working','submitting'].includes(status)&&!rankDecision(p,j).eligible)throw Error('Başvuru puanlama koşulu karşılanmıyor: '+rankDecision(p,j).label+'. Önce rank-jobs ile değerlendir.');
    if(j.sessionId&&j.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait; kullanıcı devralmalı');
    if(status==='submitting')delete j.validationFailure;
    j.status=status;j.note=text(note,'Açıklama',3000);j.sessionId=sessionId;return this.saveJob(j,'job_updated');
  }
  recordValidationFailure(candidate,id,input,sessionId){
    const j=this.job(candidate,id);
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
  saveJob(j,kind){j.updatedAt=new Date().toISOString();this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(j),j.id);this.event(j.candidateId,kind,j);return j;}
  recordSubmission(candidate,id,input,sessionId){
    const j=this.job(candidate,id);
    // This saves evidence of an already-started submission. Current permissions
    // are enforced when entering submitting, not when recording its outcome.
    if(j.status==='submitted')return j;
    if(!['submitting','uncertain'].includes(j.status)||j.sessionId!==sessionId)throw Error('Gönderim bu oturuma ait değil veya başlatılmadı');
    const kind=input.kind;if(!['success_page','confirmation_email','confirmation_message'].includes(kind))throw Error('Geçersiz kanıt türü');
    const proof={kind,text:text(input.text,'Onay metni',5000),url:canonicalUrl(input.url),documents:text(input.documents,'Gönderilen belgeler',3000),observedAt:new Date().toISOString()};
    j.status='submitted';j.proof=proof;j.note='Gönderim onayı kaydedildi';return this.saveJob(j,'submission_recorded');
  }
  recoverSession(candidate,sessionId){for(const j of this.jobs(candidate))if(j.sessionId===sessionId&&['working','prepared','submitting'].includes(j.status)){j.status=j.status==='submitting'?'uncertain':'blocked';j.note='Oturum kapandı. Devralmadan önce dış sitedeki durumu kontrol et.';this.saveJob(j,'session_interrupted');}}
  reclaim(candidate,id,sessionId){const j=this.job(candidate,id);if(!['blocked','uncertain'].includes(j.status))throw Error('Yalnızca kesilmiş işler devralınabilir');j.sessionId=sessionId;return this.saveJob(j,'job_reclaimed');}
  saveApplicationCheckpoint(candidate,id,input,sessionId){
    const job=this.job(candidate,id);
    if(['submitted','skipped'].includes(job.status))throw Error('Tamamlanmış ilana devam noktası eklenemez');
    if(job.sessionId&&job.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait');
    const url=new URL(text(input.url,'Form URL',3000));
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz form URL');
    job.resumeContext={browser:text(input.browser,'Tarayıcı',300),tabId:text(input.tabId,'Sekme kimliği',300),url:url.toString(),step:text(input.step,'Form adımı',2000),nextAction:text(input.nextAction,'Devam adımı',3000),savedAt:new Date().toISOString()};
    return this.saveJob(job,'application_checkpoint_saved');
  }
  ask(candidate,input,sessionId){const fields=normalizeFields(input.fields);this.profile(candidate);if(input.jobId)this.job(candidate,input.jobId);if(input.resumeContext){if(!input.jobId)throw Error('Devam noktası için ilan gerekli');this.saveApplicationCheckpoint(candidate,input.jobId,input.resumeContext,sessionId);}const q={id:randomUUID(),candidateId:candidate,jobId:input.jobId||null,question:text(input.question,'Soru',3000),answer:null,fields,applicationBlocker:input.applicationBlocker??null,createdAt:new Date().toISOString()};this.db.prepare('INSERT INTO questions(id,candidate_id,job_id,question,answer,created_at,fields,application_blocker) VALUES(?,?,?,?,?,?,?,?)').run(q.id,candidate,q.jobId,q.question,null,q.createdAt,fields?JSON.stringify(fields):null,q.applicationBlocker?JSON.stringify(q.applicationBlocker):null);this.event(candidate,'question_asked',q);return q;}
  questions(candidate){return this.db.prepare('SELECT id, question, answer, job_id AS jobId, fields, answer_values AS answerValues, application_blocker AS applicationBlocker FROM questions WHERE candidate_id=? AND resolution IS NULL ORDER BY rowid DESC').all(candidate).map(q=>({...q,fields:JSON.parse(q.fields??'null'),answerValues:JSON.parse(q.answerValues??'null'),applicationBlocker:JSON.parse(q.applicationBlocker??'null')}));}
  resolveTechnicalQuestion(candidate,id,evidence){
    const q=this.questions(candidate).find(q=>q.id===id);
    if(!q||q.answer!==null||q.applicationBlocker?.recovery?.kind!=='form_entry')throw Error('Yalnızca yanıtlanmamış teknik form giriş sorusu kapatılabilir');
    const resolution={kind:'technical_resolved',evidence:text(evidence,'Çözüm kanıtı',3000),at:new Date().toISOString()};
    this.db.prepare('UPDATE questions SET resolution=? WHERE id=? AND candidate_id=? AND answer IS NULL').run(JSON.stringify(resolution),id,candidate);
    this.event(candidate,'technical_question_resolved',{id,...resolution});return resolution;
  }
  answer(candidate,id,answer){const q=this.questions(candidate).find(q=>q.id===id);if(!q||q.answer!==null)throw Error('Soru bulunamadı veya zaten yanıtlandı');const result=q.fields&&typeof answer!=='string'?validateAnswers(q.fields,answer):{summary:text(answer,'Yanıt',10000),values:null};const r=this.db.prepare('UPDATE questions SET answer=?, answer_values=? WHERE id=? AND candidate_id=? AND answer IS NULL').run(result.summary,result.values?JSON.stringify(result.values):null,id,candidate);if(!r.changes)throw Error('Soru zaten yanıtlandı');this.event(candidate,'question_answered',{id,answer:result.summary,answerValues:result.values});return{id,answer:result.summary,answerValues:result.values};}
  setup(id){const row=this.db.prepare('SELECT data FROM setups WHERE candidate_id=?').get(id);return row?JSON.parse(row.data):null;}
  saveSetup(id,value){this.profile(id);this.db.prepare('INSERT INTO setups VALUES(?,?) ON CONFLICT(candidate_id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(value));return value;}
  createSetup(settings){const p=this.saveProfile({name:'Yeni aday',preferences:'Setup sırasında belirlenecek',facts:'',authorization:'research',agentSettings:settings});this.saveSetup(p.id,{status:'intake',stage:'source',source:null,needsTurn:false});return p;}
  updateSetupProfile(id,input){
    const setup=this.setup(id);if(setup?.status!=='running')throw Error('Etkin setup bulunamadı');
    if(!['reading','preferences','review'].includes(input.stage))throw Error('Geçersiz setup aşaması');
    const p=this.profile(id),fields={...p};for(const key of ['name','preferences','facts'])if(input[key]!==undefined)fields[key]=text(input[key],key,key==='facts'?30000:12000);
    if(input.stage==='review'&&(fields.name==='Yeni aday'||fields.preferences==='Setup sırasında belirlenecek'||!fields.facts.trim()||this.questions(id).some(q=>q.answer===null)))throw Error('Profil ve bekleyen sorular tamamlanmalı');
    this.saveProfile(fields);this.saveSetup(id,{...setup,status:input.stage==='review'?'review':'running',stage:input.stage,message:text(input.message,'Durum'),error:null});this.event(id,'setup_updated',{stage:input.stage,message:input.message});return this.profile(id);
  }
  completeSetup(id,input){const setup=this.setup(id);if(setup?.status!=='review')throw Error('Profil henüz hazır değil');const p=this.profile(id);const updated=this.saveProfile({...p,name:input.name,preferences:input.preferences,facts:text(input.facts,'Profil bilgileri',30000),authorization:input.authorization});this.saveSetup(id,{...setup,status:'complete',needsTurn:false,completedAt:new Date().toISOString()});
    for(const source of this.sources(id)){if(source.modeInherited){const dk=['jobindex','jobnet','jobdanmark','jobbank'].includes(source.integrationId);const preferences=updated.preferences.toLowerCase();const denmark=/\b(denmark|danmark|danimarka|copenhagen|kopenhag)\b/.test(preferences)&&!/(outside|hariç|exclude|dışında|not)/.test(preferences);this.saveSource(id,{...source,applyMode:'auto',enabled:dk?denmark:source.enabled},{silent:true});}}
    return updated;}
  campaign(id){const row=this.db.prepare("SELECT data FROM campaigns WHERE candidate_id=?").get(id);return row?JSON.parse(row.data):null;}
  saveCampaign(id,value){this.profile(id);this.db.prepare("INSERT INTO campaigns VALUES(?,?) ON CONFLICT(candidate_id) DO UPDATE SET data=excluded.data").run(id,JSON.stringify(value));return value;}
  saveTaskReview(candidate,taskId,knowledge){
    this.profile(candidate);
    this.db.prepare('INSERT INTO task_context_reviews VALUES(?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET task_id=excluded.task_id,data=excluded.data').run(candidate,taskId,knowledge);
  }
  taskReview(candidate,taskId){
    return this.db.prepare('SELECT data FROM task_context_reviews WHERE candidate_id=? AND task_id=?').get(candidate,taskId)?.data;
  }
  taskContext(candidate){
    const campaign=this.campaign(candidate),task=campaign?.task;
    const profile=this.profile(candidate),job=task?.jobId?this.rankedJob(candidate,task.jobId):null;
    return {setup:this.setup(candidate),campaign:campaign?{status:campaign.status,task}:null,profile,job,browserResume:browserResume(profile,job),source:task?.sourceId?this.source(candidate,task.sourceId):null,questions:this.questions(candidate).filter(q=>!q.jobId||q.jobId===task?.jobId),unfinishedTabs:this.jobs(candidate).filter(j=>j.resumeContext&&!['submitted','skipped'].includes(j.status)).map(j=>({jobId:j.id,status:j.status,resumeContext:j.resumeContext}))};
  }
  rankedJob(candidate,id){const job=this.job(candidate,id);return {...job,rankDecision:rankDecision(this.profile(candidate),job)};}
  snapshot(candidate){const profile=this.profile(candidate),sources=this.sources(candidate),bySource=new Map(sources.map(s=>[s.id,s]));return{setup:this.setup(candidate),campaign:this.campaign(candidate),profile,sources,jobs:this.jobs(candidate).map(job=>({...job,rankDecision:rankDecision(profile,job),queueState:applicationReadiness(profile,job,bySource.get(job.sourceId))})),questions:this.questions(candidate),events:this.db.prepare('SELECT seq,kind,data,at FROM events WHERE candidate_id=? ORDER BY seq DESC LIMIT 60').all(candidate).map(r=>({...r,data:JSON.parse(r.data)}))};}
  close(){this.db.close();}
}
