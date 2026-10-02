import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {briefBlocks,readJevBrief} from '../app/jev-brief.mjs';
import {jevTaskSummary} from '../app/jev-tasks.mjs';

function fixture(t,text){
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('job-search',{goal:'Compliance',sources:['https://example.test/']});
 const store=db.jevTasks,task=store.create(a.id,'parent',{operation:'collect_details'}),e=store.evidence(task,{url:'https://example.test/role',title:'Role',text});
 let calls=0;const controller=new AbortController();
 const options={store,owner:a.id,taskId:'parent',evidenceId:e.id,criteria:{goal:'Compliance'},signal:controller.signal,evaluate:async(state,questions)=>{
  calls++;return {answers:Object.fromEntries(Object.entries(questions).map(([name,q])=>{
   const choice=state.blocks[name].includes('IMPORTANT')?'requirements':'irrelevant';
   return [name,{choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}];
  })),usage:{input_tokens:100,output_tokens:20}};
 }};
 return {core,store,task,e,options,controller,calls:()=>calls};
}
const noise='Navigation and cookies. '.repeat(35)+'\n';
const required='IMPORTANT: SAP HCM experience is mandatory. Homeoffice möglich; full remote is not confirmed. Salary estimate by the job site, not an employer offer.\n';

test('briefs retain exact mandatory qualifiers and late facts while omitting unrelated content',async t=>{
 const raw=noise.repeat(30)+required+noise.repeat(10),f=fixture(t,raw),result=await readJevBrief(f.options);
 assert.equal(result.status,'ready');assert.equal(result.coverage.analyzedAllText,true);
 assert.ok(result.sections.map(s=>s.text).join('').includes(required));assert.ok(result.coverage.selectedCharacters<raw.length/4);
 for(const part of result.sections)assert.equal(part.text,raw.slice(part.offset,part.endOffset));
 const count=f.calls();await readJevBrief(f.options);assert.equal(f.calls(),count,'cached briefs do not call the model again');
 assert.equal(f.store.get(f.options.owner,'parent',f.task.id).usage.calls,count);
 assert.equal(f.core.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('jev_briefs','jev_evidence','jev_tasks')").get().n,0);
 f.store.release(f.options.owner,'parent');assert.equal(f.store.briefs.size,0);assert.equal(f.store.briefJobs.size,0);
 await assert.rejects(readJevBrief(f.options),/bu göreve ait değil/);
});

test('uncertain selections stay visible and partial reads cover all retained text',async t=>{
 const raw=required.repeat(80),f=fixture(t,raw);
 f.options.evaluate=async(state,questions)=>({answers:Object.fromEntries(Object.entries(questions).map(([k,q])=>[k,{choice:'irrelevant',confidence:.6,probabilities:Object.fromEntries(Object.keys(q.criteria).map(c=>[c,c==='irrelevant'?.6:c==='uncertain'?.4:0]))}]))});
 const sections=[];let offset=0;
 do{const result=await readJevBrief({...f.options,offset});assert.equal(result.status,'ready');sections.push(...result.sections);offset=result.nextOffset;}while(offset!==null);
 assert.ok(sections.every(s=>s.kind==='uncertain'));assert.equal(sections.map(s=>s.text).join(''),raw);
});

test('slow brief calls continue in RAM and polling never duplicates work',async t=>{
 const f=fixture(t,noise+required+noise),evaluate=f.options.evaluate;let done,calls=0;
 f.options.evaluate=async(...args)=>{calls++;await new Promise(resolve=>{done=resolve;});return evaluate(...args);};
 assert.equal((await readJevBrief({...f.options,waitMs:1})).status,'running');
 assert.equal((await readJevBrief({...f.options,waitMs:1})).status,'running');assert.equal(calls,1);
 done();assert.equal((await readJevBrief(f.options)).status,'ready');assert.equal(calls,1);
});

test('briefs isolate owners and invalidate on fresh text or criteria; failures expose a fallback',async t=>{
 const f=fixture(t,noise+required+noise);
 await assert.rejects(readJevBrief({...f.options,owner:'foreign'}),/bu göreve ait değil/);
 await readJevBrief(f.options);const before=f.calls();
 await readJevBrief({...f.options,criteria:{goal:'Other goal'}});assert.ok(f.calls()>before);
 f.store.evidence(f.task,{...f.e,text:noise+required+'IMPORTANT: Berlin office attendance is mandatory.\n'+noise});
 const refreshed=await readJevBrief(f.options);assert.match(refreshed.sections.map(s=>s.text).join(''),/Berlin office attendance/);
 f.options.criteria={goal:'New criteria'};f.options.evaluate=async()=>{throw Error('API unavailable');};
 const failed=await readJevBrief(f.options);assert.equal(failed.status,'needs_agent');assert.match(failed.next,/read_jev_evidence/);
 f.controller.abort();await assert.rejects(readJevBrief(f.options),/abort/i);
});

test('compact review indices omit URLs and duplicate exclusion metadata but retain selectable facts',()=>{
 const item={url:'https://example.test/job?bb='+('x'.repeat(1500)),title:'Current role',evidenceId:'evidence',assessment:{decision:'mismatch',confidence:.9,reason:'unrelated_role',exclusion:{evidenceId:'evidence',reason:'unrelated_role',confidence:.9}}};
 const task={id:'task',input:{operation:'collect_details'},items:[item],batch:{id:'batch',urls:[item.url]},answers:{}};
 const compact=jevTaskSummary(task),full=jevTaskSummary(task,{view:'details'});
 assert.equal(compact.items[0].url,undefined);assert.equal(compact.items[0].item,1);assert.equal(compact.items[0].assessment.reason,'unrelated_role');assert.equal(full.items[0].url,item.url);
 assert.equal(compact.items[0].evidenceId,item.evidenceId);assert.ok(JSON.stringify(compact.items).length<JSON.stringify(full.items).length/5);
 const text='x'.repeat(4500);assert.equal(briefBlocks(text).map(p=>p.text).join(''),text);
});
