import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {conversationMessages} from '../app/conversation-messages.mjs';

const message=(id,extra={})=>({id,role:'assistant',text:id,at:100,...extra});

test('old worker reports and application answers never become chat as recent runs age out',()=>{
 const messages=[message('old StepStone scan'),message('old KPMG submission'),message('unknown user reply',{role:'user'}),message('chat',{conversation:true}),message('worker',{conversation:false})];
 for(const runs of [[],[{id:'recent',kind:'run',startedAt:10000}],[{id:'setup',kind:'interview',startedAt:20000}]]){
  assert.deepEqual(conversationMessages({messages,runs}).map(m=>m.id),['chat']);
 }
});

test('chat requires its own run, question or explicit marker, independent of message wording',()=>{
 const runs=[{id:'setup',kind:'interview',messageId:'request'},{id:'scan',kind:'run'}];
 const questions=[{id:'setup-form',runId:'setup',text:'Location',answer:'Berlin'},{id:'application',recordId:'job',text:'Submitted?',answer:'No'},{id:'unknown',text:'Unknown origin',answer:'Yes'}];
 const messages=[message('request',{role:'user'}),message('setup-reply',{runId:'setup',text:'StepStone results requested by the user'}),message('scan-reply',{runId:'scan'}),message('setup-answer',{role:'user',text:'Location\nYanıt: Berlin'}),message('application-answer',{role:'user',text:'Submitted?\nYanıt: No'}),message('unknown-answer',{role:'user',text:'Unknown origin\nYanıt: Yes'}),message('system',{role:'system',conversation:true}),message('explicit-worker',{conversation:false,runId:'setup'})];
 assert.deepEqual(conversationMessages({runs,messages,automation:{questions}}).map(m=>m.id),['request','setup-reply','setup-answer']);
});

test('durable run provenance survives the recent-run limit without rewriting old messages',t=>{
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('custom'),foreign=db.create('custom');
 const setup={id:'old-setup',automationId:a.id,kind:'interview',status:'completed',startedAt:1};db.putRun(setup);
 const old=db.message(a.id,'assistant','Original setup reply',{runId:setup.id});
 const unknown=db.message(a.id,'assistant','Legacy source report');
 db.putRun({id:'foreign-setup',automationId:foreign.id,kind:'interview',status:'completed'});const wrong=db.message(a.id,'assistant','Foreign run',{runId:'foreign-setup'});
 for(let i=0;i<40;i++)db.putRun({id:'scan-'+i,automationId:a.id,kind:'run',status:'completed',startedAt:100+i});
 const snapshot=db.snapshot(a.id);assert.ok(!snapshot.runs.some(run=>run.id===setup.id));
 const displayed=conversationMessages(snapshot);assert.ok(displayed.some(m=>m.id===old.id));assert.ok(!displayed.some(m=>[unknown.id,wrong.id].includes(m.id)));
 assert.equal(JSON.parse(core.db.prepare('SELECT data FROM automation_messages WHERE id=?').get(old.id).data).conversation,undefined,'Read enrichment does not mutate stored history');
 assert.equal(db.messages(a.id).length,4,'Worker history remains stored');
});

test('welcome messages and form answers record their origin when written',t=>{
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('custom');
 assert.equal(db.messages(a.id)[0].conversation,true);
 const run=db.begin(a.id,'interview'),q=db.askQuestion(a.id,{text:'Where?'},{runId:run.id});db.answerQuestion(a.id,q.id,'Berlin');
 const answer=db.messages(a.id).at(-1);assert.equal(answer.conversation,true);assert.equal(answer.questionId,q.id);assert.equal(answer.runId,run.id);
 db.put({...db.get(a.id),questions:[...db.get(a.id).questions,{id:'record-question',text:'Did it submit?',recordId:'job',answer:null,createdAt:Date.now()}]});
 db.answerQuestion(a.id,'record-question','No');assert.equal(db.messages(a.id).at(-1).conversation,false);
});

test('live replies update in chat and disappear when the saved final reply arrives',()=>{
 const run={id:'chat',kind:'interview',startedAt:100},snapshot={activeRuns:[run],runs:[run],messages:[]},native=[message('stream',{role:'agent',at:200,text:'Live reply'})];
 assert.equal(conversationMessages(snapshot,native)[0].text,'Live reply');
 snapshot.messages=[message('final',{conversation:true,at:300,text:'Final reply'})];
 assert.deepEqual(conversationMessages(snapshot,native).map(m=>m.id),['final']);
});
