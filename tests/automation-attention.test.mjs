import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationAttention} from '../app/automation-attention.mjs';
import {attentionTabs} from '../src/automation-attention.js';

const source={url:'https://homes.example/list',name:'Homes',enabled:true,blocked:true,lastResult:'CAPTCHA kaldı. Açık sekmede doğrulamayı tamamla.'};
const snapshot=()=>({automation:{revision:1,reviewedRevision:1,trial:{status:'passed'}},sources:[source],runs:[],activeRuns:[]});

test('a blocked source stays visible beside working sources, and disappears only after retry or disable',()=>{
 const s=snapshot();s.sources.push({...source,url:'https://other.example',blocked:false,scanning:true});s.activeRuns=[{id:'other-run'}];
 const [issue]=automationAttention(s);assert.equal(issue.retry,'source');assert.equal(issue.sourceUrl,source.url);
 assert.equal(automationAttention(s).length,1);
 for(const patch of [{enabled:false},{blocked:false},{scanning:true}])assert.equal(automationAttention({...s,sources:[{...source,...patch}]}).length,0);
 s.sources[0]={...source,blocker:{recordId:'record'}};
 assert.equal(automationAttention(s)[0].retry,null,'Do not offer to resend an uncertain record action');
});

test('tab focus prefers the saved current URL and never guesses among multiple source tabs',()=>{
 const s=snapshot(),issue={...automationAttention(s)[0],tabId:'retained',url:'https://homes.example/detail/2'};
 const retained={tabId:'retained',url:issue.url,sourceUrl:source.url},other={tabId:'other',url:'https://homes.example/detail/3',sourceUrl:source.url};
 assert.deepEqual(attentionTabs(issue,[other,retained],s.sources),[retained]);
 assert.deepEqual(attentionTabs(issue,[{...retained,url:'https://foreign.example'}],s.sources),[{...retained,url:'https://foreign.example'}],'Saved source can redirect to an auth page');
 assert.deepEqual(attentionTabs({...issue,tabId:null,url:null},[other,retained],s.sources),[other,retained]);
 assert.deepEqual(attentionTabs(issue,[{tabId:'foreign',url:'https://foreign.example'}],s.sources),[]);
});

test('browser checkpoint survives a blocked report and recent run history pruning',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const db=new AutomationStore(store);
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[source.url]});
 db.review(a.id);let run=db.begin(a.id,'trial');db.observe(a.id,run.id,source.url,'Actual listings');db.finish(a.id,run.id,'completed','Ready');db.enable(a.id);
 const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',capability:'browser.observe',sources:[source.url],sourceUrl:source.url,lockKey:'source:'+source.url});
 run=db.begin(a.id,{kind:'run',taskId:task.id});
 const url='https://homes.example/detail/2',flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:{async call(){return {pageContext:{tabId:'captcha-tab',url},content:[{type:'text',text:`Page URL: ${url}\nHuman verification required`}]};}},report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
 await flow.call(a.id,run.id,'browser_read',{});
 await flow.call(a.id,run.id,'finish_automation_run',{status:'blocked',summary:source.lastResult});
 const s=db.snapshot(a.id),[issue]=automationAttention({...s,runs:[]});
 assert.equal(issue.tabId,'captcha-tab');assert.equal(issue.url,url);assert.equal(issue.workerId,'main');assert.equal(issue.retry,'source');
 assert.equal(db.get(a.id).status,'enabled','Other sources keep running');
});
