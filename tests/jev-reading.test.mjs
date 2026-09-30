import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {validateJevArgs} from '../app/jev-browser.mjs';
import {validate} from '../app/mcp.mjs';

test('Jev full document reading is explicit; automation scopes scroll to its current tab',async()=>{
 const calls=[],browser={prepare:()=>({ready:true}),async call(id,name,args){calls.push({id,name,args});return {content:[{type:'text',text:JSON.stringify({tabId:'owned-tab',url:'https://example.com/list',tabs:[]})}]};}};
 const adapter=automationBrowser(browser,{mode:'jev'});
 await adapter.call('workspace','browser_navigate',{url:'https://example.com/list'},'run');
 await adapter.call('workspace','browser_snapshot',{},'run');assert.deepEqual(calls.at(-1).args,{tabId:'owned-tab',scope:'document',full:true,fullReason:'context_loss'});
 await adapter.call('workspace','browser_jev_scroll',{controlId:'observed-scroll',direction:'down',tabId:'foreign-tab'},'run');assert.deepEqual(calls.at(-1).args,{tabId:'owned-tab',controlId:'observed-scroll',direction:'down'});
 await adapter.call('workspace','browser_jev_reveal',{controlId:'date',tabId:'foreign'},'run');assert.deepEqual(calls.at(-1).args,{tabId:'owned-tab',controlId:'date'});
 await adapter.call('workspace','browser_jev_inspect_form',{tabId:'foreign'},'run');assert.deepEqual(calls.at(-1).args,{tabId:'owned-tab'});
 validateJevArgs('browser_jev_observe',{tabId:'owned-tab',scope:'document'});validateJevArgs('browser_jev_observe',{tabId:'owned-tab'});
 assert.throws(()=>validateJevArgs('browser_jev_observe',{tabId:'owned-tab',scope:'hidden_state'}));
});

function fixture(t,kind='trial',mode='jev'){
 const store=new Store(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),url='https://example.com/list';
 const a=db.create('custom',{goal:'Read listings',sources:[url],criteria:{outcome:'Listings',rules:'Read only',completion:'One scan'}});db.save(a.id,{browserMode:mode,maxBrowserSteps:5});if(kind!=='interview')db.review(a.id);
 const run=db.begin(a.id,kind),controller=new AbortController();let current=url,calls=[];
 const browser={async currentUrl(){return current;},async call(id,name,args){calls.push(name);return {content:[{type:'text',text:`Page URL: ${current}\nCurrent listings`}],action:{status:'ready',executed:true}};}};
 const flow=automationWorkflow({db,run,signal:controller.signal,browser,report:()=>{}});
 return {db,a,run,flow,controller,calls,redirect:url=>{current=url;},call:(name,args={})=>flow.call(a.id,run.id,name,args)};
}

test('trial scrolling needs an observed container and continues without a step budget',async t=>{
 const f=fixture(t),tool=f.flow.tools.find(t=>t.name==='browser_jev_scroll');
 validate(tool.inputSchema,{controlId:'s1',direction:'down'});
 for(const args of [{direction:'down'},{controlId:'s1',direction:'click'},{controlId:'s1',direction:'down',selector:'body'}])assert.throws(()=>validate(tool.inputSchema,args));
 const first=await f.call('browser_read'),scrolled=await f.call('browser_jev_scroll',{controlId:'s1',direction:'down'});assert.equal(scrolled.action.executed,true);
 assert.equal(f.db.run(f.run.id).browserSteps,2);assert.equal(f.db.run(f.run.id).observations.length,2);
 await assert.rejects(f.call('browser_read_part',{snapshotId:first.snapshot.id}),/eski/);
 await f.call('browser_interact',{operation:'click',ref:'any-target'});assert.ok(f.calls.includes('browser_click'));
 f.redirect('https://other.example/');await f.call('browser_jev_scroll',{controlId:'s1',direction:'down'});
 f.redirect('https://example.com/list');while(f.db.run(f.run.id).browserSteps<5)await f.call('browser_jev_scroll',{controlId:'s1',direction:'down'});
 await f.call('browser_jev_scroll',{controlId:'s1',direction:'down'});assert.equal(f.db.run(f.run.id).browserSteps,6);
});

test('research scrolling stays public, requires an active run, and is absent from separate browser tools',async t=>{
 const f=fixture(t,'interview');await f.call('browser_jev_scroll',{controlId:'s1',direction:'down'});assert.equal(f.db.run(f.run.id).browserSteps,1);
 f.redirect('http://localhost/private');await assert.rejects(f.call('browser_jev_scroll',{controlId:'s1',direction:'down'}),/herkese açık/);
 f.controller.abort();await assert.rejects(f.call('browser_jev_scroll',{controlId:'s1',direction:'down'}),/geçersiz/);
 const other=fixture(t,'trial','separate');assert.ok(!other.flow.tools.some(t=>t.name==='browser_jev_scroll'));
 await assert.rejects(other.call('browser_jev_scroll',{controlId:'s1',direction:'down'}),/Jev/);
});


test('read navigation uses an app-owned stable scope, never URL-matched foreign tabs',async()=>{
 const calls=[],browser={prepare:()=>({ready:true}),async call(id,name,args,session,options){calls.push({name,args,options});return {content:[{type:'text',text:JSON.stringify({tabId:'reading',url:args.url})}]};}};
 for(const session of ['turn-one','turn-two']){
  const adapter=automationBrowser(browser,{mode:'jev',readTabKey:'read:main'});
  for(const url of ['https://example.com/page','https://example.com/detail'])await adapter.call('workspace','browser_navigate',{url},session);
 }
 const opens=calls.filter(c=>c.name==='browser_jev_open'),reads=calls.filter(c=>c.name==='browser_jev_observe');assert.equal(opens.length,4);assert.equal(reads.length,4);assert.ok(opens.every(c=>c.options.automationTabKey==='source:https://example.com'&&c.options.automationSourceUrl==='https://example.com'&&!c.args.tabId));assert.ok(reads.every(c=>c.args.tabId==='reading'&&c.args.scope==='document'));
});

test('source tab changes invalidate cached page handles and are unavailable to other task kinds',async t=>{
 const f=fixture(t),run=f.db.putRun({...f.run,kind:'run',sourceUrl:'https://example.com/list'});
 const calls=[],browser={async call(id,name){calls.push(name);return name==='browser_jev_tabs'?{tabs:[{tabId:'retained',url:run.sourceUrl}]}:{content:[{type:'text',text:`Page URL: ${run.sourceUrl}\nRetained results`} ]};}};
 const flow=automationWorkflow({db:f.db,run,signal:f.controller.signal,browser,report:()=>{}}),call=(name,args={})=>flow.call(f.a.id,run.id,name,args);
 const first=await call('browser_read');
 assert.equal((await call('browser_jev_tabs')).tabs[0].tabId,'retained');
 await call('browser_read_part',{snapshotId:first.snapshot.id});
 const selected=await call('browser_jev_use_tab',{tabId:'retained'});
 assert.deepEqual(calls,['browser_snapshot','browser_jev_tabs','browser_jev_use_tab']);
 await assert.rejects(call('browser_read_part',{snapshotId:first.snapshot.id}),/eski/);
 await call('browser_jev_close_tab',{tabId:'retained'});
 await assert.rejects(call('browser_read_part',{snapshotId:selected.snapshot.id}),/eski/);
 assert.ok(!f.flow.tools.some(tool=>tool.name==='browser_jev_tabs'));
 const recordRun=f.db.putRun({...run,recordId:'record'});
 const recordFlow=automationWorkflow({db:f.db,run:recordRun,signal:f.controller.signal,browser,report:()=>{}});
 assert.ok(!recordFlow.tools.some(tool=>tool.name==='browser_jev_close_tab'));
 await assert.rejects(recordFlow.call(f.a.id,run.id,'browser_jev_close_tab',{tabId:'retained'}),/kaynak taraması/);
});
