import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
import {WorkerCampaigns} from '../app/worker-campaigns.mjs';
import {workerKey} from '../app/worker-state.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';
import {startMcp} from '../app/mcp.mjs';
import {addRankedJob} from './rank-fixture.mjs';

function fixture(file=':memory:'){
  const store=new Store(file),p=store.saveProfile({name:'Parallel candidate',preferences:'Remote backend',authorization:'submit'}),sessions=new Map(),launches=[];
  for(const source of store.sources(p.id))store.saveSource(p.id,{...source,enabled:false});
  let serial=0;
  const pool=new WorkerCampaigns(store,{changed:()=>{},active:(id,w)=>sessions.get(workerKey(id,w)),launch:async(id,prompt,job,worker)=>{const session={candidateId:id,workerId:worker,sessionId:`session-${++serial}`,state:'Working'};sessions.set(workerKey(id,worker),session);launches.push({id,prompt,job,worker});},send:async()=>{},stop:async(id,w)=>{const key=workerKey(id,w),session=sessions.get(key);if(session)store.recoverSession(id,session.sessionId);sessions.delete(key);}});
  const job=n=>addRankedJob(store,p.id,{url:`https://example.test/jobs/${n}`,company:`Company ${n}`,role:`Backend ${n}`,location:'Remote',fit:'Backend work'}).job;
  return{store,p,pool,sessions,launches,job};
}

test('same candidate dispatches distinct jobs, pauses one worker and retains the other',async()=>{
  const f=fixture();try{
    const jobs=[f.job(1),f.job(2)],w=f.store.workerState.add(f.p.id);
    await f.pool.start(f.p.id);
    const tasks=f.store.workerState.tasks(f.p.id);
    assert.equal(tasks.length,2);assert.equal(new Set(tasks.map(t=>t.task.jobId)).size,2);assert.deepEqual(new Set(tasks.map(t=>t.task.jobId)),new Set(jobs.map(j=>j.id)));
    assert.equal(f.sessions.size,2);
    const kept=f.store.forWorker(w.id).campaign(f.p.id).task.id;
    await f.pool.forWorker().pause(f.p.id);
    assert.equal(f.sessions.size,1);assert.equal(f.store.forWorker(w.id).campaign(f.p.id).task.id,kept);
    assert.equal(f.pool.summary(f.p.id).status,'running');
    await f.pool.pause(f.p.id);assert.equal(f.sessions.size,0);
  }finally{f.store.close();}
});

test('concurrent dispatch claims before an asynchronous provider launch',async()=>{
  const f=fixture();try{
    f.job(1);f.job(2);const w=f.store.workerState.add(f.p.id);let release;
    const primary=f.pool.forWorker(),launch=primary.launch;
    primary.launch=async(...args)=>{await new Promise(resolve=>{release=resolve;});await launch(...args);};
    const first=primary.start(f.p.id);while(!release)await new Promise(r=>setImmediate(r));
    await f.pool.startWorker(f.p.id,w.id);
    assert.equal(new Set(f.store.workerState.tasks(f.p.id).map(w=>w.task.jobId)).size,2);
    release();await first;
  }finally{f.store.close();}
});

test('parallel searches reserve separate sources and discovery rows until search completes',async()=>{
  const f=fixture();try{
    const sources=f.store.sources(f.p.id).slice(0,2);for(const source of sources)f.store.saveSource(f.p.id,{...source,enabled:true});
    const w=f.store.workerState.add(f.p.id);await f.pool.start(f.p.id);
    const a=f.store.campaign(f.p.id),b=f.store.forWorker(w.id).campaign(f.p.id);assert.notEqual(a.task.sourceId,b.task.sourceId);
    const added=f.store.addJob(f.p.id,{url:'https://example.test/new',company:'New',role:'Backend',location:'Remote',fit:'New listing',sourceId:a.task.sourceId}).job;
    assert.equal(added.discoveryTaskId,a.task.id);
    assert.notEqual(f.pool.forWorker(w.id).choose(f.p.id,{...b,task:null})?.jobId,added.id);
    const session=f.sessions.get(f.p.id);f.pool.forWorker().signal(f.p.id,'Working');f.pool.forWorker().report(f.p.id,session.sessionId,{taskId:a.task.id,outcome:'done',note:'Search finished'});f.pool.forWorker().signal(f.p.id,'Idle');
    assert.equal(f.pool.forWorker(w.id).choose(f.p.id,{...f.store.forWorker(w.id).campaign(f.p.id),task:null}).jobId,added.id);
  }finally{f.store.close();}
});

test('shared target cap prevents a second automatic submission assignment',async()=>{
  const f=fixture();try{
    f.job(1);f.job(2);const w=f.store.workerState.add(f.p.id);await f.pool.start(f.p.id,{target:1});
    assert.equal(f.store.workerState.tasks(f.p.id).filter(w=>w.task.kind==='application').length,1);
    assert.equal(f.store.forWorker(w.id).campaign(f.p.id).task,null);
  }finally{f.store.close();}
});

test('every worker can take application, ranking and search tasks',()=>{
  const f=fixture();try{
    const job=f.job(1),unranked=f.store.addJob(f.p.id,{url:'https://example.test/unranked',company:'New company',role:'Backend',location:'Remote',fit:'Test'}).job;
    const workers=[...f.store.workers(f.p.id),f.store.workerState.add(f.p.id,{role:'search'}),f.store.workerState.add(f.p.id,{role:'application'})];
    for(const worker of workers)assert.equal(f.pool.forWorker(worker.id).choose(f.p.id,{attempts:{},target:100}).kind,'application');
    f.store.saveJob({...job,status:'skipped'},'test');
    for(const worker of workers)assert.equal(f.pool.forWorker(worker.id).choose(f.p.id,{attempts:{},target:100}).kind,'rank');
    f.store.saveJob({...unranked,status:'skipped'},'test');
    f.store.saveSource(f.p.id,{...f.store.sources(f.p.id)[0],enabled:true});
    for(const worker of workers)assert.equal(f.pool.forWorker(worker.id).choose(f.p.id,{attempts:{},target:100}).kind,'search');
  }finally{f.store.close();}
});

test('shared queue merges independent edits and removals from stale worker reads',()=>{
  const f=fixture();try{
    const w=f.store.workerState.add(f.p.id),other=f.store.forWorker(w.id);
    f.store.saveCampaign(f.p.id,{status:'running',attempts:{old:1},pendingRetries:{old:{requestId:'old'}}});other.saveCampaign(f.p.id,{status:'running',attempts:{}});
    const a=f.store.campaign(f.p.id),b=other.campaign(f.p.id);
    a.pendingRetries.first={requestId:'one'};f.store.saveCampaign(f.p.id,a);
    b.pendingRetries.second={requestId:'two'};delete b.pendingRetries.old;other.saveCampaign(f.p.id,b);
    assert.deepEqual(Object.keys(f.store.campaign(f.p.id).pendingRetries).sort(),['first','second']);
    const latest=other.campaign(f.p.id);delete latest.pendingRetries.second;other.saveCampaign(f.p.id,latest);
    assert.deepEqual(Object.keys(f.store.campaign(f.p.id).pendingRetries),['first']);
  }finally{f.store.close();}
});

test('worker history, task reviews and reservations survive reopening and stay candidate scoped',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'jobloop-workers-')),file=path.join(dir,'db');const f=fixture(file);let reopened;
  try{
    const w=f.store.workerState.add(f.p.id),other=f.store.forWorker(w.id),job=f.job(1);
    f.store.db.prepare('UPDATE agent_workers SET data=? WHERE id=?').run(JSON.stringify({...w,role:'search'}),w.id);
    f.store.saveConversation(f.p.id,'codex','primary-thread',{});other.saveConversation(f.p.id,'codex','other-thread',{});
    f.store.saveTaskReview(f.p.id,'one','primary review');other.saveTaskReview(f.p.id,'two','other review');
    other.saveCampaign(f.p.id,{status:'running',task:{id:'task-two',kind:'application',jobId:job.id},attempts:{}});
    assert.throws(()=>f.store.saveCampaign(f.p.id,{status:'running',task:{id:'task-one',jobId:job.id}}),/başka bir worker/);
    const outsider=f.store.saveProfile({name:'Other candidate',preferences:'Remote'});assert.throws(()=>f.store.workerState.get(outsider.id,w.id),/adaya ait/);
    f.store.close();reopened=new Store(file);const scoped=reopened.forWorker(w.id);
    assert.equal(reopened.workerState.get(f.p.id,w.id).role,undefined);
    assert.equal(JSON.parse(reopened.db.prepare('SELECT data FROM agent_workers WHERE id=?').get(w.id).data).role,undefined);
    assert.equal(reopened.workers(f.p.id).length,2);assert.equal(reopened.conversation(f.p.id,'codex'),'primary-thread');assert.equal(scoped.conversation(f.p.id,'codex'),'other-thread');
    assert.equal(scoped.taskReview(f.p.id,'two'),'other review');assert.equal(reopened.taskReview(f.p.id,'one'),'primary review');assert.equal(scoped.taskReview(f.p.id,'one'),undefined);
    assert.equal(reopened.workerState.tasks(f.p.id)[0].task.id,'task-two');
    reopened.deleteWorkspace(f.p.id);assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM worker_state WHERE candidate_id=?').get(f.p.id).n,0);
  }finally{(reopened??f.store).close();rmSync(dir,{recursive:true,force:true});}
});

test('MCP tokens see only their worker task and cannot alter another worker job',async()=>{
  const f=fixture();let mcp;
  try{
    f.job(1);f.job(2);const w=f.store.workerState.add(f.p.id);await f.pool.start(f.p.id);
    mcp=await startMcp(f.store,()=>{},undefined,null,null,null,({workerId})=>{const store=f.store.forWorker(workerId),c=f.pool.forWorker(workerId);return{store,browser:null,campaigns:{get:id=>store.campaign(id),report:c.report.bind(c)}};});
    const session=f.sessions.get(workerKey(f.p.id,w.id)),token=mcp.grant(f.p.id,session.sessionId,w.id);
    const call=async(name,args={})=>(await(await fetch(mcp.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json()).result;
    const context=JSON.parse((await call('get_task_context')).content[0].text);assert.equal(context.campaign.task.id,f.store.forWorker(w.id).campaign(f.p.id).task.id);
    const wrong=f.store.campaign(f.p.id).task.jobId;
    assert.equal((await call('update_application',{jobId:wrong,status:'working',note:'Wrong worker'})).isError,true);
    const right=f.store.forWorker(w.id).campaign(f.p.id).task.jobId;
    assert.notEqual((await call('update_application',{jobId:right,status:'working',note:'Assigned job'})).isError,true);
    assert.equal(f.store.job(f.p.id,right).sessionId,session.sessionId);assert.equal(f.store.job(f.p.id,wrong).status,'found');
    f.store.saveTaskReview(f.p.id,'primary-task','primary');assert.ok(f.store.forWorker(w.id).taskReview(f.p.id,context.campaign.task.id));
  }finally{await mcp?.close();f.store.close();}
});

test('Jev filters other workers tabs and refuses cross-worker observations',async()=>{
  const browser=new JevBrowser('/unused',{connection:'test'});
  browser.context=async()=>({});browser.reconcileJobs=async()=>{};browser.homeId='home';
  for(const id of ['home','a','b','search','old-source'])browser.tabs.set(id,{id,page:{url:()=>`https://example.test/${id}`,isClosed:()=>false}});
  browser.tabJobs.set('a','job-a');browser.tabJobs.set('b','job-b');browser.tabSearches.set('search','search-b');browser.tabSearches.set('old-source','old');
  const state={multiWorker:true,taskKind:'application',activeJobId:'job-a',activeSearchTaskIds:['search-b']};
  const result=JSON.parse((await browser.callTool({name:'browser_jev_tabs',arguments:{}},'session-a',state)).content[0].text);
  assert.deepEqual(result.tabs.map(t=>t.tabId),['a']);
  await assert.rejects(browser.callTool({name:'browser_jev_observe',arguments:{tabId:'b'}},'session-a',state),/başka bir worker/);
  const search={multiWorker:true,taskKind:'search',activeSearchTaskId:'new-search',activeSourceTabId:'old-source',activeSearchTaskIds:['search-b','new-search']};
  const restored=JSON.parse((await browser.callTool({name:'browser_jev_tabs',arguments:{}},'new-session',search)).content[0].text);
  assert.deepEqual(restored.tabs.map(t=>t.tabId),['old-source']);
  browser.observe=async()=>({browser:'Jev Chrome',tabId:'old-source',url:'https://example.test/old-source'});
  await browser.callTool({name:'browser_jev_observe',arguments:{tabId:'old-source'}},'new-session',search);
  assert.equal(browser.tabSearches.get('old-source'),'new-search');
});

test('browser calls serialize shared Chrome and discard queued calls from a stopped worker',async()=>{
  const browser=new BrowserTools('/unused'),calls=[];let release,live=true;
  browser.performCall=async(id,name)=>{calls.push(name);if(name==='first')await new Promise(r=>{release=r;});return name;};
  const a=browser.forWorker('main'),b=browser.forWorker('second',()=>live),first=a.call('candidate','first',{});
  while(!release)await new Promise(r=>setImmediate(r));
  const next=b.call('candidate','second',{});assert.deepEqual(calls,['first']);live=false;release();
  await first;await assert.rejects(next,/oturumu kapandı/);assert.deepEqual(calls,['first']);await browser.close();
});

test('stop during group startup prevents later workers from launching',async()=>{
  const f=fixture();try{
    f.job(1);f.job(2);const w=f.store.workerState.add(f.p.id);let release;
    const primary=f.pool.forWorker(),launch=primary.launch;
    primary.launch=async(...args)=>{await new Promise(resolve=>{release=resolve;});await launch(...args);};
    const starting=f.pool.start(f.p.id);while(!release)await new Promise(r=>setImmediate(r));
    await f.pool.pause(f.p.id);release();await starting;await f.pool.tick();
    assert.equal(f.sessions.size,0);assert.equal(f.store.campaign(f.p.id).status,'paused');
    assert.equal(f.store.forWorker(w.id).campaign(f.p.id),null);assert.equal(f.store.workerState.tasks(f.p.id).length,0);
  }finally{f.store.close();}
});

for(const outcome of ['manual_submitted','already_submitted'])test(`submission limit is rechecked if ${outcome} consumes a reserved slot`,async()=>{
  const f=fixture();try{
    const a=f.job(1),b=f.job(2);await f.pool.start(f.p.id,{target:1});
    const job=f.store.campaign(f.p.id).task.jobId,session=f.sessions.get(f.p.id).sessionId;
    f.store.updateJob(f.p.id,job,'working','Form opened',session);f.store.updateJob(f.p.id,job,'prepared','Ready',session);
    f.store.setManualJobStatus(f.p.id,job===a.id?b.id:a.id,outcome);
    assert.throws(()=>f.store.updateJob(f.p.id,job,'submitting','Send',session),/Ortak başvuru limiti/);assert.equal(f.store.job(f.p.id,job).status,'prepared');
  }finally{f.store.close();}
});

test('separate Chrome drafts remain with their worker across pause and cannot be orphaned by removal',async()=>{
  const f=fixture();try{
    f.store.saveProfile({...f.p,browserMode:'separate'});const job=f.job(1),w=f.store.workerState.add(f.p.id);
    await f.pool.startWorker(f.p.id,w.id);const scoped=f.store.forWorker(w.id),session=f.sessions.get(workerKey(f.p.id,w.id));
    scoped.updateJob(f.p.id,job.id,'working','Form opened',session.sessionId);
    await f.pool.stopWorker(f.p.id,w.id);
    assert.equal(f.pool.forWorker().choose(f.p.id,{attempts:{},target:100}),null);
    await assert.rejects(f.pool.remove(f.p.id,w.id),/yarım kalan başvurular/);
    await f.pool.startWorker(f.p.id,w.id);assert.equal(scoped.campaign(f.p.id).task.jobId,job.id);
  }finally{f.store.close();}
});

test('legacy separate Chrome drafts stay in the original main profile',()=>{
  const f=fixture();try{
    f.store.saveProfile({...f.p,browserMode:'separate'});const job=f.job(1),w=f.store.workerState.add(f.p.id);
    f.store.saveJob({...job,status:'prepared',resumeContext:{browser:'Playwright',tabId:'legacy'}},'test');
    assert.equal(f.pool.forWorker(w.id).choose(f.p.id,{attempts:{},target:100}),null);
    assert.equal(f.pool.forWorker().choose(f.p.id,{attempts:{},target:100}).jobId,job.id);
  }finally{f.store.close();}
});
