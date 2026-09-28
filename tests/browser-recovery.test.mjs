import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserConnections} from '../app/browser-connection.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {Store} from '../app/store.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('one connection handshake, backoff, disconnect and retry without agent calls',async()=>{
 let count=0,now=100,resolve,reject;
 const c=new BrowserConnections({now:()=>now,connect:()=>{count++;return new Promise((ok,fail)=>{resolve=ok;reject=fail;});}});
 assert.equal(c.prepare('a').state,'connecting');c.prepare('a');await flush();assert.equal(count,1);
 reject(Error('Chrome closed'));await flush();assert.equal(c.status('a').state,'waiting');c.prepare('a');await flush();assert.equal(count,1);
 now+=2000;c.prepare('a');await flush();resolve();await flush();assert.equal(c.status('a').ready,true);
 c.disconnected('a');assert.equal(c.status('a').ready,false);now+=2000;c.prepare('a');await flush();resolve();await flush();assert.equal(count,3);
 c.close();c.disconnected('a');assert.equal(c.status('a').ready,true);
});
test('resume uses the database URL and returns historical progress separately',async()=>{
 const job={id:'job',url:'https://jobs.example/correct-id',status:'working',sessionId:'s',browserProgress:{fields:[{label:'Name',value:'Known'}]}};
 const browser=new BrowserTools('/unused',()=> 'jev',()=>({lifecycle:{activeJobId:'job',jobs:[job]}}));let requested;
 browser.call=async(...args)=>{requested=args;return{content:[{type:'text',text:JSON.stringify({tabId:'live',reused:true,fillFields:[{label:'Name',value:''}]})}]};};
 const result=JSON.parse((await browser.resumeApplication('c','job','s')).content[0].text);
 assert.equal(requested[2].url,job.url);assert.equal(result.resume.reopened,false);assert.equal(result.fillFields[0].value,'');assert.equal(result.resume.previousProgress.fields[0].value,'Known');
 await assert.rejects(()=>browser.resumeApplication('c','other','s'),/etkin/);
 await assert.rejects(()=>browser.resumeApplication('c','job','other'),/oturuma/);
 job.resumeContext={browser:'Chrome profile old',tabId:'123'};await assert.rejects(()=>browser.resumeApplication('c','job','s'),/orijinal/);
 job.status='submitted';assert.equal(JSON.parse((await browser.resumeApplication('c','job','s')).content[0].text).status,'complete');
});
test('progress persists observed values and files without stale control IDs or changing submission state',()=>{
 const store=new Store(':memory:');try{
 const p=store.saveProfile({name:'Test',preferences:'Remote',authorization:'prepare'});
 const job=store.addJob(p.id,{url:'https://example.test/job',company:'Example',role:'Engineer',location:'Remote',fit:'Test'}).job;
 store.saveBrowserProgress(p.id,job.id,{tabId:'first',url:job.url,fields:[{fieldId:'stale',label:'Email',type:'email',value:'test@example.test'}],files:[{label:'CV',files:['CV.pdf']}]},'s');
 let current=store.job(p.id,job.id);assert.equal(current.status,'found');assert.equal(current.resumeContext.tabId,'first');assert.equal(current.browserProgress.fields[0].fieldId,undefined);assert.deepEqual(current.browserProgress.files[0].files,['CV.pdf']);
 store.saveBrowserProgress(p.id,job.id,{tabId:'new',url:job.url,fields:[{label:'Email',type:'email',value:''}],files:[]},'s');
 current=store.job(p.id,job.id);assert.equal(current.browserProgress.fields[0].value,'');assert.deepEqual(current.browserProgress.files,[]);
 current.status='uncertain';current.sessionId='s';store.saveJob(current,'test');
 assert.throws(()=>store.saveBrowserProgress(p.id,job.id,{tabId:'new',url:job.url},'other'),/oturuma/);
 store.saveBrowserProgress(p.id,job.id,{tabId:'new',url:job.url},'s');assert.equal(store.job(p.id,job.id).status,'uncertain');
 }finally{store.close();}
});

test('a late handshake cannot mark a newly selected Chrome profile ready',async()=>{
 let resolve;const c=new BrowserConnections({connect:()=>new Promise(r=>resolve=r)});
 c.prepare('candidate');await flush();c.reset('candidate');resolve();await flush();assert.equal(c.status('candidate').state,'idle');
 c.prepare('candidate');await flush();resolve();await flush();assert.equal(c.status('candidate').ready,true);
});
