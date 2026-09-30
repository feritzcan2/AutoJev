import {webUrl} from './automation-templates.mjs';
import {createHash} from 'node:crypto';
import {jobSearchTemplate} from './templates/job-search.mjs';

const parse=row=>row?JSON.parse(row.data):null;
const mode=value=>({research:'observe',find_only:'observe',prepare:'prepare',submit:'auto',auto:'auto'}[value]??'observe');
const at=value=>typeof value==='number'?value:Date.parse(value)||0;
const proof=value=>typeof value==='string'?value:JSON.stringify(value??'');

// Startup-only compatibility import. The old runtime is never registered.
// Receipts prevent replay after edits, restarts, or deletion of an imported workspace.
export function upgradeWorkspaces(db){
 const core=db.store.workspaces,sql=db.db;
 sql.exec('CREATE TABLE IF NOT EXISTS workspace_imports(workspace_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
 return core.tasks.atomic(()=>{
  // Previously imported application templates keep their mail vocabulary.
  for(const row of sql.prepare("SELECT DISTINCT t.id,t.data FROM automation_templates t JOIN workspaces w ON w.template_id=t.id JOIN automations a ON a.id=w.id WHERE json_extract(a.data,'$.migration.from')='applications' AND json_type(t.data,'$.mail') IS NULL").all()){
   sql.prepare('UPDATE automation_templates SET data=? WHERE id=?').run(JSON.stringify({...parse(row),mail:jobSearchTemplate.mail}),row.id);
  }
  if(!core.exists('candidates'))return [];
  const migrated=[];
  for(const row of sql.prepare('SELECT id,data FROM candidates').all()){
   if(sql.prepare('SELECT 1 FROM workspace_imports WHERE workspace_id=?').get(row.id))continue;
   const id=row.id,p=parse(row),workspace=core.get(id);
   if(db.has(id))throw Error('Çalışma alanı geçişinde kimlik çakışması: '+id);
   const personal=core.exists('automation_templates')?parse(sql.prepare('SELECT data FROM automation_templates WHERE id=?').get(workspace.templateId)):null;
   if(personal){
    const fields=[...jobSearchTemplate.fields,...(personal.fields??[]).filter(f=>!jobSearchTemplate.fields.some(x=>x.id===f.id))];
    const template={...personal,kind:'web',execution:{driver:'browser'},records:jobSearchTemplate.records,mail:personal.mail??jobSearchTemplate.mail,workflow:undefined,fields,guidance:[jobSearchTemplate.guidance,personal.guidance].filter(Boolean).join('\n\n')};
    sql.prepare('UPDATE automation_templates SET data=? WHERE id=?').run(JSON.stringify(template),workspace.templateId);
   }
   const sources=core.exists('sources')?sql.prepare('SELECT data FROM sources WHERE candidate_id=? ORDER BY rowid').all(id).map(parse):[];
   const campaign=core.exists('campaigns')?parse(sql.prepare('SELECT data FROM campaigns WHERE candidate_id=?').get(id)):null;
   const tasks=core.tasks.list(id,{limit:100000});
   const questions=core.exists('questions')?sql.prepare('SELECT * FROM questions WHERE candidate_id=?').all(id):[];
   const now=Date.now(),sourceSettings={},sourceState={};
   const table=structuredClone(workspace.table??jobSearchTemplate.table);
   for(const column of table.columns)if(column.key==='source'&&column.label==='Şirket')column.label='Kaynak';
   if(!table.columns.some(c=>c.key==='company')&&table.columns.length<10)table.columns.splice(2,0,{key:'company',label:'Şirket',type:'text'});
   for(const source of sources){
    const url=webUrl(source.url);
    sourceSettings[url]={searchMethod:source.searchMethod??'free',integrationId:source.integrationId??null,fallback:source.fallback??'web',skillText:source.skillText??null,customTool:source.customTool??null,name:source.name,query:source.query,enabled:source.enabled,intervalMinutes:source.intervalMinutes,mode:mode(source.applyMode)};
    const pending=source.scanProgress,checkpoint=source.resumeContext;
    sourceState[url]={lastRunAt:source.lastRunAt,nextRunAt:source.nextRunAt,lastStatus:source.lastStatus,lastFound:source.lastFound,lastResult:source.lastResult,blocked:source.lastStatus==='blocked',
     ...(pending?{scan:{complete:pending.complete===true,pendingUrls:pending.pendingUrls??[],reason:pending.reason??source.lastResult??'Kayıtlı taramaya devam et',evidenceUrl:pending.evidenceUrl??checkpoint?.url??source.url}}:{}),
     ...(checkpoint?{resumeContext:checkpoint,blocker:source.lastStatus==='blocked'?checkpoint:null}:{}),legacySourceId:source.id};
   }
   const legacyRecords=sql.prepare('SELECT id,record_key,data FROM workspace_records WHERE workspace_id=?').all(id);
   const migratedQuestions=questions.filter(q=>!q.resolution).map(q=>({id:q.id,recordId:q.job_id??null,text:q.question,fields:JSON.parse(q.fields??'null'),answerValues:JSON.parse(q.answer_values??'null'),resolution:q.resolution,answer:q.answer,createdAt:at(q.created_at),answeredAt:q.answer==null?null:now}));
   const a={id,templateId:workspace.templateId,templateVersion:2,title:workspace.title,goal:p.preferences||'Kayıtlı profile uygun iş ilanlarını bul ve başvuruları takip et.',
    criteria:{...p.criteria,preferences:p.preferences??'',ranking:p.criteria?.ranking??JSON.stringify({threshold:p.rankThreshold,weights:p.rankWeights},null,2),application_policy:p.criteria?.application_policy??JSON.stringify(p.applicationPolicy??{},null,2)},facts:(p.facts??'').slice(0,12000),instructions:'Kayıtlı belgeleri, geçmiş başvuruları ve profil bilgilerini kullan. Aynı ilana tekrar başvurma.',
    sources:sources.map(s=>webUrl(s.url)),sourceSettings,sourceState,mode:mode(p.authorization),intervalMinutes:campaign?.intervalMinutes??30,
    revision:1,reviewedRevision:null,trial:null,status:'paused',nextRunAt:null,createdAt:at(p.createdAt)||now,updatedAt:now,
    referenceData:{profile:p,applicationPolicy:p.applicationPolicy??{},ranking:{threshold:p.rankThreshold,weights:p.rankWeights},previousTasks:tasks},questions:migratedQuestions,
    migration:{from:'applications',at:now},table};
   // Keep the existing files, Chrome profile, identity and worker conversations.
   sql.prepare('UPDATE workspaces SET data=? WHERE id=?').run(JSON.stringify({...workspace,table,storagePath:'candidates/'+id,browserStoragePath:'.'}),id);
   db.put(a);
   for(const old of legacyRecords){
    const record=parse(old),status=['submitted','already_submitted'].includes(record.status)||['already_submitted','manual_submitted'].includes(record.manualOutcome)?'completed':['submitting','uncertain'].includes(record.status)?'uncertain':['skipped','withdrawn'].includes(record.status)||record.manualOutcome==='withdrawn'?'dismissed':record.status==='prepared'?'prepared':'found';
    const proposal=record.preparation?.summary??record.note??'',sourceUrl=sources.find(s=>s.id===record.sourceId)?.url;
    const item={...record,legacyApplication:record,automationId:id,key:old.record_key,title:record.role??record.title??'İlan',summary:record.fit??record.note??'',status,proposal,
     digest:createHash('sha256').update(JSON.stringify([record.url,proposal])).digest('hex'),approvedDigest:null,trial:false,revision:1,
     createdAt:at(record.createdAt)||now,updatedAt:at(record.updatedAt)||now,attemptedAt:['completed','uncertain'].includes(status)?at(record.updatedAt)||now:undefined,
     evidence:proof(record.proof??record.evidence),documents:record.documents??record.preparation?.documents??[],sourceUrl:sourceUrl?webUrl(sourceUrl):undefined,
     cells:{...record.cells,company:record.company??'',location:record.location??'',score:record.rank?.score??''}};
    core.records.put(id,item.key,item);
   }
   // Legacy task payloads remain as history, but cannot hold a live worker lease.
   for(const task of tasks)if(['pending','running','reported','paused'].includes(task.state))core.tasks.finish(id,task.id,'interrupted','Ortak otomasyon modeline taşındı; kayıtlı devam noktası korundu.');
   db.message(id,'system','Çalışma alanı ortak otomasyon modeline taşındı. Kayıtlar, belgeler, kaynak aralıkları ve bekleyen sorular korundu. Profili kontrol edip kaydet; takibi sürdürebilirsin. Her kaynak ilk turunda otomatik denenir.');
   for(const q of migratedQuestions)db.message(id,q.answer==null?'assistant':'system',q.text+(q.answer==null?'':'\nKayıtlı yanıt: '+q.answer));
   if(core.exists('telegram_links'))sql.prepare('UPDATE telegram_links SET cursor=0 WHERE candidate_id=?').run(id);
   sql.prepare('INSERT INTO workspace_imports VALUES(?,?)').run(id,JSON.stringify({profile:p,sources,campaign,questions,tasks,at:now}));
   migrated.push(id);
  }
  return migrated;
 });
}

export function removeImportedWorkspace(sql,id){
 if(!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_imports'").get()||!sql.prepare('SELECT 1 FROM workspace_imports WHERE workspace_id=?').get(id))return;
 for(const {name} of sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
  if(!/^[a-z_]+$/.test(name))continue;
  if(sql.prepare(`PRAGMA table_info(${name})`).all().some(c=>c.name==='candidate_id'))sql.prepare(`DELETE FROM ${name} WHERE candidate_id=?`).run(id);
 }
 sql.prepare('DELETE FROM candidates WHERE id=?').run(id);
 sql.prepare('UPDATE workspace_imports SET data=? WHERE workspace_id=?').run('{"deleted":true}',id);
}
