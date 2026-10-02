import {unknownScorecard} from './helpers/scorecard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {assessmentEvidence} from '../app/record-evidence.mjs';

const source='https://www.linkedin.com/jobs';
const detail='https://www.linkedin.com/jobs/view/synthetic-compliance-role-1234567890/';
const alias='https://www.linkedin.com/jobs/view/synthetic-compliance-role-1234567890?trackingId=alias';
const text='Synthetic compliance position in Berlin. Salary and remote policy are unspecified.';
const assessment={status:'scored',scorecard:unknownScorecard(),score:70,summary:'Relevant work; missing facts remain unknown.',evidenceUrl:alias,evidence:text,strengths:['Compliance work'],gaps:[],uncertainties:['Salary unknown']};

function fixture(t){
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core);
 const a=db.create('job-search',{goal:'Compliance roles',criteria:{preferences:'Berlin',ranking:'Compare verified role and skills'},sources:[source]});db.review(a.id);
 const task=core.workspaces.tasks.enqueue(a.id,{operation:'scan',capability:'browser.observe',sourceUrl:source,sources:[source],lockKey:'source:'+source});
 let run=db.begin(a.id,{kind:'run',taskId:task.id});
 const restart=()=>{db.finish(a.id,run.id,'interrupted','Restart');core.workspaces.tasks.put({...core.workspaces.tasks.get(a.id,task.id),state:'pending',workerId:null});run=db.begin(a.id,{kind:'run',taskId:task.id});return run;};
 const saved=(patch={})=>{
  const job=db.jevTasks.create(patch.owner??a.id,patch.taskId??task.id,{operation:patch.operation??'collect_details'});job.searchId=patch.searchId??'default';
  const evidence=db.jevTasks.evidence(job,{url:patch.url??detail,title:'Synthetic role',text:patch.text??text,links:[{url:alias,text:'Observed link'}]});
  job.items=[{url:alias,evidenceId:evidence.id,collected:true,detailComplete:true,...patch.item}];job.status='needs_agent';db.jevTasks.save(job);return {job,evidence};
 };
 return {core,db,id:a.id,task,get run(){return run;},restart,saved,record:()=>db.record(a.id,run.id,{url:alias,title:'Synthetic role',summary:'Saved original evidence',assessment})};
}

test('a restarted source can score its saved Jev detail without reopening it or manufacturing a new observation',t=>{
 const f=fixture(t),{evidence}=f.saved();
 f.db.observe(f.id,f.run.id,detail,text);
 // The original detail has fallen out of the recent 20-page observation list.
 for(let i=0;i<25;i++)f.db.observe(f.id,f.run.id,source+'/other-'+i,'Other detail');
 assert.ok(!f.db.run(f.run.id).observations.some(o=>o.url===detail));
 const next=f.restart(),before=JSON.stringify(f.db.run(next.id)),record=f.record();
 assert.equal(record.assessment.score,70);assert.equal(record.assessment.evidenceUrl,evidence.url);
 assert.equal(record.assessment.runId,next.id);assert.equal(record.assessment.rubric,'Compare verified role and skills');
 assert.equal(JSON.stringify(f.db.run(next.id)),before,'scoring does not turn historical evidence into a fresh browser observation');
 assert.equal(f.db.run(next.id).browserSteps,0);
 const another=f.restart();assert.equal(f.record().id,record.id);assert.equal(f.db.results(f.id).length,1);assert.equal(f.db.run(another.id).observations.length,0);
});

test('scoring without cached evidence does not manufacture a new observation',t=>{
 const f=fixture(t);f.db.observe(f.id,f.run.id,detail,text);f.restart();
 assert.equal(assessmentEvidence(f.db,f.id,f.run,alias),null);assert.equal(f.record().assessment.score,70);assert.equal(f.db.run(f.run.id).observations.length,0);
 f.db.observe(f.id,f.run.id,detail,text);assert.equal(assessmentEvidence(f.db,f.id,f.db.run(f.run.id),alias).url,detail);
});

test('an agent can retire previously scored work without a fresh listing observation',t=>{
 const f=fixture(t);f.saved();f.db.observe(f.id,f.run.id,source,'Search page',[alias]);
 f.db.saveScanProgress(f.id,f.run.id,{pendingUrls:[alias],reason:'Pending listing'},{url:source,text:'Search page'});
 f.restart();f.record();
 f.db.observe(f.id,f.run.id,source,'Current search page');
 f.db.saveScanProgress(f.id,f.run.id,{pendingUrls:[],processedUrls:[alias],reason:'Previously scored work is complete'});
 assert.deepEqual(f.db.scanQueue(f.id,f.run.id).pendingUrls,[]);
});

for(const [name,patch] of Object.entries({
 'another task':{taskId:'foreign-task'},
 'another search':{searchId:'foreign-search'},
 'discovery only':{operation:'scan_results'},
 'no description':{item:{collected:false,detailComplete:false}},
 'a failed detail':{item:{error:'Page unavailable'}},
 'a results page':{item:{pageKind:'results'}},
 'empty evidence':{text:'   '},
 'a different listing':{url:'https://www.linkedin.com/jobs/view/1234567891'},
 'a lookalike domain':{url:'https://linkedin.com.evil.test/jobs/view/1234567890'},
}))test('historical evidence rejects '+name,t=>{
 const f=fixture(t);f.saved(patch);f.restart();assert.equal(assessmentEvidence(f.db,f.id,f.db.run(f.run.id),alias),null);assert.equal(f.db.results(f.id).length,0);
});

test('historical evidence cannot cross workspaces or borrow a foreign evidence ID',t=>{
 const f=fixture(t),other=f.db.create('job-search',{goal:'Other workspace',criteria:{preferences:'Berlin',ranking:'Skills'},sources:[source]});
 const foreign=f.saved({owner:other.id}),own=f.saved({text:' '});
 own.job.items[0].evidenceId=foreign.evidence.id;f.db.jevTasks.save(own.job);
 f.restart();assert.equal(assessmentEvidence(f.db,f.id,f.db.run(f.run.id),alias),null);
});

test('old untagged browser observations cannot be reassigned between multiple saved searches',t=>{
 const f=fixture(t);f.db.observe(f.id,f.run.id,detail,text);
 f.db.saveScanSearches(f.id,f.run.id,[{id:'default',label:'Original'},{id:'other',label:'Other'}]);
 f.restart();assert.equal(assessmentEvidence(f.db,f.id,f.db.run(f.run.id),alias),null);
 // Jev retains the original search identity even when browser excerpts cannot.
 f.saved();assert.equal(assessmentEvidence(f.db,f.id,f.db.run(f.run.id),alias).url,detail);
 f.db.selectScanSearch(f.id,f.run.id,'other');assert.equal(assessmentEvidence(f.db,f.id,f.db.run(f.run.id),alias),null);
});

test('current observations take precedence and a new task still needs its own evidence',t=>{
 const f=fixture(t);f.saved();f.restart();
 const current='https://www.linkedin.com/jobs/view/synthetic-compliance-role-1234567890?trackingId=current';f.db.observe(f.id,f.run.id,current,'Current detail');
 assert.equal(f.record().assessment.evidenceUrl,current);
 const run=f.db.run(f.run.id);
 assert.equal(assessmentEvidence(f.db,f.id,{...run,id:'new-run',taskId:'new-task',observations:[]},alias),null);
 f.db.put({...f.db.get(f.id),revision:run.revision+1});assert.throws(()=>f.record(),/Profil değişti/);
});
