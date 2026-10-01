import {DatabaseSync} from 'node:sqlite';

// Frozen pre-workspace data, deliberately independent of the current stores.
// Migration tests must remain able to open this format after the old engine is gone.
export function seedLegacyDatabase(file,{personal=false}={}){
 const sql=new DatabaseSync(file),settings={provider:'codex',model:'default',permission:'default',reasoning:'default',network:null};
 const profile={id:'legacy-person',name:'Synthetic candidate',preferences:'Remote engineering',facts:'Berlin',authorization:'research',table:{title:'Applications',columns:[{key:'source',label:'Şirket',type:'text'},{key:'title',label:'Pozisyon',type:'text'}]},browserMode:'jev',chromeProfile:{name:'Work',directory:'Profile 1'},agentSettings:settings,...(personal?{templateId:'template-old-job'}:{})};
 const completed={id:'legacy-completed',candidateId:profile.id,url:'https://example.com/sent',company:'ACME',role:'Engineer',location:'Berlin',status:'submitted',proof:{text:'Receipt 123',url:'https://example.com/sent'},documents:[{path:'documents/letter.md'}]};
 const unsure={...completed,id:'legacy-uncertain',url:'https://example.com/uncertain',role:'Lead',status:'submitting',proof:null};
 const source={id:'legacy-source',name:'Synthetic jobs',url:'https://example.com/jobs',query:'Remote engineering',enabled:true,intervalMinutes:555,applyMode:'find_only',lastRunAt:1000,nextRunAt:33301000,lastResult:'Saved search',lastFound:2};
 const worker={id:'legacy-worker',name:'Saved helper'};
 sql.exec(`PRAGMA user_version=4;
  CREATE TABLE candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
  CREATE TABLE jobs(id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES candidates(id),url TEXT,identity TEXT,data TEXT);
  CREATE TABLE sources(id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES candidates(id),data TEXT);
  CREATE TABLE campaigns(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),data TEXT);
  CREATE TABLE questions(id TEXT PRIMARY KEY,candidate_id TEXT REFERENCES candidates(id),job_id TEXT REFERENCES jobs(id),question TEXT,answer TEXT,created_at TEXT,fields TEXT,answer_values TEXT,resolution TEXT);
  CREATE TABLE agent_workers(candidate_id TEXT REFERENCES candidates(id),id TEXT,data TEXT,PRIMARY KEY(candidate_id,id));
  CREATE TABLE agent_conversations(candidate_id TEXT,provider TEXT,native_id TEXT);
  CREATE TABLE conversation_launch_settings(candidate_id TEXT,provider TEXT,native_id TEXT,data TEXT);
  CREATE TABLE worker_state(candidate_id TEXT,worker_id TEXT,kind TEXT,data TEXT);
  CREATE TABLE automation_templates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 `);
 try{
  sql.prepare('INSERT INTO candidates VALUES(?,?)').run(profile.id,JSON.stringify(profile));
  for(const job of [completed,unsure])sql.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id,profile.id,job.url,job.url,JSON.stringify(job));
  sql.prepare('INSERT INTO sources VALUES(?,?,?)').run(source.id,profile.id,JSON.stringify(source));
  sql.prepare('INSERT INTO campaigns VALUES(?,?)').run(profile.id,JSON.stringify({status:'running',intervalMinutes:30}));
  sql.prepare('INSERT INTO questions VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-question',profile.id,unsure.id,'Start date?',null,'2026-09-29',JSON.stringify([{id:'start',label:'Başlangıç',type:'date'}]),null,null);
  sql.prepare('INSERT INTO agent_workers VALUES(?,?,?)').run(profile.id,worker.id,JSON.stringify(worker));
  sql.prepare('INSERT INTO agent_conversations VALUES(?,?,?)').run(profile.id,'codex','main-history');
  sql.prepare('INSERT INTO conversation_launch_settings VALUES(?,?,?,?)').run(profile.id,'codex','main-history',JSON.stringify(settings));
  sql.prepare('INSERT INTO worker_state VALUES(?,?,?,?)').run(profile.id,worker.id,'conversation:claude',JSON.stringify({nativeId:'helper-history',settings:{...settings,provider:'claude'}}));
  if(personal)sql.prepare('INSERT INTO automation_templates VALUES(?,?)').run(profile.templateId,JSON.stringify({id:profile.templateId,version:1,personal:true,kind:'jobs',title:'Personal applications',fields:[{id:'salary',label:'Salary',question:'Salary?',required:false}],guidance:'Keep personal guidance.'}));
 }finally{sql.close();}
 return {profile,completed,unsure,source,worker,settings};
}
