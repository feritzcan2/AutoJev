import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SiteAccess,accessBarrier,retryAfterTime} from '../app/site-access.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';
const url='https://www.kleinanzeigen.de/list',minute=60000;

test('a user response retires only its incident; observing a real challenge blocks again',()=>{
 const db=new DatabaseSync(':memory:');let now=100000;const gate=new SiteAccess(db,{now:()=>now});
 try{
  const first=gate.block(url,'verification');gate.acknowledge([first]);assert.equal(gate.status(url),null);
  now++;const next=gate.complete(url,null,{status:403,reason:'verification'});assert.ok(next.waiting);
  assert.throws(()=>gate.acknowledge([first]),/yeni bir erişim/);assert.equal(gate.status(url).blockedAt,next.blockedAt);
  now=next.retryAt;gate.begin(url);assert.throws(()=>gate.acknowledge([next]),/yeni bir erişim/);
 }finally{db.close();}
});

test('only explicit access barriers cause a shared wait',()=>{
 assert.equal(accessBarrier({status:403,text:'Forbidden'}),null);
 assert.equal(accessBarrier({status:200,text:'An article about Your IP address has been temporarily blocked.'}),null);
 assert.equal(accessBarrier({status:403,text:'Your IP address has been temporarily blocked.\nTry later'}),'ip_block');
 assert.equal(accessBarrier({status:429}),'rate_limit');
});
const challenge={title:'Just a moment...',text:'Link: Indeed Home — https://www.indeed.com/\nFind jobs\nAdditional Verification Required\nYour Ray ID for this request is synthetic-ray\nTroubleshooting Cloudflare Errors\nContact us'};
test('Cloudflare challenge detection requires the verification title and body together',()=>{
 for(const status of [200,403])assert.equal(accessBarrier({status,...challenge}),'verification');
 assert.equal(accessBarrier({...challenge,title:'Cloudflare Security Engineer'}),null);
 assert.equal(accessBarrier({...challenge,text:'A listing mentions Additional Verification Required and Cloudflare.'}),null);
 assert.equal(accessBarrier({title:'Just a moment...',text:'Loading the job description'}),null);
 assert.equal(accessBarrier({title:'Just a moment...',text:'Additional Verification Required'}),null);
 assert.equal(accessBarrier({title:'Just a moment...',text:'himalayas.app\nPerforming security verification\nThis website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.\nRay ID:\na44a19d13d8ee525\nPerformance and Security by\nLink: Cloudflare, opens in a new tab — https://www.cloudflare.com/\nCloudflare'}),'verification','the newer interstitial wording');
 assert.equal(accessBarrier({title:'Just a moment...',text:'Link: Cloudflare, opens in a new tab — https://www.cloudflare.com/privacypolicy/\nPrivacy'}),null,'footer links alone are not a verification body');
});
test('browser observation detects a challenge before creating listing evidence and shares its wait',async()=>{
 const db=new DatabaseSync(':memory:'),gate=new SiteAccess(db),browser=new JevBrowser('/unused',{siteAccess:gate});let reads=0;
 const slot={id:'owned',http:{url,status:200},page:{evaluate:async()=>++reads===1?{loading:false}:{url,...challenge}}};
 try{
  await assert.rejects(browser.observeOnce(slot),error=>error.code==='SITE_WAIT'&&error.wait.reason==='verification'&&error.url===url);
  assert.equal(slot.observed,undefined);assert.equal(reads,2);
  assert.match(gate.status(url).message,/Erişim doğrulaması/);
  assert.throws(()=>gate.begin(url+'/another'),{code:'SITE_WAIT'});
  assert.equal(gate.begin('https://other.example/list'),null);
 }finally{db.close();}
});
test('persistent host wait retries at five and ten minutes, then requires intervention',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'site-wait-')),file=path.join(dir,'state.sqlite');let db=new DatabaseSync(file),now=10000000;
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 let gate=new SiteAccess(db,{now:()=>now});gate.block(url,'ip_block');
 assert.equal(gate.status(url).retryAt,now+5*minute);
 assert.throws(()=>gate.begin('https://kleinanzeigen.de/another'),{code:'SITE_WAIT'});
 assert.equal(gate.begin('https://www.ebay.de/list'),null);
 now+=minute;gate.block(url,'ip_block');assert.equal(gate.status(url).attempts,1);
 db.close();db=new DatabaseSync(file);gate=new SiteAccess(db,{now:()=>now});
 now=gate.status(url).retryAt;const token=gate.begin(url);
 const other=new SiteAccess(db,{now:()=>now});assert.throws(()=>other.begin(url),{code:'SITE_WAIT'});
 gate.complete(url,token,{status:403,reason:'ip_block'});assert.equal(gate.status(url).retryAt,now+10*minute);
 now=gate.status(url).retryAt;gate.complete(url,gate.begin(url),{status:429,reason:'rate_limit'});assert.equal(gate.status(url).retryAt,null);
 const stopped=gate.status(url);assert.equal(stopped.exhausted,true);assert.equal(stopped.attempts,3);
 now+=24*60*minute;assert.throws(()=>gate.begin(url),{code:'SITE_WAIT'});gate.complete(url,'stale',{status:200});assert.equal(gate.status(url).exhausted,true);
 db.close();db=new DatabaseSync(file);gate=new SiteAccess(db,{now:()=>now});assert.equal(gate.status(url).exhausted,true);
 gate.acknowledge([stopped]);assert.equal(gate.status(url),null);assert.equal(gate.block(url,'rate_limit').attempts,1);
});
test('the explicit retry policy is five then ten minutes, including uncertain probes',()=>{
 const db=new DatabaseSync(':memory:');let now=10000000;const gate=new SiteAccess(db,{now:()=>now});
 try{
  gate.block(url,'rate_limit','180');assert.equal(gate.status(url).retryAt,now+5*minute);
  now+=5*minute;const token=gate.begin(url);gate.complete(url,token,{status:403});assert.ok(gate.status(url).waiting);
  assert.equal(gate.status(url).attempts,2);assert.equal(gate.status(url).retryAt,now+10*minute);
  now+=10*minute;gate.complete(url,gate.begin(url),{});assert.equal(gate.status(url).exhausted,true);
  assert.equal(retryAfterTime(new Date(now+5*minute).toUTCString(),now),now+5*minute);
  assert.equal(retryAfterTime('invalid',now),null);
 }finally{db.close();}
});


test('a healthy probe preserves the scan retry budget until completion and stale completions cannot clear new incidents',()=>{
 const db=new DatabaseSync(':memory:');let now=1000000;const gate=new SiteAccess(db,{now:()=>now});
 try{
  const first=gate.block(url,'rate_limit');now=first.retryAt;gate.complete(url,gate.begin(url),{status:200});assert.equal(gate.status(url),null);
  const second=gate.block(url+'?page=2','verification');assert.equal(second.attempts,2);assert.equal(second.retryAt,now+10*minute);
  gate.finish([first]);assert.equal(gate.status(url).attempts,2);
  now=second.retryAt;gate.complete(url,gate.begin(url),{status:200});gate.finish([first]);assert.equal(gate.row(url).attempts,2);
  gate.finish([second]);assert.equal(gate.row(url),null);assert.equal(gate.block(url,'ip_block').attempts,1);
 }finally{db.close();}
});

test('a site that rate-limited recently is paced between navigations; other sites never wait',()=>{
 const db=new DatabaseSync(':memory:');let now=1_000_000;const gate=new SiteAccess(db,{now:()=>now});
 try{
  assert.equal(gate.pace('https://calm.test/a'),0);assert.equal(gate.pace('https://calm.test/b'),0);
  gate.block(url,'rate_limit');now+=6*minute;
  assert.equal(gate.pace(url),0,'the first navigation after the wait leaves immediately');
  assert.equal(gate.pace(url),4000,'the next one keeps a four second gap');
  assert.equal(gate.pace('https://kleinanzeigen.de/other'),8000,'the same site queues the following slot');
  now+=20000;assert.equal(gate.pace(url),0,'elapsed time frees the slot');
  gate.acknowledge([gate.status(url)]);assert.equal(gate.status(url),null);assert.equal(gate.pace(url),4000,'a user answer clears the wait, not the pacing');
  now+=7*60*minute;assert.equal(gate.pace(url),0,'pacing expires hours after the last incident');
  const fresh=new SiteAccess(db,{now:()=>now});gate.block(url,'verification');assert.ok(fresh.pace(url)>=0,'a new process derives pacing from the saved incident');
 }finally{db.close();}
});
