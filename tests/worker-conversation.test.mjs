import test from 'node:test';
import assert from 'node:assert/strict';
import {workerConversation,conversationSignature} from '../src/worker-conversation.js';

test('web workspaces show saved messages and the worker’s own run history in time order',()=>{
 const snapshot={
  automation:{id:'a'},
  messages:[{id:'m2',role:'assistant',text:'Hangi şehir?',at:'2026-09-30T10:01:00.000Z'},{id:'m1',role:'user',text:'Ev arıyorum',at:'2026-09-30T10:00:00.000Z'}],
  runs:[{id:'r1',workerId:'main',kind:'run',summary:'3 ilan kaydedildi',startedAt:'2026-09-30T10:02:00.000Z',status:'completed'},{id:'r2',workerId:'worker-2',kind:'run',summary:'başka worker',startedAt:'2026-09-30T10:03:00.000Z',status:'completed'},{id:'r3',workerId:'main',kind:'interview',summary:'Başlatılıyor',startedAt:'2026-09-30T10:04:00.000Z',status:'running'}]
 };
 const entries=workerConversation(snapshot,{id:'main',name:'Worker 1'});
 assert.deepEqual(entries.map(e=>[e.role,e.text]),[['user','Ev arıyorum'],['agent','Hangi şehir?'],['system','Çalışma · 3 ilan kaydedildi']]);
 assert.equal(entries[2].label,'Tamamlandı');
 assert.deepEqual(workerConversation(snapshot,{id:'worker-2',name:'Worker 2'}).map(e=>[e.role,e.text]),[['system','Çalışma · başka worker']]);
});

test('document notes show the file name, never the internal path',()=>{
 const snapshot={automation:{id:'a'},messages:[{id:'m',role:'system',text:'Kullanıcı bir belge ekledi: documents/139c6175.pdf (Resume.pdf). Yalnızca bu otomasyon kapsamında kullan.',at:'t'}]};
 assert.deepEqual(workerConversation(snapshot,{id:'main'}).map(e=>[e.role,e.text,e.label]),[['system','Belge eklendi: Resume.pdf','Belge']]);
});

test('job workspaces turn worker events and sent prompts into a readable transcript',()=>{
 const snapshot={
  profile:{id:'c'},
  workers:[{id:'main',active:{sessionId:'s1'}},{id:'w2',active:{sessionId:'s2'}}],
  jobs:[{id:'j1',company:'Acme',role:'Dev'}],
  prompts:[{seq:2,kind:'message',text:'Berlin’e odaklan',sessionId:'s1',at:'2026-09-30T09:00:10.000Z'},{seq:1,kind:'start',text:'Read AGENTS.md',sessionId:'s1',at:'2026-09-30T09:00:00.000Z'}],
  events:[
   {seq:4,kind:'question_asked',data:{question:'Maaş beklentin?',workerId:'main',jobId:'j1'},at:'2026-09-30T09:04:00.000Z'},
   {seq:3,kind:'agent_activity',data:{message:'Formu dolduruyorum',sessionId:'s2',workerId:'w2'},at:'2026-09-30T09:03:00.000Z'},
   {seq:2,kind:'job_found',data:{company:'Acme',role:'Dev',workerId:'main'},at:'2026-09-30T09:02:00.000Z'},
   {seq:1,kind:'agent_activity',data:{message:'Kaynağı tarıyorum',sessionId:'s1',workerId:'main'},at:'2026-09-30T09:00:30.000Z'}
  ]
 };
 const entries=workerConversation(snapshot,{id:'main',name:'Worker 1',active:{sessionId:'s1'}});
 assert.deepEqual(entries.map(e=>[e.role,e.text]),[
  ['task','Berlin’e odaklan'],
  ['agent','Kaynağı tarıyorum'],
  ['system','Acme · Dev: ilan bulundu'],
  ['agent','Maaş beklentin?']
 ]);
 assert.equal(entries[3].label,'Soru');
 assert.equal(entries[3].pending,true);
});

test('provider transcripts add the agent’s own words and mark app-sent prompts as tasks',()=>{
 const snapshot={profile:{id:'c'},workers:[{id:'main',active:{sessionId:'s1'}}],prompts:[{seq:1,kind:'message',text:'Görev metni',sessionId:'s1',at:'2026-09-30T09:00:00.000Z'}],events:[]};
 const transcript=[{id:'n1',role:'task',text:'Görev metni',at:'2026-09-30T09:00:00.000Z'},{id:'n2',role:'agent',text:'Şu an 13. sayfadayım.',at:'2026-09-30T09:00:05.000Z'},{id:'n3',role:'user',text:'devam et',at:'2026-09-30T09:00:09.000Z'}];
 const entries=workerConversation(snapshot,{id:'main',active:{sessionId:'s1'}},transcript);
 assert.deepEqual(entries.map(e=>[e.role,e.text,e.label??null]),[['task','Görev metni','Görev'],['agent','Şu an 13. sayfadayım.',null],['user','devam et',null]]);
});

test('start prompts and other workers’ messages never leak into a worker transcript',()=>{
 const snapshot={profile:{id:'c'},workers:[{id:'main',active:{sessionId:'s1'}}],prompts:[{seq:1,kind:'start',text:'Read AGENTS.md',sessionId:'s1',at:'2026-09-30T09:00:00.000Z'},{seq:2,kind:'message',text:'başka',sessionId:'other',at:'2026-09-30T09:00:00.000Z'}],events:[]};
 assert.deepEqual(workerConversation(snapshot,{id:'main',active:{sessionId:'s1'}}),[]);
});

test('signature changes only when the transcript changes',()=>{
 const a=[{id:'1',role:'user',text:'x',at:'t'}],b=[{id:'1',role:'user',text:'x',at:'t'}],c=[{id:'1',role:'user',text:'y',at:'t'}];
 assert.equal(conversationSignature(a),conversationSignature(b));
 assert.notEqual(conversationSignature(a),conversationSignature(c));
});
