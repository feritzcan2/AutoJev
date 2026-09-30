import test from 'node:test';
import assert from 'node:assert/strict';
import {automationProgress} from '../app/automation-progress.mjs';
import {webWorkspaceView} from '../app/workspace-view.mjs';

const snapshot=(automation={},rest={})=>({automation:{id:'home',title:'Ev takibi',goal:'Berlin’de ev bul',revision:2,reviewedRevision:2,trial:null,status:'ready',intervalMinutes:30,...automation},runs:[],messages:[],missing:[],...rest});
const finished=(kind,status,summary='Sonuç özeti')=>({id:'run',kind,status,summary,revision:2,startedAt:10,finishedAt:20});

test('an interview completion asks for missing answers or profile review, never silently starts a trial',()=>{
 const run=finished('interview','completed'),reply={role:'assistant',text:'Hangi semtler uygun?',at:15};
 const s=snapshot({reviewedRevision:null},{runs:[run],messages:[reply],missing:['Konum']});
 const p=automationProgress(s);assert.equal(p.primary.id,'message');assert.match(p.next,/Konum/);assert.equal(p.detail,reply.text);assert.equal(p.running,false);
 s.missing=[];const ready=automationProgress(s);assert.equal(ready.title,'Kurulum taslağı hazır');assert.equal(ready.primary.id,'profile');assert.equal(ready.steps[0].state,'current');
});

test('reviewed setup names the exact next action and explains the read-only trial',()=>{
 const p=automationProgress(snapshot());assert.equal(p.primary.id,'enable');assert.equal(p.title,'Kurulum tamamlandı');assert.match(p.next,/göndermez/);
 assert.deepEqual(p.steps.map(s=>s.state),['done','current']);
});

test('a failed trial takes precedence over a ready profile on every Agent surface',()=>{
 const s=snapshot({trial:{revision:2,status:'failed'}},{runs:[finished('trial','blocked','Çerez diyaloğunu kapatıp tekrar dene.')]});
 const p=automationProgress(s),v=webWorkspaceView(s,{sessions:new Map()});
 assert.equal(p.title,'Deneme tamamlanamadı');assert.equal(p.primary.id,'sources');assert.match(p.detail,/Çerez/);assert.equal(p.passed,false);
 assert.equal(v.activity.title,p.title);assert.equal(v.workers[0].presentation.outcome.title,p.title);assert.equal(v.workers[0].presentation.status,p.label);assert.equal(v.active,null);
});

test('a recorded result remains closing until the active run is released',()=>{
 const run=finished('trial','completed'),p=automationProgress(snapshot({trial:{revision:2,status:'passed'}},{runs:[run],activeRun:{...run,status:'running'}}));
 assert.equal(p.running,true);assert.equal(p.title,'Oturum kapanıyor…');assert.equal(p.primary,null);assert.equal(p.finishedRun,null);
});

test('repeated failed trials lead to fixing the blocker, and another active worker prevents a finished banner',()=>{
 const blocked=finished('trial','blocked'),s=snapshot({trial:{revision:2,status:'failed'}},{runs:[blocked,{...blocked,id:'previous'}]});
 const repeated=automationProgress(s);assert.equal(repeated.primary.id,'sources');assert.match(repeated.next,/engelli kaynağı/);
 const ended=finished('run','completed'),running={...ended,id:'another',status:'running',finishedAt:null};
 const p=automationProgress(snapshot({}, {runs:[ended,running],activeRun:ended,activeRuns:[ended,running]}));assert.equal(p.title,'Kaynaklar taranıyor');assert.equal(p.finishedRun,null);
});

test('successful trial offers tracking and one-off execution as separate actions',()=>{
 const p=automationProgress(snapshot({trial:{revision:2,status:'passed'}},{runs:[finished('trial','completed')]}));
 assert.equal(p.title,'Kurulum tamamlandı');assert.equal(p.primary.id,'enable');assert.ok(p.secondary.some(a=>a.id==='run'));assert.match(p.next,/Düzenli takip kapalı/);
});

test('reviewed setup has no workspace trial gate, including legacy skip metadata',()=>{
 for(const trial of [null,{revision:2,status:'skipped'},{revision:1,status:'failed'}]){
  const p=automationProgress(snapshot({trial}));
  assert.equal(p.primary.id,'enable');assert.ok(p.secondary.some(a=>a.id==='run'));
  assert.deepEqual(p.steps.map(step=>step.label),['Kurulum','Takip']);
  assert.ok(!p.secondary.some(a=>a.id==='skip-trial'));assert.match(p.next,/ilk turu denemedir/);
 }
});

test('a paused source failure exposes tracking for healthy sources without retrying the blocked source',()=>{
 const s=snapshot({status:'paused',trial:{revision:2,status:'passed'}},{runs:[{...finished('run','blocked','IP blocked'),sourceUrl:'https://blocked.example/'}],sources:[{enabled:true,blocked:true},{enabled:true,blocked:false}]});
 const p=automationProgress(s);assert.equal(p.primary.id,'enable');assert.equal(p.primary.label,'Düzenli takibi sürdür');assert.ok(p.secondary.some(a=>a.id==='sources'));assert.ok(!p.secondary.some(a=>a.id==='run'));
 for(const changed of [{automation:{...s.automation,status:'blocked'}},{runs:[{...s.runs[0],recordId:'uncertain-action'}]},{sources:[{enabled:true,blocked:true}]}])assert.notEqual(automationProgress({...s,...changed}).primary.id,'enable');
});

test('one completed scan does not claim the overall goal is complete or tracking is enabled',()=>{
 const run=finished('run','completed','İki ilan bulundu.');
 const stopped=automationProgress(snapshot({trial:{revision:2,status:'passed'}},{runs:[run]}));assert.equal(stopped.title,'Bu tur tamamlandı');assert.equal(stopped.primary.id,'enable');
 const scheduled=automationProgress(snapshot({status:'enabled',trial:{revision:2,status:'passed'},nextRunAt:Date.now()+60000},{runs:[run]}));assert.equal(scheduled.title,'Düzenli takip açık');assert.match(scheduled.next,/Sonraki kontrol/);assert.equal(scheduled.primary.id,'results');assert.ok(scheduled.secondary.some(a=>a.id==='stop'));
});

test('dirty and revised plans cannot present an old trial as ready to run',()=>{
 const s=snapshot({revision:3,reviewedRevision:2,trial:{revision:2,status:'passed'}},{runs:[finished('trial','completed')]});
 assert.equal(automationProgress(s).primary.id,'profile');assert.equal(automationProgress(s).passed,false);
 const dirty=automationProgress(snapshot({trial:{revision:2,status:'passed'}}),{dirty:true});assert.equal(dirty.primary.id,'profile');assert.match(dirty.title,/kaydedilmedi/);
});

test('provider permission requests lead to the live terminal, and legacy expiry dates do not block tracking',()=>{
 const run={...finished('trial','running'),finishedAt:null,state:'AwaitingInput'};
 const p=automationProgress(snapshot({}, {activeRun:run,runs:[run]}));assert.equal(p.primary.id,'terminal');assert.equal(p.tone,'waiting');
 const expired=automationProgress(snapshot({endAt:1}));assert.equal(expired.primary.id,'enable');assert.doesNotMatch(expired.next,/bitiş tarihi/);
});


test('a secondary worker supplies the shared session view while run state keeps its own identity',()=>{
 const run={...finished('run','running'),id:'secondary-run',workerId:'helper',finishedAt:null};
 const session={candidateId:'home',workerId:'helper',sessionId:run.id,state:'Working',token:'private'};
 const view=webWorkspaceView(snapshot({}, {runs:[run],activeRun:run,activeRuns:[run],workers:[{id:'main',name:'Worker 1'},{id:'helper',name:'Helper'}]}),{sessions:new Map([['home~helper',session]])});
 assert.equal(view.active.workerId,'helper');assert.equal(view.active.sessionId,run.id);assert.equal(view.active.token,undefined);
 assert.equal(view.activeRun.kind,'run');assert.equal(view.workers[0].active,null);assert.equal(view.workers[1].active.sessionId,run.id);
 assert.equal(automationProgress(view).running,true);
});

test('an enabled worker with no task waits instead of borrowing another worker’s running status',()=>{
 const run={...finished('run','running'),workerId:'main',operation:'scan',sources:['https://homes.test/'],finishedAt:null};
 const session={candidateId:'home',workerId:'main',sessionId:run.id,state:'Working'};
 const s=snapshot({status:'enabled'},{runs:[run],activeRun:run,activeRuns:[run],workers:[{id:'main',name:'Worker 1'},{id:'helper',name:'Worker 2'}]});
 const view=webWorkspaceView(s,{sessions:new Map([['home',session]])});
 assert.equal(view.workers[0].presentation.status,'Çalışıyor');
 const idle=view.workers[1];
 assert.equal(idle.active,null);assert.equal(idle.execution.task,null);
 assert.equal(idle.execution.status,'running'); // Still enabled to receive work.
 assert.equal(idle.presentation.status,'Görev bekliyor');
 assert.equal(idle.presentation.title,'Sıradaki görev bekleniyor');
 assert.match(idle.presentation.detail,/çalışan agent oturumu yok/);
 assert.equal(idle.presentation.outcome,null);
 s.activeRun=null;s.activeRuns=[];s.runs=[finished('run','completed')];
 assert.equal(webWorkspaceView(s,{sessions:new Map()}).workers[1].presentation.status,'Görev bekliyor');
 s.workers[1].enabled=false;
 const stopped=webWorkspaceView(s,{sessions:new Map()}).workers[1];
 assert.equal(stopped.execution.status,'paused');
 assert.notEqual(stopped.presentation.status,'Görev bekliyor');
});

test('a brand-new workspace with no conversation invites the first message instead of listing missing fields',()=>{
 const greeting={role:'assistant',text:'Ne yapmak istediğini anlat.',at:1};
 const s=snapshot({goal:'',reviewedRevision:null},{messages:[greeting],missing:['Amaç','En az bir kaynak adresi','Beklenen sonuç']});
 const p=automationProgress(s);
 assert.equal(p.title,'Ne yapmak istediğini anlat');assert.equal(p.next,'İlk mesajını Agent sayfasına yaz; gerisini agent sorar.');assert.equal(p.primary.id,'message');assert.equal(p.fresh,true);
 assert.doesNotMatch(p.next,/Eksik/);
 assert.equal(automationProgress({...s,messages:[{role:'assistant',text:'Ne yapmak istediğini anlat.',at:1}]}).fresh,true);
 const after=automationProgress({...s,messages:[greeting,{role:'user',text:'Ev arıyorum',at:2}]});
 assert.match(after.next,/Eksik bilgiler/);assert.equal(after.fresh,false);
});
