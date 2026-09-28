import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {addRankedJob} from './rank-fixture.mjs';
import {vacancyMatch} from '../app/job-identity.mjs';
const listing={company:'Delivery Hero',role:'Legal Counsel, Privacy',location:'Berlin, Germany',fit:'Privacy experience',url:'https://careers.example/job/11063'};
test('company/title/location similarity requires an observed vacancy link before merging',()=>{
 const s=new Store(':memory:');try{
  const p=s.saveProfile({name:'Test',preferences:'Berlin'}),j=s.addJob(p.id,listing).job;
  const found=s.addJob(p.id,{...listing,company:'Delivery Hero SE',role:'Legal Counsel, Privacy (m/f/d)',location:'Berlin (hybrid)',url:'https://stepstone.example/14481463'});
  assert.equal(found.duplicate,false);assert.notEqual(found.job.id,j.id);assert.equal(s.jobs(p.id).length,2);
  assert.equal(s.addJob(p.id,{...listing,location:'Hamburg',url:'https://careers.example/job/other'}).duplicate,false);
  assert.equal(vacancyMatch(listing,{...listing,company:'Hero'}),null);
  assert.equal(vacancyMatch(listing,{...listing,role:'Senior Legal Counsel, Privacy'}),null);
 }finally{s.close();}
});
test('cross-source submitted vacancy recognizes m/w/d gender suffix',()=>{
 const s=new Store(':memory:');try{
  const p=s.saveProfile({name:'Test',preferences:'Berlin'});
  const old=s.addJob(p.id,{company:'Axel Springer Tech GmbH',role:'(Senior) Manager Privacy & Data Governance',location:'Berlin (80% office)',fit:'Privacy',url:'https://www.stepstone.de/stellenangebote--Senior-Manager--14425447-inline.html'}).job;
  old.status='submitted';old.proof={kind:'success_page',text:'Application sent',url:old.url};s.saveJob(old,'test');
  const newer=s.addJob(p.id,{company:'Axel Springer Tech GmbH',role:'(Senior) Manager Privacy & Data Governance (m/w/d)',location:'Berlin, Germany',fit:'Privacy',url:'https://de.whatjobs.com/jobs/privacy/berlin?id=491014868'}).job;
  assert.equal(s.job(p.id,newer.id).duplicateApplication.jobId,old.id);
 }finally{s.close();}
});
test('an imported application with unknown location holds the cross-source match without faking a submission',async()=>{
 const s=new Store(':memory:');try{
  const p=s.saveProfile({name:'Test',preferences:'Berlin',authorization:'submit'});
  for(const source of s.sources(p.id))s.saveSource(p.id,{...source,enabled:false});
  const old=s.addJob(p.id,{...listing,location:'Geçmiş başvuru kaydı — konum Excel dosyasında belirtilmemiş'}).job;
  old.status='submitted';old.proof={kind:'success_page',text:'Submitted',url:old.url};s.saveJob(old,'test');
  const newer=addRankedJob(s,p.id,{...listing,company:'Delivery Hero SE',url:'https://stepstone.example/14481463'}).job;
  assert.equal(s.job(p.id,newer.id).status,'found');assert.equal(s.job(p.id,newer.id).proof,null);
  const duplicate=s.job(p.id,newer.id).duplicateApplication;assert.equal(duplicate.jobId,old.id);assert.equal(duplicate.match,'possible');
  assert.throws(()=>s.updateJob(p.id,newer.id,'working','Start','s'),/önceki başvuru/);
  let launches=0;const c=new Campaigns(s,{active:()=>null,changed:()=>{},launch:async()=>launches++});
  await c.start(p.id);assert.equal(launches,0);assert.equal(s.snapshot(p.id).jobs.find(j=>j.id===newer.id).queueState.state,'duplicate');
  s.saveCampaign(p.id,{status:'running',task:{id:'old-task',kind:'application',jobId:newer.id}});
  assert.equal(s.taskContext(p.id).job.duplicateApplication.jobId,old.id);
  const other=s.saveProfile({name:'Other candidate',preferences:'Berlin'});
  assert.equal(s.addJob(other.id,{...listing,company:'Delivery Hero SE'}).job.duplicateApplication,undefined);
 }finally{s.close();}
});
test('the submit transition rechecks history even when the draft was already prepared',()=>{
 const s=new Store(':memory:');try{
  const p=s.saveProfile({name:'Test',preferences:'Berlin',authorization:'submit'});
  const current=addRankedJob(s,p.id,listing).job;
  s.updateJob(p.id,current.id,'working','Open','s');s.updateJob(p.id,current.id,'prepared','Ready','s');
  const old=s.addJob(p.id,{...listing,location:'Unknown',url:'https://old.example/application'}).job;
  old.status='submitted';old.proof={kind:'success_page',text:'Imported confirmation'};s.saveJob(old,'test');
  assert.throws(()=>s.updateJob(p.id,current.id,'submitting','Send','s'),/önceki başvuru/);
  assert.equal(s.job(p.id,current.id).status,'prepared');
  // An uncertain send remains verifiable; duplicate detection cannot reset it.
  current.status='uncertain';s.saveJob(current,'test');assert.equal(s.job(p.id,current.id).duplicateApplication,undefined);
 }finally{s.close();}
});
