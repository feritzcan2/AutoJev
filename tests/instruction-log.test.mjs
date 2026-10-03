import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {InstructionLog,instructionPart,fileInstructionParts,contextInstructionParts,pruneInstructionLogs} from '../app/instruction-log.mjs';
import {AgentSessions} from '../app/agent-sessions.mjs';
import {startToolServer} from '../app/tool-server.mjs';
import {webInstructionCatalog} from '../app/instruction-catalog.mjs';
import {createBackup,pruneLogs} from '../app/data-management.mjs';
import {DatabaseSync} from 'node:sqlite';
const settings={provider:'codex',model:'default',permission:'default',reasoning:'default',network:null};
function fixture(t,file=':memory:'){
 const core=new WorkspaceDatabase(file);t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('housing',{title:'Evler'}),b=db.create('custom',{title:'Diğer'}),log=new InstructionLog(core.workspaces);
 return {core,db,a,b,log,record:(parts,extra={})=>log.record({workspaceId:a.id,sessionId:'s1',workerId:'main',kind:'context',title:'Bağlam',status:'returned',parts,...extra})};
}
test('instruction history distinguishes current, available and changed content and isolates workspaces, sessions and workers',t=>{
 const {core,a,b,log,record}=fixture(t),old=instructionPart('budget','Bütçe','workspace','1200'),current={...old,text:'1500'};
 record([old]);record([current],{sessionId:'s2',workerId:'other'});
 assert.equal(log.status(a.id,[current],{session:'s1'})[0].state,'changed');assert.equal(log.status(a.id,[current],{session:'s2'})[0].state,'recorded');assert.equal(log.status(b.id,[current])[0].state,'unrecorded');
 const parts=fileInstructionParts('AGENTS.md','First rule.\nSecond rule.');assert.equal(parts.length,2);record(parts,{kind:'files',status:'available'});assert.equal(log.status(a.id,parts,{session:'s1'})[0].state,'available');
 const history=log.history(a.id,{worker:'other'});assert.equal(history.events.length,1);assert.equal(history.events[0].parts[0].text,undefined);assert.equal(log.detail(a.id,history.events[0].seq).parts[0].text,'1500');assert.throws(()=>log.detail(b.id,history.events[0].seq),/bulunamadı/);
 assert.ok(webInstructionCatalog(new AutomationStore(core),a.id).length>10);
 core.workspaces.remove(a.id);assert.equal(core.db.prepare('SELECT count(*) AS n FROM workspace_instruction_events').get().n,0);
});
test('instruction logs page, mark truncation, redact secret fields and obey retention',t=>{
 const {a,log,record,core}=fixture(t);
 record(contextInstructionParts('get_context',{profile:{password:'never-store',nested:{apiKey:'also-secret'},preferences:'Remote'}}));
 assert.ok(!JSON.stringify(log.detail(a.id,1)).includes('never-store'));assert.ok(!JSON.stringify(log.detail(a.id,1)).includes('also-secret'));
 for(let i=0;i<105;i++)record([instructionPart('key','Text','workspace',String(i))]);
 const page=log.history(a.id),next=log.history(a.id,{before:page.next});assert.equal(page.events.length,100);assert.equal(next.events.length,6);assert.ok(next.events[0].seq<page.events.at(-1).seq);
 const seq=record([instructionPart('large','Large','tool','x'.repeat(128010))]);assert.equal(log.detail(a.id,seq).parts[0].truncated,true);assert.equal(log.detail(a.id,seq).parts[0].text.length,128000);
 assert.equal(pruneInstructionLogs(core.db,{now:Date.now()+31*86400000}),107);assert.equal(log.history(a.id).events.length,0);
});
test('shared sessions record immutable launch files, submission requests, failures and provider delivery without logging terminal keystrokes',async t=>{
 const {a,log}=fixture(t),directory=await mkdtemp(path.join(tmpdir(),'loop-instructions-'));t.after(()=>rm(directory,{recursive:true,force:true}));await writeFile(path.join(directory,'AGENTS.md'),'Initial rules.');
 let emit,fail=false;const agents=new AgentSessions({root:process.cwd(),data:directory,instructions:log,createEngine:(_binary,_directory,event)=>{emit=event;return {request:async op=>{if(fail&&op==='message')throw Error('queue full');return {queued:true};},close:async()=>{}};}});t.after(()=>agents.close());
 await agents.start({id:a.id,sessionId:'session',settings,cwd:directory,runtimeDirectory:directory,prompt:'Read the plan.'});
 await writeFile(path.join(directory,'AGENTS.md'),'Changed rules.');emit({event:'delivery',sessionId:'session',state:'Some(Confirmed)'});
 await agents.input(a.id,'private terminal text');await agents.message(a.id,'Continue');fail=true;await assert.rejects(agents.message(a.id,'Rejected'),/queue full/);
 const events=log.history(a.id).events;assert.ok(events.some(e=>e.kind==='message_failed'));assert.ok(events.some(e=>e.kind==='delivery'&&e.detail==='Some(Confirmed)'));
 const files=log.detail(a.id,events.find(e=>e.kind==='files').seq);assert.equal(files.parts[0].text,'Initial rules.');assert.equal(files.status,'available');assert.ok(!JSON.stringify(events).includes('private terminal text'));
});
test('tool exchange logging captures the actual returned context and tools without changing scoped execution',async t=>{
 const {a,log}=fixture(t);let calls=0;
 const tools=[{name:'get_test_context',description:'Read saved criteria',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
 const protocol={tools,call:async()=>{calls++;return {profile:{goal:'Ev bul',password:'private'}};}};
 const server=await startToolServer({assertOwner:()=>{},resolve:()=>protocol,onExchange:(grant,event)=>log.tool(grant,event)});t.after(()=>server.close());const token=server.grant(a.id,'session');
 const call=async(method,authorization=token)=>{const r=await fetch(server.endpoint,{method:'POST',headers:{Authorization:'Bearer '+authorization},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{name:'get_test_context',arguments:{}}})});return {status:r.status,body:await r.json()};};
 assert.equal((await call('tools/list')).body.result.tools[0].description,'Read saved criteria');assert.equal((await call('tools/call')).status,200);assert.equal(calls,1);assert.equal((await call('tools/call','bad')).status,401);assert.equal(calls,1);
 const events=log.history(a.id).events;assert.deepEqual(events.map(e=>e.kind),['tool_result','tool_catalog']);const text=JSON.stringify(log.detail(a.id,events[0].seq));assert.ok(text.includes('Ev bul'));assert.ok(!text.includes('private'));assert.ok(!text.includes(token));
});
test('page report validation errors and successful checkpoints remain inspectable',t=>{
 const {a,log}=fixture(t),grant={workspaceId:a.id,sessionId:'scan'};
 log.tool(grant,{name:'browser_read',result:{isError:true,content:[{type:'text',text:'Sayfalama kanıtı bu tarayıcı gözleminde bulunamadı.'}]}});
 log.tool(grant,{name:'browser_read',result:{content:[{type:'text',text:JSON.stringify({pageReport:{currentPage:8,totalPages:null,evidence:'Seite 8'}})}]}});
 const events=log.history(a.id,{session:'scan'}).events;
 assert.deepEqual(events.map(e=>({title:e.title,status:e.status})),[{title:'browser_read',status:'returned'},{title:'browser_read',status:'failed'}]);
 assert.match(log.detail(a.id,events[0].seq).parts[0].text,/Seite 8/);
});

test('portable backups and clear-logs remove instruction content while leaving saved plans intact',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'loop-instruction-backup-'));t.after(()=>rm(dir,{recursive:true,force:true}));const data=path.join(dir,'data');await mkdir(data);const {core,a,log,record}=fixture(t,path.join(data,'jobloop.sqlite'));
 record([instructionPart('secret-plan','Saved criteria','workspace','Private criteria')]);const backup=path.join(dir,'backup');await createBackup({dataDirectory:data,destination:backup,db:core.db,appVersion:'0.1.1'});
 const copy=new DatabaseSync(path.join(backup,'jobloop.sqlite'));try{assert.equal(copy.prepare('SELECT count(*) AS n FROM workspace_instruction_events').get().n,0);}finally{copy.close();}
 assert.equal(log.history(a.id).events.length,1);await pruneLogs({dataDirectory:data,db:core.db,clear:true});assert.equal(log.history(a.id).events.length,0);assert.equal(core.workspaces.get(a.id).title,'Evler');
});
