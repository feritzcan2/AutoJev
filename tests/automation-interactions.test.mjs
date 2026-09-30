import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';

for(const kind of ['interview','trial','run'])for(const mode of ['observe','prepare','auto'])test(`${kind}/${mode}: interactions and Jev decisions need no result or reservation`,async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const db=new AutomationStore(store);
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:['https://example.com/list']});db.save(a.id,{mode,browserMode:'jev',maxBrowserSteps:12});db.review(a.id);
 if(kind==='run'){const trial=db.begin(a.id,'trial');db.observe(a.id,trial.id,a.sources[0],'Listings');db.finish(a.id,trial.id,'completed','Read source');}
 const run=db.begin(a.id,kind),calls=[],controller=new AbortController();let current='https://other.example/search';
 const browser={currentUrl:async()=>current,async call(id,name,args,session,options){calls.push({name,args,options});if(name==='browser_navigate')current=args.url;return {content:[{type:'text',text:`Page URL: ${current}\n- button "Any label" [ref=e1]`}],action:{executed:true}};}};
 const flow=automationWorkflow({db,run,signal:controller.signal,browser,report:()=>{}}),call=(name,args)=>flow.call(a.id,run.id,name,args);
 assert.ok(!flow.tools.some(t=>t.name==='browser_browse'));
 await call('browser_open',{url:current});
 for(const input of [{operation:'click',ref:'e1'},{operation:'type',ref:'e1',text:'Any text'},{operation:'select',ref:'e1',text:'Any option'},{operation:'press',ref:'e1',key:'Shift+Tab'},{operation:'autocomplete',ref:'c1',text:'Berlin'},{operation:'autocomplete',ref:'c1',option:'Berlin'}])await call('browser_interact',input);
 await call('browser_jev_act',{decisionId:'current-decision'});
 await call('browser_jev_inspect_form',{});await call('browser_jev_reveal',{controlId:'offscreen-date'});
 assert.ok(flow.tools.some(t=>t.name==='browser_jev_inspect_form'));assert.ok(calls.some(c=>c.name==='browser_jev_reveal'&&c.args.controlId==='offscreen-date'));
 for(const name of ['browser_click','browser_type','browser_select_option','browser_target_press','browser_jev_list_suggestions','browser_jev_autocomplete','browser_jev_act'])assert.ok(calls.some(c=>c.name===name),name);
 assert.ok(calls.every(c=>!c.options?.browsing));assert.equal(db.run(run.id).browserSteps,10);assert.equal(db.run(run.id).actionId,null);assert.equal(db.results(a.id).length,0);
 await assert.rejects(flow.call('foreign',run.id,'browser_interact',{operation:'click',ref:'e1'}),/geçersiz/);
 await assert.rejects(flow.call(a.id,'old-session','browser_jev_act',{decisionId:'current-decision'}),/geçersiz/);
 controller.abort();await assert.rejects(call('browser_interact',{operation:'click',ref:'e1'}),/geçersiz/);
});
