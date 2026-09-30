import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {BackgroundStore} from '../app/background-store.mjs';
import {BackgroundJobs} from '../app/background.mjs';
import {mailWorkflow,skillWorkflow} from '../app/background-worker.mjs';
import {startMcp} from '../app/mcp.mjs';
function fixture(){const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Remote',facts:'E-posta: test@example.com'}),other=store.saveProfile({name:'Other',preferences:'Remote'}),db=new BackgroundStore(store);return{store,p,other,db};}
test('scheduler runs once, persists before closing, resumes overdue schedules without backlog',async()=>{
 const {store,p,db}=fixture();let launches=0,closes=0;const jobs=new BackgroundJobs(db,{now:()=>1000,launch:async()=>{launches++;return{close:async()=>{closes++;}};}});db.save(p.id,{...db.task(p.id),enabled:true});await jobs.tick();await jobs.tick();await new Promise(r=>setImmediate(r));assert.equal(launches,1);assert.equal(jobs.active.size,1);const run=jobs.active.get(p.id).run;await assert.rejects(jobs.start(p.id),/zaten/);jobs.complete(p.id,run.id,'Completed');assert.equal(db.run(run.id).summary,'Completed');await jobs.finish(p.id,'completed','Completed');assert.equal(closes,1);assert.equal(db.run(run.id).status,'completed');assert.equal(db.task(p.id).nextRunAt,1801000);await jobs.tick();assert.equal(launches,1);await jobs.close();store.close();
});
test('stop during launch waits for worker then closes, errors and restart are never success',async()=>{
 const {store,p,db}=fixture();let resolve,closed=0;const jobs=new BackgroundJobs(db,{launch:()=>new Promise(r=>{resolve=r;})});const start=jobs.start(p.id);await new Promise(r=>setImmediate(r));const stop=jobs.finish(p.id,'cancelled','Stopped');resolve({close:async()=>{closed++;}});await Promise.all([start,stop]);assert.equal(closed,1);assert.equal(db.runs(p.id)[0].status,'cancelled');const interrupted=db.begin(p.id);db.recover();assert.equal(db.run(interrupted.id).status,'interrupted');assert.equal(db.task(p.id).nextRunAt,0);await jobs.close();store.close();
});
test('connector outcomes require verified account, scoped jobs, evidence and deduplication',async()=>{
 const {store,p,other,db}=fixture();const job=store.addJob(p.id,{url:'https://example.com/test',company:'Example',role:'Backend',location:'Berlin',fit:'Test'}).job,foreign=store.addJob(other.id,{url:'https://example.com/other',company:'Other',role:'Backend',location:'Berlin',fit:'Test'}).job;
 const run=db.begin(p.id),controller=new AbortController();let completed=0;
 const flow=mailWorkflow(db,run,()=>{completed++;return{saved:true};},controller.signal),call=(name,args={})=>flow.call(p.id,run.id,name,args);
 await assert.rejects(flow.call(other.id,run.id,'get_mail_task',{}),/geçersiz/);
 assert.equal((await call('get_mail_task')).expectedAccount,'test@example.com');
 await assert.rejects(call('finish_background_job',{summary:'fake'}),/doğrula/);
 await assert.rejects(call('is_mail_processed',{messageId:'m1'}),/doğrula/);
 await call('report_mail_connection',{status:'ready',account:'test@example.com',connector:'gmail',message:'Account verified from connector profile'});
 const evidence={messageId:'m1',threadId:'t1',subject:'Interview',date:'2026-09-25T10:00:00Z',url:'https://mail.google.com/mail/u/0/#all/t1',evidence:'We invite you for a first interview',outcome:'interview',summary:'Interview'};
 await assert.rejects(call('record_mail_outcome',{...evidence,jobId:foreign.id}));
 await assert.rejects(call('record_mail_outcome',{...evidence,jobId:job.id,url:'https://evil.example/mail'}),/Gmail/);
 await call('record_mail_outcome',{...evidence,jobId:job.id});
 assert.equal((await call('record_mail_outcome',{...evidence,jobId:job.id})).duplicate,true);
 assert.equal((await call('is_mail_processed',{messageId:'m1'})).processed,true);
 await call('finish_background_job',{summary:'done'});assert.equal(completed,1);assert.equal(db.signals(p.id).length,1);assert.equal(db.signals(p.id)[0].evidence,evidence.evidence);assert.equal(store.job(p.id,job.id).status,'found');assert.equal(db.signals(other.id).length,0);
 controller.abort();await assert.rejects(call('get_mail_task'),/geçersiz/);store.close();
});
test('missing connector and wrong account block instead of claiming successful empty scans',async()=>{
 for(const status of ['missing','identity_missing','ready']){
  const {store,p,db}=fixture(),run=db.begin(p.id);let result;
  const flow=mailWorkflow(db,run,(id,runId,summary,state)=>{result=state;return{saved:true};},new AbortController().signal);
  await flow.call(p.id,run.id,'report_mail_connection',{status,account:'wrong@example.com',connector:'gmail',message:'Unavailable'});
  assert.equal(result,'blocked');assert.notEqual(db.task(p.id).connection.status,'ready');
  await assert.rejects(flow.call(p.id,run.id,'finish_background_job',{summary:'No mail'}),/doğrula/);store.close();
 }
});
test('missing Gmail connection suspends automatic work but permits manual retry',async()=>{
 const {store,p,db}=fixture();let launches=0;const jobs=new BackgroundJobs(db,{launch:async()=>{launches++;return{close:async()=>{}};}});db.putTask(p.id,{...db.task(p.id),enabled:true,connection:{status:'missing'}});await jobs.tick();await new Promise(r=>setImmediate(r));assert.equal(launches,0);await jobs.start(p.id);assert.equal(launches,1);await jobs.finish(p.id,'blocked','Missing connector');db.save(p.id,{enabled:true,intervalMinutes:30});await jobs.tick();assert.equal(launches,1);await jobs.close();store.close();
});
test('old token storage is retired while mailbox choice and results survive',()=>{
 const {store,p,db}=fixture();store.db.exec('CREATE TABLE gmail_accounts(candidate_id TEXT PRIMARY KEY,email TEXT,secret BLOB)');store.db.prepare('INSERT INTO gmail_accounts VALUES(?,?,?)').run(p.id,'test@example.com',Buffer.from('old-encrypted-secret'));
 const migrated=new BackgroundStore(store);assert.equal(migrated.task(p.id).mailbox,'test@example.com');assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='gmail_accounts'").get(),undefined);store.close();
});
test('background MCP never exposes application mutation or browser tools',async()=>{
 const {store,p}=fixture();const mcp=await startMcp(store,()=>{},async()=>({}),null,null,{tools:[{name:'mail_only',description:'Test',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}],call:()=>({ok:true})});const token=mcp.grant(p.id,'run');
 const call=async(method,params)=>{const r=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return r.json();};
 try{assert.deepEqual((await call('tools/list')).result.tools.map(t=>t.name),['mail_only']);assert.equal((await call('tools/call',{name:'record_submission',arguments:{}})).result.isError,true);assert.equal((await call('tools/call',{name:'mail_only',arguments:{}})).result.content[0].text,'{"ok":true}');}finally{await mcp.close();store.close();}
});
test('timeout terminates the worker and shutdown waits for an in-flight close',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {store,p,db}=fixture();let release,closed=false;const jobs=new BackgroundJobs(db,{launch:async()=>({close:()=>new Promise(resolve=>{release=()=>{closed=true;resolve();};})})});await jobs.start(p.id);t.mock.timers.tick(600000);const stopping=jobs.close();await new Promise(r=>setImmediate(r));assert.equal(closed,false);release();await stopping;assert.equal(closed,true);assert.equal(db.runs(p.id)[0].status,'timeout');assert.equal(jobs.active.size,0);store.close();
});
test('ambiguous mail mapping requires a job in the same candidate',()=>{
 const {store,p,other,db}=fixture();const job=store.addJob(p.id,{url:'https://example.com/job',company:'Example',role:'Engineer',location:'Berlin',fit:'Test'}).job,foreign=store.addJob(other.id,{url:'https://example.com/other-job',company:'Other',role:'Engineer',location:'Berlin',fit:'Test'}).job;
 const signal=db.record(p.id,'test@example.com',{id:'m1',threadId:'t1',date:new Date().toISOString(),subject:'Invitation'},{outcome:'unmatched',summary:'Role unclear'});assert.equal(signal.review,'pending');assert.throws(()=>db.resolve(p.id,signal.id,foreign.id,'interview'));assert.throws(()=>db.resolve(other.id,signal.id,foreign.id,'interview'));db.resolve(p.id,signal.id,job.id,'interview');assert.equal(db.signals(p.id)[0].review,'accepted');assert.equal(db.signals(p.id)[0].jobId,job.id);assert.equal(store.job(p.id,job.id).status,'found');store.close();
});

test('a custom skill inherits current profile settings and finishes without Gmail',async()=>{
 const {store,p,other,db}=fixture();db.save(p.id,{enabled:true,intervalMinutes:45,skillPath:'/tmp/custom/SKILL.md'});
 const changed=store.saveProfile({...p,agentSettings:{...p.agentSettings,model:'custom-model'}});
 assert.deepEqual(db.task(p.id).agentSettings,changed.agentSettings);assert.equal(db.task(p.id).timeoutMinutes,10);
 const run=db.begin(p.id);assert.equal(run.skillPath,'/tmp/custom/SKILL.md');let result;
 const flow=skillWorkflow(db,run,(...args)=>{result=args;return{saved:true};},new AbortController().signal);
 await assert.rejects(flow.call(other.id,run.id,'get_background_context',{}),/geçersiz/);
 assert.equal((await flow.call(p.id,run.id,'get_background_context',{})).profile.id,p.id);
 await flow.call(p.id,run.id,'finish_background_job',{summary:'Custom skill done'});
 assert.equal(result[2],'Custom skill done');assert.equal(db.signals(p.id).length,0);store.close();
});

test('background chat keeps its worker open and accepts follow-up messages after a blocked result',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {store,p,db}=fixture();let closes=0;const messages=[];
 const jobs=new BackgroundJobs(db,{launch:async()=>({close:async()=>{closes++;},message:async text=>messages.push(text)})});
 try{
  const old=db.begin(p.id);db.putRun({...old,status:'blocked',summary:'No connector'});
  const run=await jobs.message(p.id,'How do I connect?',old.id);assert.equal(run.interactive,true);assert.equal(run.previousRunId,old.id);
  jobs.complete(p.id,run.id,'Connection needed','blocked');jobs.event(p.id,{event:'state',state:'Working'});jobs.event(p.id,{event:'state',state:'Idle'});t.mock.timers.tick(600001);
  assert.equal(closes,0);assert.equal(jobs.active.size,1);await jobs.message(p.id,'I connected',run.id);assert.deepEqual(messages,['I connected']);
  await jobs.finish(p.id,'cancelled','Stopped');assert.equal(closes,1);
 }finally{await jobs.close();store.close();}
});
test('a message promotes an automatic task to interactive without closing it or crossing candidates',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {store,p,other,db}=fixture();let closes=0;
 const jobs=new BackgroundJobs(db,{launch:async()=>({close:async()=>{closes++;},message:async()=>{}})});
 try{const run=await jobs.start(p.id);jobs.complete(p.id,run.id,'Done');await jobs.message(p.id,'One more question',run.id);t.mock.timers.tick(600001);assert.equal(closes,0);await assert.rejects(jobs.message(other.id,'Wrong candidate',run.id),/adaya/);assert.equal(jobs.active.size,1);}finally{await jobs.close();store.close();}
});

test('background model override is independent, survives profile edits, and can return to inheritance',()=>{
 const {store,p,db}=fixture();try{
  const original=store.profile(p.id).agentSettings,override={provider:'claude',model:'opus',permission:'default',reasoning:'default',network:null,contextRestartPercent:0};
  db.putTask(p.id,{...db.task(p.id),connection:{status:'missing'},connectorAccess:{provider:'codex',appId:'old'}});
  db.save(p.id,{enabled:false,intervalMinutes:30,agentOverride:override});assert.deepEqual(db.task(p.id).agentSettings,override);assert.equal(db.task(p.id).connection,null);assert.equal(db.task(p.id).connectorAccess,null);assert.deepEqual(store.profile(p.id).agentSettings,original);
  store.saveProfile({...store.profile(p.id),agentSettings:{...original,model:'another-model'}});assert.deepEqual(db.begin(p.id).agentSettings,override);
  db.save(p.id,{enabled:false,intervalMinutes:45});assert.deepEqual(db.task(p.id).agentSettings,override);
  db.save(p.id,{enabled:false,intervalMinutes:45,agentOverride:null});assert.equal(db.task(p.id).agentSettings.model,'another-model');
 }finally{store.close();}
});

test('mail context exposes application evidence and retries pending matches without duplicates',async()=>{
 const {store,p,other,db}=fixture();
 try{
  const job=store.addJob(p.id,{url:'https://jobs.ashbyhq.com/example/role',company:'Example',role:'Engineer',location:'Berlin',fit:'Test'}).job;
  job.status='submitted';job.proof={kind:'success_page',url:job.url,text:'Application received',observedAt:'2026-09-25T10:00:00Z'};store.saveJob(job,'submission_recorded');
  const run=db.begin(p.id),flow=mailWorkflow(db,run,()=>({saved:true}),new AbortController().signal),call=(name,args={})=>flow.call(p.id,run.id,name,args);
  const evidence={messageId:'retry',threadId:'thread',subject:"We've Received Your Application",date:'2026-09-25T10:01:00Z',url:'https://mail.google.com/mail/u/0/#all/thread',evidence:'Thank you for applying',outcome:'unmatched',summary:'No company in email'};
  await call('report_mail_connection',{status:'ready',account:'test@example.com',connector:'gmail',message:'Verified'});
  const initial=await call('record_mail_outcome',evidence);
  db.record(p.id,'old@example.com',{id:'old-account',threadId:'other',date:evidence.date,subject:'Other'},{outcome:'unmatched',summary:'Other account'});
  db.record(other.id,'test@example.com',{id:'other-candidate',threadId:'other',date:evidence.date,subject:'Other'},{outcome:'unmatched',summary:'Other candidate'});
  const context=await call('get_mail_task');
  assert.deepEqual(context.applications[0].proof,job.proof);assert.equal(context.applications[0].createdAt,job.createdAt);
  assert.deepEqual(context.pendingSignals.map(s=>s.messageId),['retry']);assert.equal(context.pendingSignals[0].evidence,evidence.evidence);
  assert.equal(context.previousSignals[0].review,'pending');
  assert.equal((await call('is_mail_processed',{messageId:'retry'})).processed,false);
  const repeated=await call('record_mail_outcome',evidence);assert.equal(repeated.id,initial.id);
  const resolved=await call('record_mail_outcome',{...evidence,jobId:job.id,outcome:'confirmation',summary:'Gönderimden bir dakika sonraki Ashby onayı; zaman ve ATS üzerinden eşleştirildi.'});
  assert.equal(resolved.id,initial.id);assert.equal(resolved.createdAt,initial.createdAt);assert.equal(resolved.review,'accepted');assert.equal(resolved.jobId,job.id);
  assert.equal((await call('get_mail_task')).pendingSignals.length,0);
  assert.equal((await call('is_mail_processed',{messageId:'retry'})).processed,true);
  assert.equal((await call('record_mail_outcome',evidence)).duplicate,true);
  assert.equal(db.signals(p.id).filter(s=>s.messageId==='retry').length,1);
  const dismissed=await call('record_mail_outcome',{...evidence,messageId:'dismissed'});db.dismiss(p.id,dismissed.id);
  assert.equal((await call('is_mail_processed',{messageId:'dismissed'})).processed,true);
  assert.equal((await call('record_mail_outcome',{...evidence,messageId:'dismissed',jobId:job.id,outcome:'confirmation'})).duplicate,true);
  assert.equal((await call('get_mail_task')).pendingSignals.length,0);
 }finally{store.close();}
});
