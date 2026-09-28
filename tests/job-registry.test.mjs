import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../app/store.mjs';
import {listingIdentity,jobUrlKey} from '../app/job-urls.mjs';
import {uniqueJobCount} from '../app/job-identity.mjs';
import {addRankedJob} from './rank-fixture.mjs';
import {startMcp} from '../app/mcp.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

const listing={company:'Example',role:'Backend Engineer',location:'Berlin',fit:'Backend experience',url:'https://www.linkedin.com/jobs/view/4472057514'};
const ats='https://example.jobs.personio.de/job/123';
const fixture=()=>{const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Berlin',authorization:'submit'});return {store,p};};

test('platform identities collapse URL variants and retain employer namespaces',()=>{
  const pairs=[
    [listing.url,'https://de.linkedin.com/jobs/view/backend-engineer-at-example-4472057514?trk=search'],
    [ats,'https://example.jobs.personio.com/job/123?language=de&display=de'],
    ['https://www.stepstone.de/jobs--Role--13883309-inline.html','https://www.stepstone.de/stellenangebote--Role--13883309-inline.html'],
    ['https://job-boards.greenhouse.io/example/jobs/123','https://job-boards.eu.greenhouse.io/example/jobs/123/confirmation'],
    ['https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc','https://jobs.eu.lever.co/example/12345678-1234-1234-1234-123456789abc/apply'],
    ['https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc','https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/already-received?ms=123'],
    ['https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc','https://jobs.ashbyhq.com/example/12345678-1234-1234-1234-123456789abc/application'],
    ['https://join.com/companies/example/123-backend-engineer','https://join.com/companies/example/123-engineer'],
    ['https://jobs.smartrecruiters.com/Example/123-backend','https://jobs.smartrecruiters.com/Example/123-engineer']
  ];
  for(const [a,b] of pairs){assert.ok(listingIdentity(a),a);assert.equal(jobUrlKey(a),jobUrlKey(b));}
  assert.notEqual(jobUrlKey(ats),jobUrlKey('https://other.jobs.personio.de/job/123'));
  assert.notEqual(jobUrlKey(ats),jobUrlKey('https://example.jobs.personio.de/job/124'));
  assert.notEqual(jobUrlKey('https://custom.example/job?position=1'),jobUrlKey('https://custom.example/job?position=2'));
  for(const url of ['https://linkedin.com.evil.test/jobs/view/4472057514','https://evil-linkedin.com/jobs/view/4472057514','https://jobs.ashbyhq.com/example','https://example.jobs.personio.de/login','https://job-boards.greenhouse.io/example/confirmation','javascript:alert(1)'])assert.equal(listingIdentity(url),null,url);
});

test('URL variants reuse a saved job despite changed metadata and are candidate scoped',()=>{
  const {store:s,p}=fixture();try{
    const j=addRankedJob(s,p.id,listing).job;
    const alternate={...listing,url:'https://de.linkedin.com/jobs/view/backend-4472057514',role:'Senior Backend Engineer',location:'Berlin, Germany (hybrid)'};
    const result=s.addJob(p.id,alternate);assert.equal(result.duplicate,true);assert.equal(result.job.id,j.id);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM job_urls WHERE candidate_id=?').get(p.id).n,2);
    const other=s.saveProfile({name:'Other',preferences:'Berlin'});assert.equal(s.addJob(other.id,alternate).duplicate,false);
    assert.equal(s.checkJobs(other.id,[{url:ats}])[0].duplicate,false);
    assert.throws(()=>s.linkJobUrl(other.id,j.id,{url:ats,evidence:'Observed Apply link'},'s'),/bulunamadı/);
  }finally{s.close();}
});

test('distinct requisitions with identical metadata remain separate and may be applied to',()=>{
  const {store:s,p}=fixture();try{
    const first=addRankedJob(s,p.id,{...listing,url:ats}).job;first.status='submitted';first.proof={kind:'success_page',url:ats,text:'Received'};s.saveJob(first,'test');
    const second=addRankedJob(s,p.id,{...listing,url:'https://example.jobs.personio.de/job/124'});
    assert.equal(second.duplicate,false);assert.equal(second.job.duplicateApplication,undefined);
    assert.doesNotThrow(()=>s.updateJob(p.id,second.job.id,'working','Opening form','session'));
    assert.equal(s.visibleJobs(p.id).length,2);
  }finally{s.close();}
});

test('an observed employer link consolidates records without losing questions or proof',()=>{
  const {store:s,p}=fixture();try{
    const old=s.addJob(p.id,{...listing,url:ats}).job;old.status='submitted';old.proof={kind:'success_page',url:ats,text:'Received'};s.saveJob(old,'test');
    const newer=addRankedJob(s,p.id,{...listing,company:'Example Recruiting',location:'Germany'}).job;
    const question=s.ask(p.id,{jobId:newer.id,question:'Saved access question'});
    const linked=s.linkJobUrl(p.id,newer.id,{url:ats,evidence:'Listing Apply link opened this vacancy'},'session');
    assert.equal(linked.job.id,old.id);assert.equal(s.jobs(p.id).length,2);assert.equal(s.visibleJobs(p.id).length,1);
    assert.equal(s.job(p.id,newer.id).duplicateApplication.match,'exact');
    assert.throws(()=>s.updateJob(p.id,newer.id,'working','Open','session'),/önceki kayıt/);
    const history=s.applicationHistory(p.id,{jobId:old.id});assert.equal(history.relatedApplications[0].id,newer.id);assert.equal(history.questions[0].id,question.id);
    assert.equal(s.job(p.id,old.id).proof.text,'Received');
    assert.equal(s.snapshot(p.id).jobs[0].relatedApplications.length,1);
    assert.equal(s.checkJobs(p.id,[{url:listing.url}])[0].job.id,old.id);
    s.deleteWorkspace(p.id);assert.equal(s.db.prepare('SELECT count(*) AS n FROM job_keys').get().n,0);
  }finally{s.close();}
});

test('late employer identity is checked before a send and stays saved after rejection',()=>{
  const {store:s,p}=fixture();try{
    const old=s.addJob(p.id,{...listing,url:ats,role:'Different source title'}).job;old.status='submitted';old.proof={kind:'success_page',text:'Received',url:ats};s.saveJob(old,'test');
    const newer=addRankedJob(s,p.id,listing).job;s.updateJob(p.id,newer.id,'working','Open','s');s.updateJob(p.id,newer.id,'prepared','Ready','s');
    assert.throws(()=>s.assertSubmissionAllowed(p.id,newer.id,ats,'s'),/önceki kayıt/);
    assert.equal(s.canonicalJobId(p.id,newer.id),old.id);
    assert.throws(()=>s.updateJob(p.id,newer.id,'submitting','Send','s'),/önceki kayıt/);
    assert.equal(s.job(p.id,newer.id).status,'prepared');
  }finally{s.close();}
});

test('a Jev final click rechecks the current URL before any mouse input',async()=>{
  let guards=0,clicked=false;
  const browser=new JevBrowser('/unused',{beforeSubmit:()=>{guards++;throw Error('duplicate vacancy');}});
  browser.fresh=async()=>true;browser.tabJobs.set('tab','job');
  const slot={id:'tab',owner:'s',page:{url:()=>ats,evaluate:()=>{clicked=true;}}};
  await assert.rejects(()=>browser.execute(slot,{action:{kind:'click',role:'button',label:'Submit',node:1},observed:{},operation:'CLICK'},'',{jobs:[{id:'job',status:'submitting'}]}),/duplicate vacancy/);
  assert.equal(guards,1);assert.equal(clicked,false);
});

test('linked employer identities distinguish a later requisition and retain saved ranking',()=>{
  const {store:s,p}=fixture();try{
    const board=s.addJob(p.id,listing).job;
    const employer=addRankedJob(s,p.id,{...listing,company:'Example Recruiting',url:ats}).job;
    s.linkJobUrl(p.id,board.id,{url:ats,evidence:'Observed application link'},'s');
    assert.equal(s.canonicalJobId(p.id,board.id),employer.id,'reuse the scored record');
    const current=s.job(p.id,employer.id);current.status='submitted';current.proof={kind:'success_page',text:'Received',url:ats};s.saveJob(current,'test');
    const another=addRankedJob(s,p.id,{...listing,url:'https://example.jobs.personio.de/job/124'}).job;
    assert.equal(s.job(p.id,another.id).duplicateApplication,undefined);
    assert.equal(s.jobs(p.id).find(j=>j.id===another.id).duplicateApplication,undefined);
  }finally{s.close();}
});

test('late identity discovery lets a duplicate worker finish without losing the first task',()=>{
  const {store:s,p}=fixture();try{
    const first=addRankedJob(s,p.id,listing).job,second=addRankedJob(s,p.id,{...listing,company:'ATS employer',url:ats}).job;
    const worker=s.workerState.add(p.id),view=s.forWorker(worker.id);
    s.saveCampaign(p.id,{status:'running',task:{id:'task-a',kind:'application',jobId:first.id}});
    view.saveCampaign(p.id,{status:'running',task:{id:'task-b',kind:'application',jobId:second.id}});
    s.updateJob(p.id,first.id,'working','Opening','a');view.updateJob(p.id,second.id,'working','Opening','b');
    view.linkJobUrl(p.id,second.id,{url:listing.url,evidence:'Observed same employer vacancy'},'b');
    const canonical=s.canonicalJobId(p.id,first.id),alias=canonical===first.id?second.id:first.id;
    const canonicalView=canonical===first.id?s:view,duplicateView=alias===first.id?s:view;
    assert.throws(()=>canonicalView.updateJob(p.id,canonical,'prepared','Ready',canonical===first.id?'a':'b'),/başka bir worker/);
    duplicateView.saveCampaign(p.id,{...duplicateView.campaign(p.id),task:{...duplicateView.campaign(p.id).task,report:{outcome:'done',note:'Existing vacancy'}}});
    assert.doesNotThrow(()=>canonicalView.updateJob(p.id,canonical,'prepared','Ready',canonical===first.id?'a':'b'));
    assert.throws(()=>duplicateView.updateJob(p.id,alias,'prepared','Ready',alias===first.id?'a':'b'),/önceki kayıt|başka bir worker/);
  }finally{s.close();}
});

test('workers reserve the canonical vacancy and uncertain aliases remain verifiable',()=>{
  const {store:s,p}=fixture();try{
    for(const source of s.sources(p.id))s.saveSource(p.id,{...source,enabled:false});
    const a=addRankedJob(s,p.id,listing).job,b=addRankedJob(s,p.id,{...listing,company:'ATS employer',url:ats}).job;
    s.linkJobUrl(p.id,b.id,{url:listing.url,evidence:'Observed original listing'},'s');
    const primary=s.canonicalJobId(p.id,a.id),alias=primary===a.id?b.id:a.id,w=s.workerState.add(p.id),second=s.forWorker(w.id);
    s.saveCampaign(p.id,{status:'running',task:{id:'first',kind:'application',jobId:primary}});
    assert.throws(()=>second.saveCampaign(p.id,{status:'running',task:{id:'second',kind:'application',jobId:alias}}),/başka bir worker/);
    const sent=s.job(p.id,primary);sent.status='submitted';sent.proof={kind:'success_page',text:'Received',url:ats};s.saveJob(sent,'test');
    const uncertain=s.job(p.id,alias);uncertain.status='uncertain';uncertain.sessionId='old';s.saveJob(uncertain,'test');
    s.saveCampaign(p.id,{status:'running',task:null,target:100,attempts:{}});
    const c=new Campaigns(s,{active:()=>null,changed:()=>{}});assert.equal(c.choose(p.id,s.campaign(p.id)).jobId,alias);
    assert.equal(s.job(p.id,alias).status,'uncertain');assert.equal(s.job(p.id,alias).duplicateApplication,undefined);
    assert.equal(uniqueJobCount(s.jobs(p.id),['submitted','uncertain']),1);
  }finally{s.close();}
});

test('legacy migration keeps original rows, IDs, questions and proofs and is repeatable',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'jobloop-registry-')),file=path.join(dir,'jobs.sqlite');let s;
  try{
    const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON; CREATE TABLE candidates(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE jobs(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL REFERENCES candidates(id),url TEXT NOT NULL,identity TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(candidate_id,url),UNIQUE(candidate_id,identity)); CREATE TABLE questions(id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL REFERENCES candidates(id),job_id TEXT REFERENCES jobs(id),question TEXT NOT NULL,answer TEXT,created_at TEXT NOT NULL);');
    db.prepare('INSERT INTO candidates VALUES(?,?)').run('p',JSON.stringify({id:'p',name:'Legacy',preferences:'Berlin'}));
    const rows=[{...listing,id:'first',candidateId:'p',status:'found',createdAt:'2026-01-01'}, {...listing,id:'second',candidateId:'p',url:'https://de.linkedin.com/jobs/view/engineer-4472057514',status:'submitted',proof:{kind:'success_page',text:'Received',url:ats},createdAt:'2026-01-02'}];
    for(const [i,j] of rows.entries())db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(j.id,'p',j.url,String(i),JSON.stringify(j));
    db.prepare('INSERT INTO questions VALUES(?,?,?,?,?,?)').run('q','p','first','Question','Answer','2026-01-01');db.close();
    s=new Store(file);assert.equal(s.jobs('p').length,2);assert.equal(s.visibleJobs('p').length,1);assert.equal(s.canonicalJobId('p','first'),'second');
    assert.equal(s.applicationHistory('p',{jobId:'second'}).questions[0].answer,'Answer');assert.deepEqual(s.db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(s.checkJobs('p',[{url:ats}])[0].job.id,'second');s.close();s=new Store(file);
    assert.equal(s.visibleJobs('p').length,1);assert.equal(s.job('p','second').proof.text,'Received');
    assert.equal(s.addJob('p',{...listing,url:'https://www.linkedin.com/jobs/view/4472057515'}).duplicate,false);
  }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});

test('batch MCP checks are bounded, compact, read-only and retain pending/completed decisions',async()=>{
  const {store:s,p}=fixture();const server=await startMcp(s),token=server.grant(p.id,'session');
  const call=async(name,args)=>{const r=await fetch(server.endpoint,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await r.json()).result;};
  try{
    const job=addRankedJob(s,p.id,listing).job,unranked=s.addJob(p.id,{...listing,url:ats}).job;
    const rows=[{url:'https://de.linkedin.com/jobs/view/engineer-4472057514'},{url:ats},{url:'https://new.example/job/1'}];
    const result=JSON.parse((await call('check_jobs',{jobs:rows})).content[0].text);
    assert.deepEqual(result.jobs.map(j=>j.needsResearch),[false,true,true]);assert.equal(result.jobs[0].job.fit,undefined);assert.equal(result.jobs[0].job.id,job.id);
    assert.equal(s.jobs(p.id).length,2);assert.equal(s.db.prepare('SELECT count(*) AS n FROM job_urls').get().n,2);
    assert.equal((await call('check_jobs',{jobs:Array(51).fill(rows[0])})).isError,true);
    unranked.status='submitted';s.saveJob(unranked,'test');
    assert.equal(JSON.parse((await call('check_jobs',{jobs:[{url:ats}]})).content[0].text).jobs[0].needsResearch,false);
    const link=JSON.parse((await call('link_job_url',{jobId:job.id,url:ats,evidence:'Apply opened this URL'})).content[0].text);assert.equal(link.job.id,unranked.id);
  }finally{await server.close();s.close();}
});
