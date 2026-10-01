import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationAttention} from '../app/automation-attention.mjs';
import {attentionTabs} from '../src/automation-attention.js';

const source={url:'https://homes.example/list',name:'Homes',enabled:true,blocked:true,lastResult:'CAPTCHA kaldı. Açık sekmede doğrulamayı tamamla.'};
const snapshot=()=>({automation:{revision:1,reviewedRevision:1,trial:{status:'passed',revision:1}},sources:[source],runs:[],activeRuns:[]});

test('conversation forms stay distinct from source and record questions during concurrent work',()=>{
 const s=snapshot();s.sources=[];s.runs=[{id:'chat',kind:'interview',startedAt:100},{id:'scan',kind:'run',startedAt:100,sourceUrl:'https://source.example'}];
 s.automation.questions=[
  {id:'chat-form',runId:'chat',text:'Puanlama tercihleri',createdAt:200,answer:null},
  {id:'old-chat-form',conversation:true,text:'Tercihler',answer:null},
  {id:'source-question',runId:'scan',sourceUrl:'https://source.example',text:'Kaynak sorusu',createdAt:200,answer:null},
  {id:'record-question',conversation:true,recordId:'record',text:'Kayıt sorusu',answer:null},
 ];
 assert.deepEqual(automationAttention(s).map(i=>[i.id,i.conversation]),[['chat-form',true],['old-chat-form',true],['source-question',false],['record-question',false]]);
});

test('question cards keep the exact tab across login redirects and history pruning',()=>{
 const s=snapshot();s.sources=[];s.automation.questions=[{id:'question',text:'Log in',answer:null,recordId:'record',browserContext:{tabId:'login',url:'https://homes.example/login'}}];
 const [issue]=automationAttention(s);
 const tabs=[{tabId:'another',url:'https://homes.example/login'},{tabId:'login',url:'https://homes.example/application'}];
 assert.deepEqual(attentionTabs(issue,tabs,[]),[tabs[1]]);
 assert.equal(issue.kind,'question');assert.equal(issue.tabId,'login');
});

test('questions save their observed tab and old questions recover it from durable runs',t=>{
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());let now=1000;const db=new AutomationStore(store,{now:()=>now});
 const a=db.create('custom',{goal:'Find records'}),run=db.begin(a.id,'interview');
 db.observe(a.id,run.id,'https://homes.example/login','Sign in',[],{tabId:'login'});
 const q=db.askQuestion(a.id,{text:'Did you sign in?'},{runId:run.id});
 assert.equal(q.browserContext.tabId,'login');now=2000;db.finish(a.id,run.id,'completed','Waiting');
 db.put({...db.get(a.id),questions:[{...q,browserContext:undefined}]});
 const old=db.questionContext(a.id,db.get(a.id).questions[0]);assert.equal(old.browserContext.tabId,'login');
 const [issue]=automationAttention({...db.snapshot(a.id),runs:[]});assert.equal(issue.tabId,'login');
});

test('skipping a failed trial clears its prompt while source blockers remain actionable',()=>{
 const s=snapshot();s.automation.trial.status='skipped';
 assert.equal(automationAttention(s)[0].retry,'source');
 s.sources=[];s.runs=[{id:'trial',kind:'trial',status:'blocked',revision:1,summary:'Access unavailable'}];
 assert.deepEqual(automationAttention(s),[]);
 s.automation.trial.revision=0;assert.equal(automationAttention(s)[0].retry,'trial');
});

test('blocked trials retain the worker that should receive the reply',()=>{
 const s=snapshot();s.sources=[];s.runs=[{id:'trial',kind:'trial',status:'blocked',revision:1,summary:'Doğrulama gerekiyor',workerId:'second'}];
 const [issue]=automationAttention(s);assert.equal(issue.retry,'trial');assert.equal(issue.workerId,'second');
});

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
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store);
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[source.url]});
 db.review(a.id);let run=db.begin(a.id,'trial');db.observe(a.id,run.id,source.url,'Actual listings');db.finish(a.id,run.id,'completed','Ready');db.enable(a.id);
 const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',capability:'browser.observe',sources:[source.url],sourceUrl:source.url,lockKey:'source:'+source.url});
 run=db.begin(a.id,{kind:'run',taskId:task.id});
 const url='https://homes.example/detail/2',flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:{async call(){return {pageContext:{tabId:'captcha-tab',url},content:[{type:'text',text:`Page URL: ${url}\nHuman verification required`}]};}},report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
 await flow.call(a.id,run.id,'browser_read',{});
 await flow.call(a.id,run.id,'finish_automation_run',{status:'blocked',summary:source.lastResult,stop:{kind:'access',evidence:'Human verification required'}});
 const s=db.snapshot(a.id),[issue]=automationAttention({...s,runs:[]});
 assert.equal(issue.tabId,'captcha-tab');assert.equal(issue.url,url);assert.equal(issue.workerId,'main');assert.equal(issue.retry,'source');
 assert.equal(db.get(a.id).status,'enabled','Other sources keep running');
});
