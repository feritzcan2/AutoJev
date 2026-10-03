import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserConnections} from '../app/browser-connection.mjs';
import {BrowserTools} from '../app/browser.mjs';
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
 const browser=new BrowserTools('/unused',()=>({lifecycle:{activeJobId:'job',jobs:[job]}}));let requested;
 browser.call=async(...args)=>{requested=args;return{content:[{type:'text',text:JSON.stringify({tabId:'live',reused:true,fillFields:[{label:'Name',value:''}]})}]};};
 const result=JSON.parse((await browser.resumeApplication('c','job','s')).content[0].text);
 assert.equal(requested[2].url,job.url);assert.equal(result.resume.reopened,false);assert.equal(result.fillFields[0].value,'');assert.equal(result.resume.previousProgress.fields[0].value,'Known');
 await assert.rejects(()=>browser.resumeApplication('c','other','s'),/etkin/);
 await assert.rejects(()=>browser.resumeApplication('c','job','other'),/oturuma/);
 job.resumeContext={browser:'Chrome profile old',tabId:'123'};await assert.rejects(()=>browser.resumeApplication('c','job','s'),/orijinal/);
 job.status='submitted';assert.equal(JSON.parse((await browser.resumeApplication('c','job','s')).content[0].text).status,'complete');
});

test('a late handshake cannot mark a newly selected Chrome profile ready',async()=>{
 let resolve;const c=new BrowserConnections({connect:()=>new Promise(r=>resolve=r)});
 c.prepare('candidate');await flush();c.reset('candidate');resolve();await flush();assert.equal(c.status('candidate').state,'idle');
 c.prepare('candidate');await flush();resolve();await flush();assert.equal(c.status('candidate').ready,true);
});

test('preparing initializes the selected profile before publishing a ready connection',async()=>{
 let profile='Default',connects=0;
 const browser=new BrowserTools('/unused',()=>({profile:{directory:profile}}));
 browser.connect=async()=>({client:{context:async()=>{connects++;}}});
 for(const selected of ['Default','Profile 2']){
  profile=selected;browser.prepare('candidate');await browser.connections.pending.get('candidate');
  assert.equal(browser.status('candidate').ready,true);
  browser.prepare('candidate');await flush();
 }
 assert.equal(connects,2);
});
