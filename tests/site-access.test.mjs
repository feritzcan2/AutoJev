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
test('persistent host wait, one probe, increasing delays and verified recovery',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'site-wait-')),file=path.join(dir,'state.sqlite');let db=new DatabaseSync(file),now=10000000;
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 let gate=new SiteAccess(db,{now:()=>now});gate.block(url,'ip_block');
 assert.equal(gate.status(url).retryAt,now+30*minute);
 assert.throws(()=>gate.begin('https://kleinanzeigen.de/another'),{code:'SITE_WAIT'});
 assert.equal(gate.begin('https://www.ebay.de/list'),null);
 now+=minute;gate.block(url,'ip_block');assert.equal(gate.status(url).attempts,1);
 db.close();db=new DatabaseSync(file);gate=new SiteAccess(db,{now:()=>now});
 now=gate.status(url).retryAt;const token=gate.begin(url);
 const other=new SiteAccess(db,{now:()=>now});assert.throws(()=>other.begin(url),{code:'SITE_WAIT'});
 gate.complete(url,token,{status:403,reason:'ip_block'});assert.equal(gate.status(url).retryAt,now+60*minute);
 now=gate.status(url).retryAt;gate.complete(url,gate.begin(url),{status:429,reason:'rate_limit'});assert.equal(gate.status(url).retryAt,now+120*minute);
 now=gate.status(url).retryAt;const last=gate.begin(url);gate.complete(url,'stale',{status:200});assert.ok(gate.status(url));
 gate.complete(url,last,{status:200});assert.equal(gate.status(url),null);assert.equal(other.status(url),null);
});
test('Retry-After seconds and dates are honored; an uncertain probe stays blocked',()=>{
 const db=new DatabaseSync(':memory:');let now=10000000;const gate=new SiteAccess(db,{now:()=>now});
 try{
  gate.block(url,'rate_limit','180');assert.equal(gate.status(url).retryAt,now+180000);
  now+=180000;const token=gate.begin(url);gate.complete(url,token,{status:403});assert.ok(gate.status(url).waiting);
  assert.equal(gate.status(url).attempts,1);
  assert.equal(retryAfterTime(new Date(now+5*minute).toUTCString(),now),now+5*minute);
  assert.equal(retryAfterTime('invalid',now),null);
 }finally{db.close();}
});
