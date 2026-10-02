import test from 'node:test';
import assert from 'node:assert/strict';
import {validate} from '../app/tool-schema.mjs';
import {jevTaskTools} from '../app/jev-tasks.mjs';
import {workspaceCellsSchema,normalizeCellToolArgs} from '../app/workspace-table-tools.mjs';

const note={type:'object',required:['evidence'],properties:{evidence:{type:'string',minLength:1,maxLength:600}}};
test('array failures explain type, shape and limits without retaining input content',()=>{
 for(const cells of ['private page text',null,{notes:42}])assert.throws(()=>validate(workspaceCellsSchema,cells,'arguments.cells'),error=>{
  assert.match(error.message,/Expected array; received (string|null|object)/);
  assert.match(error.message,/configured_column/);assert.match(error.message,/string values/);
  assert.doesNotMatch(JSON.stringify(error.validationIssues),/private page text|notes/);
  assert.equal(error.validationIssues[0].path,'arguments.cells');return true;
 });
 const values=Array.from({length:11},(_,i)=>({key:'column_'+i,value:'private page text'}));
 assert.throws(()=>validate(workspaceCellsSchema,values,'arguments.cells'),error=>{
  assert.match(error.message,/received 11 items; maximum 10/);
  assert.deepEqual(error.validationIssues,[{path:'arguments.cells',expected:'array',received:'array',length:11,minItems:0,maxItems:10}]);return true;
 });
 assert.doesNotThrow(()=>validate(workspaceCellsSchema,values.slice(0,10)));
 assert.doesNotThrow(()=>validate(workspaceCellsSchema,[]));
 assert.throws(()=>validate({...workspaceCellsSchema,minItems:1},[]),/received 0 items; minimum 1/);
 const schema={type:'object',required:['summary'],properties:{summary:{type:'string'},cells:workspaceCellsSchema}};
 assert.throws(()=>validate(schema,{cells:[{key:'notes',value:42}],'private-field-name':'private-value'}),error=>{
  assert.deepEqual(error.validationIssues[0],{path:'arguments.summary',expected:'string',received:'missing'});
  assert.equal(error.validationIssues[1].path,'arguments.cells[0].value');
  assert.doesNotMatch(JSON.stringify(error.validationIssues),/private-field-name|private-value|notes/);return true;
 });
});

test('cell maps normalize losslessly only for cell writes and still obey the schema',()=>{
 const input={summary:'Observed details',cells:{location:'Remote',salary:'1234.50',notes:''}};
 for(const name of ['record_automation_result','update_automation_cells','update_workspace_cells']){
  const result=normalizeCellToolArgs(name,input);
  assert.deepEqual(result,{summary:input.summary,cells:[{key:'location',value:'Remote'},{key:'salary',value:'1234.50'},{key:'notes',value:''}]});
  assert.doesNotThrow(()=>validate(workspaceCellsSchema,result.cells));
  assert.equal(normalizeCellToolArgs(name,result),result);
  assert.deepEqual(input.cells,{location:'Remote',salary:'1234.50',notes:''});
  for(const cells of [null,'{"notes":"text"}',{notes:7},{notes:null},{notes:['text']},{notes:{value:'text'}}]){
   const bad={cells};assert.equal(normalizeCellToolArgs(name,bad),bad);
   assert.throws(()=>validate(workspaceCellsSchema,bad.cells));
  }
 }
 assert.equal(normalizeCellToolArgs('record_automation_score',input),input);
 assert.deepEqual(normalizeCellToolArgs('record_automation_result',{cells:{}}).cells,[]);
 const large={cells:Object.fromEntries(Array.from({length:11},(_,i)=>['column_'+i,'observed']))};
 assert.throws(()=>validate(workspaceCellsSchema,normalizeCellToolArgs('record_automation_result',large).cells),/maximum 10/);
});

test('nonempty oversized source notes report the exact length and limit, not an empty-string error',()=>{
 for(const length of [700,693,642])assert.throws(()=>validate(note,{evidence:'x'.repeat(length)}),error=>{
  assert.equal(error.validationPath,'arguments.evidence');assert.match(error.message,new RegExp(`received ${length} characters; maximum 600`));assert.doesNotMatch(error.message,/non-empty/);return true;
 });
 assert.doesNotThrow(()=>validate(note,{evidence:'x'.repeat(600)}));
 assert.throws(()=>validate(note,{evidence:'  '}),/non-empty string/);
 assert.throws(()=>validate(note,{evidence:42}),/expected a string/);
 assert.throws(()=>validate(note,{evidence:'ok',evidenceId:'extra'}),/Unknown field evidenceId/);
});
test('evidence-read bounds explain the permitted range and accept its boundary',()=>{
 const schema=jevTaskTools.find(t=>t.name==='read_jev_evidence').inputSchema;
 assert.throws(()=>validate(schema,{evidenceId:'test',limit:9000}),/arguments.limit: Number exceeds maximum 6000; received 9000/);
 assert.throws(()=>validate(schema,{evidenceId:'test',offset:-1}),/arguments.offset: Number below minimum 0/);
 for(const limit of [NaN,Infinity,'6000',1.5])assert.throws(()=>validate(schema,{evidenceId:'test',limit}),/finite integer/);
 assert.doesNotThrow(()=>validate(schema,{evidenceId:'test',limit:6000,offset:0}));
});
test('nullable and enum fields retain their validation rules without leaking invalid text',()=>{
 assert.doesNotThrow(()=>validate({type:['string','null'],maxLength:3},null));
 assert.throws(()=>validate({type:['string','null'],maxLength:3},'private content'),error=>!error.message.includes('private content')&&error.message.includes('maximum 3'));
 assert.throws(()=>validate({type:'string',enum:['ready','blocked']},'unknown'),/ready \| blocked/);
 assert.doesNotThrow(()=>validate({type:'string',minLength:0},''));
});

test('validation reports missing and malformed sibling fields together, with bounded output',()=>{
 const schema={type:'object',required:['title','url'],properties:{
  title:{type:'string'},url:{type:'string'},assessment:{type:'object',required:['score'],properties:{score:{type:'integer',minimum:0,maximum:100}}}
 }};
 assert.throws(()=>validate(schema,{url:3,assessment:{name:'private content'}}),error=>{
  assert.equal(error.validationPath,'arguments');
  for(const message of ['arguments: Missing title','arguments.url: Invalid argument: expected a string','arguments.assessment: Missing score','arguments.assessment: Unknown field name'])assert.ok(error.message.includes(message),error.message);
  assert.doesNotMatch(error.message,/private content/);return true;
 });
 assert.throws(()=>validate({type:'array',items:{type:'integer'}},Array(100).fill('private content')),error=>{
  assert.equal(error.message.split('\n').length,8);assert.doesNotMatch(error.message,/private content/);return true;
 });
 assert.throws(()=>validate({type:'object',required:['title','url'],properties:schema.properties},{}),/Missing title\narguments: Missing url/);
});
