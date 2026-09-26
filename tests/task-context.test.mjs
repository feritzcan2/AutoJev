import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {campaignPrompt} from '../app/campaign.mjs';
test('task context includes assigned job, replies and retained tabs, not unrelated job details or other candidates',()=>{
 const s=new Store(':memory:');try{
 const a=s.saveProfile({name:'A',preferences:'Remote'}),b=s.saveProfile({name:'B',preferences:'Berlin'});
 const job=s.addJob(a.id,{company:'X',role:'Dev',location:'Remote',fit:'Backend',url:'https://example.com/1'}).job;
 const other=s.addJob(a.id,{company:'Private employer',role:'Dev',location:'Remote',fit:'Backend',url:'https://example.com/2'}).job;
 const source=s.sources(a.id)[0];s.saveCampaign(a.id,{status:'running',task:{id:'task',kind:'application',jobId:job.id,sourceId:source.id}});
 const q=s.ask(a.id,{jobId:job.id,question:'Required date?'});s.answer(a.id,q.id,'Tomorrow');s.ask(a.id,{jobId:other.id,question:'Unrelated question'});s.ask(b.id,{question:'Other candidate'});
 const ctx=s.taskContext(a.id);assert.equal(ctx.job.id,job.id);assert.equal(ctx.source.id,source.id);assert.equal(ctx.questions.length,1);assert.equal(ctx.questions[0].answer,'Tomorrow');assert.equal(ctx.jobs,undefined);assert.equal(ctx.events,undefined);assert.ok(!JSON.stringify(ctx).includes('Private employer'));assert.ok(!JSON.stringify(ctx).includes('Other candidate'));
 }finally{s.close();}
});
test('task prompt stays bounded regardless of profile, history and checkpoint size',()=>{
 const text=campaignPrompt({task:{id:'task',kind:'application',jobId:'job',applyMode:'auto'},profile:{authorization:'submit',preferences:'x'.repeat(30000)},checkpoint:{url:'x'.repeat(3000)},answers:Array(100).fill({answer:'x'.repeat(1000)})});
 assert.ok(text.length<850);assert.match(text,/apply-to-jobs/);assert.doesNotMatch(text,/find-jobs|xxx/);assert.match(text,/already authorized/);
});
