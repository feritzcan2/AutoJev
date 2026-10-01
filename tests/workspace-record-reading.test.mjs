import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {workspaceTableCall,workspaceTableTools} from '../app/workspace-table-tools.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {AUTOMATION_CONTEXT_BYTES} from '../app/automation-context.mjs';
import {validate} from '../app/tool-schema.mjs';

function fixture(t){
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),a=db.create('custom',{goal:'Find roles',sources:['https://jobs.example/']});
 const add=(key,patch={},id=a.id)=>db.putResult({id:key,automationId:id,key,url:'https://jobs.example/'+key,title:'Role '+key,status:'found',summary:'Full requirements. '.repeat(1000),proposal:'Exact proposal. '.repeat(1000),digest:'proposal-digest',approvedDigest:null,evidence:{url:'https://jobs.example/'+key,text:'Observed proof. '.repeat(1000)},assessment:{status:'scored',score:70,gaps:['No certification'],uncertainties:['Salary unknown'],revision:1},cells:{},...patch});
 const call=args=>workspaceTableCall(store,a.id,'get_workspace_records',args);
 return {store,db,a,add,call};
}

test('record lists are compact indexes; exact proposals, uncertainties and proof remain available by ID',t=>{
 const f=fixture(t),record=f.add('one',{status:'uncertain',cells:{company:'Örnek'},consent:false});
 const list=f.call({}),index=list.records[0],full=f.call({itemId:record.id});
 assert.equal(index.operationState,'uncertain');assert.equal(index.assessment.score,70);assert.equal(index.fields.company,'Örnek');
 assert.equal(index.proposal,undefined);assert.equal(index.evidence,undefined);assert.equal(index.assessment.uncertainties,undefined);
 assert.match(list.detail,/complete record.*evidence and uncertainties/);
 for(const key of Object.keys(record))assert.deepEqual(full.record[key],record[key],key);
 assert.deepEqual(f.db.result(f.a.id,record.id),record,'reading does not mutate durable state');
 assert.ok(JSON.stringify(list).length<JSON.stringify(full).length*.2);
 assert.equal(list.definition.guidance,undefined);assert.deepEqual(list.definition.records,f.store.workspaces.definition(f.a.id).records);
});

test('literal Unicode searches stay within the workspace and paginate only matching records',t=>{
 const f=fixture(t);f.add('unrelated');f.add('one',{title:'ÖRNEK 100%_ Backend'});f.add('two',{cells:{company:'Örnek 100%_'}});f.add('three',{summary:'Örnek 100%_ remote'});
 const foreign=f.db.create('custom',{goal:'Other'});f.add('foreign',{title:'Örnek 100%_'},foreign.id);
 const first=f.call({query:'örnek 100%_',limit:2}),second=f.call({query:'örnek 100%_',offset:first.nextOffset,limit:2});
 assert.equal(first.total,3);assert.deepEqual(first.records.map(r=>r.id),['one','two']);assert.deepEqual(second.records.map(r=>r.id),['three']);assert.equal(second.nextOffset,null);
 assert.equal(f.call({query:'NOT PRESENT'}).total,0);assert.equal(f.call({query:'jobs.example/two'}).records[0].id,'two');
 assert.throws(()=>f.call({itemId:'foreign'}),/çalışma alanına/);assert.throws(()=>f.call({query:'  '}),/boş olmayan/);
 const schema=workspaceTableTools.find(t=>t.name==='get_workspace_records').inputSchema;
 for(const args of [{query:'x'.repeat(201)},{limit:51},{offset:-1}])assert.throws(()=>validate(schema,args));
});

test('large full-record reads use exact bounded context fragments without losing consent or proof',async t=>{
 const f=fixture(t),record=f.add('one',{consent:false,status:'uncertain'}),run=f.db.begin(f.a.id,'interview');
 const flow=automationWorkflow({db:f.db,run,signal:new AbortController().signal,browser:{call(){throw Error('No browser needed');}},report:()=>{}});
 const call=(name,args)=>flow.call(f.a.id,run.id,name,args);
 let page=await call('get_workspace_records',{itemId:record.id}),text='',count=0;
 assert.ok(page.context);
 for(;;){assert.ok(Buffer.byteLength(JSON.stringify(page))<=AUTOMATION_CONTEXT_BYTES);text+=page.text;count++;if(page.context.nextOffset===null)break;page=await call('read_automation_context_part',{contextId:page.context.id,offset:page.context.nextOffset});}
 assert.ok(count>1);assert.deepEqual(JSON.parse(text).record,JSON.parse(JSON.stringify(f.call({itemId:record.id}).record)));
 assert.equal(JSON.parse(text).record.consent,false);assert.equal(JSON.parse(text).record.status,'uncertain');
});
