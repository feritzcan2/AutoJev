import {canonicalJobUrl,jobUrlKey,listingIdentity} from './job-urls.mjs';
import {vacancyGroupKey,annotateDuplicates,applicationDuplicate} from './job-identity.mjs';

const terminal=new Set(['submitted','already_submitted','skipped']);
const preference={submitted:8,already_submitted:7,uncertain:6,submitting:6,prepared:5,working:4,blocked:3,found:2,skipped:1};
// A saved package owns this vacancy's preparation hold and user edits. Keep it
// visible when another source later resolves to the same listing identity.
const primaryPreference=job=>job.preparation&&['found','working','blocked','prepared'].includes(job.status)?5.5:preference[job.status]??0;

// Original job rows and their foreign keys remain intact. Membership only
// changes which row represents the vacancy in queues, lists and counters.
export class JobRegistry {
  constructor(db){
    this.db=db;this.sequence=0;
    const uniqueMetadata=db.prepare('PRAGMA index_list(jobs)').all().some(index=>index.unique&&db.prepare(`PRAGMA index_info("${index.name.replaceAll('"','""')}")`).all().map(c=>c.name).join(',')==='candidate_id,identity');
    if(uniqueMetadata){
      db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
      try{
        db.exec(`CREATE TABLE jobs_new(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL REFERENCES candidates(id),url TEXT NOT NULL,identity TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(candidate_id,url));
          INSERT INTO jobs_new SELECT * FROM jobs;
          DROP TABLE jobs; ALTER TABLE jobs_new RENAME TO jobs;`);
        if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('İlan geçmişi taşınırken ilişki doğrulaması başarısız');
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys=ON');}
    }
    db.exec(`CREATE INDEX IF NOT EXISTS jobs_candidate ON jobs(candidate_id);
      CREATE TABLE IF NOT EXISTS job_members(candidate_id TEXT NOT NULL REFERENCES candidates(id),job_id TEXT PRIMARY KEY REFERENCES jobs(id),canonical_id TEXT NOT NULL REFERENCES jobs(id),match_key TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_members_group ON job_members(candidate_id,canonical_id);
      CREATE INDEX IF NOT EXISTS job_members_match ON job_members(candidate_id,match_key);
      CREATE TABLE IF NOT EXISTS job_keys(candidate_id TEXT NOT NULL REFERENCES candidates(id),key TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES jobs(id),PRIMARY KEY(candidate_id,key));
      CREATE INDEX IF NOT EXISTS job_keys_job ON job_keys(job_id);
      CREATE TABLE IF NOT EXISTS job_urls(candidate_id TEXT NOT NULL REFERENCES candidates(id),url TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES jobs(id),evidence TEXT NOT NULL,PRIMARY KEY(candidate_id,url));
      CREATE TABLE IF NOT EXISTS job_registry_lock(id INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO job_registry_lock VALUES(1);`);
    this.atomic(()=>{
      // Reindex on startup so new route support and jobs imported by older
      // app versions also acquire identities. No application row is rewritten.
      const rows=db.prepare('SELECT data FROM jobs ORDER BY rowid').all();
      for(const row of rows)this.register(JSON.parse(row.data));
    });
  }
  atomic(fn){
    const name='job_registry_'+(++this.sequence);
    this.db.exec(`SAVEPOINT ${name}`);
    try{
      // Acquire the writer lock before reading identity/ownership state, also
      // when two Store instances share a database.
      this.db.exec('UPDATE job_registry_lock SET id=id WHERE id=1');
      const result=fn();this.db.exec(`RELEASE ${name}`);return result;
    }catch(error){this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);throw error;}
  }
  canonical(candidate,id){return this.db.prepare('SELECT canonical_id FROM job_members WHERE candidate_id=? AND job_id=?').get(candidate,id)?.canonical_id??id;}
  raw(candidate,id){const row=this.db.prepare('SELECT data FROM jobs WHERE candidate_id=? AND id=?').get(candidate,id);if(!row)throw Error('İlan bulunamadı');return JSON.parse(row.data);}
  members(candidate,id){return this.db.prepare('SELECT j.data FROM jobs j JOIN job_members m ON m.job_id=j.id WHERE m.candidate_id=? AND m.canonical_id=? ORDER BY j.rowid').all(candidate,this.canonical(candidate,id)).map(r=>JSON.parse(r.data));}
  selectPrimary(candidate,ids){
    const peers=ids.flatMap(id=>this.members(candidate,id));
    peers.sort((a,b)=>primaryPreference(b)-primaryPreference(a)||Number(Boolean(b.proof))-Number(Boolean(a.proof))||Number(b.rank?.status==='scored')-Number(a.rank?.status==='scored')||String(a.createdAt).localeCompare(String(b.createdAt))||a.id.localeCompare(b.id));
    const primary=peers[0].id;
    for(const id of new Set(ids))this.db.prepare('UPDATE job_members SET canonical_id=? WHERE candidate_id=? AND canonical_id=?').run(primary,candidate,id);
    return primary;
  }
  register(job){
    this.db.prepare('INSERT INTO job_members VALUES(?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET match_key=excluded.match_key').run(job.candidateId,job.id,job.id,vacancyGroupKey(job));
    this.bind(job.candidateId,job.id,job.url,'listing',true);
    if(listingIdentity(job.proof?.url))this.bind(job.candidateId,job.id,job.proof.url,'saved_submission_proof');
    return this.selectPrimary(job.candidateId,[this.canonical(job.candidateId,job.id)]);
  }
  lookup(candidate,url){
    const clean=canonicalJobUrl(url),key=jobUrlKey(clean);
    const row=this.db.prepare('SELECT m.canonical_id FROM job_keys k JOIN job_members m ON m.job_id=k.job_id WHERE k.candidate_id=? AND k.key=?').get(candidate,key)
      ??this.db.prepare('SELECT m.canonical_id FROM job_urls u JOIN job_members m ON m.job_id=u.job_id WHERE u.candidate_id=? AND u.url=?').get(candidate,clean);
    return row?.canonical_id??null;
  }
  bind(candidate,id,url,evidence,allowUnknown=false){
    const clean=canonicalJobUrl(url),identity=listingIdentity(clean);
    if(!identity&&!allowUnknown)return {linked:false,reason:'unknown_listing_identity',jobId:this.canonical(candidate,id)};
    const key=identity?.key??'url:'+clean,prior=this.lookup(candidate,clean);
    if(prior&&prior!==this.canonical(candidate,id))this.selectPrimary(candidate,[prior,this.canonical(candidate,id)]);
    this.db.prepare('INSERT OR IGNORE INTO job_keys VALUES(?,?,?)').run(candidate,key,id);
    this.db.prepare('INSERT OR IGNORE INTO job_urls VALUES(?,?,?,?)').run(candidate,clean,id,evidence);
    return {linked:true,key,jobId:this.canonical(candidate,id)};
  }
  decorate(jobs){
    if(!jobs.length)return [];
    const candidate=jobs[0].candidateId,byId=new Map(jobs.map(j=>[j.id,j]));
    const members=this.db.prepare('SELECT job_id,canonical_id FROM job_members WHERE candidate_id=?').all(candidate);
    const counts=new Map();for(const m of members)counts.set(m.canonical_id,(counts.get(m.canonical_id)??0)+1);
    for(const m of members){const job=byId.get(m.job_id);if(job){job.canonicalJobId=m.canonical_id;job.duplicateCount=counts.get(m.canonical_id)-1;}}
    const keys=this.db.prepare('SELECT k.key,m.canonical_id FROM job_keys k JOIN job_members m ON m.job_id=k.job_id WHERE k.candidate_id=?').all(candidate),groupKeys=new Map();
    for(const {canonical_id,key} of keys){if(!groupKeys.has(canonical_id))groupKeys.set(canonical_id,[]);groupKeys.get(canonical_id).push(key);}
    for(const job of jobs)job.listingKeys=groupKeys.get(job.canonicalJobId)??[];
    return annotateDuplicates(jobs);
  }
  job(candidate,id){
    const job=this.raw(candidate,id),canonical=this.canonical(candidate,id);
    const rows=this.db.prepare(`SELECT j.data,m.canonical_id FROM jobs j JOIN job_members m ON m.job_id=j.id
      WHERE m.candidate_id=? AND (m.canonical_id=? OR m.match_key=?)`).all(candidate,canonical,vacancyGroupKey(job));
    const peers=rows.map(r=>({...JSON.parse(r.data),canonicalJobId:r.canonical_id}));
    const groupKeys=new Map();
    for(const peer of peers){
      if(!groupKeys.has(peer.canonicalJobId))groupKeys.set(peer.canonicalJobId,this.db.prepare('SELECT k.key FROM job_keys k JOIN job_members m ON m.job_id=k.job_id WHERE k.candidate_id=? AND m.canonical_id=?').all(candidate,peer.canonicalJobId).map(r=>r.key));
      peer.listingKeys=groupKeys.get(peer.canonicalJobId);
    }
    const result=peers.find(p=>p.id===id)??{...job,canonicalJobId:canonical};
    delete result.duplicateApplication;result.duplicateCount=peers.filter(p=>p.canonicalJobId===canonical).length-1;
    const duplicate=applicationDuplicate(result,peers);if(duplicate)result.duplicateApplication=duplicate;
    return result;
  }
  assertAvailable(candidate,id,sessionId,tasks=[]){
    const job=this.job(candidate,id),canonical=this.canonical(candidate,id);
    const reservation=tasks.find(w=>w.task?.jobId&&w.task.jobId!==id&&this.canonical(candidate,w.task.jobId)===canonical&&!w.task.report);
    if(reservation)throw Error('Aynı ilan başka bir worker tarafından işleniyor. Görevi tamamla ve ana kaydı kullan.');
    const previous=this.members(candidate,id).find(p=>p.id!==id&&(['submitted','already_submitted','submitting','uncertain'].includes(p.status)||p.followupStopped));
    if(job.duplicateApplication||previous||job.canonicalJobId!==id)throw Error((job.duplicateApplication?.reason??'Aynı ilan için önceki başvuru veya devam eden gönderim var; tekrar gönderilmez.')+' Önceki ilan: '+(previous?.id??canonical));
    if(job.sessionId&&job.sessionId!==sessionId&&!terminal.has(job.status))throw Error('İlan başka bir oturuma ait; kullanıcı devralmalı');
    return job;
  }
}
