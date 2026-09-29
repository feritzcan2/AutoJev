import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {AgentSessions} from '../app/agent-sessions.mjs';
import {WorkspaceScheduler} from '../app/workspace-scheduler.mjs';
import {workspaceTableCall} from '../app/workspace-table-tools.mjs';
import {startMcp} from '../app/mcp.mjs';
import {automationWorkflow,launchAutomationWorker} from '../app/automation-worker.mjs';
import {Workspaces} from '../app/workspaces.mjs';
import {BackgroundStore} from '../app/background-store.mjs';
import {BackgroundJobs} from '../app/background.mjs';
import {launchSkillWorker} from '../app/background-worker.mjs';

const settings={provider:'codex',model:'default',permission:'default',reasoning:'default',network:null};
const profile=store=>store.saveProfile({name:'Test',preferences:'Remote engineering',authorization:'research',agentSettings:settings});
const table={title:'İşlemler',columns:[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'Başlık',type:'text'},{key:'amount',label:'Tutar',type:'money'}]};

test('old job and web data migrate to canonical workspaces without changing IDs, authority or records',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'loop-workspace-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));const file=path.join(directory,'db.sqlite');
 let store=new Store(file),db=new AutomationStore(store);const p=profile(store),job=store.addJob(p.id,{company:'Test Corp',role:'Engineer',location:'Berlin',url:'https://example.com/job/1',fit:'Relevant'}).job,a=db.create('housing',{title:'Evler'});
 const run=db.begin(a.id,'interview');db.finish(a.id,run.id,'completed','Kurulum sürüyor');db.configureTable(a.id,table);
 const oldJob={...store.profile(p.id),browserMode:'jev',chromeProfile:{name:'Work',directory:'Profile 1'}},oldWeb={...db.get(a.id),conversations:{claude:{nativeId:'web-native',settings:{...settings,provider:'claude'}}}};
 store.db.prepare('UPDATE candidates SET data=? WHERE id=?').run(JSON.stringify(oldJob),p.id);store.db.prepare('UPDATE automations SET data=? WHERE id=?').run(JSON.stringify(oldWeb),a.id);
 store.db.exec('PRAGMA foreign_keys=OFF; DELETE FROM workspace_conversations; DROP TABLE workspace_conversations; DROP TABLE workspaces; PRAGMA user_version=3; PRAGMA foreign_keys=ON');
 store.db.exec('CREATE TABLE agent_conversations(candidate_id TEXT,provider TEXT,native_id TEXT); CREATE TABLE conversation_launch_settings(candidate_id TEXT,provider TEXT,native_id TEXT,data TEXT)');
 store.db.prepare('INSERT INTO agent_conversations VALUES(?,?,?)').run(p.id,'codex','job-native');store.db.prepare('INSERT INTO conversation_launch_settings VALUES(?,?,?,?)').run(p.id,'codex','job-native',JSON.stringify(settings));store.close();
 store=new Store(file);t.after(()=>store.close());db=new AutomationStore(store);
 assert.equal(store.workspaces.list().length,2);assert.equal(store.workspaces.get(p.id).templateId,'job-search');assert.equal(store.workspaces.get(a.id).templateId,'housing');
 assert.deepEqual(store.job(p.id,job.id),job);assert.equal(store.profile(p.id).authorization,'research');assert.equal(db.get(a.id).mode,oldWeb.mode);assert.deepEqual(db.get(a.id).table,table);assert.equal(db.runs(a.id)[0].id,run.id);
 assert.equal(store.profile(p.id).browserMode,'jev');assert.deepEqual(store.profile(p.id).chromeProfile,oldJob.chromeProfile);assert.equal(store.conversation(p.id,'codex'),'job-native');assert.equal(db.conversation(a.id,'claude'),'web-native');
 assert.equal(store.workspaces.exists('agent_conversations'),false);assert.equal(store.workspaces.exists('conversation_launch_settings'),false);
 const registry=new Workspaces(store.workspaces,{templates:{applications:{snapshot:id=>store.profile(id)},browser:{snapshot:id=>db.get(id)}}});assert.equal(registry.list().length,2);assert.equal(registry.snapshot(p.id).id,p.id);assert.equal(registry.snapshot(a.id).id,a.id);
});

test('both templates edit tables through the same MCP endpoint without changing action authority',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const p=profile(store),db=new AutomationStore(store),a=db.create('custom');
 const job=store.addJob(p.id,{company:'Test Corp',role:'Engineer',location:'Berlin',url:'https://example.com/job/1',fit:'Observed details'}).job,run=db.begin(a.id,'interview'),controller=new AbortController();
 const flow=automationWorkflow({db,run,signal:controller.signal,browser:{},report:()=>{}}),mcp=await startMcp(store);t.after(()=>mcp.close());const jobToken=mcp.grant(p.id,'job-session'),webToken=mcp.grant(a.id,run.id,'main',flow);
 const call=async(token,name,args)=>{const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await response.json()).result;};
 for(const token of [jobToken,webToken])assert.ok(!(await call(token,'configure_workspace_table',table)).isError);
 assert.ok(!(await call(jobToken,'update_workspace_cells',{itemId:job.id,cells:[{key:'amount',value:'1200.50'}]})).isError);
 assert.equal((await call(webToken,'update_workspace_cells',{itemId:job.id,cells:[{key:'amount',value:'999'}]})).isError,true);
 assert.equal((await call(jobToken,'update_workspace_cells',{itemId:job.id,cells:[{key:'status',value:'submitted'}]})).isError,true);
 assert.equal(store.job(p.id,job.id).status,job.status);assert.equal(store.job(p.id,job.id).cells.amount,'1200.5');assert.equal(store.profile(p.id).authorization,'research');assert.equal(db.get(a.id).mode,'observe');assert.equal(db.get(a.id).reviewedRevision,null);
 assert.equal((await call(webToken,'record_submission',{jobId:job.id})).isError,true);assert.equal((await call(jobToken,'save_automation_plan',{})).isError,true);
 mcp.revoke(webToken);assert.equal((await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+webToken}})).status,401);
});

function sessionFixture(){
 const created=[],events=[],agents=new AgentSessions({root:process.cwd(),data:tmpdir(),emit:e=>events.push(e),createEngine:(binary,directory,event)=>{
  const engine={directory,event,calls:[],closed:0,failClose:false,async request(op,args){this.calls.push({op,args});return {};},async close(){this.closed++;if(this.failClose)throw Error('Still alive');}};created.push(engine);return engine;
 }});return {agents,created,events};
}
const start=(agents,id,extra={})=>agents.start({id,sessionId:id+'-session',settings,cwd:tmpdir(),runtimeDirectory:tmpdir(),endpoint:'http://127.0.0.1/mcp',token:'test',prompt:'Test',...extra});

test('one session service isolates worker output/input and applies identical resume rules to every template',async t=>{
 const {agents,created,events}=sessionFixture();t.after(()=>agents.close());const store=new Store(':memory:');t.after(()=>store.close());const p=profile(store),db=new AutomationStore(store),a=db.create('housing');
 store.saveConversation(p.id,'codex','job-native',settings);db.saveConversation(a.id,'codex','web-native',settings);
 await start(agents,p.id,{history:store});await start(agents,a.id,{history:db});
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
 const {agents}=sessionFixture();t.after(()=>agents.close());const store=new Store(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),a=db.create('housing'),limited={...settings,contextRestartPercent:70};
 db.saveConversation(a.id,'codex','over-limit',limited);await start(agents,a.id,{settings:limited,history:db,rotateAtBoundary:true});agents.sessions.get(a.id).contextUsage={percent:78,peakPercent:78};
 await agents.stop(a.id);assert.equal(db.conversation(a.id,'codex'),null);assert.equal(db.get(a.id).mode,a.mode);assert.equal(db.get(a.id).revision,a.revision);
});


test('background skills launch through the shared agent pool and MCP server without owning another engine',async t=>{
 const data=await mkdtemp(path.join(tmpdir(),'loop-shared-background-'));t.after(()=>rm(data,{recursive:true,force:true}));const store=new Store(path.join(data,'db.sqlite'));t.after(()=>store.close());const p=profile(store),db=new BackgroundStore(store),{agents,created}=sessionFixture(),mcp=await startMcp(store);t.after(()=>mcp.close());
 const manager=new BackgroundJobs(db,{launch:(run,task,onEvent,signal)=>launchSkillWorker({root:process.cwd(),data,db,run,task,onEvent,signal,agents,mcp,complete:(...args)=>manager.complete(...args),onOutput:()=>{}})});t.after(async()=>{await manager.close();await agents.close();});
 const run=await manager.start(p.id),args=created[0].calls.find(c=>c.op==='start').args;
 assert.equal(args.endpoint,mcp.endpoint);assert.equal(agents.sessions.get(p.id+'~background').sessionId,run.id);assert.equal(store.conversation(p.id,'codex'),null);
 const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+args.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_background_context',arguments:{}}})});
 const body=await response.json();assert.equal(JSON.parse(body.result.content[0].text).profile.id,p.id);
 await manager.finish(p.id,'completed','Test tamamlandı');assert.equal(db.run(run.id).status,'completed');assert.equal(agents.sessions.size,0);assert.equal(created[0].closed,1);
});


test('web automation launches in its managed workspace and reads the minimal user request through scoped tools',async t=>{
 const data=await mkdtemp(path.join(tmpdir(),'loop-managed-automation-'));
 const store=new Store(path.join(data,'db.sqlite'));const db=new AutomationStore(store),a=db.create('housing');
 db.message(a.id,'user','Amsterdam’da bana uygun kiralık ev bul.');const run=db.begin(a.id,'interview');
 const {agents,created}=sessionFixture(),mcp=await startMcp(store);let worker;
 t.after(async()=>{await worker?.close();await agents.close();await mcp.close();store.close();await rm(data,{recursive:true,force:true});});
 worker=await launchAutomationWorker({data,db,run,automation:db.get(a.id),agents,mcp,signal:new AbortController().signal,browser:{waitForOperations:async()=>{}},report:()=>{},changed:()=>{},onEvent:()=>{}});
 const args=created[0].calls.find(c=>c.op==='start').args;
 assert.equal(args.taskType,'automation');assert.equal(args.cwd,await realpath(path.join(data,'automations','workspaces',a.id)));assert.equal(args.permission,a.agentSettings.permission);
 assert.ok(args.approvedTools.includes('research_automation_source'));assert.ok(args.approvedTools.includes('reply_to_user'));
 const response=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:'Bearer '+args.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_automation_context',arguments:{}}})});
 const context=JSON.parse((await response.json()).result.content[0].text);assert.equal(context.messages.at(-1).text,'Amsterdam’da bana uygun kiralık ev bul.');
 assert.deepEqual(context.automation.criteria,{});assert.equal(context.automation.mode,'prepare');
});
