import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
const source='https://homes.example/list';

test('details that stay unreadable after bounded recovery leave the queue with a reason; slow pages wait first',async t=>{
 let now=Date.now();const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store,{now:()=>now});
 const runtime=new WebTasks(db,{now:()=>now,launch:async()=>({close:async()=>{}})});
 t.after(async()=>{await runtime.close();store.close();});
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[source]});db.review(a.id);
 const trial=db.begin(a.id,'trial');db.observe(a.id,trial.id,source,'Listings');db.finish(a.id,trial.id,'completed','Ready');const id=a.id;
 const task=store.workspaces.tasks.enqueue(id,{operation:'scan',capability:'browser.observe',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 const run=await runtime.start(id,{kind:'run',taskId:task.id});
 const apply='https://apply.example/flow?job=1',slow='https://homes.example/detail/slow',good='https://homes.example/detail/good',reads=[];
 db.observe(id,run.id,source,'Observed queue',[apply,slow,good]);
 db.saveScanProgress(id,run.id,{pendingUrls:[apply,slow,good],reason:'Read details'},{url:source,text:'Observed queue'});
 const flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:{
  evaluateJev:async()=>({answers:{fit:{choice:'possible',confidence:1,probabilities:{possible:1,mismatch:0,uncertain:0,incomplete:0,results:0}}}}),
  async call(_id,name,args){
   const url=args.url??reads.at(-1);reads.push(url);
   // The apply flow renders nothing readable; the slow page never finishes loading.
   const page=url===apply?{url,title:'',text:''}:url===slow?{url,title:'Loading',text:'',reading:{readiness:{loading:true,reason:'stream_pending'}}}:{url,title:'A home',text:'Complete detail'};
   return {jevPage:page,pageContext:{url,tabId:'owned'},content:[{type:'text',text:'Page URL: '+url+'\n'+JSON.stringify(page)}]};
  }
 },report:(...args)=>runtime.report(...args)});
 const first=await flow.call(id,run.id,'browser_jev_run',{operation:'collect_details'});
 assert.deepEqual(first.retired,{count:1,urls:[apply]});assert.match(first.next,/retired 1 unreadable/);
 assert.deepEqual(db.run(run.id).scan.pendingUrls,[slow,good],'the slow page keeps its wait, the good detail awaits review');
 assert.match(db.run(run.id).scan.reason,/okunamadı; kuyruktan çıkarıldı/);
 assert.ok(reads.filter(u=>u===apply).length<=3,'reads stay bounded');
 assert.equal(db.jevTasks.detailDeferrals(id,task.id,slow),1);
});
