import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Setups,IMPROVE_PROMPT} from '../app/setup.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {startMcp} from '../app/mcp.mjs';

test('profile improvement reuses setup, waits only for its own questions and preserves candidate settings',async()=>{
 const store=new Store(':memory:'),calls=[];let active=null;
 try{
  const p=store.saveProfile({name:'Deniz',preferences:'Berlin hybrid',facts:'Backend engineer',authorization:'submit'});
  const source=store.sources(p.id)[0];store.saveSource(p.id,{...source,enabled:false,applyMode:'prepare'},{silent:true});
  const sources=store.sources(p.id);
  const job=store.addJob(p.id,{company:'Employer',role:'Engineer',location:'Berlin',fit:'Backend',url:'https://example.com/job'}).job;
  const old=store.ask(p.id,{question:'What would you like to improve?'});
  const applicationQuestion=store.ask(p.id,{jobId:job.id,question:'Please sign in'});
  const setup=new Setups(store,{active:()=>active,changed:()=>{},launch:async(id,prompt)=>{calls.push(prompt);active={candidateId:id,state:'Working'};},send:async prompt=>calls.push(prompt)});
  store.beginProfileImprovement(p.id);await setup.begin(p.id);
  assert.equal(calls.length,1);assert.ok(calls[0].startsWith(IMPROVE_PROMPT));assert.match(calls[0],/just opened/);
  assert.throws(()=>store.beginProfileImprovement(p.id),/tamamla/);
  const q=store.ask(p.id,{question:old.question});assert.notEqual(q.id,old.id);
  assert.deepEqual(store.setupQuestions(p.id).map(q=>q.id),[q.id]);
  assert.throws(()=>store.updateSetupProfile(p.id,{stage:'review',message:'Ready'}),/sorular/);
  active.state='Idle';setup.answered(p.id);await setup.tick();assert.equal(calls.length,1);
  store.answer(p.id,q.id,'Remote backend roles');setup.answered(p.id);await setup.tick();await setup.tick();assert.equal(calls.length,2);
  assert.equal(calls[1],IMPROVE_PROMPT);
  store.updateSetupProfile(p.id,{stage:'review',message:'Preferences updated',preferences:'Remote backend roles',authorization:'research'});
  assert.equal(store.profile(p.id).authorization,'submit');
  const campaign=new Campaigns(store,{active:()=>active,changed:()=>{},launch:async()=>assert.fail('must not launch')});
  await assert.rejects(()=>campaign.start(p.id),/setup/);
  await setup.begin(p.id);assert.match(calls.at(-1),/returned from review/);
  store.updateSetupProfile(p.id,{stage:'review',message:'Ready'});
  store.completeSetup(p.id,{...store.profile(p.id)});
  assert.equal(store.setup(p.id).status,'complete');assert.equal(store.profile(p.id).preferences,'Remote backend roles');
  assert.deepEqual(store.profile(p.id).agentSettings,p.agentSettings);
  assert.equal(store.profile(p.id).authorization,'submit');assert.equal(store.jobs(p.id).length,1);
  assert.deepEqual(store.sources(p.id),sources);
  for(const id of [old.id,applicationQuestion.id])assert.equal(store.questions(p.id).find(q=>q.id===id).answer,null);
 }finally{store.close();}
});

test('leaving improvement keeps saved changes and closes only unanswered questions from this session',()=>{
 const store=new Store(':memory:');try{
  const p=store.saveProfile({name:'Deniz',preferences:'Remote',facts:'',authorization:'prepare'});
  const old=store.ask(p.id,{question:'Earlier pending question'});store.beginProfileImprovement(p.id);
  const answered=store.ask(p.id,{question:'Target role?'});store.answer(p.id,answered.id,'Backend');
  const pending=store.ask(p.id,{question:'Anything else?'});
  store.updateSetupProfile(p.id,{stage:'preferences',message:'Saved',preferences:'Remote backend'});
  store.finishProfileImprovement(p.id);
  assert.equal(store.profile(p.id).preferences,'Remote backend');assert.equal(store.setup(p.id).needsTurn,false);
  assert.equal(store.setup(p.id).status,'complete');
  assert.ok(store.questions(p.id).some(q=>q.id===old.id));assert.ok(store.questions(p.id).some(q=>q.id===answered.id));
  assert.ok(!store.questions(p.id).some(q=>q.id===pending.id));
  store.beginProfileImprovement(p.id);assert.deepEqual(store.setupQuestions(p.id),[]);
  store.updateSetupProfile(p.id,{stage:'review',message:'No extra facts needed'});
  store.completeSetup(p.id,{...store.profile(p.id)});assert.equal(store.profile(p.id).facts,'');
 }finally{store.close();}
});

test('improvement launch failures remain retryable; pending onboarding cannot be replaced',async()=>{
 const store=new Store(':memory:');try{
  const p=store.createSetup({provider:'codex',model:'default',permission:'default',reasoning:'default',network:null});
  assert.throws(()=>store.beginProfileImprovement(p.id),/tamamla/);
  store.saveSetup(p.id,{status:'complete'});store.beginProfileImprovement(p.id);
  const setup=new Setups(store,{active:()=>null,changed:()=>{},launch:async()=>{throw Error('Provider unavailable');}});
  await setup.begin(p.id);assert.equal(store.setup(p.id).error,'Provider unavailable');assert.equal(store.setup(p.id).needsTurn,false);
  store.finishProfileImprovement(p.id);assert.equal(store.setup(p.id).status,'complete');
 }finally{store.close();}
});

test('MCP edits the current candidate during improvement and rejects application work',async()=>{
 const store=new Store(':memory:'),p=store.saveProfile({name:'Deniz',preferences:'Remote',facts:'Backend',authorization:'submit'}),other=store.saveProfile({name:'Other',preferences:'Onsite'});
 store.beginProfileImprovement(p.id);
 const server=await startMcp(store),token=server.grant(p.id,'improve-session');
 const call=async(name,args={})=>{const response=await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return(await response.json()).result;};
 try{
  const context=await call('get_task_context');assert.equal(JSON.parse(context.content[0].text).setup.mode,'improve');
  assert.equal((await call('update_setup_profile',{stage:'review',message:'Saved',preferences:'Germany remote',facts:'Backend; English C1'})).isError,undefined);
  assert.equal(store.profile(p.id).preferences,'Germany remote');assert.equal(store.profile(other.id).preferences,'Onsite');assert.equal(store.profile(p.id).authorization,'submit');
  assert.equal((await call('add_job',{company:'Employer',role:'Engineer',location:'Berlin',fit:'Backend',url:'https://example.com/job'})).isError,true);
  store.saveSetup(p.id,{...store.setup(p.id),status:'running'});
  assert.equal((await call('update_setup_profile',{stage:'review',message:'Facts cleared at candidate request',facts:''})).isError,undefined);assert.equal(store.profile(p.id).facts,'');
  store.completeSetup(p.id,{...store.profile(p.id)});
  assert.equal((await call('update_setup_profile',{stage:'preferences',message:'Late update',preferences:'Old value'})).isError,true);
 }finally{await server.close();store.close();}
});
