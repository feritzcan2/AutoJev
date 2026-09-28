import test from 'node:test';
import assert from 'node:assert/strict';
import {captureControls,presentObservation} from '../app/jev-navigation.mjs';
import {updateVerification} from '../app/jev-verification.mjs';
import {controlState} from '../scripts/jev-control-state.mjs';

test('control deltas reconstruct full state across edits, removals and full refreshes',()=>{
 const slot={},remember=controlState();
 const controls=Array.from({length:80},(_,i)=>({controlId:`c${i}`,label:`Question ${i}`,question:`Full wording of required question ${i}`,role:'combobox',value:'',required:true,visible:i<4}));
 const page={tabId:'tab',url:'https://example.test/form',text:'Form',elements:[],controls,clickTargets:[],scrollTargets:[],fillFields:[],uploads:[]};
 const first=presentObservation(slot,page);assert.equal(first.observationMode,'full');remember(first);
 const unchanged=presentObservation(slot,page);
 assert.deepEqual(unchanged.controls,[]);assert.deepEqual(unchanged.removedControls,[]);
 assert.ok(JSON.stringify(unchanged).length<JSON.stringify(first).length*.1);
 assert.deepEqual(remember(unchanged).controls,controls);
 const changed=[{...controls[0],visible:false},...controls.slice(2),{controlId:'new',label:'New consent',choice:{question:'Share with other employers?',option:'No',selected:false},required:true}];
 const next={...page,controls:changed,fillFields:[{fieldId:'fresh',label:'Email'}],clickTargets:[{targetId:'new-target',label:'Continue'}],status:'stale',executed:false};
 const delta=presentObservation(slot,next);
 assert.deepEqual(delta.removedControls,['c1']);assert.deepEqual(delta.controls,[changed[0],changed.at(-1)]);
 assert.deepEqual(remember(delta).controls,changed);
 assert.deepEqual(delta.fillFields,next.fillFields);assert.deepEqual(delta.clickTargets,next.clickTargets);
 assert.equal(delta.status,'stale');assert.equal(delta.executed,false);
 const refreshed=presentObservation(slot,next,{full:true});
 assert.equal(refreshed.baseObservationId,undefined);assert.deepEqual(remember(refreshed).controls,changed);
 const navigated=presentObservation(slot,{...page,url:'https://example.test/done',controls:[]});
 assert.equal(navigated.observationMode,'full');assert.deepEqual(remember(navigated).controls,[]);
});

test('changed guards and session owners explicitly retire previous control handles',()=>{
 const observed={controls:[{node:1,label:'Consent'}],control_guards:{1:['document','Question A']},scrollTargets:[],scroll_guards:{}};
 const slot={observed},remember=controlState(),page={tabId:'a',url:'https://example.test',elements:[]};
 const first=presentObservation(slot,{...page,...captureControls(slot,'owner')});remember(first);
 slot.observed.control_guards[1]=['document','Question B'];slot.observed.controls[0].label='New consent';
 const second=presentObservation(slot,{...page,...captureControls(slot,'owner')});
 assert.deepEqual(second.removedControls,[first.controls[0].controlId]);
 assert.notEqual(second.controls[0].controlId,first.controls[0].controlId);remember(second);
 const third=presentObservation(slot,{...page,...captureControls(slot,'new-owner')});
 assert.deepEqual(third.removedControls,[second.controls[0].controlId]);
 assert.deepEqual(remember(third).controls,third.controls);
 const untouched=slot.presented;
 assert.deepEqual(presentObservation(slot,{status:'uncertain'}),{status:'uncertain'});assert.equal(slot.presented,untouched);
 const other=presentObservation({}, {...page,tabId:'b',controls:[{controlId:'b-control'}]});remember(other);
 const fourth=presentObservation(slot,{...page,...captureControls(slot,'new-owner')});
 assert.deepEqual(remember(fourth).controls,third.controls);
});
test('short handles retain session and DOM identity isolation',()=>{
 const observed={controls:[{node:1,label:'University'}],control_guards:{1:['document-a','value-a']},scrollTargets:[],scroll_guards:{}};
 const slot={observed};let a=captureControls(slot,'owner').controls[0].controlId;
 assert.ok(a.length<20);assert.equal(captureControls(slot,'owner').controls[0].controlId,a);
 assert.notEqual(captureControls(slot,'other').controls[0].controlId,a);
 a=captureControls(slot,'owner').controls[0].controlId;slot.observed.control_guards[1]=['document-b','value-a'];assert.notEqual(captureControls(slot,'owner').controls[0].controlId,a);
 assert.notEqual(captureControls({observed},'owner').controls[0].controlId,a);
});
test('a new owner receives a full baseline even when the page has not changed',()=>{
 const slot={owner:'first'},page={tabId:'a',url:'https://example.test',text:'Same page',elements:[],controls:[{controlId:'x',label:'Field'}]};
 presentObservation(slot,page);
 assert.equal(presentObservation(slot,page).observationMode,'delta');
 slot.owner='second';
 const resumed=presentObservation(slot,page);
 assert.equal(resumed.observationMode,'full');assert.equal(resumed.baseObservationId,undefined);
 assert.equal(resumed.text,page.text);assert.deepEqual(resumed.controls,page.controls);
 const next=presentObservation(slot,page);
 assert.equal(next.observationMode,'delta');assert.equal(next.baseObservationId,resumed.observationId);
});
test('consumers accept legacy replacement maps and explicitly advertised map deltas',()=>{
 const remember=controlState();
 remember({tabId:'t',observationMode:'full',observationId:'a',controls:[],clickTargets:[{targetId:'old'}],fillFields:[]});
 const legacy=remember({tabId:'t',observationMode:'delta',observationId:'b',baseObservationId:'a',clickTargets:[{targetId:'new'}],fillFields:[]});
 assert.deepEqual(legacy.clickTargets,[{targetId:'new'}]);
 const current=remember({tabId:'t',observationMode:'delta',mapDeltas:true,observationId:'c',baseObservationId:'b',clickTargets:[],fillFields:[{fieldId:'f'}]});
 assert.deepEqual(current.clickTargets,[{targetId:'new'}]);assert.deepEqual(current.fillFields,[{fieldId:'f'}]);
 const removed=remember({tabId:'t',observationMode:'delta',mapDeltas:true,observationId:'d',baseObservationId:'c',clickTargets:[],removedClickTargets:['new'],fillFields:[],removedFillFields:['f']});
 assert.deepEqual(removed.clickTargets,[]);assert.deepEqual(removed.fillFields,[]);
});
test('unsupported challenges stop immediately; supported challenges stop at two attempts or 60 seconds',()=>{
 const slot={};const evidence={state:'required',capability:'supported',evidence:'Verify you are human'};
 assert.equal(updateVerification(slot,evidence,0).handoff,false);
 assert.equal(updateVerification(slot,evidence,59999).handoff,false);assert.equal(updateVerification(slot,evidence,60000).handoff,true);
 updateVerification(slot,null,60001);assert.equal(slot.verification,undefined);
 updateVerification(slot,evidence,70000);slot.verification.attempts=2;assert.equal(updateVerification(slot,evidence,70001).handoff,true);
 updateVerification(slot,null);assert.equal(updateVerification(slot,{...evidence,capability:'not_exposed',limitation:'No drag support'},80000).handoff,true);
});

import {observationPolicy} from '../app/jev-navigation.mjs';
test('routine full requests produce compact maps; lost context and recovery retain full reconstruction',()=>{
 const page={url:'https://example.test',elements:[],controls:[{controlId:'x',value:'before'}],text:'Form'},slot={owner:'a'};
 const present=(value,args={full:true},name='browser_jev_observe')=>presentObservation(slot,value,observationPolicy(name,args,value.status));
 assert.equal(present(page).observationMode,'full');
 const changed=present({...page,text:'Thank you for applying',controls:[{controlId:'x',value:'after'}]});
 assert.equal(changed.observationMode,'compact');assert.equal(changed.text,'Thank you for applying');assert.equal(changed.controls[0].value,'after');
 assert.equal(present(page,{full:true,fullReason:'context_loss'}).observationMode,'full');
 assert.equal(present(page,{full:true,fullReason:'missing_baseline'}).observationMode,'compact');
 assert.equal(present(page,{}).observationMode,'compact');
 slot.owner='b';assert.equal(present(page).observationMode,'full');
 assert.equal(present({...page,url:'https://example.test/new'}).observationMode,'full');
 assert.equal(observationPolicy('browser_jev_fill_fields',{},'invalid_target').full,true);
 assert.equal(observationPolicy('browser_jev_select_choice',{},'blocked').full,true);
});

test('compact wire state works without prior maps, removes old IDs, and preserves exact consent and new evidence',()=>{
 const slot={owner:'a'},longText='Same page details. '.repeat(1000);
 const page={tabId:'t',url:'https://example.test',text:longText,elements:[{index:1,label:'Duplicate'}],controls:[{controlId:'c',choice:{question:'Exact privacy consent?',option:'Agree',selected:false},required:true}],clickTargets:[{targetId:'old',label:'Continue'}],fillFields:[{fieldId:'f',label:'Email',value:'saved'}],scrollTargets:[],uploads:[]};
 presentObservation(slot,page,{standalone:true});
 const current={...page,clickTargets:[{targetId:'new',label:'Continue'}]};
 const wire=presentObservation(slot,current,observationPolicy('browser_jev_observe',{full:true,fullReason:'missing_baseline'}));
 assert.equal(wire.observationMode,'compact');assert.equal(wire.controlMaps,'replace');assert.equal(wire.baseObservationId,undefined);
 assert.deepEqual(wire.controls,page.controls);assert.deepEqual(wire.fillFields,page.fillFields);
 assert.equal(wire.text,undefined);assert.equal(wire.textUnchanged,true);assert.equal(wire.elements,undefined);
 const remember=controlState();assert.deepEqual(remember(wire).clickTargets,current.clickTargets);
 const empty=presentObservation(slot,{...current,clickTargets:[],text:'Application received'},{standalone:true});
 assert.deepEqual(remember(empty).clickTargets,[]);assert.equal(empty.text,'Application received');assert.equal(empty.textUnchanged,undefined);
 const recovery=presentObservation(slot,page,observationPolicy('browser_jev_observe',{full:true,fullReason:'context_loss'}));
 assert.equal(recovery.observationMode,'full');assert.equal(recovery.text,longText);
 assert.ok(JSON.stringify(wire).length<JSON.stringify(page).length*.1);
});
