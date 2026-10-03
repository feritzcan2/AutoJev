import {unknownScorecard} from './helpers/scorecard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {startToolServer} from '../app/tool-server.mjs';
import {automationAttention} from '../app/automation-attention.mjs';
import {recordOperationStatus} from '../src/record-operation-status.js';
import {InstructionLog} from '../app/instruction-log.mjs';

const source='https://example.test/jobs',url=source+'/developer';
const assessment={status:'scored',scorecard:unknownScorecard(),score:82,summary:'Skills match the role.',evidenceUrl:url,evidence:'JavaScript developer, remote.',strengths:['JavaScript'],gaps:[],uncertainties:[]};
async function fixture(t){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);
 const a=db.create('job-search',{goal:'Find jobs',criteria:{preferences:'Remote JavaScript',ranking:'Skills 100%.'},sources:[source]});db.review(a.id);
 const seed=db.begin(a.id,'run'),item=db.record(a.id,seed.id,{url,title:'Developer',summary:'Saved listing',proposal:'Reviewed proposal'});db.finish(a.id,seed.id,'completed','Saved');db.approve(a.id,item.id);
 const entries=new Map(),reports=[],log=new InstructionLog(core.workspaces);
 const server=await startToolServer({assertOwner:id=>db.get(id),resolve:grant=>entries.get(grant.sessionId).flow,onExchange:(grant,event)=>log.tool(grant,event)});
 let runtime;
 const rebuild=entry=>{
  const flow=automationWorkflow({db,run:entry.run,signal:entry.signal,browser:{call:async()=>{if(entry.page)return {content:[{type:'text',text:`Page URL: ${url}\n${entry.page}`}]};throw Error('Browser unavailable');}},report:(...args)=>{reports.push(args);return runtime.report(...args);}});
  const call=flow.call;flow.call=(...args)=>{entry.calls.push(args[2]);return call(...args);};entry.flow=flow;
 };
 const runtimeOptions={launch:async(run,_a,_onEvent,signal)=>{
  let closed;const entry={run,signal,calls:[],closed:new Promise(resolve=>{closed=resolve;})};rebuild(entry);entries.set(run.id,entry);
  entry.token=server.grant(a.id,run.id,run.workerId,entry.flow);
  return {close:async()=>{entry.didClose=true;server.revoke(entry.token);closed();}};
 }};
 runtime=new WebTasks(db,runtimeOptions);
 t.after(async()=>{await runtime.close();await server.close();core.close();});
 const start=async(record=item,kind='score',input={})=>{
  const task=await runtime.runRecord(a.id,record.id,kind,input);
  await new Promise(resolve=>setImmediate(resolve));
  return [...entries.values()].find(e=>e.run.taskId===task.id);
 };
 let rpcId=0;
 const call=async(entry,name,args={})=>{
  const response=await fetch(server.endpoint,{method:'POST',headers:{Authorization:'Bearer '+entry.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})});
  const body=await response.json();return {...body,httpStatus:response.status};
 };
 const score=(entry,patch={})=>call(entry,'record_automation_score',{itemId:entry.run.recordId,...assessment,...patch});
 const failures=entry=>Object.values(db.store.workspaces.tasks.get(a.id,entry.run.taskId).toolFailures??{});
 const restart=async()=>{await runtime.close();runtime=new WebTasks(db,runtimeOptions);return runtime;};
 return {core,db,id:a.id,item:db.result(a.id,item.id),runtime,entries,reports,rebuild,restart,start,call,score,failures,log};
}
const errorText=response=>response.result?.content?.map(c=>c.text).join('\n')??response.error;

test('source saves recover from missing summaries and cell maps without losing facts or duplicating records',async t=>{
 const f=await fixture(t),trial=f.db.begin(f.id,'trial');f.db.observe(f.id,trial.id,source,'Accessible');f.db.finish(f.id,trial.id,'completed','Checked');
 await f.runtime.runOnce(f.id);await new Promise(setImmediate);const entry=[...f.entries.values()].at(-1);
 const before=f.db.results(f.id).length;
 const input={url:'https://board.example.test/view?record=42',title:'Synthetic engineer',score:'73',scoreReason:'Observed skills match',cells:{company:'Synthetic employer',location:'Remote'}};
 const missing=await f.call(entry,'record_automation_result',input);
 assert.equal(missing.result.isError,true);assert.match(errorText(missing),/Missing summary/);
 assert.match(errorText(missing),/scoreReason.*does not replace summary/);
 assert.doesNotMatch(errorText(missing),/arguments.cells/);assert.equal(f.db.results(f.id).length,before);
 const corrected={...input,summary:'Observed role details'},response=await f.call(entry,'record_automation_result',corrected);
 assert.equal(response.result.isError,undefined,errorText(response));
 const receipt=JSON.parse(response.result.content[0].text),saved=f.db.result(f.id,receipt.id);
 assert.equal(saved.url,input.url);assert.equal(saved.summary,corrected.summary);assert.equal(saved.assessment.score,73);
 assert.equal(saved.assessment.summary,input.scoreReason);assert.equal(saved.cells.company,input.cells.company);assert.equal(saved.cells.location,'Remote');
 assert.deepEqual(f.failures(entry),[]);assert.equal(f.db.run(entry.run.id).status,'running');
 const duplicate=await f.call(entry,'record_automation_result',corrected);assert.equal(JSON.parse(duplicate.result.content[0].text).id,receipt.id);
 assert.equal(f.db.results(f.id).length,before+1);
 for(const name of ['update_workspace_cells']){
  const update=await f.call(entry,name,{itemId:receipt.id,cells:{location:'Berlin'}});
  assert.equal(update.result.isError,undefined,errorText(update));assert.equal(f.db.result(f.id,receipt.id).cells.location,'Berlin');
 }
});

test('failed save diagnostics survive worker shutdown without storing arguments or page content',async t=>{
 const f=await fixture(t),entry=await f.start(f.item,'prepare');
 const input={url:f.item.url,title:'private title',cells:{company:42},'private-field-name':'private text'};
 for(let i=0;i<3;i++){
  const response=await f.call(entry,'record_automation_result',input);
  assert.equal(response.result.isError,true);assert.match(errorText(response),/Missing summary/);assert.match(errorText(response),/Expected array; received object/);
 }
 await entry.closed;
 const history=f.log.history(f.id,{session:entry.run.id}).events;
 assert.equal(history.length,3);assert.ok(history.every(e=>e.title==='record_automation_result'&&e.status==='failed'));
 const details=history.map(e=>f.log.detail(f.id,e.seq));
 assert.doesNotMatch(JSON.stringify(details),/private title|private-field-name|private text|company/);
 const issues=JSON.parse(details[0].parts[0].text).issues;
 assert.ok(issues.some(i=>i.path==='arguments.summary'&&i.received==='missing'));
 assert.ok(issues.some(i=>i.path==='arguments.cells'&&i.received==='object'&&i.maxItems===10));
 assert.equal(f.db.run(entry.run.id).status,'blocked');assert.deepEqual(f.db.result(f.id,f.item.id),f.item);
});

test('the third repeated save error stops only its worker and persists a visible reason',async t=>{
 const f=await fixture(t),entry=await f.start();
 f.runtime.workers.add(f.id,{name:'Other worker'});
 const second=f.db.putResult({...f.item,id:'other-record',key:source+'/other',url:source+'/other',title:'Other developer'}),other=await f.start(second);
 for(let i=1;i<=2;i++){
  const response=await f.score(entry,{itemId:'missing-record',summary:'Updated explanation '+i});assert.equal(response.result.isError,true);assert.match(errorText(response),new RegExp(`${i}/3`));
  assert.equal((await f.call(entry,'get_automation_context')).result.isError,undefined);
 }
 const response=await f.score(entry,{itemId:'missing-record',evidenceUrl:'https://www.linkedin.com/jobs/view/4473093841'});
 assert.match(errorText(response),/Puanlama durduruldu.*3 kez/);
 assert.equal(f.db.run(entry.run.id).status,'blocked');assert.equal(f.reports.length,1);
 assert.equal(f.failures(entry)[0].count,3);
 assert.deepEqual(f.db.result(f.id,f.item.id),f.item,'An error must not replace an existing draft or approval');
 await entry.closed;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(entry.didClose,true);assert.equal(other.didClose,undefined);assert.equal(f.db.run(other.run.id).status,'running');
 await f.runtime.tick();assert.equal(f.entries.size,2,'No automatic retry of the blocked task');
 const snapshot=f.db.snapshot(f.id),row=snapshot.results.find(r=>r.id===f.item.id);
 assert.equal(recordOperationStatus(row).label,'İşlem engellendi');assert.match(row.recordAction.lastTask.summary,/Sonuç bu otomasyona ait değil/);
 const issues=automationAttention({...snapshot,runs:[],activeRuns:[other.run]});
 assert.equal(issues.length,1);assert.equal(issues[0].kind,'repeated_tool_error');assert.equal(issues[0].recordId,f.item.id);assert.match(issues[0].message,/3 kez/);
 assert.equal(f.db.messages(f.id).filter(m=>m.recordId===f.item.id&&m.role==='system').length,1);
});

test('schema validation failures are counted before the tool body executes',async t=>{
 const f=await fixture(t),entry=await f.start();
 for(let i=0;i<3;i++)assert.equal((await f.score(entry,{score:'82 points'})).result.isError,true);
 assert.equal(entry.calls.filter(name=>name==='record_automation_score').length,0);
 assert.equal(f.db.run(entry.run.id).status,'blocked');assert.match(f.db.run(entry.run.id).toolFailure.message,/arguments.score/);
});

test('an explicitly unavailable blank score normalizes before MCP validation without weakening real scores',async t=>{
 const f=await fixture(t),entry=await f.start();
 const response=await f.score(entry,{status:'unavailable',score:''});assert.equal(response.result.isError,undefined);
 assert.equal(f.db.result(f.id,f.item.id).assessment.score,null);assert.equal(f.failures(entry).length,0);
 const invalid=await f.score(entry,{status:'scored',score:''});assert.equal(invalid.result.isError,true);assert.equal(f.db.run(entry.run.id).status,'running');
 assert.equal(f.db.result(f.id,f.item.id).assessment.score,null);assert.equal(f.failures(entry)[0].count,1);
});

test('parallel requests cannot execute a fourth attempt',async t=>{
 const f=await fixture(t),entry=await f.start();
 const responses=await Promise.all(Array.from({length:6},()=>f.score(entry,{itemId:'missing-record'})));
 assert.equal(entry.calls.filter(name=>name==='record_automation_score').length,3);
 assert.equal(f.failures(entry)[0].count,3);assert.equal(f.reports.length,1);
 assert.ok(responses.every(r=>r.result?.isError||r.httpStatus===401));
});

test('only success of the failing operation clears its counters',async t=>{
 const f=await fixture(t),entry=await f.start();
 await f.score(entry,{itemId:'missing-record'});await f.score(entry,{itemId:'missing-record'});f.db.observe(f.id,entry.run.id,url,'Full detail');
 assert.equal((await f.score(entry)).result.isError,undefined);assert.deepEqual(f.failures(entry),[]);
 const response=await f.score(entry,{itemId:'missing-record',evidenceUrl:url+'/unobserved'});
 assert.match(errorText(response),/1\/3/);assert.equal(f.db.run(entry.run.id).status,'running');
});

test('distinct errors stay separate and rebuilding the workflow preserves counters',async t=>{
 const f=await fixture(t),entry=await f.start();
 await f.score(entry,{itemId:'missing-record'});await f.score(entry,{score:'82 points'});await f.score(entry,{score:'82 points'});
 f.rebuild(entry);
 assert.match(errorText(await f.score(entry,{itemId:'missing-record'})),/2\/3/);assert.equal(f.db.run(entry.run.id).status,'running');
 assert.match(errorText(await f.score(entry,{itemId:'missing-record'})),/3 kez/);assert.equal(f.db.run(entry.run.id).status,'blocked');
});

test('a manual retry starts a new task and clears the old warning',async t=>{
 const f=await fixture(t),entry=await f.start();
 for(let i=0;i<3;i++)await f.score(entry,{itemId:'missing-record'});
 await entry.closed;await new Promise(resolve=>setImmediate(resolve));
 const next=await f.start();assert.notEqual(next.run.taskId,entry.run.taskId);assert.deepEqual(f.failures(next),[]);
 assert.deepEqual(automationAttention(f.db.snapshot(f.id)),[]);
 f.db.observe(f.id,next.run.id,url,'Full detail');assert.equal((await f.score(next)).result.isError,undefined);
 assert.equal((await f.call(next,'finish_automation_run',{status:'completed',summary:'Scored'})).result.isError,undefined);
});

test('application restart resumes the same task with its existing failure count',async t=>{
 const f=await fixture(t),entry=await f.start();await f.score(entry,{itemId:'missing-record'});await f.score(entry,{itemId:'missing-record'});
 const runtime=await f.restart();await runtime.tick();await new Promise(resolve=>setImmediate(resolve));
 const next=[...f.entries.values()].at(-1);assert.notEqual(next.run.id,entry.run.id);assert.equal(next.run.taskId,entry.run.taskId);
 assert.match(errorText(await f.score(next,{itemId:'missing-record'})),/3 kez/);assert.equal(f.db.run(next.run.id).status,'blocked');
});

test('browser failures on different pages are distinct while same-listing URL aliases share a limit',async t=>{
 const f=await fixture(t),entry=await f.start();
 for(let i=0;i<2;i++)await f.call(entry,'browser_open',{url:'https://www.linkedin.com/jobs/view/4473093841'});
 assert.match(errorText(await f.call(entry,'browser_open',{url:'https://www.linkedin.com/jobs/view/4473093842'})),/1\/3/);
 const response=await f.call(entry,'browser_open',{url:'https://www.linkedin.com/jobs/view/4473093841/?utm_source=mail'});
 assert.match(errorText(response),/3 kez/);assert.equal(f.db.run(entry.run.id).status,'blocked');
});

test('an interrupted submission remains uncertain and offers verification after the error limit',async t=>{
 const f=await fixture(t),entry=await f.start(f.item,'execute',{direct:true});
 f.db.observe(f.id,entry.run.id,url,'Full listing');
 assert.equal((await f.call(entry,'reserve_automation_action',{itemId:f.item.id})).result.isError,undefined);
 for(let i=0;i<3;i++)await f.call(entry,'record_automation_outcome',{itemId:f.item.id,status:'completed',url:url+'/confirmation',evidence:'Unobserved confirmation'});
 await entry.closed;await new Promise(resolve=>setImmediate(resolve));
 const row=f.db.snapshot(f.id).results.find(r=>r.id===f.item.id);
 assert.equal(row.status,'uncertain');assert.equal(row.recordAction.retryOperation.kind,'verify');
 assert.equal(f.db.run(entry.run.id).status,'blocked');
});

test('rejected proof responses also stop after three attempts while preserving uncertainty',async t=>{
 const f=await fixture(t),item=f.db.putResult({...f.item,status:'uncertain'}),entry=await f.start(item,'verify');
 const quote=`${url} — Draft`;entry.page=quote;
 const data=response=>JSON.parse(response.result.content[0].text);
 let observed=data(await f.call(entry,'browser_read'));entry.page=`${url} — Submitted`;
 for(let i=0;i<3;i++){
  observed=data(await f.call(entry,'record_automation_outcome',{itemId:item.id,status:'not_submitted',url,evidence:quote,notSubmittedProof:{snapshotId:observed.snapshot.id,kind:'draft',quote,recordEvidence:url}}));
  assert.equal(observed.status,'evidence_rejected');assert.equal(observed.saved,false);
 }
 assert.match(observed.message,/Doğrulama durduruldu.*3 kez/);assert.equal(f.db.run(entry.run.id).status,'blocked');assert.equal(f.db.result(f.id,item.id).status,'uncertain');
});

test('source schema failures share a limit across records and cannot auto-requeue',async t=>{
 const f=await fixture(t),trial=f.db.begin(f.id,'trial');f.db.observe(f.id,trial.id,source,'Source accessible');f.db.finish(f.id,trial.id,'completed','Checked');
 await f.runtime.runOnce(f.id);await new Promise(setImmediate);const entry=[...f.entries.values()].at(-1);
 assert.ok(entry);assert.equal(entry.run.recordId??null,null);
 const responses=await Promise.all(Array.from({length:6},(_,i)=>f.call(entry,'record_automation_result',{key:source+'/'+i,url:source+'/'+i,title:'Role '+i,summary:'Observed',...(i%2?{score:'bad'}:{score:null,unexpected:true})})));
 assert.equal(f.db.run(entry.run.id).status,'blocked');assert.equal(f.failures(entry)[0].count,3);assert.equal(f.reports.length,1);
 assert.equal(entry.calls.filter(n=>n==='record_automation_result').length,0);assert.ok(responses.every(r=>r.result?.isError||r.httpStatus===401));
 await entry.closed;await new Promise(setImmediate);const count=f.entries.size;await f.runtime.tick();assert.equal(f.entries.size,count);
 assert.equal(f.core.workspaces.tasks.get(f.id,entry.run.taskId).state,'blocked');assert.match(f.db.run(entry.run.id).summary,/Kaynak taraması durduruldu/);
});

test('URL records omit redundant key and recover from complete field feedback without losing deduplication',async t=>{
 const f=await fixture(t),trial=f.db.begin(f.id,'trial');f.db.observe(f.id,trial.id,source,'Source accessible');f.db.finish(f.id,trial.id,'completed','Checked');
 await f.runtime.runOnce(f.id);await new Promise(setImmediate);const entry=[...f.entries.values()].at(-1);
 const detail=source+'/new-listing',before=f.db.results(f.id).length;
 const invalid=await f.call(entry,'record_automation_result',{url:detail,summary:'Observed description',score:101,eligibility:'unsure'});
 assert.equal(invalid.result.isError,true);
 for(const error of ['Missing title','arguments.score: Number exceeds maximum 100','arguments.eligibility: Invalid argument'])assert.ok(errorText(invalid).includes(error),errorText(invalid));
 assert.doesNotMatch(errorText(invalid),/Missing key/);assert.equal(f.db.results(f.id).length,before);
 const malformed=await f.call(entry,'record_automation_result',{url:detail,title:'Developer',summary:'Observed description',assessment:'{"score":65}. <tool_call>anything'});
 assert.equal(malformed.result.isError,true);assert.match(errorText(malformed),/Unknown field assessment/);
 assert.equal(f.db.results(f.id).length,before,'A malformed assessment never saves a partial record');
 const input={url:detail,title:'Developer',summary:'Observed description',score:65};
 const saved=await f.call(entry,'record_automation_result',input);assert.equal(saved.result.isError,undefined,errorText(saved));
 const receipt=JSON.parse(saved.result.content[0].text);
 assert.equal(receipt.key,detail);assert.equal(receipt.assessment.score,65);assert.deepEqual(f.failures(entry),[]);
 const repeated=await f.call(entry,'record_automation_result',input);assert.equal(repeated.result.isError,undefined);
 assert.equal(JSON.parse(repeated.result.content[0].text).id,receipt.id);assert.equal(f.db.results(f.id).length,before+1);
 assert.equal(f.db.run(entry.run.id).status,'running');assert.equal(f.reports.length,0);
});

test('templates with explicit record keys still require them',async t=>{
 const f=await fixture(t),fields=f.db.template('custom').fields;
 const a=f.db.create('custom',{sources:[source],goal:'Find slots',criteria:Object.fromEntries(fields.filter(field=>field.required).map(field=>[field.id,'Test criteria']))});
 f.db.review(a.id);const run=f.db.begin(a.id,'trial');
 const flow=automationWorkflow({db:f.db,run,signal:{aborted:false},browser:{},report:()=>{}});
 assert.equal(f.db.template(a.templateId).records.identity,'key');
 assert.ok(flow.tools.find(tool=>tool.name==='record_automation_result').inputSchema.required.includes('key'));
});

test('source scoring uses scalar MCP arguments and preserves the stored assessment and eligibility',async t=>{
 const f=await fixture(t),trial=f.db.begin(f.id,'trial');f.db.observe(f.id,trial.id,source,'Accessible');f.db.finish(f.id,trial.id,'completed','Checked');
 await f.runtime.runOnce(f.id);await new Promise(setImmediate);const entry=[...f.entries.values()].at(-1);
 const schema=entry.flow.tools.find(tool=>tool.name==='record_automation_result').inputSchema;
 assert.equal(schema.properties.assessment,undefined);assert.deepEqual(schema.properties.score.type,['integer','null']);
 for(const score of [0,72,100,null]){
  const input={url:source+'/scalar-'+String(score),title:'Synthetic analyst',summary:'Observed listing facts',score,scoreReason:score===null?'Detail unavailable':'Matches current preferences',eligibility:'unverified',eligibilityReason:'Mandatory certificate not confirmed'};
  const response=await f.call(entry,'record_automation_result',input);assert.equal(response.result.isError,undefined,errorText(response));
  const receipt=JSON.parse(response.result.content[0].text),saved=f.db.result(f.id,receipt.id);
  assert.equal(saved.assessment.score,score);assert.equal(saved.assessment.status,score===null?'unavailable':'scored');
  assert.equal(saved.assessment.summary,input.scoreReason);assert.equal(saved.summary,input.summary);
  assert.equal(saved.assessment.eligibility,'unverified');assert.equal(saved.assessment.eligibilityReason,input.eligibilityReason);
  assert.equal(saved.cells.score,score===null?'':String(score));assert.equal(saved.score,undefined,'Persisted record format is unchanged');
 }
 const before=f.db.results(f.id).length;
 for(const score of ['not a score',101]){
  const response=await f.call(entry,'record_automation_result',{url:source+'/bad-score',title:'Synthetic role',summary:'Observed',score});
  assert.equal(response.result.isError,true);assert.equal(f.db.results(f.id).length,before);
 }
 assert.equal(f.db.run(entry.run.id).status,'running');
});

test('read-only timeout messages preserve the actual failure and stop after three attempts',async t=>{
 const {recordToolGuard}=await import('../app/record-tool-guard.mjs');
 const f=await fixture(t),entry=await f.start(),guard=recordToolGuard({db:f.db,run:entry.run,report:(...args)=>f.runtime.report(...args),changed:()=>{}});
 for(let i=1;i<=3;i++){
  const original=new DOMException('Synthetic request timeout','TimeoutError');
  await assert.rejects(guard('browser_open',{url},()=>{throw original;}),error=>{
   assert.equal(error.cause,original);assert.equal(error.code,original.code);assert.match(error.message,/Synthetic request timeout/);assert.doesNotMatch(error.message,/read only|getter/);return true;
  });
 }
 assert.equal(f.db.run(entry.run.id).status,'blocked');assert.equal(f.db.run(entry.run.id).stop.kind,'technical');assert.equal(f.failures(entry)[0].count,3);
});


test('integer text scores normalize before MCP validation without changing their meaning',async t=>{
 const f=await fixture(t),entry=await f.start();
 for(const score of ['39',' 0 ','100']){
  const response=await f.score(entry,{score});assert.equal(response.result.isError,undefined);
  assert.equal(f.db.result(f.id,f.item.id).assessment.score,Number(score));assert.equal(f.failures(entry).length,0);
 }
 for(const score of ['39 points','39.5']){
  const response=await f.score(entry,{score});assert.equal(response.result.isError,true);assert.match(errorText(response),/expected integer or null/);
  assert.equal(f.db.result(f.id,f.item.id).assessment.score,100);
 }
});
