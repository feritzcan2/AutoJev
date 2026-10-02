import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import documentPlugin from '../app/opencode-documents-plugin.mjs';
import {readOpenCodeFailure} from '../app/opencode-failure.mjs';
import {AgentSessions} from '../app/agent-sessions.mjs';
import {TaskRuns} from '../app/task-runs.mjs';

const nativeId='ses_12345678901234567890';
const failure={name:'APIError',data:{message:'Upstream request failed: content part type "file" is not supported; only text and image_url are',statusCode:400,isRetryable:false,responseBody:'PRIVATE',responseHeaders:{Authorization:'SECRET'}}};
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'opencode-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'opencode.db'),db=new DatabaseSync(file);t.after(()=>db.close());
 db.exec('CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);');
 db.prepare('INSERT INTO session VALUES(?,?)').run(nativeId,root);
 const set=(error=failure,at=Date.now(),extra={})=>{db.exec('DELETE FROM message');db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('message',nativeId,at,JSON.stringify({role:'assistant',time:{completed:at+1},error,...extra}));};
 const read=(options={})=>readOpenCodeFailure({nativeId,cwd:root,file,...options});
 return {root,file,db,set,read};
}

test('native PDF reads are redirected to local CV text, including uppercase names and symlink aliases; text, images and MCP remain available',async t=>{
 const {root}=await fixture(t),hook=(await documentPlugin({directory:root}))['tool.execute.before'];
 await writeFile(path.join(root,'CV.PDF'),'%PDF-1.4\nprivate document');await symlink(path.join(root,'CV.PDF'),path.join(root,'alias'));
 await writeFile(path.join(root,'facts.txt'),'Profile facts');await writeFile(path.join(root,'image.png'),Buffer.from([137,80,78,71]));
 for(const filePath of ['CV.PDF','alias',path.join(root,'CV.PDF')])await assert.rejects(hook({tool:'read'},{args:{filePath}}),/jobloop_read_scoring_profile.*nextOffset/);
 for(const filePath of ['facts.txt','image.png','missing.txt'])await hook({tool:'read'},{args:{filePath}});
 await hook({tool:'jobloop_read_scoring_profile'},{args:{source:'cv'}});
});

test('only the current workspace’s latest completed fatal message is reported, with no provider bodies or headers',async t=>{
 const f=await fixture(t);f.set(failure,1000);
 const result=await f.read();assert.equal(result.kind,'unsupported_file');assert.ok(!/PRIVATE|SECRET/.test(JSON.stringify(result)));
 assert.equal(await f.read({since:1001}),null);assert.equal(await f.read({cwd:tmpdir()}),null);
 assert.equal(await f.read({nativeId:'invalid'}),null);
 for(const error of [null,{name:'MessageAbortedError',data:{}},{...failure,data:{...failure.data,isRetryable:true}}]){f.set(error,1000);assert.equal(await f.read(),null);}
 f.set(failure,1000,{time:{}});assert.equal(await f.read(),null);
 f.set(failure,1000);f.db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('new-turn',nativeId,2000,JSON.stringify({role:'user'}));assert.equal(await f.read(),null);
 f.set({name:'APIError',data:{isRetryable:false,statusCode:401,message:'SECRET'}},3000);assert.match((await f.read()).summary,/HTTP 401/);assert.ok(!(await f.read()).summary.includes('SECRET'));
});

for(const trigger of ['monitor','exit'])test(`fatal error via ${trigger} ends only its own task and retires its resume history without UI polling`,async t=>{
 const f=await fixture(t),deliveries=new Map(),launches=[],forgot=[],runs=new Map();
 const agents=new AgentSessions({root:process.cwd(),data:f.root,readProviderFailure:args=>readOpenCodeFailure({...args,file:f.file}),createEngine:(_bin,_dir,event)=>({request:async(op,args)=>{if(op==='start'){launches.push(args);deliveries.set(args.sessionId,event);}return {};},close:async()=>{}})});
 const runtime=new TaskRuns({recover(){},config:()=>({}),begin:(id,input,workerId)=>{const run={id:workerId,workerId,status:'running'};runs.set(run.id,run);return run;},run:id=>runs.get(id),save:run=>runs.set(run.id,run),finish:(id,runId,status,summary)=>runs.set(runId,{...runs.get(runId),status,summary})},{launch:async(run,task,onEvent)=>{
  await agents.start({id:'workspace',worker:run.workerId,sessionId:run.id,settings:{provider:'opencode',model:'default',contextCompactPercent:0},cwd:f.root,runtimeDirectory:f.root,prompt:'Scan',approvedTools:['read_scoring_profile'],history:{conversation:()=>null,saveConversation(){},forgetConversation:(...args)=>forgot.push(args)},onEvent});
  await deliveries.get(run.id)({event:'identity',sessionId:run.id,nativeId:run.workerId==='main'?nativeId:'ses_98765432109876543210'});
  return {close:()=>agents.stop('workspace',run.workerId)};
 }});
 t.after(async()=>{await runtime.close();await agents.close();});
 await runtime.start('workspace',null,'main');await runtime.start('workspace',null,'second');
 assert.ok(launches.every(x=>x.opencodeDocumentGuard===true));
 const session=agents.sessions.get('workspace');assert.ok(session.failureTimer,'Native error monitoring is armed independently of the renderer');
 f.set(failure,Date.now()+1);if(trigger==='exit')await deliveries.get('main')({event:'eof',sessionId:'main'});else await agents.checkProviderFailure(session);
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(runs.get('main').status,'failed');assert.equal(runs.get('main').stop.kind,'technical');assert.equal(runtime.slots('workspace').length,1);
 assert.equal(runs.get('second').status,'running');assert.equal(agents.sessions.size,1);assert.deepEqual(forgot,[['workspace','opencode',nativeId]]);
 await agents.checkProviderFailure(session);assert.equal(forgot.length,1);
});

test('late error reads from a retired session cannot fail its replacement',async t=>{
 const f=await fixture(t);let resolve,deliver;const events=[];
 const agents=new AgentSessions({root:process.cwd(),data:f.root,readProviderFailure:()=>new Promise(done=>{resolve=done;}),createEngine:(_b,_d,callback)=>{deliver=callback;return {request:async()=>({}),close:async()=>{}};}});t.after(()=>agents.close());
 const start=sessionId=>agents.start({id:'workspace',sessionId,settings:{provider:'opencode',model:'default',contextCompactPercent:0},cwd:f.root,runtimeDirectory:f.root,prompt:'Scan',onEvent:event=>events.push(event)});
 await start('old');await deliver({event:'identity',sessionId:'old',nativeId});const checking=agents.checkProviderFailure(agents.sessions.get('workspace'));
 await agents.stop('workspace');await start('new');resolve({summary:'stale failure'});await checking;
 assert.equal(events.filter(x=>x.event==='provider_error').length,0);assert.equal(agents.sessions.get('workspace').sessionId,'new');
});
