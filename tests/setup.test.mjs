import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Setups} from '../app/setup.mjs';
import {Campaigns} from '../app/campaign.mjs';
const settings={provider:'codex',model:'default',permission:'default',reasoning:'default',network:null};
test('setup saves evidence incrementally, preserves permissions and requires user completion',()=>{
 const s=new Store(':memory:');try{const p=s.createSetup(settings);s.saveSetup(p.id,{...s.setup(p.id),status:'running'});
 s.updateSetupProfile(p.id,{stage:'reading',message:'CV read',name:'Candidate',facts:'CV: backend engineer',authorization:'submit'});assert.equal(s.profile(p.id).authorization,'research');assert.equal(s.setup(p.id).status,'running');
 const q=s.ask(p.id,{question:'Remote preference?'});assert.throws(()=>s.updateSetupProfile(p.id,{stage:'review',message:'Done',preferences:'Berlin'}));s.answer(p.id,q.id,'Berlin hybrid');s.updateSetupProfile(p.id,{stage:'review',message:'Ready',preferences:'Berlin hybrid'});assert.equal(s.setup(p.id).status,'review');assert.equal(s.profile(p.id).authorization,'research');s.completeSetup(p.id,{name:'Corrected',facts:'CV: backend engineer',preferences:'Berlin hybrid',authorization:'submit'});assert.equal(s.setup(p.id).status,'complete');assert.equal(s.profile(p.id).name,'Corrected');assert.equal(s.profile(p.id).authorization,'submit');assert.throws(()=>s.updateSetupProfile(p.id,{stage:'reading',message:'Overwrite'}));}finally{s.close();}
});
test('setup waits for answers, continues once on idle, and prevents campaign launch',async()=>{
 const store=new Store(':memory:');let active=null;const calls=[];try{const p=store.createSetup(settings);store.setCv(p.id,'/test/cv.txt');const setup=new Setups(store,{active:()=>active,changed:()=>{},launch:async id=>{calls.push('launch');active={candidateId:id,state:'Working'};},send:async()=>calls.push('send')});await setup.begin(p.id);await setup.tick();assert.deepEqual(calls,['launch']);const q=store.ask(p.id,{question:'Location?'});active.state='Idle';await setup.tick();assert.equal(calls.length,1);store.answer(p.id,q.id,'Berlin');setup.answered(p.id);await setup.tick();await setup.tick();assert.deepEqual(calls,['launch','send']);const campaign=new Campaigns(store,{active:()=>null,changed:()=>{},launch:async()=>{throw Error('must not launch');}});await assert.rejects(()=>campaign.start(p.id),/setup/);const legacy=store.saveProfile({name:'Existing',preferences:'Remote'});assert.equal(store.setup(legacy.id),null);}finally{store.close();}
});

test('candidate setup runs while another candidate campaign is active',async()=>{
 const store=new Store(':memory:'),sessions=new Map();try{
  const other=store.saveProfile({name:'Searching',preferences:'Berlin'});store.saveCampaign(other.id,{status:'running'});sessions.set(other.id,{candidateId:other.id,state:'Working'});
  const p=store.createSetup(settings);store.setCv(p.id,'/test/cv.txt');
  const setup=new Setups(store,{active:id=>sessions.get(id),changed:()=>{},launch:async id=>sessions.set(id,{candidateId:id,state:'Working'}),send:async()=>{}});
  await setup.begin(p.id);assert.equal(sessions.size,2);assert.equal(sessions.get(other.id).state,'Working');
 }finally{store.close();}
});
