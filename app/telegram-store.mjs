import {randomBytes,createHash} from 'node:crypto';

const id=()=>randomBytes(12).toString('hex');
const hash=value=>createHash('sha256').update(value).digest('hex');
const decode=row=>row?{...row,data:JSON.parse(row.data)}:null;
export const applicationCompleted=job=>['submitted','already_submitted'].includes(job.status)||['manual_submitted','already_submitted'].includes(job.manualOutcome);
export const matchesTelegramScore=(job,minScore)=>minScore==null||Number.isFinite(job.assessment?.score)&&job.assessment.score>minScore&&job.assessment.score<=100;

// Telegram state shares the candidate database so workspace deletion also removes its deliveries.
export class TelegramStore{
 constructor(store,now=Date.now,botId=null){
  this.store=store;this.db=store.db;this.now=now;this.botId=botId==null?null:String(botId);
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS telegram_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS telegram_configs(candidate_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,bot_id TEXT NOT NULL,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS telegram_links(candidate_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,chat_id TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,cursor INTEGER NOT NULL,UNIQUE(bot_id,chat_id),UNIQUE(bot_id,user_id));
   CREATE TABLE IF NOT EXISTS telegram_pairs(hash TEXT PRIMARY KEY,candidate_id TEXT UNIQUE NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS telegram_outbox(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0,message_id INTEGER,error TEXT,UNIQUE(candidate_id,event_key));
   CREATE INDEX IF NOT EXISTS telegram_pending ON telegram_outbox(status,next_at);
   CREATE TABLE IF NOT EXISTS telegram_job_deliveries(candidate_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,job_id TEXT NOT NULL,sent_at INTEGER NOT NULL,PRIMARY KEY(candidate_id,bot_id,job_id));
   CREATE TABLE IF NOT EXISTS telegram_job_messages(delivery_id TEXT PRIMARY KEY REFERENCES telegram_outbox(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL,body TEXT,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0,error TEXT);
   CREATE INDEX IF NOT EXISTS telegram_job_message_updates ON telegram_job_messages(job_id,status);
   CREATE TABLE IF NOT EXISTS telegram_pins(delivery_id TEXT PRIMARY KEY REFERENCES telegram_outbox(id) ON DELETE CASCADE,
    wanted INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'synced',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT);
   INSERT OR IGNORE INTO telegram_job_messages(delivery_id,job_id)
    SELECT id,json_extract(data,'$.jobId') FROM telegram_outbox
    WHERE status='sent' AND message_id>0 AND json_extract(data,'$.kind')='new_job';
  `);
  // Keep the existing durable edit queue and its retries; it now also tracks
  // question cards and form prompts. Backfill saved messages on upgrade.
  if(!this.db.prepare('PRAGMA table_info(telegram_job_messages)').all().some(column=>column.name==='question_id'))this.db.exec('ALTER TABLE telegram_job_messages ADD COLUMN question_id TEXT');
  if(!this.db.prepare('PRAGMA table_info(telegram_job_messages)').all().some(column=>column.name==='priority'))this.db.exec('ALTER TABLE telegram_job_messages ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
  this.db.exec('CREATE INDEX IF NOT EXISTS telegram_question_message_updates ON telegram_job_messages(question_id,status)');
  this.db.exec(`INSERT OR IGNORE INTO telegram_job_messages(delivery_id,job_id,question_id)
    SELECT o.id,coalesce(json_extract(q.value,'$.recordId'),''),json_extract(q.value,'$.id') FROM telegram_outbox o
    JOIN automations a ON a.id=o.candidate_id
    JOIN json_each(a.data,'$.questions') q ON json_extract(q.value,'$.id')=json_extract(o.data,'$.questionId')
    WHERE o.status='sent' AND o.message_id>0 AND json_extract(o.data,'$.kind') IN ('question','message')
     AND coalesce(json_extract(o.data,'$.reply_markup.force_reply'),0)=0;`);
  if(!this.db.prepare('PRAGMA table_info(telegram_links)').all().some(column=>column.name==='bot_id'))this.transaction(()=>{
   this.db.exec(`CREATE TABLE telegram_links_scoped(candidate_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL,chat_id TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,cursor INTEGER NOT NULL,UNIQUE(bot_id,chat_id),UNIQUE(bot_id,user_id));
    INSERT INTO telegram_links_scoped SELECT candidate_id,coalesce((SELECT value FROM telegram_meta WHERE key='bot'),''),chat_id,user_id,data,cursor FROM telegram_links;
    DROP TABLE telegram_links;ALTER TABLE telegram_links_scoped RENAME TO telegram_links;`);
  });
  this.migrateSentJobs(this.meta('bot'));
 }
 transaction(fn){this.db.exec('BEGIN');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 metaKey(key){return this.botId===null?key:`bot:${this.botId}:${key}`;}
 meta(key,fallback=null){if(key==='bot'&&this.botId!==null)return this.botId;return this.db.prepare('SELECT value FROM telegram_meta WHERE key=?').get(this.metaKey(key))?.value??fallback;}
 setMeta(key,value){this.db.prepare('INSERT OR REPLACE INTO telegram_meta VALUES(?,?)').run(this.metaKey(key),String(value));}
 configs(){return this.db.prepare('SELECT * FROM telegram_configs').all().map(decode);}
 config(candidate){return decode(this.db.prepare('SELECT * FROM telegram_configs WHERE candidate_id=?').get(candidate));}
 saveConfig(candidate,config){this.db.prepare('INSERT INTO telegram_configs VALUES(?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET bot_id=excluded.bot_id,data=excluded.data').run(candidate,String(config.bot.id),JSON.stringify(config));}
 scope(column,enabled=false){return `${column} IN (SELECT candidate_id FROM telegram_configs WHERE (? IS NULL OR bot_id=?)${enabled?" AND json_extract(data,'$.enabled')=1":''})`;}
 owns(candidate){return this.botId===null||this.config(candidate)?.bot_id===this.botId;}
 assertCandidate(candidate){this.store.profile(candidate);if(!this.owns(candidate))throw Error('Bu aday farklı bir Telegram botuna bağlı.');}
 links(){return this.db.prepare(`SELECT * FROM telegram_links WHERE ${this.scope('candidate_id',true)}`).all(this.botId,this.botId).map(decode);}
 link(candidate){return this.owns(candidate)?decode(this.db.prepare('SELECT * FROM telegram_links WHERE candidate_id=?').get(candidate)):null;}
 sender(chat,user){return decode(this.db.prepare(`SELECT * FROM telegram_links WHERE chat_id=? AND user_id=? AND ${this.scope('candidate_id',true)}`).get(String(chat),String(user),this.botId,this.botId));}
 saveLink(link){this.db.prepare('UPDATE telegram_links SET data=?,cursor=? WHERE candidate_id=? AND chat_id=? AND user_id=?').run(JSON.stringify(link.data),link.cursor,link.candidate_id,link.chat_id,link.user_id);}
 pair(candidate){
  this.assertCandidate(candidate);if(this.link(candidate))throw Error('Bu aday zaten bağlı. Yeni hesap için önce bağlantıyı kaldır.');
  const token=randomBytes(24).toString('base64url'),expires=this.now()+10*60*1000;
  this.db.prepare('DELETE FROM telegram_pairs WHERE expires<=? OR candidate_id=?').run(this.now(),candidate);
  this.db.prepare('INSERT INTO telegram_pairs VALUES(?,?,?)').run(hash(token),candidate,expires);
  return {token,expires};
 }
 bind(token,chat,user,name){
  if(typeof token!=='string'||token.length>64)return null;
  return this.transaction(()=>{
   const pair=this.db.prepare(`SELECT * FROM telegram_pairs WHERE hash=? AND expires>? AND ${this.scope('candidate_id',true)}`).get(hash(token),this.now(),this.botId,this.botId);
   if(!pair||this.link(pair.candidate_id))return null;
   const botId=this.config(pair.candidate_id).bot_id;
   if(this.db.prepare('SELECT 1 FROM telegram_links WHERE bot_id=? AND (chat_id=? OR user_id=?)').get(botId,String(chat),String(user)))return null;
   const cursor=this.store.maxEventSeq();
   const data={name:String(name).slice(0,150),newJobs:true,notifications:true,questions:true,linkedAt:this.now(),dialog:null};
   this.db.prepare('INSERT INTO telegram_links VALUES(?,?,?,?,?,?)').run(pair.candidate_id,botId,String(chat),String(user),JSON.stringify(data),cursor);
   this.db.prepare('DELETE FROM telegram_pairs WHERE candidate_id=?').run(pair.candidate_id);
   return this.link(pair.candidate_id);
  });
 }
 unlink(candidate){
  this.transaction(()=>this.clearConnection(candidate));
 }
 clearConnection(candidate){
  this.assertCandidate(candidate);
  this.migrateSentJobs(this.config(candidate)?.bot_id,candidate);
  for(const table of ['telegram_outbox','telegram_pairs','telegram_links'])this.db.prepare(`DELETE FROM ${table} WHERE candidate_id=?`).run(candidate);
 }
 preferences(candidate,input){
  const link=this.link(candidate);if(!link)throw Error('Önce adayı Telegram’a bağla.');
  const previousMinScore=link.data.newJobsMinScore??null,wasEnabled=link.data.newJobs!==false;
  if(input.newJobsMinScore!==undefined&&input.newJobsMinScore!==null&&(!Number.isFinite(input.newJobsMinScore)||input.newJobsMinScore<0||input.newJobsMinScore>100))throw Error('Otomatik ilanlar için minimum puan 0–100 arasında olmalı.');
  for(const key of ['notifications','questions']){if(typeof input[key]!=='boolean')throw Error('Geçersiz bildirim tercihi');link.data[key]=input[key];}
  if(input.newJobs!==undefined&&typeof input.newJobs!=='boolean')throw Error('Geçersiz ilan bildirimi tercihi');
  link.data.newJobs=input.newJobs??link.data.newJobs??true;
  if(input.newJobsMinScore!==undefined)link.data.newJobsMinScore=input.newJobsMinScore;
  if(!link.data.questions)link.data.dialog=null;
  this.transaction(()=>{
   this.saveLink(link);
   if(link.data.newJobs&&(!wasEnabled||previousMinScore!==(link.data.newJobsMinScore??null)))this.wakeScoreWaits(candidate);
  });return link;
 }
 enqueue(candidate,key,data){
  this.assertCandidate(candidate);
  this.db.prepare('INSERT OR IGNORE INTO telegram_outbox(id,candidate_id,event_key,data) VALUES(?,?,?,?)').run(id(),candidate,key,JSON.stringify(data));
  return decode(this.db.prepare('SELECT * FROM telegram_outbox WHERE candidate_id=? AND event_key=?').get(candidate,key));
 }
 message(candidate,text,extra={},key=id()){return this.enqueue(candidate,key,{kind:'message',text,...extra});}
 delivery(deliveryId){return decode(this.db.prepare(`SELECT * FROM telegram_outbox WHERE id=? AND ${this.scope('candidate_id')}`).get(deliveryId,this.botId,this.botId));}
 question(candidate,questionId){
  this.assertCandidate(candidate);
  const q=this.store.questions(candidate).find(q=>q.id===questionId);
  return q?{...q,resolution:q.resolution??null}:null;
 }
 pending(){return this.db.prepare(`SELECT * FROM telegram_outbox WHERE status='pending' AND next_at<=? AND ${this.scope('candidate_id',true)} ORDER BY rowid LIMIT 20`).all(this.now(),this.botId,this.botId).map(decode);}
 recordJobDelivery(row,botId){
  if(botId!=null&&row?.data.kind==='new_job')this.db.prepare('INSERT OR IGNORE INTO telegram_job_deliveries VALUES(?,?,?,?)').run(row.candidate_id,String(botId),row.data.jobId,this.now());
 }
 migrateSentJobs(botId,candidate=null){
  if(botId==null)return;
  for(const row of this.db.prepare("SELECT o.* FROM telegram_outbox o JOIN telegram_configs c ON c.candidate_id=o.candidate_id WHERE c.bot_id=? AND o.status IN ('sent','deleted') AND (? IS NULL OR o.candidate_id=?)").all(String(botId),candidate,candidate))this.recordJobDelivery(decode(row),botId);
 }
 jobSent(candidate,botId,jobId){return botId!=null&&Boolean(this.db.prepare('SELECT 1 FROM telegram_job_deliveries WHERE candidate_id=? AND bot_id=? AND job_id=?').get(candidate,String(botId),jobId));}
 sent(deliveryId,messageId=null,botId=this.meta('bot'),body=null){
  this.transaction(()=>{
   this.db.prepare("UPDATE telegram_outbox SET status='sent',message_id=?,error=NULL WHERE id=?").run(messageId,deliveryId);
   const row=this.delivery(deliveryId);this.recordJobDelivery(row,botId);
   if(row?.data.kind==='new_job'&&messageId>0)this.db.prepare('INSERT OR IGNORE INTO telegram_job_messages(delivery_id,job_id,body,status) VALUES(?,?,?,?)').run(deliveryId,row.data.jobId,body?JSON.stringify(body):null,body?'synced':'pending');
   // Telegram cannot edit ForceReply messages; their original question card is editable.
   if(row?.data.questionId&&!row.data.reply_markup?.force_reply&&messageId>0){
    const q=this.question(row.candidate_id,row.data.questionId);
    if(q)this.db.prepare('INSERT OR IGNORE INTO telegram_job_messages(delivery_id,job_id,question_id,body,status) VALUES(?,?,?,?,?)').run(deliveryId,q.jobId??'',q.id,body?JSON.stringify(body):null,body?'synced':'pending');
   }
  });
 }
 deleted(deliveryId){this.transaction(()=>{this.db.prepare("UPDATE telegram_outbox SET status='deleted',error=NULL WHERE id=? AND status='sent'").run(deliveryId);this.db.prepare('DELETE FROM telegram_job_messages WHERE delivery_id=?').run(deliveryId);this.db.prepare('DELETE FROM telegram_pins WHERE delivery_id=?').run(deliveryId);});}
 prioritizeEdit(deliveryId){
  const row=this.delivery(deliveryId);if(row?.status!=='sent')return;
  this.db.prepare("UPDATE telegram_job_messages SET priority=1,status=CASE WHEN status='synced' THEN 'pending' ELSE status END WHERE delivery_id=?").run(deliveryId);
 }
 pendingEdits({urgent=false}={}){return this.db.prepare(`SELECT o.*,m.body AS rendered_body,m.attempts AS edit_attempts FROM telegram_job_messages m JOIN telegram_outbox o ON o.id=m.delivery_id WHERE o.status='sent' AND m.status='pending' AND m.next_at<=? AND ${this.scope('o.candidate_id',true)} ${urgent?'AND (m.priority>0 OR m.question_id IS NOT NULL)':''} ORDER BY m.priority DESC,(m.question_id IS NOT NULL) DESC,m.rowid LIMIT 20`).all(this.now(),this.botId,this.botId).map(decode);}
 edited(deliveryId,body){this.db.prepare("UPDATE telegram_job_messages SET body=?,status='synced',attempts=0,next_at=0,error=NULL,priority=0 WHERE delivery_id=?").run(body?JSON.stringify(body):null,deliveryId);}
 failEdit(row,error){
  const attempts=row.edit_attempts+1,permanent=[400,403].includes(error.code);
  const delay=Math.max(error.retryAfter??0,Math.min(300,2**Math.min(attempts,8)))*1000;
  this.db.prepare('UPDATE telegram_job_messages SET attempts=?,next_at=?,status=?,error=? WHERE delivery_id=?').run(attempts,this.now()+delay,permanent?'failed':'pending',error.message,row.id);
 }
 collectPins(){
  for(const link of this.links())this.transaction(()=>{
   const candidate=link.candidate_id,jobs=new Set(this.store.jobs(candidate).map(job=>job.id));
   // Pinning only needs live record tasks. Resolve them once per workspace;
   // queueState would reload the workspace and task history for every card.
   const queued=new Set(this.store.workerState.tasks(candidate).map(({task})=>task.jobId).filter(Boolean));
   const rows=this.db.prepare("SELECT o.id,json_extract(o.data,'$.jobId') AS job_id,p.wanted FROM telegram_outbox o LEFT JOIN telegram_pins p ON p.delivery_id=o.id WHERE o.candidate_id=? AND o.status='sent' AND o.message_id>0 AND json_extract(o.data,'$.kind')='new_job'").all(candidate);
   for(const row of rows){
    const wanted=Number(jobs.has(row.job_id)&&queued.has(row.job_id));
    if(row.wanted===null){this.db.prepare('INSERT INTO telegram_pins(delivery_id,wanted,status) VALUES(?,?,?)').run(row.id,wanted,wanted?'pending':'synced');if(wanted)this.prioritizeEdit(row.id);}
    else if(row.wanted!==wanted){this.db.prepare("UPDATE telegram_pins SET wanted=?,status='pending',attempts=0,next_at=0,error=NULL WHERE delivery_id=?").run(wanted,row.id);this.prioritizeEdit(row.id);}
   }
  });
 }
 pendingPins(){return this.db.prepare(`SELECT o.*,p.wanted,p.attempts AS pin_attempts FROM telegram_pins p JOIN telegram_outbox o ON o.id=p.delivery_id WHERE o.status='sent' AND p.status='pending' AND p.next_at<=? AND ${this.scope('o.candidate_id',true)} ORDER BY p.wanted,p.rowid LIMIT 20`).all(this.now(),this.botId,this.botId).map(decode);}
 pinned(deliveryId){this.db.prepare("UPDATE telegram_pins SET status='synced',attempts=0,next_at=0,error=NULL WHERE delivery_id=?").run(deliveryId);}
 failPin(row,error){
  const attempts=row.pin_attempts+1,permanent=[400,403].includes(error.code),delay=Math.max(error.retryAfter??0,Math.min(300,2**Math.min(attempts,8)))*1000;
  this.db.prepare('UPDATE telegram_pins SET attempts=?,next_at=?,status=?,error=? WHERE delivery_id=?').run(attempts,this.now()+delay,permanent?'failed':'pending',error.message,row.id);
 }
 skipped(deliveryId){this.db.prepare("UPDATE telegram_outbox SET status='skipped',error=NULL WHERE id=?").run(deliveryId);}
 waitForScore(deliveryId){this.db.prepare("UPDATE telegram_outbox SET status='waiting_score',error=NULL WHERE id=? AND status='pending'").run(deliveryId);}
 wakeScoreWaits(candidate,jobId=null){
  this.db.prepare("UPDATE telegram_outbox SET status='pending',next_at=0 WHERE candidate_id=? AND status='waiting_score' AND (? IS NULL OR json_extract(data,'$.jobId')=?)").run(candidate,jobId,jobId);
 }
 fail(row,error){
  const attempts=row.attempts+1,permanent=[400,403].includes(error.code);
  const delay=Math.max(error.retryAfter??0,Math.min(300,2**Math.min(attempts,8)))*1000;
  this.db.prepare('UPDATE telegram_outbox SET attempts=?,next_at=?,status=?,error=? WHERE id=?').run(attempts,this.now()+delay,permanent?'failed':'pending',error.message,row.id);
 }
 retry(candidate){
  this.assertCandidate(candidate);
  this.db.prepare("UPDATE telegram_outbox SET status='pending',attempts=0,next_at=0,error=NULL WHERE candidate_id=? AND status IN ('pending','failed')").run(candidate);
  this.db.prepare("UPDATE telegram_job_messages SET status='pending',attempts=0,next_at=0,error=NULL WHERE status IN ('pending','failed') AND delivery_id IN (SELECT id FROM telegram_outbox WHERE candidate_id=? AND status='sent')").run(candidate);
  this.db.prepare("UPDATE telegram_pins SET status='pending',attempts=0,next_at=0,error=NULL WHERE status IN ('pending','failed') AND delivery_id IN (SELECT id FROM telegram_outbox WHERE candidate_id=? AND status='sent')").run(candidate);
 }
 queueUnsentJobs(candidate,botId,input={}){
  this.assertCandidate(candidate);if(!this.link(candidate))throw Error('Önce adayı Telegram’a bağla.');
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Geçersiz Telegram gönderim seçimi.');
  const {minScore=null,resend=false}=input;
  if(minScore!==null&&(!Number.isFinite(minScore)||minScore<0||minScore>100))throw Error('Minimum puan 0–100 arasında olmalı.');
  if(typeof resend!=='boolean')throw Error('Geçersiz yeniden gönderme seçimi.');
  return this.transaction(()=>{
   this.migrateSentJobs(botId);
   const result={queued:0,alreadyQueued:0,alreadySent:0,completed:0,filtered:0};
   const pending=new Map(this.db.prepare("SELECT * FROM telegram_outbox WHERE candidate_id=? AND status='pending' AND json_extract(data,'$.kind')='new_job' ORDER BY rowid").all(candidate).map(row=>[JSON.parse(row.data).jobId,decode(row)]));
   for(const job of this.store.visibleJobs(candidate).slice().reverse()){
    if(!matchesTelegramScore(job,minScore)){result.filtered++;continue;}
    if(!resend&&applicationCompleted(job)){result.completed++;continue;}
    const delivered=this.jobSent(candidate,botId,job.id);
    if(!resend&&delivered){result.alreadySent++;continue;}
    const data={kind:'new_job',jobId:job.id,backfill:true,...(minScore!==null?{minScore}:{}),...(resend?{resend:true}:{})};
    if(pending.has(job.id)){
     const row=pending.get(job.id);
     // Reuse a queued card, including automatic deliveries, without erasing an
     // explicit resend request or creating a second in-flight message.
     this.db.prepare('UPDATE telegram_outbox SET data=? WHERE id=?').run(JSON.stringify({...data,...(row.data.resend?{resend:true}:{})}),row.id);result.alreadyQueued++;continue;
    }
    // Keep original receipts and callbacks intact. Only this explicit delivery
    // may bypass history; automatic notifications still use new-job:<id>.
    const originalKey=`new-job:${job.id}`,original=decode(this.db.prepare('SELECT * FROM telegram_outbox WHERE candidate_id=? AND event_key=?').get(candidate,originalKey));
    const duplicate=resend&&(delivered||original&&['sent','deleted'].includes(original.status));
    // A never-delivered job retains its canonical key so collecting a delayed
    // job_found event cannot enqueue another card alongside this batch.
    const key=duplicate?`resend-job:${job.id}:${id()}`:originalKey,row=duplicate?null:original;
    if(row&&['sent','deleted'].includes(row.status)){result.alreadySent++;continue;}
    if(row)this.db.prepare("UPDATE telegram_outbox SET data=?,status='pending',attempts=0,next_at=0,error=NULL WHERE id=?").run(JSON.stringify(data),row.id);
    else this.enqueue(candidate,key,data);
    result.queued++;
   }
   return result;
  });
 }
 refreshJobMessages(candidate,jobId=null){
  this.assertCandidate(candidate);
  this.db.prepare("UPDATE telegram_job_messages SET status='pending' WHERE status='synced' AND (? IS NULL OR job_id=?) AND delivery_id IN (SELECT id FROM telegram_outbox WHERE candidate_id=? AND status='sent')").run(jobId,jobId,candidate);
 }
 refreshQuestionMessages(candidate,questionId){
  this.assertCandidate(candidate);
  this.db.prepare("UPDATE telegram_job_messages SET status='pending' WHERE status='synced' AND question_id=? AND delivery_id IN (SELECT id FROM telegram_outbox WHERE candidate_id=? AND status='sent')").run(questionId,candidate);
 }
 collect(){
  for(const link of this.links())this.transaction(()=>{
   // Queue changes live on the campaign rather than the job. Refresh old cards on
   // upgrade, and whenever scheduling or permissions change without a job event.
   const campaign=this.store.campaign(link.candidate_id),profile=this.store.profile(link.candidate_id);
   const queueSignature=hash(JSON.stringify(['workspace-cards-v1',campaign?.status,campaign?.task?.jobId,campaign?.task?.kind,Boolean(campaign?.task?.report),
    this.store.workerState.tasks(link.candidate_id).map(({workerId,task})=>[workerId,task.jobId,task.kind,task.state,Boolean(task.report)]),
    profile.authorization,this.store.sources(link.candidate_id).map(source=>[source.id,source.applyMode])]));
   if(link.data.queueSignature!==queueSignature){this.refreshJobMessages(link.candidate_id);link.data.queueSignature=queueSignature;}
   const rows=this.store.eventsAfter(link.candidate_id,link.cursor);
   for(const row of rows){
    const data=JSON.parse(row.data);
    // Keep retries/backoff intact and coalesce all job changes into the next edit.
    if(data.id)this.refreshJobMessages(link.candidate_id,data.id);
    // Only deliveries already waiting on a score may wake after ranking. A
    // later assessment must not resurrect sent/deleted cards or old jobs.
    if(data.id&&link.data.newJobs!==false)this.wakeScoreWaits(link.candidate_id,data.id);
    if(['question_answered','question_updated','technical_question_resolved'].includes(row.kind)){
     this.refreshQuestionMessages(link.candidate_id,data.id);
     const q=this.question(link.candidate_id,data.id);if(q?.jobId)this.refreshJobMessages(link.candidate_id,q.jobId);
    }
    if(link.data.newJobs!==false&&row.kind==='job_found'&&!this.jobSent(link.candidate_id,this.meta('bot'),data.id))this.enqueue(link.candidate_id,`new-job:${data.id}`,{kind:'new_job',jobId:data.id});
    if(link.data.notifications&&['submission_recorded','existing_submission_recorded','candidate_submission_recorded'].includes(row.kind))this.enqueue(link.candidate_id,`submission:${data.id}`,{kind:'submission',jobId:data.id,event:row.kind});
    if(link.data.questions&&row.kind==='question_asked')this.enqueue(link.candidate_id,`question:${data.id}`,{kind:'question',questionId:data.id});
    link.cursor=row.seq;
   }
   if(link.data.dialog){
    const q=this.question(link.candidate_id,link.data.dialog.questionId);
    if(!q||q.answer!==null||q.resolution)link.data.dialog=null;
   }
   this.saveLink(link);
  });
 }
 openQuestions(link){
  if(!link.data.questions)return;
  for(const q of this.store.questions(link.candidate_id).filter(q=>q.answer===null)){
   const row=this.enqueue(link.candidate_id,`question:${q.id}`,{kind:'question',questionId:q.id});
   if(row.status==='skipped')this.db.prepare("UPDATE telegram_outbox SET status='pending',next_at=0 WHERE id=?").run(row.id);
  }
 }
 status(candidate){
  if(!candidate)return null;this.store.profile(candidate);
  const link=this.link(candidate),pair=this.db.prepare('SELECT expires FROM telegram_pairs WHERE candidate_id=? AND expires>?').get(candidate,this.now());
  const deliveryStates=this.db.prepare("SELECT status,error FROM telegram_outbox WHERE candidate_id=? UNION ALL SELECT m.status,m.error FROM telegram_job_messages m JOIN telegram_outbox o ON o.id=m.delivery_id WHERE o.candidate_id=? AND o.status='sent' UNION ALL SELECT p.status,p.error FROM telegram_pins p JOIN telegram_outbox o ON o.id=p.delivery_id WHERE o.candidate_id=? AND o.status='sent'").all(candidate,candidate,candidate);
  const lastError=deliveryStates.findLast(row=>row.error)?.error??null;
  return {candidateId:candidate,candidateName:this.store.profile(candidate).name,connected:Boolean(link),name:link?.data.name??null,
   newJobs:link?.data.newJobs??true,newJobsMinScore:link?.data.newJobsMinScore??null,notifications:link?.data.notifications??true,questions:link?.data.questions??true,expires:pair?.expires??null,
   pending:deliveryStates.filter(row=>row.status==='pending').length,waitingScore:deliveryStates.filter(row=>row.status==='waiting_score').length,failed:deliveryStates.filter(row=>row.status==='failed').length,lastError};
 }
}
