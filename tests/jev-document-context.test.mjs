import test from 'node:test';
import assert from 'node:assert/strict';
import {documentObservation} from '../app/jev-document.mjs';

function fixture(text,viewportText){
 const url='https://jobs.example/role',document={url,text,links:[{text:'Apply',url:url+'/apply'}],pagination:[],readiness:{loading:false,reason:null}};
 const slot={page:{evaluate:async()=>document,frames:()=>[{},{}]}};
 const value={url,text:viewportText,elements:[{index:1,label:'Apply'}],controls:[{controlId:'current-control',label:'Apply'}],clickTargets:[{targetId:'current-target',label:'Apply'}],fillFields:[{fieldId:'current-field',value:'No'}],scrollTargets:[{controlId:'current-scroll'}],uploads:[{uploadId:'current-upload'}],savedLogin:{ready:true},status:'uncertain',verified:false};
 return {slot,value,document};
}

test('document observations omit repeated prose while retaining exact text, links and current guarded action state',async()=>{
 const f=fixture('Senior Engineer\nSalary €100,000\nConsent: No\nMore below the fold','Senior  Engineer\nSalary €100,000\nConsent: No'),before=structuredClone(f.value);
 const result=await documentObservation(f.slot,f.value);
 assert.equal(result.text,f.document.text);assert.equal(result.viewportText,'');assert.equal(result.elements,undefined);
 assert.deepEqual(result.links,f.document.links);assert.equal(result.reading.unreadFrames,1);
 for(const key of ['controls','clickTargets','fillFields','scrollTargets','uploads','savedLogin','status','verified'])assert.deepEqual(result[key],f.value[key]);
 assert.deepEqual(f.value,before,'the browser snapshot remains intact for guarded actions');
});

test('viewport-only facts, frame content and changed consent wording remain verbatim',async()=>{
 for(const viewport of ['Senior Engineer\nForm answer: No','Senior Engineer\nFrame: Application submitted','Consent: Yes','Salary €10,000']){
  const f=fixture('Senior Engineer\nSalary €100,000\nConsent: No',viewport);
  assert.equal((await documentObservation(f.slot,f.value)).viewportText,viewport);
 }
 const f=fixture('','Frame: Not submitted');delete f.value.controls;
 const result=await documentObservation(f.slot,f.value);assert.deepEqual(result.elements,f.value.elements);assert.equal(result.viewportText,f.value.text);
});

test('document reading refuses a redirect rather than combining stale action IDs with another page',async()=>{
 const f=fixture('Role','Role');f.document.url='https://other.example/';
 await assert.rejects(documentObservation(f.slot,f.value),/yönlendi/);
});
