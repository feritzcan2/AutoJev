import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {actionSpace,chooseJev,jevConfig,validateChoice} from '../app/jev-policy.mjs';
import {validateJevArgs} from '../app/jev-browser.mjs';
import {browserProfileInstruction} from '../app/prompts.mjs';
import {Store} from '../app/store.mjs';
import {seedJevDemo,startJevFixture} from '../scripts/jev-demo.mjs';
const page={url:'https://fixture.example',title:'Jobs',text:'Synthetic jobs',actions:[
  {id:'e1',node:1,kind:'fill',role:'textbox',label:'Keywords',value:''},
  {id:'e2',node:1,kind:'click',role:'textbox',label:'Open Keywords',value:''},
  {id:'e3',node:2,kind:'select',role:'combobox',label:'Location → Remote',value:'remote',current_value:'All'},
  {id:'wait',kind:'wait',label:'Wait'}
]};
const answer=choice=>({choice,confidence:1,probabilities:{[choice]:1}});
test('operation-specific heads use shared observed node indices',()=>{
  const space=actionSpace(page.actions);assert.equal(space.elements.length,2);
  assert.equal(space.targets.TYPE_TEXT['1'].id,'e1');assert.equal(space.targets.CLICK['1'].id,'e2');assert.equal(space.targets.SELECT['2:1'].value,'remote');
});
test('invalid model choices and probabilities cannot reach the executor',()=>{
  for(const bad of [answer('evil'),{choice:'CLICK',confidence:1,probabilities:{CLICK:.3}},{choice:'CLICK',confidence:NaN,probabilities:{CLICK:1}},{choice:'CLICK',confidence:1,probabilities:{CLICK:1,EXTRA:0}}])assert.throws(()=>validateChoice(bad,{CLICK:'click'}));
});
test('Jev calls only TypeSafe and returns a text request, never calls a text provider',async()=>{
  let count=0;
  const result=await chooseJev(page,'Search Python',[],{apiKey:'synthetic-test-key',fetchImpl:async(url,options)=>{
    count++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');
    const body=JSON.parse(options.body),probabilities=Object.fromEntries(Object.keys(body.questions.operation.criteria).map(key=>[key,key==='TYPE_TEXT'?1:0]));
    assert.equal(body.questions.type_text_target.criteria['1'].element,'[1] Keywords');
    return {ok:true,json:async()=>({answers:{operation:{choice:'TYPE_TEXT',confidence:1,probabilities},type_text_target:answer('1'),click_target:{choice:'arbitrary code'}}})};
  }});
  assert.equal(count,1);assert.equal(result.operation,'TYPE_TEXT');assert.equal(result.action.id,'e1');
});
test('missing key and provider failures do not expose credentials',async()=>{
  await assert.rejects(()=>chooseJev(page,'goal',[],{}),/TYPESAFE_API_KEY/);
  await assert.rejects(()=>chooseJev(page,'goal',[],{apiKey:'secret',fetchImpl:async()=>({ok:false,status:401})}),/^Error: TypeSafe HTTP 401/);
});
test('agent arguments cannot replace observed actions or execute code',()=>{
  assert.throws(()=>validateJevArgs('browser_jev_act',{tabId:'tab',decisionId:'id',action:'evil'}));
  assert.throws(()=>validateJevArgs('browser_jev_next',{tabId:'tab'}));
  assert.throws(()=>validateJevArgs('browser_jev_run_code',{code:'anything'}));
  validateJevArgs('browser_jev_act',{tabId:'tab',decisionId:'id',text:''});
});
test('settings load only Jev config and do not mutate the process environment',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'jev-config-'));try{
    const file=path.join(dir,'env');await writeFile(file,'TYPESAFE_API_KEY=local-test\nTEXT_MODEL_API_KEY=unused\nTYPESAFE_MODEL=jev-latest\n');
    assert.deepEqual(await jevConfig({TYPESAFE_API_KEY:'override'},file),{apiKey:'override',model:'jev-latest'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('Jev selection persists and instructs the existing agent to supply text',()=>{
  const store=new Store(':memory:');try{
    const profile=store.saveProfile({name:'Test',preferences:'Remote',browserMode:'jev'});
    assert.equal(store.profile(profile.id).browserMode,'jev');assert.match(browserProfileInstruction(profile),/YOU remain the Jobloop agent/);assert.match(browserProfileInstruction(profile),/No OpenRouter/);
  }finally{store.close();}
});
test('demo seeds the real app with only a local synthetic source',async()=>{
  const fixture=await startJevFixture(),dir=await mkdtemp(path.join(os.tmpdir(),'jev-seed-'));
  try{
    const {candidateId}=await seedJevDemo(dir,fixture.url),store=new Store(path.join(dir,'jobloop.sqlite'));
    try{assert.equal(store.profile(candidateId).browserMode,'jev');const enabled=store.sources(candidateId).filter(s=>s.enabled);assert.equal(enabled.length,1);assert.equal(enabled[0].url,fixture.url);assert.equal(enabled[0].fallback,'none');}finally{store.close();}
    assert.equal((await fetch(fixture.url)).status,200);assert.equal((await fetch(fixture.url.replace('/jobs','/.env.jev'))).status,404);
  }finally{await fixture.close();await rm(dir,{recursive:true,force:true});}
});
