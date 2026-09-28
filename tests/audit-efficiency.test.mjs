import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {startMcp,validate,tools} from '../app/mcp.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';
import {questionKnowledge,validateQuestionReview} from '../app/question-gate.mjs';
import {addRankedJob} from './rank-fixture.mjs';

const listing=i=>({company:`Employer ${i}`,role:'Engineer',location:'Remote',fit:'Profile matches',url:`https://example.test/job/${i}`});
const checkpoint={browser:'Jev Chrome',tabId:'owned',url:'https://example.test/form',step:'Required details',nextAction:'Fill saved answers'};
const fixture=()=>{const store=new Store(':memory:');return {store,p:store.saveProfile({name:'Test',preferences:'Remote',authorization:'submit'})};};
const rpc=(server,token,name,args={})=>fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}).then(r=>r.json()).then(r=>r.result);

test('application history is paginated, scoped and never exposes full event/profile payloads',()=>{
 const {store,p}=fixture();try{
  for(let i=0;i<27;i++)store.addJob(p.id,listing(i));
  const job=store.jobs(p.id)[0];store.ask(p.id,{jobId:job.id,question:'Private required detail'});
  store.event(p.id,'large',{secret:'Unrelated event payload'.repeat(20000)});
  const first=store.applicationHistory(p.id);assert.equal(first.jobs.length,20);assert.equal(first.total,27);assert.equal(first.nextOffset,20);
  const last=store.applicationHistory(p.id,{offset:first.nextOffset});assert.equal(last.jobs.length,7);assert.equal(last.nextOffset,null);
  assert.equal(new Set([...first.jobs,...last.jobs].map(j=>j.id)).size,27);
  assert.ok(JSON.stringify(first).length<12000);assert.equal(first.events,undefined);assert.equal(first.profile,undefined);assert.equal(first.questions,undefined);
  const detail=store.applicationHistory(p.id,{jobId:job.id});assert.equal(detail.job.id,job.id);assert.equal(detail.questions.length,1);
  const other=store.saveProfile({name:'Other',preferences:'Remote'});assert.throws(()=>store.applicationHistory(other.id,{jobId:job.id}));
  assert.equal(store.applicationHistory(p.id,{company:'EMPLOYER 26',status:'found'}).total,1);
 }finally{store.close();}
});

test('assigned task context excludes other drafts and ranking excludes pending form questions',()=>{
 const {store,p}=fixture();try{
  const jobs=[0,1].map(i=>store.addJob(p.id,listing(i)).job);
  for(const job of jobs){store.saveApplicationCheckpoint(p.id,job.id,{...checkpoint,tabId:job.id},'s');store.ask(p.id,{jobId:job.id,question:'Missing date'});}
  store.saveCampaign(p.id,{status:'running',task:{id:'t',kind:'application',jobId:jobs[0].id}});
  assert.deepEqual(store.taskContext(p.id).unfinishedTabs.map(j=>j.jobId),[jobs[0].id]);
  store.saveCampaign(p.id,{status:'running',task:{id:'t',kind:'rank',jobId:jobs[0].id}});
  const context=store.taskContext(p.id);assert.deepEqual(context.unfinishedTabs,[]);assert.deepEqual(context.questions,[]);assert.equal(context.browserResume,null);
  // Legacy native tabs still need turn-scoped retention, but no form prose.
  store.saveApplicationCheckpoint(p.id,jobs[1].id,{...checkpoint,browser:'Chrome profile Test (Default)',step:'Private long form details'},'s');
  const retained=store.taskContext(p.id).unfinishedTabs;assert.equal(retained.length,1);assert.equal(retained[0].resumeContext.tabId,'owned');assert.equal(retained[0].resumeContext.step,undefined);
 }finally{store.close();}
});

test('rank browser_wait preserves the task without spending recovery attempts, then resumes once',async()=>{
 const {store,p}=fixture();let server;try{
  const job=store.addJob(p.id,listing(0)).job;
  store.saveCampaign(p.id,{status:'running',target:100,task:{id:'rank-task',kind:'rank',jobId:job.id,seenWorking:true},attempts:{}});
  let ready=false,sends=0,state='Working';
  const c=new Campaigns(store,{active:()=>({sessionId:'s',state}),changed:()=>{},browserReady:()=>({ready}),send:async prompt=>{sends++;assert.doesNotMatch(prompt,/with resume_application/);}});
  // Unrequested background connection changes must not block pure ranking.
  c.waitForBrowser(p.id);assert.equal(store.campaign(p.id).browserWait,undefined);
  const browser={call:async()=>({content:[{type:'text',text:JSON.stringify({status:'browser_wait'})}]})};
  server=await startMcp(store,()=>{},undefined,browser,c);const token=server.grant(p.id,'s');
  for(let i=0;i<5;i++){
   await rpc(server,token,'browser_jev_tabs');c.signal(p.id,'Idle');c.exited(p.id);
   assert.equal(store.campaign(p.id).status,'running');assert.equal(store.campaign(p.id).task.recoveryAttempts,undefined);
  }
  state='Idle';await c.resumeTurn(p.id,store.campaign(p.id));assert.equal(sends,0);
  ready=true;await c.resumeTurn(p.id,store.campaign(p.id));await c.resumeTurn(p.id,store.campaign(p.id));assert.equal(sends,1);
  assert.equal(store.campaign(p.id).task.id,'rank-task');assert.equal(store.campaign(p.id).browserWait,undefined);
 }finally{await server?.close();store.close();}
});

test('rank mutation tools are rejected before reaching any browser or changing application data',async()=>{
 const {store,p}=fixture();let server;try{
  const job=store.addJob(p.id,listing(0)).job;store.saveCampaign(p.id,{status:'running',task:{id:'r',kind:'rank',jobId:job.id}});
  let called=0;server=await startMcp(store,()=>{},undefined,{call:async()=>{called++;return {content:[]};}});const token=server.grant(p.id,'s');
  for(const name of ['update_application','record_submission','ask_candidate','browser_jev_fill_fields','browser_jev_upload','browser_jev_autocomplete','browser_fill_form'])assert.equal((await rpc(server,token,name,{})).isError,true,name);
  assert.equal(called,0);assert.equal(store.job(p.id,job.id).status,'found');assert.equal(store.questions(p.id).length,0);
  assert.notEqual((await rpc(server,token,'browser_jev_observe',{tabId:'research'})).isError,true);assert.equal(called,1);
 }finally{await server?.close();store.close();}
});

test('a required-fact question commits checkpoint, blocked status and task report in one MCP call',async()=>{
 const {store,p}=fixture();let server;try{
  const job=addRankedJob(store,p.id,listing(0)).job;
  store.saveCampaign(p.id,{status:'running',target:100,task:{id:'application',kind:'application',jobId:job.id},attempts:{}});
  const c=new Campaigns(store,{active:()=>({sessionId:'s',state:'Working'}),changed:()=>{}});
  server=await startMcp(store,()=>{},undefined,null,{get:id=>store.campaign(id),askApplicationQuestion:(...args)=>c.askApplicationQuestion(...args)});const token=server.grant(p.id,'s');await rpc(server,token,'get_task_context');
  const input={jobId:job.id,question:'Zorunlu maaş beklentin?',resumeContext:checkpoint,applicationBlocker:{kind:'required_form_field',evidence:'Salary *',reasonUnknown:'No saved salary',review:{cvChecked:'No CV supplied',missingFacts:[{key:'salary_expectation',gap:'Required salary absent'}]}}};
  const response=await rpc(server,token,'ask_candidate',input);assert.ok(!response.isError,JSON.stringify(response));const result=JSON.parse(response.content[0].text);
  assert.equal(result.completion.taskReported,true);assert.equal(store.job(p.id,job.id).status,'blocked');assert.equal(store.job(p.id,job.id).resumeContext.tabId,checkpoint.tabId);assert.equal(store.campaign(p.id).task.report.outcome,'blocked');
  const again=await rpc(server,token,'ask_candidate',input);assert.ok(!again.isError);assert.equal(store.questions(p.id).length,1);
  c.signal(p.id,'Idle');assert.equal(store.campaign(p.id).task,null);
 }finally{await server?.close();store.close();}
});

test('required-fact question failure rolls back its checkpoint and question too',()=>{
 const {store,p}=fixture();try{
  const job=addRankedJob(store,p.id,listing(0)).job;store.updateJob(p.id,job.id,'working','Form','s');
  store.saveCampaign(p.id,{status:'running',task:{id:'t',kind:'application',jobId:job.id}});
  const c=new Campaigns(store,{active:()=>({sessionId:'s'}),changed:()=>{}});
  const beforeCheckpoint=store.job(p.id,job.id).resumeContext;
  store.updateJob=()=>{throw Error('Write failure');};
  assert.throws(()=>c.askApplicationQuestion(p.id,'s',{jobId:job.id,question:'Required date',resumeContext:checkpoint,applicationBlocker:{kind:'required_form_field'}}),/Write failure/);
  assert.equal(store.questions(p.id).length,0);assert.equal(store.job(p.id,job.id).resumeContext,undefined);assert.equal(store.campaign(p.id).task.report,undefined);
 }finally{store.close();}
});

test('question review reports all known facts at once and schema failures identify the exact path',()=>{
 const profile={learnedFacts:{notice_period:{value:'2 months'},work_preferences:{value:'Germany or Turkey'}},facts:'',preferences:'',cvPath:null};
 const store={profile:()=>profile,reusableAnswers:()=>[],questions:()=>[]};
 const input={applicationBlocker:{kind:'required_form_field',review:{cvChecked:'CV checked',missingFacts:[{key:'notice_period',gap:'start date'},{key:'work_preferences',gap:'timezone'}]}}};
 assert.throws(()=>validateQuestionReview(store,'c',input,questionKnowledge(store,'c')),e=>e.message.includes('notice_period')&&e.message.includes('work_preferences'));
 assert.throws(()=>validate(tools.find(t=>t.name==='report_campaign_work').inputSchema,{taskId:'t',outcome:'blocked',note:'Needs answer',blocker:{kind:'technical',requiresUserInput:false,evidence:'',reason:''}}),/arguments.blocker.evidence/);
});

test('post-action settling retries reads only and preserves failures unrelated to navigation',async()=>{
 let reads=0;const slot={page:{isClosed:()=>false}};
 const fake={observe:async()=>{if(++reads<3)throw Error('Execution context was destroyed');return {status:'ready'};}};
 assert.deepEqual(await JevBrowser.prototype.observeAfterAction.call(fake,slot),{status:'ready'});assert.equal(reads,3);
 reads=0;fake.observe=async()=>{reads++;throw Error('Chrome disconnected');};
 await assert.rejects(()=>JevBrowser.prototype.observeAfterAction.call(fake,slot),/disconnected/);assert.equal(reads,1);
});
