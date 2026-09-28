import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
test('Chrome reconnection rechecks old connection questions together without answering site access or interrupting work',()=>{
 const s=new Store(':memory:');try{
  const p=s.saveProfile({name:'Test',preferences:'Berlin'});
  s.saveCampaign(p.id,{status:'running',task:{id:'current',kind:'search'},attempts:{}});
  const c=new Campaigns(s,{active:()=>null,changed:()=>{}});
  const add=(company,evidence)=>{
   const job=s.addJob(p.id,{company,role:'Counsel',location:'Berlin',fit:'Test',url:'https://example.test/'+company}).job;
   job.status='blocked';s.saveJob(job,'test');
   return s.ask(p.id,{jobId:job.id,question:'Access needed',applicationBlocker:{kind:'access',evidence,recovery:{kind:'user_only',userActionReason:'Resolve access'}}});
  };
  const a=add('A11','Chrome bağlantı izninin beklediğini bildirdi; 30 saniye sonra zaman aşımına uğradı.');
  const b=add('Raisin','Jev Chrome bağlantı izninin beklediğini bildirdi ve sekme açılmadı.');
  const login=add('Site','Chrome is connected; employer login requires an email code.');
  c.recheckBrowserQuestions(p.id);
  const campaign=s.campaign(p.id);assert.equal(campaign.task.id,'current');
  assert.deepEqual(campaign.pendingRecoveries,{[a.jobId]:a.id,[b.jobId]:b.id});
  assert.ok(s.questions(p.id).every(q=>q.answer===null));assert.equal(campaign.pendingRecoveries[login.jobId],undefined);
  c.recheckBrowserQuestions(p.id);assert.equal(Object.keys(s.campaign(p.id).pendingRecoveries).length,2);
 }finally{s.close();}
});
