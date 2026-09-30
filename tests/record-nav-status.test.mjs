import test from 'node:test';
import assert from 'node:assert/strict';
import {activeRecordOperations} from '../src/record-operation-status.js';
import {TemplateRegistry} from '../app/template-registry.mjs';

function snapshot(){
 const runs=[{id:'apply',workerId:'one',recordId:'a',recordOperation:'execute',status:'running'},{id:'draft',workerId:'two',recordId:'b',recordOperation:'prepare',status:'running'},{id:'scan',workerId:'three',status:'running',sourceUrl:'https://example.test'}];
 return {automation:{questions:[]},definition:new TemplateRegistry().template('job-search'),runs,activeRuns:runs,workers:runs.map(r=>({id:r.workerId,active:{sessionId:r.id},execution:{task:{id:r.id}}}))};
}
test('board nav counts active application and preparation workers separately, using template labels',()=>{
 const s=snapshot();assert.deepEqual(activeRecordOperations(s),[{kind:'execute',count:1,label:'başvuruluyor'},{kind:'prepare',count:1,label:'hazırlanıyor'}]);
 s.definition.recordOperations.execute.runningLabel='Rezervasyon yapılıyor';assert.equal(activeRecordOperations(s)[0].label,'rezervasyon yapılıyor');
 s.activeRuns=[...s.activeRuns,s.activeRuns[0]];assert.equal(activeRecordOperations(s)[0].count,1);
});
test('completed runs, stopped workers, unanswered records and queued tasks are not active work',()=>{
 const s=snapshot();s.activeRuns=structuredClone(s.runs);s.runs[0].status='completed';
 s.automation.questions=[{recordId:'b',answer:null}];
 s.tasks=[{recordOperation:'execute',state:'pending'}];assert.deepEqual(activeRecordOperations(s),[]);
 s.automation.questions[0].answer='Ready';s.workers[1].active=null;assert.deepEqual(activeRecordOperations(s),[]);
 s.workers[1].active={sessionId:'new'};s.workers[1].execution.task.id='new';assert.deepEqual(activeRecordOperations(s),[]);
 s.workers[1].execution.task.id='draft';assert.deepEqual(activeRecordOperations(s),[{kind:'prepare',count:1,label:'hazırlanıyor'}]);
});
