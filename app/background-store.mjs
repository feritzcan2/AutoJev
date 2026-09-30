import {withAgentDefaults} from './agent-settings.mjs';
import {randomUUID} from 'node:crypto';
import {boundedText as text} from './automation-templates.mjs';
import {applicationMailContract,mailReviewOutcomes} from './mail-contract.mjs';
export class BackgroundStore {
 constructor(store){this.store=store;this.db=store.db;this.db.exec(`
 CREATE TABLE IF NOT EXISTS background_tasks(candidate_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS background_runs(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS mail_signals(id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, account TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(candidate_id,account,message_id));`);
 // Preserve mailbox selection while retiring application-owned OAuth credentials.
 if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gmail_accounts'").get()){
  for(const row of this.db.prepare('SELECT candidate_id,email FROM gmail_accounts').all()){const task=this.task(row.candidate_id);if(!task.mailbox)this.putTask(row.candidate_id,{...task,mailbox:row.email.toLowerCase(),connection:null});}
  this.db.exec('DROP TABLE gmail_accounts');
 }
 }
 task(id){const profile=this.store.profile(id),saved=JSON.parse(this.db.prepare('SELECT data FROM background_tasks WHERE candidate_id=?').get(id)?.data??'null');const emails=[...new Set(((profile.facts??'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)??[]).map(email=>email.toLowerCase()))];return{candidateId:id,enabled:false,intervalMinutes:30,timeoutMinutes:10,nextRunAt:0,...saved,skillPath:saved?.skillPath??'',agentOverride:saved?.agentOverride??null,agentSettings:withAgentDefaults(saved?.agentOverride??profile.agentSettings),mailbox:(emails.length===1?emails[0]:saved?.mailbox??''),connection:saved?.connection??null};}
 save(id,input){const previous=this.task(id);input={timeoutMinutes:10,...input};const agentOverride=input.agentOverride===undefined?previous.agentOverride:input.agentOverride;const agentSettings=withAgentDefaults(agentOverride??this.store.profile(id).agentSettings);const providerChanged=agentSettings.provider!==previous.agentSettings.provider;for(const [key,min,max]of [['intervalMinutes',1,10080],['timeoutMinutes',1,60]])if(!Number.isInteger(input[key])||input[key]<min||input[key]>max)throw Error(`${key}: ${min}–${max} olmalı`);const mailbox=String(input.mailbox??previous.mailbox).trim().toLowerCase();if(mailbox&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox))throw Error('Geçerli Gmail adresi gerekli');const task={...previous,mailbox,connectorAccess:providerChanged?null:previous.connectorAccess,connection:providerChanged||mailbox!==previous.mailbox||input.skillPath!==undefined&&input.skillPath!==previous.skillPath?null:previous.connection,enabled:input.enabled===true,intervalMinutes:input.intervalMinutes,timeoutMinutes:input.timeoutMinutes,skillPath:String(input.skillPath??previous.skillPath),agentOverride,agentSettings,nextRunAt:input.enabled&&(!previous.enabled||input.intervalMinutes!==previous.intervalMinutes||input.skillPath!==undefined&&input.skillPath!==previous.skillPath)?0:previous.nextRunAt};this.putTask(id,task);return task;}
 putTask(id,task){this.store.profile(id);this.db.prepare('INSERT INTO background_tasks VALUES(?,?) ON CONFLICT(candidate_id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(task));}
 runs(id){this.store.profile(id);return this.db.prepare('SELECT data FROM background_runs WHERE candidate_id=? ORDER BY rowid DESC LIMIT 30').all(id).map(r=>JSON.parse(r.data));}
 run(id){return JSON.parse(this.db.prepare('SELECT data FROM background_runs WHERE id=?').get(id)?.data??'null');}
 putRun(run){this.db.prepare('INSERT INTO background_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id,run.candidateId,JSON.stringify(run));}
 begin(id){const run={id:randomUUID(),candidateId:id,status:'running',state:'Starting',agentSettings:this.task(id).agentSettings,startedAt:Date.now(),finishedAt:null,skillPath:this.task(id).skillPath,summary:'Skill çalıştırılıyor'};this.putRun(run);return run;}
 recover(){for(const row of this.db.prepare('SELECT data FROM background_runs').all()){const run=JSON.parse(row.data);if(run.status==='running'){Object.assign(run,{status:'interrupted',finishedAt:Date.now(),summary:'Uygulama kapandı; bu çalışma tamamlanamadı.'});this.putRun(run);const task=this.task(run.candidateId);this.putTask(run.candidateId,{...task,nextRunAt:0});}}}
 processed(id,email,messageId){const row=this.db.prepare('SELECT data FROM mail_signals WHERE candidate_id=? AND account=? AND message_id=?').get(id,email,messageId);if(!row)return false;const signal=JSON.parse(row.data);return !(signal.outcome==='unmatched'&&signal.review==='pending');}
 pendingSignals(id,email){this.store.profile(id);return this.db.prepare("SELECT data FROM mail_signals WHERE candidate_id=? AND account=? AND json_extract(data,'$.outcome')='unmatched' AND json_extract(data,'$.review')='pending' ORDER BY rowid").all(id,email).map(r=>JSON.parse(r.data));}
 signals(id){this.store.profile(id);return this.db.prepare("SELECT data FROM mail_signals WHERE candidate_id=? AND json_extract(data,'$.outcome')!='ignored' ORDER BY rowid DESC LIMIT 200").all(id).map(r=>JSON.parse(r.data)).filter(s=>s.outcome!=='ignored');}
 mailContract(id){this.store.profile(id);return this.store.mailContract?.(id)??applicationMailContract;}
 record(id,email,message,input){
  const row=this.db.prepare('SELECT data FROM mail_signals WHERE candidate_id=? AND account=? AND message_id=?').get(id,email,message.id),previous=row?JSON.parse(row.data):null;
  if(previous&&!(previous.outcome==='unmatched'&&previous.review==='pending'))return{duplicate:true};
  if(![...this.mailContract(id).outcomes,...mailReviewOutcomes].some(o=>o.id===input.outcome))throw Error('Geçersiz mail sonucu');
  if(input.jobId)this.store.job(id,input.jobId);
  const signal={id:previous?.id??randomUUID(),messageId:message.id,threadId:message.threadId,account:email,jobId:input.jobId||null,outcome:input.outcome,summary:text(input.summary,'Mail özeti',2000),subject:message.subject,date:message.date,url:message.url??`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${message.threadId}`,evidence:message.evidence??null,connector:message.connector??null,review:input.jobId&&input.outcome!=='unmatched'?'accepted':'pending',createdAt:previous?.createdAt??Date.now()};
  if(previous){this.db.prepare('UPDATE mail_signals SET data=? WHERE id=? AND candidate_id=? AND account=?').run(JSON.stringify(signal),previous.id,id,email);return signal;}
  this.db.prepare('INSERT INTO mail_signals VALUES(?,?,?,?,?)').run(signal.id,id,email,message.id,JSON.stringify(signal));return signal;
 }
 resolve(id,signalId,jobId,outcome){this.store.job(id,jobId);if(!this.mailContract(id).outcomes.some(o=>o.id===outcome))throw Error('Geçersiz sonuç');const row=this.db.prepare('SELECT data FROM mail_signals WHERE id=? AND candidate_id=?').get(signalId,id);if(!row)throw Error('Mail kaydı bulunamadı');const signal={...JSON.parse(row.data),jobId,outcome,review:'accepted'};this.db.prepare('UPDATE mail_signals SET data=? WHERE id=?').run(JSON.stringify(signal),signalId);return signal;}
 dismiss(id,signalId){this.store.profile(id);const row=this.db.prepare('SELECT data FROM mail_signals WHERE id=? AND candidate_id=?').get(signalId,id);if(!row)throw Error('Mail kaydı bulunamadı');const signal=JSON.parse(row.data);signal.review='dismissed';this.db.prepare('UPDATE mail_signals SET data=? WHERE id=?').run(JSON.stringify(signal),signalId);}
}
