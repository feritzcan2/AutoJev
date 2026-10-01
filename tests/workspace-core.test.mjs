import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {AgentSessions} from '../app/agent-sessions.mjs';
import {WorkspaceScheduler} from '../app/workspace-scheduler.mjs';
import {seedLegacyDatabase} from './helpers/legacy-database.mjs';
import {upgradeWorkspaces} from '../app/workspace-upgrade.mjs';
import {startTestServer} from './helpers/tool-server.mjs';
import {automationWorkflow,launchAutomationWorker} from '../app/automation-worker.mjs';
import {Workspaces} from '../app/workspaces.mjs';

const settings={provider:'codex',model:'default',permission:'default',reasoning:'default',network:null};
const profile=store=>new AutomationStore(store).create('job-search',{title:'Test',agentSettings:settings});
const table={title:'İşlemler',columns:[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'Başlık',type:'text'},{key:'amount',label:'Tutar',type:'money'}]};

test('legacy conversations migrate beside web data without changing saved authority or IDs',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'loop-workspace-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'db.sqlite');
 const {profile:p,completed:job}=seedLegacyDatabase(file);const store=new WorkspaceDatabase(file);t.after(()=>store.close());const db=new AutomationStore(store);upgradeWorkspaces(db);
 const a=db.create('housing');db.configureTable(a.id,table);db.saveConversation(a.id,'claude','web-native',{...settings,provider:'claude'});
 assert.equal(db.result(p.id,job.id).status,'completed');assert.equal(db.get(p.id).mode,'observe');assert.equal(db.get(p.id).browserMode,'jev');
 assert.equal(store.workspaces.history(p.id).conversation(p.id,'codex'),'main-history');assert.equal(db.conversation(a.id,'claude'),'web-native');
 assert.equal(store.workspaces.exists('agent_conversations'),false);assert.equal(store.workspaces.exists('conversation_launch_settings'),false);
 const registry=new Workspaces(store.workspaces,{templates:{browser:{snapshot:id=>db.get(id)}}});assert.equal(registry.list().length,2);assert.equal(registry.snapshot(p.id).id,p.id);
});
test('job and custom tables use the same scoped MCP endpoint without changing authority',async t=>{
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),p=profile(store),a=db.create('custom');
 const job=db.putResult({id:'job',automationId:p.id,key:'job',url:'https://example.com/job/1',title:'Engineer',status:'found'}),mcp=await startTestServer(store);t.after(()=>mcp.close());
 const grant=id=>{const run=db.begin(id,'interview'),flow=automationWorkflow({db,run,signal:new AbortController().signal,browser:{},report:()=>{}});return mcp.grant(id,run.id,'main',flow);};
 const jobToken=grant(p.id),webToken=grant(a.id);
 const call=async(token,name,args)=>{const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await response.json()).result;};
 for(const token of [jobToken,webToken])assert.ok(!(await call(token,'configure_workspace_table',table)).isError);
 assert.ok(!(await call(jobToken,'update_workspace_cells',{itemId:job.id,cells:[{key:'amount',value:'1200.50'}]})).isError);
 assert.equal((await call(webToken,'update_workspace_cells',{itemId:job.id,cells:[{key:'amount',value:'999'}]})).isError,true);
 assert.equal((await call(jobToken,'update_workspace_cells',{itemId:job.id,cells:[{key:'status',value:'completed'}]})).isError,true);
 assert.equal(db.result(p.id,job.id).status,'found');assert.equal(db.result(p.id,job.id).cells.amount,'1200.5');assert.equal(db.get(p.id).mode,'observe');assert.equal(db.get(a.id).reviewedRevision,null);
 assert.equal((await call(webToken,'record_submission',{jobId:job.id})).isError,true);
 mcp.revoke(webToken);assert.equal((await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+webToken}})).status,401);
});
function sessionFixture(){
 const created=[],events=[],agents=new AgentSessions({root:process.cwd(),data:tmpdir(),emit:e=>events.push(e),createEngine:(binary,directory,event)=>{
  const engine={directory,event,calls:[],closed:0,failClose:false,async request(op,args){this.calls.push({op,args});return {};},async close(){this.closed++;if(this.failClose)throw Error('Still alive');}};created.push(engine);return engine;
 }});return {agents,created,events};
}
const start=(agents,id,extra={})=>agents.start({id,sessionId:id+'-session',settings,cwd:tmpdir(),runtimeDirectory:tmpdir(),endpoint:'http://127.0.0.1/mcp',token:'test',prompt:'Test',...extra});

test('one session service isolates worker output/input and applies identical resume rules to every template',async t=>{
 const {agents,created,events}=sessionFixture();t.after(()=>agents.close());const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const p=profile(store),db=new AutomationStore(store),a=db.create('housing');
 db.saveConversation(p.id,'codex','job-native',settings);db.saveConversation(a.id,'codex','web-native',settings);
 await start(agents,p.id,{history:db});await start(agents,a.id,{history:db});
 assert.equal(created[0].calls[0].args.resumeId,'job-native');assert.equal(created[1].calls[0].args.resumeId,'web-native');
 created[0].event({event:'output',bytes:[65]});created[1].event({event:'output',bytes:[66]});assert.deepEqual(agents.output(p.id).bytes,[65]);assert.deepEqual(agents.output(a.id).bytes,[66]);
 await agents.input(a.id,'hello','main',p.id+'-session');assert.equal(created[1].calls.filter(c=>c.op==='input').length,0);
 await agents.input(a.id,'hello','main',a.id+'-session');assert.equal(created[1].calls.at(-1).args.text,'hello');
 await agents.stop(a.id);await start(agents,a.id,{history:db,settings:{...settings,permission:'plan'}});assert.equal(created[2].calls[0].args.resumeId,undefined);
 created[1].event({event:'output',bytes:[90]});assert.deepEqual(agents.output(a.id).bytes,[]);assert.equal(events.filter(e=>e.event==='output').length,2);
});

test('failed provider shutdown prevents another start until closure is confirmed',async()=>{
 const {agents,created}=sessionFixture();await start(agents,'workspace');created[0].failClose=true;
 await assert.rejects(agents.stop('workspace'),/Still alive/);await assert.rejects(start(agents,'workspace'),/kapanıyor/);assert.equal(created.length,1);
 created[0].failClose=false;await agents.stop('workspace');await start(agents,'workspace');assert.equal(created.length,2);await agents.close();
});

test('the workspace scheduler dispatches all template policies without overlapping ticks',async()=>{
 let at=0,release;const calls=[],scheduler=new WorkspaceScheduler({now:()=>at});scheduler.register('jobs',async()=>{calls.push('jobs');await new Promise(r=>release=r);});scheduler.register('housing',()=>calls.push('housing'));scheduler.register('skills',()=>calls.push('skills'),{interval:5000});
 const first=scheduler.tick();await scheduler.tick();assert.deepEqual(calls,['jobs']);release();await first;assert.deepEqual(calls,['jobs','housing','skills']);await scheduler.tick();assert.equal(calls.length,3);scheduler.close();at=6000;await scheduler.tick();assert.equal(calls.length,3);
});

test('bounded template tasks retire an over-limit conversation at the same safe task boundary',async t=>{
 const {agents}=sessionFixture();t.after(()=>agents.close());const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),a=db.create('housing'),limited={...settings,contextRestartPercent:70};
 db.saveConversation(a.id,'codex','over-limit',limited);await start(agents,a.id,{settings:limited,history:db,rotateAtBoundary:true});agents.sessions.get(a.id).contextUsage={percent:78,peakPercent:78};
 await agents.stop(a.id);assert.equal(db.conversation(a.id,'codex'),null);assert.equal(db.get(a.id).mode,a.mode);assert.equal(db.get(a.id).revision,a.revision);
});


test('web automation launches in its managed workspace and reads the minimal user request through scoped tools',async t=>{
 const data=await mkdtemp(path.join(tmpdir(),'loop-managed-automation-'));
 const store=new WorkspaceDatabase(path.join(data,'db.sqlite'));const db=new AutomationStore(store),a=db.create('housing');
 db.message(a.id,'user','Amsterdam’da bana uygun kiralık ev bul.');const run=db.begin(a.id,'interview');
 const {agents,created}=sessionFixture(),mcp=await startTestServer(store);let worker;
 t.after(async()=>{await worker?.close();await agents.close();await mcp.close();store.close();await rm(data,{recursive:true,force:true});});
 worker=await launchAutomationWorker({data,db,run,automation:db.get(a.id),agents,mcp,signal:new AbortController().signal,browser:{waitForOperations:async()=>{}},report:()=>{},changed:()=>{},onEvent:()=>{}});
 const args=created[0].calls.find(c=>c.op==='start').args;
 assert.equal(args.taskType,'automation');assert.equal(args.cwd,await realpath(path.join(data,'automations','workspaces',a.id)));assert.equal(args.permission,a.agentSettings.permission);
 assert.ok(args.approvedTools.includes('research_automation_source'));assert.ok(args.approvedTools.includes('reply_to_user'));
 const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+args.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_automation_context',arguments:{}}})});
 const context=JSON.parse((await response.json()).result.content[0].text);assert.equal(context.messages.at(-1).text,'Amsterdam’da bana uygun kiralık ev bul.');
 assert.deepEqual(context.automation.criteria,{});assert.equal(context.automation.mode,'prepare');
});
