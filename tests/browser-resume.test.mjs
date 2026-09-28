import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {browserResume} from '../app/browser-resume.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';
import {BrowserTools} from '../app/browser.mjs';

test('task context routes an existing Chrome draft to its original tool after switching to Jev',()=>{
 const store=new Store(':memory:');
 try{
  const p=store.saveProfile({name:'Irem',preferences:'Berlin',browserMode:'jev',chromeProfile:{name:'irem',directory:'Profile 1'}});
  const j=store.addJob(p.id,{company:'Example',role:'Manager',location:'Berlin',fit:'Test',url:'https://example.test/job'}).job;
  j.status='blocked';j.resumeContext={browser:'Chrome profile irem (Profile 1)',tabId:'1619436308',url:j.url+'/apply'};store.saveJob(j,'job_updated');
  store.saveCampaign(p.id,{status:'running',task:{id:'resume',kind:'application',jobId:j.id}});
  const context=store.taskContext(p.id);
  assert.equal(context.browserResume.mode,'existing');assert.equal(context.browserResume.tabId,j.resumeContext.tabId);
  assert.equal(context.profile.browserMode,'jev');assert.deepEqual(store.job(p.id,j.id).resumeContext,j.resumeContext);
  assert.equal(browserResume({...p,chromeProfile:{directory:'Profile 2'}},j).mode,'blocked');
  assert.equal(browserResume(p,{...j,status:'submitted'}),null);
  assert.equal(browserResume(p,{...j,resumeContext:{browser:'Jev Chrome',tabId:'A'.repeat(32)}}),null);
  assert.equal(browserResume(p,{...j,resumeContext:null}),null);
 }finally{store.close();}
});
test('Jev rejects Chrome numeric IDs with a backend mismatch instead of a missing-tab recovery loop',()=>{
 const browser=new JevBrowser('/unused');
 assert.throws(()=>browser.tab('1619436308'),{code:'TAB_BACKEND_MISMATCH'});
});
test('resuming a blocked listing opens its verified employer application URL',async()=>{
 const browser=new BrowserTools('/unused',()=> 'jev',()=>({lifecycle:{activeJobId:'job',jobs:[{id:'job',url:'https://aggregator.example/job',applicationUrl:'https://employer.example/jobs/31',status:'blocked'}]}}));
 browser.call=async(_candidate,name,args)=>{
  assert.equal(name,'browser_jev_open');
  assert.equal(args.url,'https://employer.example/jobs/31');
  return {content:[{type:'text',text:JSON.stringify({tabId:'new',url:args.url})}]};
 };
 const result=await browser.resumeApplication('candidate','job','session');
 assert.equal(JSON.parse(result.content[0].text).resume.reopened,true);
});
